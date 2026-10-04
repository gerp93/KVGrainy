use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use rayon::prelude::*;

use crate::encode::{encode, Format};
use crate::raster::Raster;

pub const SCALE_FACTORS: [f32; 15] =
    [1.0, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3];
const VISUAL_WEIGHT: f64 = 0.8;
const SIZE_UTILIZATION_WEIGHT: f64 = 0.2;
const SCALE_WEIGHT_BASE: f64 = 0.85;
const SCALE_WEIGHT_RANGE: f64 = 0.15;

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
    pub visual_score: f64,
    pub total_score: f64,
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
        None if source.alpha.is_some() => vec![Format::Webp, Format::Png],
        None => vec![Format::Jpeg, Format::Webp, Format::Png],
    };
    let tasks: Vec<(Format, f32)> = formats
        .iter()
        .flat_map(|&f| SCALE_FACTORS.iter().map(move |&s| (f, s)))
        .collect();
    let total = tasks.len();
    let done = AtomicUsize::new(0);
    let cancelled = || options.cancel.as_ref().is_some_and(|c| c.load(Ordering::Relaxed));

    let results: Vec<TaskResult> = tasks
        .par_iter()
        .map(|&(format, scale)| {
            let result = if cancelled() { TaskResult { best: None, smallest: u64::MAX } } else { run_task(source, options, format, scale, &cancelled) };
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
        .max_by(|a, b| {
            let key = |c: &Candidate| (c.total_score, c.bytes.len());
            key(a).partial_cmp(&key(b)).unwrap_or(std::cmp::Ordering::Equal)
        })
        .ok_or(Error::NothingFits { limit: options.limit_bytes, smallest })
}

fn run_task(source: &Raster, options: &Options, format: Format, scale: f32, cancelled: &dyn Fn() -> bool) -> TaskResult {
    let resized = source.scaled(scale);
    let mut smallest = u64::MAX;
    let mut best: Option<Candidate> = None;
    let mut try_quality = |quality: u8| -> Option<Candidate> {
        if cancelled() {
            return None;
        }
        let bytes = encode(format, &resized, quality).ok()?;
        smallest = smallest.min(bytes.len() as u64);
        if bytes.len() as u64 > options.limit_bytes {
            return None;
        }
        let visual = visual_score(source, &bytes, scale);
        let utilization = bytes.len() as f64 / options.limit_bytes as f64;
        let total_score = visual * VISUAL_WEIGHT + utilization * SIZE_UTILIZATION_WEIGHT;
        Some(Candidate { bytes, format, quality: format.has_quality().then_some(quality), scale, visual_score: visual, total_score })
    };

    if format.has_quality() {
        let (mut lo, mut hi) = (20u8, 100u8);
        while lo <= hi {
            let mid = lo + (hi - lo) / 2;
            match try_quality(mid) {
                Some(candidate) => {
                    best = Some(candidate);
                    lo = mid + 1;
                }
                None => match mid.checked_sub(1) {
                    Some(next) => hi = next,
                    None => break,
                },
            }
        }
    } else {
        best = try_quality(100);
    }
    TaskResult { best, smallest }
}

/// RMS-based similarity against the original, weighted slightly toward higher scales.
/// A perceptual metric replaces this later; it only exists to rank candidates.
fn visual_score(original: &Raster, payload: &[u8], scale: f32) -> f64 {
    let Ok(decoded) = image::load_from_memory(payload) else {
        return 0.0;
    };
    let decoded = decoded.to_rgb8();
    let (w, h) = (original.width, original.height);
    let decoded = if decoded.dimensions() == (w, h) {
        decoded.into_raw()
    } else {
        Raster { width: decoded.width(), height: decoded.height(), rgb: decoded.into_raw(), alpha: None }
            .resized(w, h)
            .rgb
    };
    let squares: u64 = original
        .rgb
        .iter()
        .zip(&decoded)
        .map(|(&a, &b)| {
            let d = a as i32 - b as i32;
            (d * d) as u64
        })
        .sum();
    let rms = (squares as f64 / original.rgb.len() as f64).sqrt();
    let similarity = (1.0 - rms / 255.0).max(0.0);
    similarity * (SCALE_WEIGHT_BASE + SCALE_WEIGHT_RANGE * scale as f64)
}
