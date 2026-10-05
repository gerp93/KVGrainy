"""Benchmark KVGrainy against other encoders at the same size limits.

For every corpus image and size limit, each contestant produces its best
output under the limit; outputs are scored with SSIMULACRA2 against the
upright, sRGB-normalized original (higher is better, ~90 is visually lossless).

    python scripts/benchmark.py --make-corpus          # synthetic stand-ins
    python scripts/benchmark.py --corpus ~/my-photos   # real images (preferred)
    python scripts/benchmark.py --list                 # show corpus + contestants

External tools (cjpeg, cwebp, avifenc, pngquant, oxipng) are used when found on
PATH and skipped otherwise. Synthetic images are only a smoke test: publish
numbers from a corpus of real photos and screenshots.
"""

import argparse
import io
import random
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image, ImageDraw, ImageOps  # noqa: E402

import kvgrainy  # noqa: E402

DEFAULT_CORPUS = Path(__file__).resolve().parent.parent / "benchmark" / "corpus"
STILL_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff"}


@dataclass
class Result:
    size_bytes: int
    score: float
    seconds: float
    label: str = ""


# ---------------------------------------------------------------- corpus


def make_corpus(directory: Path) -> None:
    """Deterministic synthetic images covering the cases that break encoders."""
    directory.mkdir(parents=True, exist_ok=True)
    rng = random.Random(1234)

    photo = Image.effect_noise((1200, 800), 30).convert("RGB")
    gradient = Image.linear_gradient("L").resize((1200, 800))
    photo = Image.merge("RGB", (gradient, ImageOps.invert(gradient), photo.convert("L")))
    draw = ImageDraw.Draw(photo)
    for _ in range(40):
        x, y = rng.randrange(1200), rng.randrange(800)
        r = rng.randrange(20, 120)
        draw.ellipse((x, y, x + r, y + r), fill=tuple(rng.randrange(256) for _ in range(3)))
    photo.save(directory / "photo_like.jpg", quality=95)

    shot = Image.new("RGB", (1280, 720), (245, 245, 247))
    d = ImageDraw.Draw(shot)
    for row in range(18):
        d.rectangle((40, 30 + row * 38, 40 + rng.randrange(200, 1100), 50 + row * 38), fill=(60, 60, 70))
    d.rectangle((900, 400, 1240, 680), fill=(30, 120, 220))
    shot.save(directory / "screenshot_like.png")

    alpha = photo.resize((600, 400)).convert("RGBA")
    alpha.putalpha(Image.linear_gradient("L").rotate(90).resize((600, 400)))
    alpha.save(directory / "transparent.png")

    photo.resize((800, 533)).convert("CMYK").save(directory / "cmyk.jpg", quality=95)

    exif = Image.Exif()
    exif[0x0112] = 6
    photo.resize((900, 600)).save(directory / "rotated_phone.jpg", quality=95, exif=exif)
    print(f"Wrote synthetic corpus to {directory}")


def corpus_files(directory: Path) -> list[Path]:
    return sorted(p for p in directory.rglob("*") if p.suffix.lower() in STILL_EXTENSIONS)


# ---------------------------------------------------------------- scoring


def flatten(image: Image.Image) -> Image.Image:
    """Composite on white so alpha images are scored on what a viewer sees."""
    if image.mode in ("RGBA", "LA"):
        background = Image.new("RGB", image.size, (255, 255, 255))
        background.paste(image, mask=image.getchannel("A"))
        return background
    return image.convert("RGB")


def score_output(reference_png: Path, output: Path, work: Path) -> float:
    from ssimulacra2 import compute_ssimulacra2

    with Image.open(reference_png) as ref:
        size = ref.size
    with Image.open(output) as out:
        out.load()
        decoded = flatten(ImageOps.exif_transpose(out))
    if decoded.size != size:
        decoded = decoded.resize(size, Image.Resampling.LANCZOS)
    decoded_png = work / "decoded.png"
    decoded.save(decoded_png)
    return float(compute_ssimulacra2(str(reference_png), str(decoded_png)))


# ------------------------------------------------------------ contestants


def bisect_quality(encode: Callable[[int], bytes | None], limit: int, lo: int = 1, hi: int = 100) -> bytes | None:
    """Highest quality in [lo, hi] whose output fits `limit`."""
    best = None
    while lo <= hi:
        mid = (lo + hi) // 2
        payload = encode(mid)
        if payload is not None and len(payload) <= limit:
            best, lo = payload, mid + 1
        else:
            hi = mid - 1
    return best


def pillow_encoder(fmt: str, ext: str):
    def run(source: Image.Image, limit: int, work: Path) -> tuple[bytes, str] | None:
        image = kvgrainy.get_working_image(source, fmt)

        def encode(quality: int) -> bytes | None:
            buffer = io.BytesIO()
            image.save(buffer, format=fmt, quality=quality)
            return buffer.getvalue()

        payload = bisect_quality(encode, limit)
        return (payload, ext) if payload else None

    return run


def kvgrainy_engine(source: Image.Image, limit: int, work: Path) -> tuple[bytes, str] | None:
    src = work / "kv_input.png"
    source.save(src)
    out = work / "kv_out"
    out.mkdir(exist_ok=True)
    try:
        candidate = kvgrainy.optimize_image(src, limit, out)
    except RuntimeError:
        return None
    ext = ".jpg" if candidate.fmt == "JPEG" else f".{candidate.fmt.lower()}"
    return candidate.image_bytes, ext


RUST_CLI = Path(__file__).resolve().parent.parent / "target" / "release" / "kvgrainy"


