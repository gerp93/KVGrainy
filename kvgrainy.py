import argparse
import io
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageChops

SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff", ".gif"}
SCALE_FACTORS = [1.0, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3]
VISUAL_WEIGHT = 0.8
SIZE_UTILIZATION_WEIGHT = 0.2
SCALE_WEIGHT_BASE = 0.85
SCALE_WEIGHT_RANGE = 0.15


def print_banner() -> None:
    """Print a colorful startup banner."""
    # ANSI color codes
    BOLD = "\033[1m"
    CYAN = "\033[96m"
    MAGENTA = "\033[95m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    RESET = "\033[0m"
    
    print()
    print(f"{CYAN}{'-'*60}{RESET}")
    print(f"{MAGENTA}|{RESET}")
    print(f"{MAGENTA}|{RESET} {BOLD}{GREEN}KVGrainy Image Right Sizer{RESET}")
    print(f"{MAGENTA}|{RESET} {YELLOW}Making Your Images More Grainy{RESET}")
    print(f"{MAGENTA}|{RESET}")
    print(f"{CYAN}{'-'*60}{RESET}")
    print()


@dataclass
class Candidate:
    image_bytes: bytes
    fmt: str
    quality: int | None
    scale: float
    size_bytes: int
    visual_score: float
    total_score: float


def is_better(candidate: Candidate, current: Candidate | None) -> bool:
    if current is None:
        return True
    return (candidate.total_score, candidate.size_bytes) > (current.total_score, current.size_bytes)


def parse_size_limit(text: str) -> int:
    value = text.strip().lower()
    if not value:
        raise ValueError("Size limit cannot be empty")
    units = [("mb", 1024 * 1024), ("kb", 1024), ("b", 1)]
    for unit, multiplier in units:
        if value.endswith(unit):
            number = value[: -len(unit)].strip()
            parsed = int(float(number) * multiplier)
            if parsed <= 0:
                raise ValueError("Size limit must be greater than zero")
            return parsed
    parsed = int(float(value))
    if parsed <= 0:
        raise ValueError("Size limit must be greater than zero")
    return parsed


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
    elif fmt == "GIF":
        params = {"optimize": True}
        if image.mode != "P":
            method = Image.Quantize.FASTOCTREE if image.mode == "RGBA" else Image.Quantize.MEDIANCUT
            image = image.quantize(method=method)
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
    return similarity * (SCALE_WEIGHT_BASE + (SCALE_WEIGHT_RANGE * scale))


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
    total_score = (visual * VISUAL_WEIGHT) + (utilization * SIZE_UTILIZATION_WEIGHT)
    return Candidate(payload, fmt, quality, scale, size, visual, total_score)


def find_best_for_format(original: Image.Image, limit_bytes: int, fmt: str) -> Candidate | None:
    best: Candidate | None = None
    for scale in SCALE_FACTORS:
        width = max(1, int(original.width * scale))
        height = max(1, int(original.height * scale))
        resized = original.resize((width, height), Image.Resampling.LANCZOS)

        if fmt in ("PNG", "GIF"):
            candidate = evaluate_candidate(original, resized, fmt, None, limit_bytes)
            if candidate and is_better(candidate, best):
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

        if best_quality_candidate and is_better(best_quality_candidate, best):
            best = best_quality_candidate
    return best


def load_gif_frames(image: Image.Image) -> tuple[list[Image.Image], list[int], int]:
    frames = []
    durations = []
    for idx in range(image.n_frames):
        image.seek(idx)
        frames.append(image.convert("RGBA"))
        durations.append(image.info.get("duration", 100))
    loop = image.info.get("loop", 0)
    return frames, durations, loop


def encode_gif(frames: list[Image.Image], durations: list[int], loop: int, colors: int) -> bytes:
    buffer = io.BytesIO()
    quantized = [f.quantize(colors=colors, method=Image.Quantize.FASTOCTREE) for f in frames]
    quantized[0].save(
        buffer,
        format="GIF",
        save_all=True,
        append_images=quantized[1:],
        duration=durations,
        loop=loop,
        optimize=True,
        disposal=2,
    )
    return buffer.getvalue()


def gif_visual_score(original_frames: list[Image.Image], payload: bytes, scale: float) -> float:
    decoded = Image.open(io.BytesIO(payload))
    frame_count = len(original_frames)
    sample_count = min(5, frame_count)
    sample_indices = {round(i * (frame_count - 1) / max(1, sample_count - 1)) for i in range(sample_count)}
    scores = []
    for idx in sample_indices:
        decoded.seek(idx)
        decoded_frame = decoded.convert("RGB")
        original_frame = original_frames[idx].convert("RGB")
        scores.append(rms_score(original_frame, decoded_frame, scale))
    return sum(scores) / len(scores)


def find_best_gif(original: Image.Image, limit_bytes: int) -> Candidate | None:
    frames, durations, loop = load_gif_frames(original)
    best: Candidate | None = None
    for scale in SCALE_FACTORS:
        width = max(1, int(frames[0].width * scale))
        height = max(1, int(frames[0].height * scale))
        resized_frames = [f.resize((width, height), Image.Resampling.LANCZOS) for f in frames]

        lo, hi = 2, 256
        best_colors_candidate: Candidate | None = None
        while lo <= hi:
            mid = (lo + hi) // 2
            payload = encode_gif(resized_frames, durations, loop, mid)
            size = len(payload)
            if size <= limit_bytes:
                visual = gif_visual_score(frames, payload, scale)
                utilization = size / limit_bytes
                total_score = (visual * VISUAL_WEIGHT) + (utilization * SIZE_UTILIZATION_WEIGHT)
                best_colors_candidate = Candidate(payload, "GIF", mid, scale, size, visual, total_score)
                lo = mid + 1
            else:
                hi = mid - 1

        if best_colors_candidate and is_better(best_colors_candidate, best):
            best = best_colors_candidate
    return best


GIF_COLOR_STEPS = [256, 220, 180, 140, 110, 90, 70, 55, 45, 35, 28, 22, 17, 13, 10, 8, 6, 4, 2]
GIF_FRAME_STEPS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20]


