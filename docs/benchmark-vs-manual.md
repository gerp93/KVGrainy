# The search against a hand-tuned baseline

PLAN.md 2.5 asks for a table that shows we win or tie on size at equal quality against the best tools. The
competition (cjpeg, cwebp, avifenc, oxipng, pngquant, gifski, ffmpeg, Squoosh, TinyPNG) is not installed here and
two of those are online services, so this is **not that table**. It is the next most honest thing: the strongest
version of what a person does by hand.

## The baseline

For each format (JPEG, WebP, AVIF, lossless PNG), slide the encoder's quality until the file just fits under the
limit, **at the photo's own size**, and keep the best-looking format. That is what a quality slider gives you
(Squoosh and similar), with perfect patience: it tries every format and finds the exact best quality. A real
person is worse than this. It never resizes, so it can fail where the search succeeds by shrinking.

Both sides use the same native encoders (mozjpeg, libwebp, rav1e at speed 8, oxipng). Both are scored against the
original with SSIMULACRA2 at a 4 MP cap, which docs/metric-study.md shows agrees with full resolution 99% of the time.
Run it yourself: `cargo run --release -p kvgrainy-core --example baseline -- 100kb --quick photo.jpg ...`
(`baseline.rs`). The CSV it prints replaces file names with `img01`, `img02`, so results can be shared.

## Results

Ten phone photos from one phone: eight at 3 MP (2048 x 1536) and two at 12 MP (4032 x 3024). Scores are
SSIMULACRA2 points (higher is better; 1 point is a small but real difference). "Search minus baseline" is positive when
KVGrainy looks better.

### 3 MP photos (8 photos), Quick effort (no AVIF in either)

| Limit | Search minus baseline: mean | median | best | worst | wins / ties / losses (more than 0.5) |
|---|---|---|---|---|---|
| 50 KB | **+1.10** | +0.14 | +4.73 | -1.26 | 3 / 4 / 1 |
| 100 KB | +0.21 | +0.24 | +0.83 | -1.19 | 3 / 4 / 1 |
| 300 KB | -0.10 | 0.00 | +1.15 | -1.06 | 1 / 5 / 2 |
| 1 MB | -0.08 | 0.00 | 0.00 | -0.60 | 0 / 7 / 1 |

At a generous limit the photo just fits at full size and the two are identical; the search has nothing to add. At a
tight limit it can pick a smaller, cleaner picture over a full-size blocky one, which is where it gains.

### 3 MP photos, Best effort (AVIF in both), 100 KB, three photos

| | Baseline | Search | Difference |
|---|---|---|---|
| photo 1 | 75.01 | 75.09 | +0.08 |
| photo 2 | 77.34 | 77.61 | +0.27 |
| photo 3 | 79.41 | 79.11 | -0.30 |

A tie. AVIF wins for both (it beats Quick's WebP/JPEG by about 4 to 5 points here), and the search finds it as well as
the slider does.

### 12 MP photos (2 photos), Quick effort: where it matters

| Limit | Baseline (full size, lowest quality that fits) | Search | Difference |
|---|---|---|---|
| 100 KB | 38.07, 40.18 | 50.74, 51.61 | **+12.7, +11.4** |
| 300 KB | 61.54, 62.67 | 70.69, 71.06 | **+9.2, +8.4** |

A 12 MP photo forced under 100 KB at its own size has to be crushed to the encoder's lowest quality and looks terrible.
The search shrinks it to about 30 to 50% of each side and keeps the quality high, which scores 8 to 13 points higher. This
is the case people actually hit (a phone photo and a small upload limit) and where KVGrainy is clearly better.

## What this shows, and does not

- **Shows:** a clear win when the photo is large for the limit (+8 to +13 points on two photos), a modest win at tight
  limits on smaller photos (+1.1 average at 50 KB), and a tie otherwise. It does not lose by more than about 1.3 points on
  any single photo here.
- **The losses are real.** The worst case is -1.3 points. The search ranks candidates on a 1 MP copy and the table scores on
  a 4 MP copy, and the two occasionally disagree about which of two close candidates is better (the metric study measured
  the regret at under 2.6 points in all cases). A better tie-break, or scoring the final pick at 4 MP, would recover some of it.
- **Does not show:** anything against Squoosh itself or TinyPNG (no browser automation of either was run), screenshots and
  graphics (only photos), WebP and AVIF at quality settings other than the default speed, or more than one camera.
- **Ten photos, one run each, one machine.** Treat the means as indications, not statistics. The two 12 MP photos are two
  data points, large though the gap is.
- **Both sides use SSIMULACRA2**, and the search optimizes it, so it is not an independent judge of what looks good to a
  person. A blind comparison with people would be the real test.

## Before claiming "better than X"

Run this baseline on a larger and more varied set (20 or more images: photos from several cameras, screenshots, flat graphics
with and without transparency), add Squoosh's own output at matched sizes, and read the results before writing the sentence. The
2 MB limit is not in the table because at 2 MB most of these photos come out as lossless PNG, where there is nothing to compare.