def kvgrainy_rust(source: Image.Image, limit: int, work: Path) -> tuple[bytes, str] | None:
    exe = shutil.which("kvgrainy") or (str(RUST_CLI) if RUST_CLI.exists() else None)
    if not exe:
        return None
    src = work / "rs_input.png"
    source.save(src)
    out = work / "rs_out"
    shutil.rmtree(out, ignore_errors=True)
    proc = subprocess.run([exe, str(src), "--limit", str(limit), "--output", str(out)], capture_output=True)
    produced = sorted(out.glob("rs_input_optimized.*")) if proc.returncode == 0 else []
    return (produced[0].read_bytes(), produced[0].suffix) if produced else None


def cli_encoder(tool: str, ext: str, build: Callable[[Path, Path, int], list[str]], needs_ppm: bool = False):
    def run(source: Image.Image, limit: int, work: Path) -> tuple[bytes, str] | None:
        exe = shutil.which(tool)
        if not exe:
            return None
        flat = flatten(source) if needs_ppm else source
        inp = work / ("in.ppm" if needs_ppm else "in.png")
        flat.save(inp)
        out = work / f"out{ext}"

        def encode(quality: int) -> bytes | None:
            out.unlink(missing_ok=True)
            cmd = [exe] + build(inp, out, quality)
            proc = subprocess.run(cmd, capture_output=True)
            if proc.returncode != 0:
                return None
            return out.read_bytes() if out.exists() else proc.stdout

        payload = bisect_quality(encode, limit)
        return (payload, ext) if payload else None

    return run


CONTESTANTS: dict[str, Callable] = {
    "kvgrainy": kvgrainy_engine,
    "kvgrainy-rs": kvgrainy_rust,
    "pillow-jpeg-q": pillow_encoder("JPEG", ".jpg"),
    "pillow-webp-q": pillow_encoder("WEBP", ".webp"),
    "mozjpeg": cli_encoder("cjpeg", ".jpg", lambda i, o, q: ["-quality", str(q), "-outfile", str(o), str(i)], True),
    "cwebp": cli_encoder("cwebp", ".webp", lambda i, o, q: ["-q", str(q), "-m", "6", str(i), "-o", str(o)]),
    "avifenc": cli_encoder("avifenc", ".avif", lambda i, o, q: ["-q", str(q), "-s", "6", str(i), str(o)]),
    "pngquant": cli_encoder("pngquant", ".png", lambda i, o, q: ["--quality", f"0-{q}", "--output", str(o), str(i)]),
}


def available(name: str) -> bool:
    if name == "kvgrainy-rs":
        return shutil.which("kvgrainy") is not None or RUST_CLI.exists()
    tool = {"mozjpeg": "cjpeg", "cwebp": "cwebp", "avifenc": "avifenc", "pngquant": "pngquant"}.get(name)
    return tool is None or shutil.which(tool) is not None


# ------------------------------------------------------------------ run


def run_benchmark(files: list[Path], ratios: list[float], names: list[str]) -> list[str]:
    rows = ["| image | limit | tool | size | SSIMULACRA2 | time |", "|---|---|---|---|---|---|"]
    for path in files:
        source = kvgrainy.load_static_image(path)
        original_size = path.stat().st_size
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            reference = work / "reference.png"
            flatten(source).save(reference)
            for ratio in ratios:
                limit = max(1024, int(original_size * ratio))
                for name in names:
                    started = time.perf_counter()
                    produced = CONTESTANTS[name](source, limit, work)
                    elapsed = time.perf_counter() - started
                    if produced is None:
                        rows.append(f"| {path.name} | {limit / 1024:.1f} KB | {name} | no fit | - | {elapsed:.1f}s |")
                        continue
                    payload, ext = produced
                    result_file = work / f"result{ext}"
                    result_file.write_bytes(payload)
                    score = score_output(reference, result_file, work)
                    rows.append(
                        f"| {path.name} | {limit / 1024:.1f} KB | {name} | {len(payload) / 1024:.1f} KB | {score:.1f} | {elapsed:.1f}s |"
                    )
                    print(rows[-1], flush=True)
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS, help="Directory of still images")
    parser.add_argument("--make-corpus", action="store_true", help="Write a synthetic corpus to --corpus and exit")
    parser.add_argument("--list", action="store_true", help="List corpus files and contestants, then exit")
    parser.add_argument("--ratios", default="0.5,0.2", help="Size limits as fractions of each source file's size")
    parser.add_argument("--tools", help="Comma-separated contestants (default: all available)")
    parser.add_argument("--output", type=Path, help="Also write the table to this markdown file")
    args = parser.parse_args()

    if args.make_corpus:
        make_corpus(args.corpus)
        return
    files = corpus_files(args.corpus)
    names = args.tools.split(",") if args.tools else [n for n in CONTESTANTS if available(n)]
    unknown = [n for n in names if n not in CONTESTANTS]
    if unknown:
        parser.error(f"unknown tool(s): {', '.join(unknown)}")
    if args.list:
        print("Corpus:", *(f"  {p.name}" for p in files), sep="\n")
        print("Contestants:", *(f"  {n}{'' if available(n) else '  (not installed)'}" for n in CONTESTANTS), sep="\n")
        return
    if not files:
        parser.error(f"no images in {args.corpus}; run with --make-corpus or pass --corpus")
    rows = run_benchmark(files, [float(r) for r in args.ratios.split(",")], names)
    table = "\n".join(rows)
    print("\n" + table)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(table + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
