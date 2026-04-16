import argparse
import io
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageChops

SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff"}
SCALE_FACTORS = [round(v, 2) for v in [1.0, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3]]


@dataclass
class Candidate:
    image_bytes: bytes
    fmt: str
    quality: int | None
    scale: float
    size_bytes: int
    visual_score: float
    total_score: float


def parse_size_limit(text: str) -> int:
    value = text.strip().lower()
    if not value:
        raise ValueError("Size limit cannot be empty")
    units = [("mb", 1024 * 1024), ("kb", 1024), ("b", 1)]
    for unit, multiplier in units:
        if value.endswith(unit):
            number = value[: -len(unit)].strip()
            return int(float(number) * multiplier)
    return int(float(value))


def iter_images(paths: Iterable[str]) -> list[Path]:
    images: list[Path] = []
    for value in paths:
        path = Path(value).expanduser().resolve()
        if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS:
            images.append(path)
        elif path.is_dir():
            for file in path.rglob("*"):
                if file.is_file() and file.suffix.lower() in SUPPORTED_EXTENSIONS:
                    images.append(file)
    return sorted(set(images))


def encode_image(image: Image.Image, fmt: str, quality: int | None) -> bytes:
    buffer = io.BytesIO()
    params = {}
    if fmt == "JPEG":
        params = {"quality": quality or 80, "optimize": True, "progressive": True}
    elif fmt == "WEBP":
        params = {"quality": quality or 80, "method": 6}
    elif fmt == "PNG":
        params = {"optimize": True}
    image.save(buffer, format=fmt, **params)
    return buffer.getvalue()


def rms_score(original: Image.Image, candidate: Image.Image, scale: float) -> float:
    if candidate.size != original.size:
        candidate = candidate.resize(original.size, Image.Resampling.LANCZOS)
    diff = ImageChops.difference(original, candidate)
    histogram = diff.histogram()
    sq = (value * ((idx % 256) ** 2) for idx, value in enumerate(histogram))
    sum_of_squares = sum(sq)
    rms = math.sqrt(sum_of_squares / float(original.size[0] * original.size[1] * 3))
    similarity = max(0.0, 1.0 - (rms / 255.0))
    return similarity * (0.85 + (0.15 * scale))


def get_working_image(image: Image.Image, fmt: str) -> Image.Image:
    if fmt == "JPEG":
        if image.mode in ("RGBA", "LA"):
            background = Image.new("RGB", image.size, (255, 255, 255))
            background.paste(image, mask=image.split()[-1])
            return background
        return image.convert("RGB")
    if image.mode not in ("RGB", "RGBA"):
        return image.convert("RGB")
    return image


def evaluate_candidate(
    original: Image.Image,
    resized: Image.Image,
    fmt: str,
    quality: int | None,
    limit_bytes: int,
) -> Candidate | None:
    payload = encode_image(resized, fmt, quality)
    size = len(payload)
    if size > limit_bytes:
        return None
    decoded = Image.open(io.BytesIO(payload)).convert("RGB")
    original_rgb = original.convert("RGB")
    scale = resized.width / original.width
    visual = rms_score(original_rgb, decoded, scale)
    utilization = size / limit_bytes
    total_score = (visual * 0.8) + (utilization * 0.2)
    return Candidate(payload, fmt, quality, scale, size, visual, total_score)


def find_best_for_format(original: Image.Image, limit_bytes: int, fmt: str) -> Candidate | None:
    best: Candidate | None = None
    for scale in SCALE_FACTORS:
        width = max(1, int(original.width * scale))
        height = max(1, int(original.height * scale))
        resized = original.resize((width, height), Image.Resampling.LANCZOS)

        if fmt == "PNG":
            candidate = evaluate_candidate(original, resized, fmt, None, limit_bytes)
            if candidate and (best is None or (candidate.total_score, candidate.size_bytes) > (best.total_score, best.size_bytes)):
                best = candidate
            continue

        lo, hi = 20, 100
        best_quality_candidate: Candidate | None = None
        while lo <= hi:
            mid = (lo + hi) // 2
            candidate = evaluate_candidate(original, resized, fmt, mid, limit_bytes)
            if candidate:
                best_quality_candidate = candidate
                lo = mid + 1
            else:
                hi = mid - 1

        if best_quality_candidate and (
            best is None
            or (best_quality_candidate.total_score, best_quality_candidate.size_bytes)
            > (best.total_score, best.size_bytes)
        ):
            best = best_quality_candidate
    return best


def optimize_image(image_path: Path, limit_bytes: int, output_dir: Path) -> Candidate:
    original = Image.open(image_path)
    formats = ["WEBP", "PNG"] if original.mode in ("RGBA", "LA") else ["JPEG", "WEBP", "PNG"]
    candidates: list[Candidate] = []
    for fmt in formats:
        best = find_best_for_format(get_working_image(original, fmt), limit_bytes, fmt)
        if best:
            candidates.append(best)

    if not candidates:
        raise RuntimeError(f"Could not create output under limit for {image_path.name}")

    best = max(candidates, key=lambda c: (c.total_score, c.size_bytes))
    ext = ".jpg" if best.fmt == "JPEG" else f".{best.fmt.lower()}"
    output_path = output_dir / f"{image_path.stem}_optimized{ext}"
    output_path.write_bytes(best.image_bytes)
    print(
        f"[done] {image_path.name} -> {output_path.name} | "
        f"{best.size_bytes / 1024:.1f}KB | fmt={best.fmt} quality={best.quality} scale={best.scale:.2f}"
    )
    return best


def interactive_inputs() -> tuple[list[str], str, str]:
    raw_paths = input("Enter file/folder paths (comma separated): ").strip()
    limit = input("Enter max size per image (e.g. 400kb, 1.5mb): ").strip()
    output = input("Output folder [./reduced]: ").strip() or "./reduced"
    paths = [value.strip() for value in raw_paths.split(",") if value.strip()]
    return paths, limit, output


def main() -> None:
    parser = argparse.ArgumentParser(
        description="AI-assisted local image reducer that maximizes quality under a size limit."
    )
    parser.add_argument("paths", nargs="*", help="Image files and/or folders")
    parser.add_argument("--limit", help="Max output size per image (e.g. 500kb, 1.5mb)")
    parser.add_argument("--output", default="./reduced", help="Output directory")
    args = parser.parse_args()

    paths = args.paths
    limit = args.limit
    output_dir = args.output
    if not paths or not limit:
        print("Starting interactive mode...")
        paths, limit, output_dir = interactive_inputs()

    limit_bytes = parse_size_limit(limit)
    if limit_bytes <= 0:
        raise ValueError("Size limit must be greater than zero")

    image_files = iter_images(paths)
    if not image_files:
        raise FileNotFoundError("No supported images found in provided paths")

    output_path = Path(output_dir).expanduser().resolve()
    output_path.mkdir(parents=True, exist_ok=True)

    print(f"Processing {len(image_files)} image(s) with limit {limit_bytes} bytes")
    for image in image_files:
        optimize_image(image, limit_bytes, output_path)
    print("All images processed.")


if __name__ == "__main__":
    main()
