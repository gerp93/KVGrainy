# Metric study: can a cheaper or size-capped score pick the same candidate?

PLAN.md Phase 1.4. Date: 2026-10-15. Follow-up to [engine-spike.md](engine-spike.md), whose open
question this answers.

**Question:** full-resolution SSIMULACRA2 needs about 2 GB of WASM memory for a 12 MP photo, so the
web build must score a size-capped copy. Does scoring a capped copy, or a cheap proxy metric, still
pick (nearly) the same candidate as full-resolution SSIMULACRA2?

**Short answer:** yes for photos. SSIMULACRA2 on a 1 MP copy picks the same candidate as the
full-size score 87% of the time and is within 2 points of the best 99% of the time. Plain luma SSIM
on a 1 MP copy is within 2 points 96% of the time at about 1/23 of the cost. The plan's gate (at
least 90% within about 2 points) passes for both. The blended proxy the web engine uses today
(`web/src/engine/metric.ts`) does not pass at 1 MP (87%). Evidence is photos only; see
[Limits](#limits) before generalising.

## Method

For each image: encode a grid of 108 JPEG candidates (12 scales x 9 qualities) with the pure-Rust
encoder, score every candidate with every metric, then for 6 size limits (50% down to 2.5% of the
full-size file) pick the best candidate that fits under the limit according to each metric.

**Regret** = true best score minus the true score of the pick, in SSIMULACRA2 points (score x 100).
"True" is SSIMULACRA2 on the full-resolution image (sources over 10 MP are first reduced to
10 MP). A metric that picks the true best has regret 0.

Corpus: 61 phone photos from one device: 58 at 3.1 MP (2048x1536, 6 of them portrait), one at
3.4 MP (1600x2134), and two 12 MP originals that the harness reduced to 10 MP (2738x3651).
366 (image, limit) cases, 300 of them with a true best above 20 points. Tool:
`cargo run --release -p kvgrainy-wasm-spike --example metric_study -- <dir>...`.

## Results (61 photos, JPEG)

| metric | mean regret | median | p90 | max | within 2 pts | within 1 pt | exact | native ms/score |
|---|---|---|---|---|---|---|---|---|
| SSIMULACRA2, 4 MP copy | 0.01 | 0.00 | 0.00 | 1.20 | 100% | 100% | 99% | 904 |
| SSIMULACRA2, 1 MP copy | 0.08 | 0.00 | 0.10 | 2.51 | 99% | 97% | 87% | 279 |
| SSIMULACRA2, 0.25 MP copy | 1.36 | 0.00 | 3.83 | 24.75 | 78% | 64% | 54% | 71 |
| Luma SSIM, 1 MP copy | 0.28 | 0.00 | 1.24 | 3.41 | 96% | 87% | 76% | 12 |
| Luma SSIM, 4 MP copy | 0.70 | 0.00 | 2.16 | 10.55 | 88% | 73% | 61% | 31 |
| Luma SSIM, 0.25 MP copy | 0.97 | 0.00 | 2.64 | 24.75 | 84% | 68% | 58% | 4 |
| Blended proxy (web engine), 4 MP | 0.58 | 0.00 | 1.94 | 12.85 | 90% | 84% | 73% | 38 |
| Blended proxy (web engine), 1 MP | 0.73 | 0.00 | 2.86 | 13.32 | 87% | 81% | 70% | 14 |
| Blended proxy (web engine), 0.25 MP | 2.02 | 0.86 | 6.20 | 24.75 | 69% | 52% | 42% | 4 |
| RMSE, full | 1.31 | 0.59 | 3.81 | 10.48 | 75% | 56% | 46% | 15 |
| RMSE, 1 MP copy | 0.75 | 0.00 | 2.82 | 10.48 | 84% | 76% | 66% | 6 |

Mean regret by limit (as a fraction of the largest candidate) stays small for SSIMULACRA2 at 1 MP
(0.03 to 0.11 points at every limit) and for luma SSIM at 1 MP (0.02 to 0.56).

## Browser cost (WASM, Node 24 / V8)

Measured on one 12.2 MP photo and one 3.1 MP photo, JPEG quality 60, single run each. Peak is the
WASM linear-memory high-water mark for the whole process, including decode and the reference.

| metric | score time, 12.2 MP photo | score time, 3.1 MP photo |
|---|---|---|
| SSIMULACRA2, 1 MP copy | 615 ms | 552 ms |
| SSIMULACRA2, 0.5 MP copy | 287 ms | 231 ms |
| Luma SSIM, 1 MP copy | 88 ms | 33 ms |
| Blended proxy, 1 MP copy | 90 ms | 35 ms |

| | 12.2 MP photo | 3.1 MP photo |
|---|---|---|
| Peak WASM memory, scoring a 1 MP copy | 241 MB | 187 MB |
| Peak WASM memory, full-resolution scoring (engine-spike.md, synthetic 12 MP) | about 2,010 MB | n/a |

Capping brings a 12 MP photo from about 2 GB to about 240 MB, which fits a phone browser tab.

## What this means

1. **The shared-core route is sound on memory and accuracy for photos.** Score a copy capped at
   1 MP: the search picks the same candidate (within 2 points) 96 to 99% of the time.
2. **Search with luma SSIM at 1 MP, verify the final pick with SSIMULACRA2 at 1 MP.** That is the
   PLAN.md Phase 2.1 design. In the browser it cuts a score from about 600 ms to about 90 ms for the
   search steps; natively, 12 ms against 279 ms.
3. **Do not search with SSIMULACRA2 below 1 MP.** At 0.25 MP it falls to 78% within 2 points with
   a worst case of 24.75 points of regret.
4. **The web engine's blended proxy is worse than plain luma SSIM at 1 MP** on photos (87% against
   96% within 2 points). Replace it, or keep it only if graphics tests show it helps (see Limits).