@dataclass
class GifConfig:
    scale: float
    colors: int
    frame_step: int


def build_gif_ladder(priority: str) -> list[GifConfig]:
    """Order configs from best (index 0) to worst, degrading `priority` first."""
    axis_steps = {"resolution": SCALE_FACTORS, "colors": GIF_COLOR_STEPS, "frames": GIF_FRAME_STEPS}
    secondary_order = {
        "frames": ["frames", "colors", "resolution"],
        "colors": ["colors", "frames", "resolution"],
        "resolution": ["resolution", "colors", "frames"],
    }[priority]

    current = {"resolution": SCALE_FACTORS[0], "colors": GIF_COLOR_STEPS[0], "frames": GIF_FRAME_STEPS[0]}
    ladder = [GifConfig(scale=current["resolution"], colors=current["colors"], frame_step=current["frames"])]
    for axis in secondary_order:
        for value in axis_steps[axis][1:]:
            current[axis] = value
            ladder.append(GifConfig(scale=current["resolution"], colors=current["colors"], frame_step=current["frames"]))
    return ladder


def apply_frame_step(
    frames: list[Image.Image], durations: list[int], step: int
) -> tuple[list[Image.Image], list[int]]:
    if step <= 1:
        return frames, durations
    kept_frames = []
    kept_durations = []
    for i in range(0, len(frames), step):
        kept_frames.append(frames[i])
        kept_durations.append(sum(durations[i : i + step]))
    return kept_frames, kept_durations


def encode_gif_config(
    frames: list[Image.Image], durations: list[int], loop: int, config: GifConfig
) -> bytes:
    stepped_frames, stepped_durations = apply_frame_step(frames, durations, config.frame_step)
    if config.scale != 1.0:
        width = max(1, int(stepped_frames[0].width * config.scale))
        height = max(1, int(stepped_frames[0].height * config.scale))
        stepped_frames = [f.resize((width, height), Image.Resampling.LANCZOS) for f in stepped_frames]
    return encode_gif(stepped_frames, stepped_durations, loop, config.colors)


