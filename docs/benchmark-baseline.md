# Benchmark baseline (Phase 0)

Run: `python scripts/benchmark.py --make-corpus --corpus /tmp/corpus && python scripts/benchmark.py --corpus /tmp/corpus --ratios 0.3`

Each tool produced its best output under a limit of 30% of the source file's
size (highest quality that fits, found by bisection; KVGrainy runs its own
search). Outputs are scored with SSIMULACRA2 against the upright sRGB original
(higher is better; ~90 is visually lossless, negative is badly broken).
Tools: KVGrainy (current Python engine), Pillow JPEG/WebP at scale 1.0,
`cwebp`, `avifenc` (libavif 1.0.4, speed 6), `pngquant`. `mozjpeg` and
`oxipng` were not available in the test environment and are not yet included.

| image | limit | tool | size | SSIMULACRA2 | time |
|---|---|---|---|---|---|
| cmyk.jpg | 93.0 KB | kvgrainy | 90.7 KB | 69.9 | 11.3s |
| cmyk.jpg | 93.0 KB | pillow-jpeg-q | 90.9 KB | 71.5 | 0.0s |
| cmyk.jpg | 93.0 KB | pillow-webp-q | 88.0 KB | 71.0 | 0.3s |
| cmyk.jpg | 93.0 KB | cwebp | 79.8 KB | 70.9 | 1.0s |
| cmyk.jpg | 93.0 KB | avifenc | 89.5 KB | 78.0 | 1.7s |
| cmyk.jpg | 93.0 KB | pngquant | 91.0 KB | 45.5 | 2.2s |
| photo_like.jpg | 104.4 KB | kvgrainy | 104.4 KB | 72.3 | 21.0s |
| photo_like.jpg | 104.4 KB | pillow-jpeg-q | 102.2 KB | 69.9 | 0.0s |
| photo_like.jpg | 104.4 KB | pillow-webp-q | 90.2 KB | 68.9 | 0.7s |
| photo_like.jpg | 104.4 KB | cwebp | 101.2 KB | 70.4 | 2.3s |
| photo_like.jpg | 104.4 KB | avifenc | 93.3 KB | 69.0 | 3.4s |
| photo_like.jpg | 104.4 KB | pngquant | 102.0 KB | -12.2 | 8.2s |
| rotated_phone.jpg | 46.7 KB | kvgrainy | 45.9 KB | 76.2 | 10.9s |
| rotated_phone.jpg | 46.7 KB | pillow-jpeg-q | 46.4 KB | 73.6 | 0.0s |
| rotated_phone.jpg | 46.7 KB | pillow-webp-q | 38.8 KB | 74.8 | 0.4s |
| rotated_phone.jpg | 46.7 KB | cwebp | 45.9 KB | 76.2 | 1.1s |
| rotated_phone.jpg | 46.7 KB | avifenc | 43.2 KB | 78.1 | 1.8s |
| rotated_phone.jpg | 46.7 KB | pngquant | no fit | - | 1.6s |
| screenshot_like.png | 1.4 KB | kvgrainy | 1.4 KB | 48.9 | 4.7s |
| screenshot_like.png | 1.4 KB | pillow-jpeg-q | no fit | - | 0.0s |
| screenshot_like.png | 1.4 KB | pillow-webp-q | no fit | - | 0.3s |
| screenshot_like.png | 1.4 KB | cwebp | no fit | - | 0.5s |
| screenshot_like.png | 1.4 KB | avifenc | 1.0 KB | 98.3 | 8.5s |
| screenshot_like.png | 1.4 KB | pngquant | 1.0 KB | 100.0 | 0.5s |
| transparent.png | 81.7 KB | kvgrainy | 72.0 KB | 84.6 | 48.6s |
| transparent.png | 81.7 KB | pillow-jpeg-q | 72.5 KB | 84.5 | 0.0s |
| transparent.png | 81.7 KB | pillow-webp-q | 74.0 KB | 84.6 | 0.3s |
| transparent.png | 81.7 KB | cwebp | 72.0 KB | 84.6 | 1.8s |
| transparent.png | 81.7 KB | avifenc | 75.0 KB | 90.1 | 1.4s |
| transparent.png | 81.7 KB | pngquant | 65.2 KB | -64.6 | 1.4s |

