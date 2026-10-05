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
    let tasks: Vec<(Format, f32)> = formats
        .iter()
        .flat_map(|&f| SCALE_FACTORS.iter().map(move |&s| (f, s)))
        .collect();
    let total = tasks.len();
    let reference = Reference::new(source);
    let done = AtomicUsize::new(0);
    let cancelled = || options.cancel.as_ref().is_some_and(|c| c.load(Ordering::Relaxed));

    let results: Vec<TaskResult> = tasks
        .par_iter()
        .map(|&(format, scale)| {
            let result = if cancelled() { TaskResult { best: None, smallest: u64::MAX } } else { run_task(&reference, source, options, format, scale, &cancelled) };
            progress(Progress { completed: done.fetch_add(1, Ordering::Relaxed) + 1, total });
            result
        })
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

fn run_task(
    reference: &Reference,
    source: &Raster,
    options: &Options,
    format: Format,
    scale: f32,
    cancelled: &dyn Fn() -> bool,
) -> TaskResult {
    let resized = source.scaled(scale);
    let mut smallest = u64::MAX;
    // Highest quality whose output fits the limit; only that one gets scored.
    let mut fit: Option<(Vec<u8>, u8)> = None;
    let mut try_quality = |quality: u8| -> bool {
        if cancelled() {
            return false;
        }
        let Ok(bytes) = encode(format, &resized, quality) else {
            return false;
        };
        smallest = smallest.min(bytes.len() as u64);
        if bytes.len() as u64 > options.limit_bytes {
            return false;
        }
        fit = Some((bytes, quality));
        true
    };

    if format.has_quality() {
        let (mut lo, mut hi) = (20u8, 100u8);
        while lo <= hi {
            let mid = lo + (hi - lo) / 2;
            if try_quality(mid) {
                lo = mid + 1;
            } else {
                match mid.checked_sub(1) {
                    Some(next) => hi = next,
                    None => break,
                }
            }
        }
    } else {
        try_quality(100);
    }

    let best = fit.filter(|_| !cancelled()).map(|(bytes, quality)| {
        let score = reference.score(&bytes, format);
        Candidate { bytes, format, quality: format.has_quality().then_some(quality), scale, score }
    });
    TaskResult { best, smallest }
}
