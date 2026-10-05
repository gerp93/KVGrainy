use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use rayon::prelude::*;

use crate::encode::{encode, Format};
use crate::raster::Raster;
use crate::score::Reference;

pub const SCALE_FACTORS: [f32; 15] =
    [1.0, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3];

pub struct Options {
    pub limit_bytes: u64,
    /// Force one output format instead of trying every suitable one.
    pub format: Option<Format>,
    /// Set from any thread to abort the search.
    pub cancel: Option<Arc<AtomicBool>>,
}

impl Options {
    pub fn new(limit_bytes: u64) -> Self {
        Options { limit_bytes, format: None, cancel: None }
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
    /// SSIMULACRA2-based similarity to the original, `0.0..=1.0`.
    pub score: f64,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("cancelled")]
    Cancelled,
    #[error("nothing fits under {limit} bytes; the smallest output tried was {smallest} bytes")]
    NothingFits { limit: u64, smallest: u64 },
}

struct TaskResult {
    best: Option<Candidate>,
    smallest: u64,
}

pub fn optimize(source: &Raster, options: &Options, progress: &(dyn Fn(Progress) + Sync)) -> Result<Candidate, Error> {
    let formats = match options.format {
        Some(f) => vec![f],
        None if source.alpha.is_some() => vec![Format::Webp, Format::Avif, Format::Png],
        None => vec![Format::Jpeg, Format::Webp, Format::Avif, Format::Png],
    };
    let total = formats.len() * SCALE_FACTORS.len();
    let done = AtomicUsize::new(0);
    let report = |steps: usize| {
        let completed = done.fetch_add(steps, Ordering::Relaxed) + steps;
        progress(Progress { completed, total });
    };
    let cancelled = || options.cancel.as_ref().is_some_and(|c| c.load(Ordering::Relaxed));
    let reference = Reference::new(source);

    let results: Vec<TaskResult> = formats
        .par_iter()
        .map(|&format| search_format(&reference, source, options, format, &cancelled, &report))
        .collect();

    if cancelled() {
        return Err(Error::Cancelled);
    }
    let smallest = results.iter().map(|r| r.smallest).min().unwrap_or(u64::MAX);
    results
        .into_iter()
        .filter_map(|r| r.best)
        .max_by_key(|c| {
            // Scores within 0.1 SSIMULACRA2 points are a tie, so noise can't pick a
            // needlessly smaller image; ties go to the higher scale, then the larger file.
            ((c.score * 1000.0).round() as i64, (c.scale * 100.0).round() as i32, c.bytes.len())
        })
        .ok_or(Error::NothingFits { limit: options.limit_bytes, smallest })
}

/// Lossy quality at or above which a full-scale fit is accepted without trying smaller
/// scales. Only a maximum-quality fit qualifies: on noisy images a smaller scale at
/// higher quality can beat full scale at medium quality (measured), so anything lower
/// is left to the score-based patience below.
const GOOD_ENOUGH_QUALITY: u8 = 100;
/// Stop walking down the scale ladder after this many scales in a row fail to improve the score.
const PATIENCE: usize = 2;
const MIN_QUALITY: u8 = 20;

/// Walk the scale ladder for one format from large to small, stopping once more
/// shrinking can't help. Cheap relative to trying every scale: a fit at high
/// quality ends the search, a scale that cannot fit costs one encode, and each
/// smaller scale only searches quality upward from the previous scale's result.
fn search_format(
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

    while index < SCALE_FACTORS.len() && !cancelled() {
        let scale = SCALE_FACTORS[index];
        let resized = source.scaled(scale);
        let attempt = fit_at_scale(&resized, options.limit_bytes, format, min_quality, cancelled, &mut smallest)
            .or_else(|| {
                // The warm start can be too optimistic; retry from the floor before giving up on this scale.
                (min_quality > MIN_QUALITY)
                    .then(|| fit_at_scale(&resized, options.limit_bytes, format, MIN_QUALITY, cancelled, &mut smallest))
                    .flatten()
            });

        let mut next = index + 1;
        match attempt {
            Some((bytes, quality)) if !cancelled() => {
                min_quality = quality;
                let score = reference.score(&bytes, format);
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
        let Ok(bytes) = encode(format, resized, quality) else {
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
    // Check the floor first so a hopeless scale costs one encode rather than a full bisection.
    // Encoded size is not strictly monotone in quality (small AVIFs especially), so a floor
    // that only just misses the limit still gets the full search.
    if !try_quality(min_quality) && last_len.get() > limit + limit / 4 {
        return None;
    }
    let (mut lo, mut hi) = (min_quality.saturating_add(1), 100u8);
    while lo <= hi {
        let mid = lo + (hi - lo) / 2;
        if try_quality(mid) {
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    fit
}