## Limits

- **Photos from one device.** 61 phone photos, 58 of them 3.1 MP. Only two are large, and the
  harness reduces anything above 10 MP, so the study never scored a full 12 MP image. The 12 MP
  figures above are WASM timing and memory only, not ranking accuracy.
- **Graphics were not tested on real images.** A first run on the 5-image synthetic corpus
  (photo-like, screenshot-like, transparent, CMYK, rotated) went the other way: the blended proxy
  was within 2 points in 96 to 100% of cases and luma SSIM in 79% (28 cases; too few to rely on).
  Screenshots and flat-colour images may need the chroma and block terms. Re-run on a real
  screenshot corpus before dropping them (Phase 2.5).
- **JPEG only.** WebP and AVIF candidates were not scored; their artefacts differ.
- **"Truth" is SSIMULACRA2 itself.** This shows the cheaper scores agree with it, not that either
  agrees with human judgement.
- **Native timings are from a 24-thread machine with the study using 8 threads; WASM timings are
  Node/V8,** not Safari or a phone. Single runs.

## Reproduce

```bash
# once: NASM 2.16 and Perl on PATH (see engine-spike.md)
cargo run --release -p kvgrainy-wasm-spike --example metric_study -- path/to/photos --csv-prefix target/study/run

# WASM time and memory
cargo build -p kvgrainy-wasm-spike --target wasm32-unknown-unknown --release
wasm-bindgen target/wasm32-unknown-unknown/release/kvgrainy_wasm_spike.wasm \
  --target nodejs --out-dir target/wasm-spike-pkg
node crates/kvgrainy-wasm-spike/capped.mjs path/to/photo.jpg 60
```

The per-image CSVs (`*-records.csv`, `*-candidates.csv`) are written under `target/` and not
committed.

## Applied in the engine (Phase 2.1)

`kvgrainy-core` now scores on a copy capped at 1 MP (`score::SCORE_CAP_PIXELS`). The search ranks the
candidates of one format with the luma-SSIM proxy and verifies each format's best with
SSIMULACRA2 at the cap, so the expensive score runs once per format instead of once per candidate.
Quality probes run three at a time when the `parallel` feature is on (a fixed set per round, so
output does not depend on core count) and one at a time otherwise. A lossless candidate is skipped
when it cannot fit at the current scale. `Effort::Quick` (CLI `--quick`) leaves AVIF out.

Measured on 10 of the photos (2 at 12 MP, 8 at 3 MP), limit 100 KB, same machine, whole run:

| engine | wall time | mean SSIMULACRA2 vs old engine |
|---|---|---|
| before (full-resolution scoring, bisection) | 9 min 02 s | n/a |
| capped scoring + proxy ranking | 8 min 09 s | -0.05 points |
| + parallel quality probes, lossless skip | 5 min 40 s | -0.05 points |
| + `--quick` (no AVIF) | 36 s | about -4 points (AVIF wins by 4 to 5 on 3 MP photos) |

Outputs were scored with SSIMULACRA2 at a 4 MP cap, which the study shows matches full resolution.
Every photo's new score is within 0.8 points of the old engine's. The 12 MP photos still take the
longest: AVIF encoding, not scoring, is now the cost, so a faster AVIF setting or a smaller probe
for the search is the next lever.