class GifTuner:
    """Caches ladder encodes for interactive fine-tuning of a single animated GIF."""

    def __init__(self, image_path: Path):
        self.image_path = image_path
        original = Image.open(image_path)
        self.frames, self.durations, self.loop = load_gif_frames(original)
        self.original_size = self.frames[0].size
        self.frame_count = len(self.frames)
        self._ladders: dict[str, list[GifConfig]] = {}
        self._cache: dict[tuple[str, int], bytes] = {}

    def ladder(self, priority: str) -> list[GifConfig]:
        if priority not in self._ladders:
            self._ladders[priority] = build_gif_ladder(priority)
        return self._ladders[priority]

    def encode(self, priority: str, index: int) -> bytes:
        key = (priority, index)
        if key not in self._cache:
            config = self.ladder(priority)[index]
            self._cache[key] = encode_gif_config(self.frames, self.durations, self.loop, config)
        return self._cache[key]

    def max_feasible_index(self, priority: str, limit_bytes: int) -> int:
        ladder = self.ladder(priority)
        for index in range(len(ladder)):
            if len(self.encode(priority, index)) <= limit_bytes:
                return index
        return len(ladder) - 1


def optimize_animated_gif(image_path: Path, limit_bytes: int, output_dir: Path, original: Image.Image) -> Candidate:
    best = find_best_gif(original, limit_bytes)
    if not best:
        raise RuntimeError(f"Could not create output under limit for {image_path.name}")

    output_path = output_dir / f"{image_path.stem}_optimized.gif"
    output_path.write_bytes(best.image_bytes)
    print(
        f"[done] {image_path.name} -> {output_path.name} | "
        f"{best.size_bytes / 1024:.1f}KB | fmt=GIF colors={best.quality} scale={best.scale:.2f}"
    )
    return best


def optimize_image(image_path: Path, limit_bytes: int, output_dir: Path, format_override: str | None = None) -> Candidate:
    original = Image.open(image_path)
    if getattr(original, "is_animated", False):
        return optimize_animated_gif(image_path, limit_bytes, output_dir, original)
    if format_override:
        formats = [format_override.upper()]
    else:
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


def interactive_inputs() -> tuple[list[str], str, str, str | None]:
    raw_paths = input("Enter file/folder paths (comma separated): ").strip()
    limit = input("Enter max size per image (e.g. 400kb, 1.5mb): ").strip()
    output = input("Output folder [./reduced]: ").strip() or "./reduced"
    fmt = input("Output format [auto] (jpeg/png/webp/gif): ").strip().lower() or None
    if fmt and fmt not in ("jpeg", "jpg", "png", "webp", "gif"):
        print(f"Invalid format '{fmt}'. Using auto-selection.")
        fmt = None
    if fmt == "jpg":
        fmt = "jpeg"
    paths = [value.strip().strip("'\"" ) for value in raw_paths.split(",") if value.strip()]
    return paths, limit, output, fmt


def main() -> None:
    print_banner()
    
    parser = argparse.ArgumentParser(description="Automated local image reducer that maximizes quality under a size limit.")
    parser.add_argument("paths", nargs="*", help="Image files and/or folders")
    parser.add_argument("--limit", help="Max output size per image (e.g. 500kb, 1.5mb)")
    parser.add_argument("--output", default="./reduced", help="Output directory")
    parser.add_argument("--format", help="Output format (jpeg, png, webp, gif). If not specified, auto-selects best format. Animated GIFs are always kept as optimized GIFs.")
    args = parser.parse_args()

    paths = args.paths
    limit = args.limit
    output_dir = args.output
    fmt = args.format
    if not paths or not limit:
        print("Starting interactive mode...")
        paths, limit, output_dir, fmt = interactive_inputs()

    limit_bytes = parse_size_limit(limit)

    image_files = iter_images(paths)
    if not image_files:
        raise FileNotFoundError("No supported images found in provided paths")

    output_path = Path(output_dir).expanduser().resolve()
    output_path.mkdir(parents=True, exist_ok=True)

    if fmt:
        print(f"Processing {len(image_files)} image(s) with limit {limit_bytes} bytes (format: {fmt.upper()})")
    else:
        print(f"Processing {len(image_files)} image(s) with limit {limit_bytes} bytes")
    for image in image_files:
        optimize_image(image, limit_bytes, output_path, fmt)
    print("All images processed.")


if __name__ == "__main__":
    main()
