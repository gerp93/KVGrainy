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
    let result = search_format(encoder, &reference, source, options, format, cancelled, report);
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
        .map(|&format| search_format(encoder, &reference, source, options, format, &cancelled, &report))
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
        let resized = source.scaled(scale);
        let attempt = fit_at_scale(encoder, &resized, options.limit_bytes, format, min_quality, cancelled, &mut smallest)
            .or_else(|| {
                // The warm start can be too optimistic; retry from the floor before giving up on this scale.
                (min_quality > MIN_QUALITY)
                    .then(|| {
                        fit_at_scale(encoder, &resized, options.limit_bytes, format, MIN_QUALITY, cancelled, &mut smallest)
                    })
                    .flatten()
            });

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
fn guess_quality(limit: u64, fit: Option<(u8, u64)>, miss: Option<(u8, u64)>, lo: u8, hi: u8) -> u8 {
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