## What this does and doesn't show

**Caveats (read before quoting any of this):**
- The corpus is **synthetic** (noise and gradients, flat-color "screenshot"). Noise-heavy images are unrepresentative of real photos. Rerun on real photos and screenshots before drawing conclusions or publishing numbers.
- The competing tools only ever **keep full resolution** and tune quality, while KVGrainy also searches scale. Where quality-only tools win, that is because downscaling is costing KVGrainy more than it gains under SSIMULACRA2.
- One run, one limit ratio, one machine. Timings are indicative only.
- `pngquant` scoring negative on the noisy images is plausible (256 colors on noise) but unverified.

**Indicative findings:**
1. KVGrainy roughly ties plain `cwebp` and Pillow on these images; it does not clearly beat a single well-tuned encoder.
2. AVIF wins clearly on CMYK (78.0 vs 69.9) and transparent (90.1 vs 84.6) at similar size. KVGrainy has no AVIF.
3. On the flat-color screenshot, `pngquant` and AVIF fit under the limit at 98–100 while KVGrainy's best is 48.9 (it picked a lossy format and downscaled; palette PNG would have been near-lossless).
4. KVGrainy takes 5–50 s per image, versus 0.5–8 s for a single external encoder. The brute-force search is the slow part, which supports the Phase 1 effort cap and the move to native, parallel code.
5. KVGrainy's RMS score disagrees with SSIMULACRA2 about what looks best, which supports Phase 2.1.

These point in the direction of the plan (better encoders, perceptual metric, faster
native search), but the gate in Phase 0.4 should be judged on a real corpus.


## Rust engine (Phase 1), same corpus, 30% limit

`kvgrainy-rs` is the Rust engine with SSIMULACRA2 scoring, AVIF, and the effort cap
(4-core machine, same synthetic corpus and caveats as above; the Python column is the table above).

| image | Python | Rust, exhaustive scale search | Rust, with effort cap |
|---|---|---|---|
| cmyk | 69.9 (14s) | 82.5 (103s) | 82.5 (38s) |
| photo-like | 72.3 (26s) | 73.8 (198s) | 73.8 (77s) |
| rotated phone | 76.2 (13s) | 78.8 (104s) | 78.8 (21s) |
| screenshot-like | 48.9 (6s) | 62.1 (52s) | 55.5 (25s) |
| transparent | 84.6 (60s) | 90.6 (37s) | 90.6 (12s) |

- The Rust engine beats the Python engine on quality on every image, and beats `avifenc` on four of five (not the flat-color screenshot, where `avifenc` and `pngquant` score 98-100 because it has no palette PNG).
- The effort cap costs nothing on four images and 6.6 points on the screenshot (the score is bumpy across scales on flat tiny images, so stopping early misses a better scale).
- Two early-exit rules were tried and **rejected** because they cost real quality: accepting a full-scale fit at quality >= 60, and jumping to a predicted scale. Output size is not proportional to pixel count and not monotone in quality for small AVIFs.
- rav1e output depends on its thread count, so AVIF encodes are pinned to one thread to keep results independent of the machine.

**Where the time goes** (1200x800 photo): scoring one candidate with SSIMULACRA2 costs about 0.8 s, roughly 10x a JPEG or WebP encode; AVIF encodes cost 0.5-2.7 s. Time is therefore roughly (candidates scored) x 0.8 s plus AVIF encodes, so Phase 1.5's target (a 20 MP photo in a few seconds) is **not met**. Next: coarse-to-fine scale search to score fewer candidates, and a cheaper scoring path for large images.
