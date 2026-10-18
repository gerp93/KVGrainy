use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

#[cfg(feature = "parallel")]
use rayon::prelude::*;

use crate::encode::{Encoder, Format};
use crate::raster::Raster;
use crate::score::Reference;

pub const SCALE_FACTORS: [f32; 15] =
    [1.0, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3];

/// How much work the search may spend.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Effort {
    /// Try every suitable format, AVIF included. The smallest output; the slowest search.
    #[default]
    Best,
    /// Skip AVIF, the slowest codec. Usually a little larger than `Best`, several times faster.
    Quick,
}

pub struct Options {
    pub limit_bytes: u64,
    /// Force one output format instead of trying every suitable one.
    pub format: Option<Format>,
    /// Set from any thread to abort the search.
    pub cancel: Option<Arc<AtomicBool>>,
    pub effort: Effort,
}

impl Options {
    pub fn new(limit_bytes: u64) -> Self {
        Options { limit_bytes, format: None, cancel: None, effort: Effort::Best }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Progress {
    pub completed: usize,
    pub total: usize,
}

#[derive(Clone, Debug)]
pub struct Candidate {
    pub bytes: Vec<u8>,
    pub format: Format,
    pub quality: Option<u8>,
    pub scale: f32,
    /// SSIMULACRA2-based similarity to the original, `0.0..=1.0`, measured on a copy of the
    /// original capped at [`crate::score::SCORE_CAP_PIXELS`] pixels.
    pub score: f64,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("cancelled")]
    Cancelled,
    #[error("nothing fits under {limit} bytes; the smallest output tried was {smallest} bytes")]
    NothingFits { limit: u64, smallest: u64 },
}

/// The formats [`optimize_with`] would try for `source` under `options` with `encoder`.
pub fn candidate_formats(encoder: &dyn Encoder, source: &Raster, options: &Options) -> Vec<Format> {
    let mut formats = match options.format {
        // A forced PNG still lets the search choose between lossless and palette.
        Some(Format::Png | Format::PngPalette) => vec![Format::Png, Format::PngPalette],
        Some(f) => vec![f],
        None if source.alpha.is_some() => vec![Format::Webp, Format::Avif, Format::Png, Format::PngPalette],
        None => vec![Format::Jpeg, Format::Webp, Format::Avif, Format::Png, Format::PngPalette],
    };
    if options.effort == Effort::Quick && options.format.is_none() {
        formats.retain(|&f| f != Format::Avif);
    }
    formats.retain(|&f| encoder.supports(f));
    formats
}

/// What the search for one format produced.
pub struct FormatOutcome {
    /// The best candidate under the limit, if any scale fit.
    pub best: Option<Candidate>,
    /// Size in bytes of the smallest output tried, `u64::MAX` if none was.
    pub smallest: u64,
}

/// Search one format only. [`optimize_with`] runs this per format (on a thread pool when the
/// `parallel` feature is on); a host with its own parallelism, such as a browser running one
/// worker per format, calls it directly and combines the results with [`pick_best`].
///
/// `report` gets the number of scale steps just completed; a format's total is
/// [`SCALE_FACTORS`]`.len()`. `cancelled` is polled between encodes.
pub fn search_one_format(
    encoder: &dyn Encoder,
    source: &Raster,
    options: &Options,
    format: Format,
    cancelled: &dyn Fn() -> bool,
    report: &dyn Fn(usize),
) -> FormatOutcome {
    let reference = Reference::new(source);
    let result = search_format(encoder, &reference, source, options, format, STRIP_PROBE_MIN_PIXELS, cancelled, report);
    FormatOutcome { best: result.best, smallest: result.smallest }
}

/// The index of the best candidate: highest score, where scores within 0.1 SSIMULACRA2 points
/// are a tie, so noise can't pick a needlessly smaller image; ties go to the higher scale, then
/// the larger file (closer to the budget). A visually lossless tie goes to the smaller file.
pub fn pick_best(candidates: &[Candidate]) -> Option<usize> {
    pick_best_of(candidates.iter().map(|c| (c.score, c.scale, c.bytes.len())))
}

/// [`pick_best`] over `(score, scale, size in bytes)` triples, for callers that don't hold the bytes.
pub fn pick_best_of(items: impl Iterator<Item = (f64, f32, usize)>) -> Option<usize> {
    items
        .enumerate()
        .max_by_key(|&(_, (score, scale, bytes))| {
            let size = bytes as i64;
            ((score * 1000.0).round() as i64, (scale * 100.0).round() as i32, if score >= VISUALLY_LOSSLESS { -size } else { size })
        })
        .map(|(i, _)| i)
}

type TaskResult = FormatOutcome;

/// Search with the native codecs. Shorthand for [`optimize_with`] and [`NativeEncoder`].
#[cfg(feature = "native")]
pub fn optimize(source: &Raster, options: &Options, progress: &(dyn Fn(Progress) + Sync)) -> Result<Candidate, Error> {
    optimize_with(&crate::native::NativeEncoder, source, options, progress)
}

/// Search for the best candidate under `options.limit_bytes`, encoding and decoding with `encoder`.
pub fn optimize_with(
    encoder: &dyn Encoder,
    source: &Raster,
    options: &Options,
    progress: &(dyn Fn(Progress) + Sync),
) -> Result<Candidate, Error> {
    let formats = candidate_formats(encoder, source, options);
    let total = formats.len() * SCALE_FACTORS.len();
    let done = AtomicUsize::new(0);
    let report = |steps: usize| {
        let completed = done.fetch_add(steps, Ordering::Relaxed) + steps;
        progress(Progress { completed, total });
    };
    let cancelled = || options.cancel.as_ref().is_some_and(|c| c.load(Ordering::Relaxed));
    let reference = Reference::new(source);

    #[cfg(feature = "parallel")]
    let format_iter = formats.par_iter();
    #[cfg(not(feature = "parallel"))]
    let format_iter = formats.iter();
    let results: Vec<TaskResult> = format_iter
        .map(|&format| search_format(encoder, &reference, source, options, format, STRIP_PROBE_MIN_PIXELS, &cancelled, &report))
        .collect();

    if cancelled() {
        return Err(Error::Cancelled);
    }
    let smallest = results.iter().map(|r| r.smallest).min().unwrap_or(u64::MAX);
    let mut bests: Vec<Candidate> = results.into_iter().filter_map(|r| r.best).collect();
    match pick_best(&bests) {
        Some(index) => Ok(bests.swap_remove(index)),
        None => Err(Error::NothingFits { limit: options.limit_bytes, smallest }),
    }
}

/// The smallest output this search can make, for when [`optimize_with`] reports
/// [`Error::NothingFits`]: every candidate format at the smallest scale and lowest quality,
/// whichever is smallest. It is over the limit by definition, so show it as a best effort,
/// never as a success. `None` only if every encode fails.
pub fn best_effort_with(encoder: &dyn Encoder, source: &Raster, options: &Options) -> Option<Candidate> {
    let scale = SCALE_FACTORS[SCALE_FACTORS.len() - 1];
    let resized = source.scaled(scale);
    let mut smallest: Option<Candidate> = None;
    for format in candidate_formats(encoder, source, options) {
        let quality = format.has_quality().then_some(MIN_QUALITY);
        let Ok(bytes) = encoder.encode(format, &resized, quality.unwrap_or(100)) else { continue };
        if smallest.as_ref().is_none_or(|c| bytes.len() < c.bytes.len()) {
            smallest = Some(Candidate { bytes, format, quality, scale, score: 0.0 });
        }
    }
    let mut best = smallest?;
    best.score = Reference::new(source).score_with(encoder, &best.bytes, best.format);
    Some(best)
}

/// [`best_effort_with`] using the native codecs.
#[cfg(feature = "native")]
pub fn best_effort(source: &Raster, options: &Options) -> Option<Candidate> {
    best_effort_with(&crate::native::NativeEncoder, source, options)
}

/// Lossy quality at or above which a full-scale fit is accepted without trying smaller
/// scales. Only a maximum-quality fit qualifies: on noisy images a smaller scale at
/// higher quality can beat full scale at medium quality (measured), so anything lower
/// is left to the score-based patience below.
const GOOD_ENOUGH_QUALITY: u8 = 100;
/// Stop walking down the scale ladder after this many scales in a row fail to improve the score.
const PATIENCE: usize = 2;
const MIN_QUALITY: u8 = 20;
/// A score at or above this is indistinguishable from the original.
const VISUALLY_LOSSLESS: f64 = 0.999;
/// Quality values encoded together in each round of the quality search. Fixed per build so
/// results never depend on the machine; one when the search runs on a single thread.
#[cfg(feature = "parallel")]
const PROBES_PER_ROUND: usize = 3;
#[cfg(not(feature = "parallel"))]
const PROBES_PER_ROUND: usize = 1;
/// Unless PNG was forced, a PNG family is dropped when its smallest full-size encode exceeds the
/// limit by more than this factor.
const PNG_HOPELESS_RATIO: f64 = 1.5;
/// A scale is skipped when the smallest full-size encode, scaled by `scale^2` and this, still exceeds the limit.
const SKIP_SLACK: f64 = 0.5;
/// A source with more pixels than this learns the size of its full-size floor encode strip by strip
/// instead of encoding the whole image (see [`strip_encoded_len`]). At or below it, nothing changes.
const STRIP_PROBE_MIN_PIXELS: u64 = 3_000_000;
/// About how many pixels one strip holds. A codec's working memory grows with the image it is given, so
/// encoding strips keeps the peak near that of a 2 MP image however large the source is.
const STRIP_PIXELS: u64 = 2_000_000;
/// Strips are cut on multiples of this many rows (a JPEG MCU is 16 rows), and none is shorter.
const STRIP_ROW_ALIGN: u32 = 16;
/// How far over the limit a lossless, no-quality-knob format's strip total may be and still get a real
/// full-size encode. The total runs a little above the whole image's size (each strip carries its own
/// headers and loses some context), so a size just over the limit is given the benefit of the doubt.
const STRIP_FIT_MARGIN: f64 = 1.05;
/// The same for a format with a quality knob. `fit_at_scale` lets a floor encode miss the limit by 25% and
/// still searches (sizes are not strictly monotone in quality, small AVIFs especially); a strip total can
/// overshoot the whole by about 10% (measured: AVIF +8.5%, WebP +1.1%, JPEG +0.6%), so the strip probe
/// allows that much more, and is never quicker than the whole-image path to give up.
const STRIP_QUALITY_MARGIN: f64 = 1.25 * 1.10;

/// Horizontal strips `(first row, row count)` covering `height` rows of an image `width` wide, about
/// [`STRIP_PIXELS`] each, cut on [`STRIP_ROW_ALIGN`] rows. A remainder shorter than one alignment unit is
/// folded into the last strip, so no strip is tiny.
fn strip_bounds(width: u32, height: u32) -> Vec<(u32, u32)> {
    let pixels = width as u64 * height as u64;
    let wanted = pixels.div_ceil(STRIP_PIXELS).clamp(1, (height / STRIP_ROW_ALIGN).max(1) as u64) as u32;
    let rows = height.div_ceil(wanted).div_ceil(STRIP_ROW_ALIGN) * STRIP_ROW_ALIGN;
    let mut strips = Vec::new();
    let mut start = 0;
    while start < height {
        let end = (start + rows).min(height);
        if height - end < STRIP_ROW_ALIGN {
            strips.push((start, height - start));
            break;
        }
        strips.push((start, end - start));
        start = end;
    }
    strips
}

/// The size in bytes `source` would encode to as `format` at `quality`, found by encoding it in strips and
/// adding them up. The total tracks the whole image's size closely (within a few percent for JPEG, WebP,
/// AVIF and PNG), but no encode ever sees more than one strip, so a 24 MP photo costs the memory of a 2 MP
/// one. `None` if cancelled or any strip fails to encode; the caller then encodes the whole image as before.
fn strip_encoded_len(
    encoder: &dyn Encoder,
    source: &Raster,
    format: Format,
    quality: u8,
    cancelled: &dyn Fn() -> bool,
) -> Option<u64> {
    let mut total = 0u64;
    for (start, count) in strip_bounds(source.width, source.height) {
        if cancelled() {
            return None;
        }
        total += encoder.encode(format, &source.rows(start, count), quality).ok()?.len() as u64;
    }
    Some(total)
}

/// Walk the scale ladder for one format from large to small, stopping once more
/// shrinking can't help. Cheap relative to trying every scale: a fit at high
/// quality ends the search, a scale that cannot fit costs one encode, and each
/// smaller scale only searches quality upward from the previous scale's result.
fn search_format(
    encoder: &dyn Encoder,
    reference: &Reference,
    source: &Raster,
    options: &Options,
    format: Format,
    strip_min_pixels: u64,
    cancelled: &dyn Fn() -> bool,
    report: &dyn Fn(usize),
) -> TaskResult {
    let mut smallest = u64::MAX;
    let mut best: Option<Candidate> = None;
    let mut misses = 0;
    let mut min_quality = MIN_QUALITY;
    let mut index = 0;
    let mut floor_len_full: Option<u64> = None;

    while index < SCALE_FACTORS.len() && !cancelled() {
        let scale = SCALE_FACTORS[index];
        // Output size shrinks roughly with pixel count. Once the smallest full-size encode is
        // far too big for this scale's pixel count (with 2x slack), skip the encode: it can't fit.
        if let Some(full) = floor_len_full {
            if full as f64 * (scale as f64).powi(2) * SKIP_SLACK > options.limit_bytes as f64 {
                report(1);
                index += 1;
                continue;
            }
        }
        // A large image's full-size floor encode is the most memory-hungry thing the search does (hundreds
        // of MB per format in a browser) and, for any limit well below the image's natural size, it only
        // finds out that full size cannot fit. Measure that floor size in strips instead, and encode the
        // whole image only when it might actually fit, which is exactly what the search did before.
        let hopeless_at_full = index == 0
            && source.width as u64 * source.height as u64 > strip_min_pixels
            // Palette PNG keeps encoding whole: each strip builds its own palette, so the strip total runs about
            // 10% under the whole (measured) and the quantizer takes about twice as long in strips. It is a
            // native-only format, where memory is not the constraint.
            && format != Format::PngPalette
            && strip_encoded_len(encoder, source, format, if format.has_quality() { MIN_QUALITY } else { 100 }, cancelled)
                .is_some_and(|len| {
                    smallest = smallest.min(len);
                    let allowed = if format.has_quality() {
                        options.limit_bytes as f64 * STRIP_QUALITY_MARGIN
                    } else {
                        options.limit_bytes as f64 * STRIP_FIT_MARGIN
                    };
                    len as f64 > allowed
                });
        let attempt = if hopeless_at_full {
            None
        } else {
            let resized = source.scaled(scale);
            fit_at_scale(encoder, &resized, options.limit_bytes, format, min_quality, cancelled, &mut smallest).or_else(|| {
                // The warm start can be too optimistic; retry from the floor before giving up on this scale.
                (min_quality > MIN_QUALITY)
                    .then(|| fit_at_scale(encoder, &resized, options.limit_bytes, format, MIN_QUALITY, cancelled, &mut smallest))
                    .flatten()
            })
        };

        if index == 0 {
            floor_len_full = Some(smallest);
        }
        if index == 0 && matches!(format, Format::Png | Format::PngPalette) {
            // A PNG family whose smallest full-size output is several times the limit would
            // need a drastic downscale to fit, and then loses to a lossy format at a higher
            // scale (typical of photos). Skip it unless the caller asked for PNG.
            if options.format.is_none() && smallest as f64 > options.limit_bytes as f64 * PNG_HOPELESS_RATIO {
                report(SCALE_FACTORS.len());
                return TaskResult { best, smallest };
            }
        }
        let mut next = index + 1;
        match attempt {
            Some((bytes, quality)) if !cancelled() => {
                min_quality = quality;
                let score = reference.score_with(encoder, &bytes, format);
                let improved = best.as_ref().is_none_or(|b| score > b.score + 0.001);
                if improved {
                    best = Some(Candidate { bytes, format, quality: format.has_quality().then_some(quality), scale, score });
                    misses = 0;
                } else {
                    misses += 1;
                }
                let good_enough = index == 0 && (!format.has_quality() || quality >= GOOD_ENOUGH_QUALITY);
                if good_enough || misses >= PATIENCE {
                    next = SCALE_FACTORS.len();
                }
            }
            Some(_) => break,
            // Nothing fit even at the lowest quality: a hopeless scale costs a single encode,
            // and output size is not reliably proportional to pixel count, so just step down.
            None => {}
        }
        report(next - index);
        index = next;
    }
    // Account for scales never visited so progress reaches its total.
    report(SCALE_FACTORS.len().saturating_sub(index));
    TaskResult { best, smallest }
}

/// Highest quality in `min_quality..=100` whose output fits, as `(bytes, quality)`.
/// Formats without a quality knob are encoded once.
fn fit_at_scale(
    encoder: &dyn Encoder,
    resized: &Raster,
    limit: u64,
    format: Format,
    min_quality: u8,
    cancelled: &dyn Fn() -> bool,
    smallest: &mut u64,
) -> Option<(Vec<u8>, u8)> {
    let mut fit = None;
    let last_len = std::cell::Cell::new(0u64);
    let mut try_quality = |quality: u8| -> bool {
        if cancelled() {
            return false;
        }
        let Ok(bytes) = encoder.encode(format, resized, quality) else {
            return false;
        };
        last_len.set(bytes.len() as u64);
        *smallest = (*smallest).min(bytes.len() as u64);
        if bytes.len() as u64 > limit {
            return false;
        }
        fit = Some((bytes, quality));
        true
    };

    if !format.has_quality() {
        try_quality(100);
        return fit;
    }
    // Check the floor first so a hopeless scale costs one encode rather than a full search.
    // Encoded size is not strictly monotone in quality (small AVIFs especially), so a floor
    // that only just misses the limit still gets the full search.
    if !try_quality(min_quality) && last_len.get() > limit + limit / 4 {
        return None;
    }
    let (mut lo, mut hi) = (min_quality.saturating_add(1), 100u8);
    // The nearest known fit and miss, as (quality, bytes): they steer where to probe next.
    let mut known_fit = fit.as_ref().map(|(bytes, q)| (*q, bytes.len() as u64));
    let mut known_miss = if known_fit.is_none() { Some((min_quality, last_len.get())) } else { None };
    while lo <= hi && !cancelled() {
        let centre = guess_quality(limit, known_fit, known_miss, lo, hi);
        let probes = probe_qualities(centre, lo, hi, PROBES_PER_ROUND);
        let outcomes: Vec<(u8, Result<Vec<u8>, String>)> = encode_probes(encoder, resized, format, &probes);
        // Highest quality that fit, and the lowest one above it that did not.
        let mut best_fit: Option<(u8, Vec<u8>)> = None;
        let mut lowest_miss: Option<(u8, u64)> = None;
        for (quality, outcome) in outcomes {
            let Ok(bytes) = outcome else { continue };
            *smallest = (*smallest).min(bytes.len() as u64);
            if bytes.len() as u64 <= limit {
                if best_fit.as_ref().is_none_or(|(q, _)| quality > *q) {
                    best_fit = Some((quality, bytes));
                }
            } else if lowest_miss.is_none_or(|(q, _)| quality < q) {
                lowest_miss = Some((quality, bytes.len() as u64));
            }
        }
        match best_fit {
            Some((quality, bytes)) => {
                lo = quality.saturating_add(1);
                known_fit = Some((quality, bytes.len() as u64));
                fit = Some((bytes, quality));
                if let Some((miss, len)) = lowest_miss.filter(|&(m, _)| m > quality) {
                    hi = miss - 1;
                    known_miss = Some((miss, len));
                }
            }
            None => {
                hi = lowest_miss.map_or(lo.saturating_sub(1), |(m, _)| m - 1);
                known_miss = lowest_miss;
            }
        }
        if lo == 0 || hi == 0 {
            break;
        }
    }
    fit
}

/// Natural-log growth of encoded size per quality point, a typical value used only to aim the
/// first probes; the search itself relies on the fit/miss bracket, never on this.
const LOG_SIZE_PER_QUALITY: f64 = 0.045;

/// The quality most likely to land just under `limit`, interpolating between a known fit and a
/// known miss, or extrapolating from one of them, in log-size.
pub(crate) fn guess_quality(limit: u64, fit: Option<(u8, u64)>, miss: Option<(u8, u64)>, lo: u8, hi: u8) -> u8 {
    let ln = |bytes: u64| (bytes.max(1) as f64).ln();
    let target = ln(limit);
    let guess = match (fit, miss) {
        (Some((qf, lf)), Some((qm, lm))) if qm > qf && lm > lf => {
            qf as f64 + (target - ln(lf)) * (qm - qf) as f64 / (ln(lm) - ln(lf))
        }
        (Some((qf, lf)), _) => qf as f64 + (target - ln(lf)) / LOG_SIZE_PER_QUALITY,
        (None, Some((qm, lm))) => qm as f64 - (ln(lm) - target) / LOG_SIZE_PER_QUALITY,
        (None, None) => (lo as f64 + hi as f64) / 2.0,
    };
    guess.round().clamp(lo as f64, hi as f64) as u8
}

/// Up to `count` distinct qualities inside `lo..=hi`, centred on `centre` and spaced two apart.
fn probe_qualities(centre: u8, lo: u8, hi: u8, count: usize) -> Vec<u8> {
    let half = count as i32 / 2;
    let mut probes: Vec<u8> = (0..count as i32)
        .map(|i| (centre as i32 + (i - half) * 2).clamp(lo as i32, hi as i32) as u8)
        .collect();
    probes.sort_unstable();
    probes.dedup();
    probes
}

fn encode_probes(
    encoder: &dyn Encoder,
    resized: &Raster,
    format: Format,
    probes: &[u8],
) -> Vec<(u8, Result<Vec<u8>, String>)> {
    #[cfg(feature = "parallel")]
    let iter = probes.par_iter();
    #[cfg(not(feature = "parallel"))]
    let iter = probes.iter();
    iter.map(|&q| (q, encoder.encode(format, resized, q))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    /// An encoder whose output size is exactly proportional to the pixels it is given (one byte per
    /// pixel at quality 100), so a test can tell what the search encoded and how large.
    #[derive(Default)]
    struct Linear {
        largest_encode_pixels: AtomicU64,
    }

    impl Encoder for Linear {
        fn encode(&self, _format: Format, raster: &Raster, quality: u8) -> Result<Vec<u8>, String> {
            let pixels = raster.width as u64 * raster.height as u64;
            self.largest_encode_pixels.fetch_max(pixels, Ordering::Relaxed);
            Ok(vec![0; (pixels * quality as u64 / 100 + 100) as usize])
        }
        fn decode(&self, _format: Format, _payload: &[u8]) -> Option<Raster> {
            Some(Raster { width: 8, height: 8, rgb: vec![128; 8 * 8 * 3], alpha: None })
        }
    }

    fn picture(width: u32, height: u32) -> Raster {
        Raster { width, height, rgb: vec![100; (width * height * 3) as usize], alpha: None }
    }

    fn search(encoder: &Linear, source: &Raster, limit: u64, format: Format, strip_min_pixels: u64) -> TaskResult {
        let options = Options { format: Some(format), ..Options::new(limit) };
        let reference = Reference::new(source);
        search_format(encoder, &reference, source, &options, format, strip_min_pixels, &|| false, &|_| {})
    }

    /// What a search chose, as something comparable: size, scale and quality of the winner.
    fn chosen(result: &TaskResult) -> Option<(usize, u32, Option<u8>)> {
        result.best.as_ref().map(|c| (c.bytes.len(), (c.scale * 100.0) as u32, c.quality))
    }

    #[test]
    fn strips_cover_every_row_once_and_none_is_tiny() {
        for (width, height) in [(4000, 3000), (6000, 4000), (2400, 1800), (100_000, 40), (7, 900_000), (3000, 1001), (5000, 5000)] {
            let strips = strip_bounds(width, height);
            let mut next = 0;
            for &(start, count) in &strips {
                assert_eq!(start, next, "{width}x{height}: strips must be contiguous");
                assert!(count >= STRIP_ROW_ALIGN.min(height), "{width}x{height}: a strip of {count} rows is tiny");
                next = start + count;
            }
            assert_eq!(next, height, "{width}x{height}: strips must cover the whole height");
        }
        // 12 MP is cut into several strips of about 2 MP, not one.
        assert!(strip_bounds(4000, 3000).len() >= 5);
        // A small image is one strip.
        assert_eq!(strip_bounds(640, 480), vec![(0, 480)]);
    }

    #[test]
    fn a_strip_carries_its_rows_and_alpha() {
        let mut image = picture(4, 6);
        image.alpha = Some((0..24).collect());
        image.rgb = (0..72).collect();
        let strip = image.rows(2, 3);
        assert_eq!((strip.width, strip.height), (4, 3));
        assert_eq!(strip.rgb, (24..60).collect::<Vec<u8>>());
        assert_eq!(strip.alpha, Some((8..20).collect()));
    }

    #[test]
    fn a_hopeless_full_size_is_found_without_encoding_the_whole_image() {
        let source = picture(2400, 1800); // 4.3 MP: over the strip threshold
        let encoder = Linear::default();
        // The full-size floor encode is ~864 KB; the limit is 100 KB, so full size can never fit.
        let result = search(&encoder, &source, 100_000, Format::Jpeg, STRIP_PROBE_MIN_PIXELS);
        let best = result.best.expect("a smaller scale fits");
        assert!(best.scale <= 0.45, "chose scale {}", best.scale);
        let largest = encoder.largest_encode_pixels.load(Ordering::Relaxed);
        assert!(largest < 2_160_000, "encoded {largest} pixels at once; the whole image is 4,320,000");
    }

    #[test]
    fn striping_changes_nothing_the_search_chooses() {
        let source = picture(2400, 1800);
        // One format with a quality knob and one without.
        for format in [Format::Jpeg, Format::Png] {
            // From too small to fit anywhere, through the scale ladder (and the borderline where the floor
            // encode just misses), to generous enough for full size.
            for limit in [20_000u64, 100_000, 350_000, 900_000, 4_500_000] {
                let before = search(&Linear::default(), &source, limit, format, u64::MAX); // striping off: the old path
                let after = search(&Linear::default(), &source, limit, format, STRIP_PROBE_MIN_PIXELS);
                assert_eq!(chosen(&before), chosen(&after), "{format:?} at a limit of {limit} bytes");
                // The "smallest size tried" is a strip total when full size was never encoded whole, so it
                // may differ a little (here: the fake encoder's per-strip header bytes), never by much.
                let (a, b) = (before.smallest as f64, after.smallest as f64);
                assert!((a - b).abs() <= a * 0.01, "{format:?} at {limit}: smallest {a} vs {b}");
            }
        }
    }

    #[test]
    fn full_size_is_still_encoded_when_it_can_fit() {
        let source = picture(2400, 1800);
        let encoder = Linear::default();
        let result = search(&encoder, &source, 6_000_000, Format::Jpeg, STRIP_PROBE_MIN_PIXELS);
        assert_eq!(result.best.expect("fits at full size").scale, 1.0);
        assert_eq!(encoder.largest_encode_pixels.load(Ordering::Relaxed), 2400 * 1800);
    }

    #[test]
    fn palette_png_is_still_encoded_whole() {
        let source = picture(2400, 1800);
        let encoder = Linear::default();
        // Hopeless at full size (floor encode ~864 KB against a 100 KB limit), yet the whole image is encoded,
        // exactly as before: strips are not used for palette PNG.
        let _ = search(&encoder, &source, 100_000, Format::PngPalette, STRIP_PROBE_MIN_PIXELS);
        assert_eq!(encoder.largest_encode_pixels.load(Ordering::Relaxed), 2400 * 1800);
    }

    #[test]
    fn a_small_image_is_never_cut_into_strips() {
        let source = picture(1600, 1200); // 1.9 MP, under the threshold
        let encoder = Linear::default();
        let _ = search(&encoder, &source, 10_000, Format::Jpeg, STRIP_PROBE_MIN_PIXELS);
        // The old path encodes the full image once to learn it cannot fit.
        assert_eq!(encoder.largest_encode_pixels.load(Ordering::Relaxed), 1600 * 1200);
    }
}
