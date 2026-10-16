//! Animated output (PLAN.md 4.2): fit an animation under a size limit as a GIF.
//!
//! Frames come from an animated GIF, WebP or PNG (APNG) ([`load_animation`]); a GIF is written by
//! `gifski`, which does far better palette work than a plain quantizer ([`encode_gif`]); and
//! [`optimize_gif`] searches the three things that make a GIF big: picture size, quality (which sets
//! the palette) and frame count. It mirrors the still-image search: walk the scale ladder from large to
//! small, find the best quality that fits at each scale, and only drop frames when nothing fits even
//! at the smallest picture. Candidates are scored on a sample of frames with SSIMULACRA2.

use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use image::codecs::gif::GifDecoder;
use image::codecs::png::PngDecoder;
use image::codecs::webp::WebPDecoder;
use image::{AnimationDecoder, ImageFormat};
use imgref::ImgVec;
use rgb::RGBA8;

use crate::raster::Raster;
use crate::score::Reference;
use crate::search::{guess_quality, SCALE_FACTORS};

/// Most pixels, summed over all frames, an animation may hold in memory. A 1080p clip of about 190 frames.
pub const MAX_TOTAL_PIXELS: u64 = 400_000_000;
/// Frame counts the search tries when no scale fits with every frame (1 keeps all).
pub const FRAME_STEPS: [usize; 9] = [1, 2, 3, 4, 6, 8, 10, 15, 20];
/// Lowest and highest gifski quality used. At a tight limit a very low quality (few colours) keeps a much larger
/// picture than shrinking would, and the score decides which looks better, so the floor is the lowest there is.
const MIN_QUALITY: u8 = 1;
const MAX_QUALITY: u8 = 100;
/// Frames scored per candidate; scoring all of them would be far slower than encoding.
const SAMPLE_FRAMES: usize = 5;
/// Browsers show GIF delays under 20 ms as 100 ms, so a shorter delay is stored as that.
const MIN_DELAY_MS: u32 = 20;

#[derive(Debug, thiserror::Error)]
pub enum AnimationError {
    #[error("could not read the animation: {0}")]
    Decode(String),
    #[error("that file is not an animation (it has a single frame)")]
    NotAnimated,
    #[error("the animation is too large to hold in memory ({frames} frames of {width}x{height})")]
    TooLarge { frames: usize, width: u32, height: u32 },
    #[error("could not write the GIF: {0}")]
    Encode(String),
    #[error("cancelled")]
    Cancelled,
    #[error("nothing fits under {limit} bytes; the smallest output tried was {smallest} bytes")]
    NothingFits { limit: u64, smallest: u64 },
}

/// A decoded animation: equally sized frames and how long each is shown.
#[derive(Clone, Debug)]
pub struct Animation {
    pub width: u32,
    pub height: u32,
    pub frames: Vec<Raster>,
    pub delays_ms: Vec<u32>,
    /// How many times it plays; 0 is forever.
    pub loops: u16,
}

/// How one GIF is made.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GifSettings {
    /// Fraction of the original width and height, `0.0..=1.0`.
    pub scale: f32,
    /// gifski quality, 1..=100.
    pub quality: u8,
    /// Keep every Nth frame (1 keeps all); the dropped frames' time is added to the kept one's.
    pub frame_step: usize,
}

#[derive(Clone, Debug)]
pub struct GifCandidate {
    pub bytes: Vec<u8>,
    pub settings: GifSettings,
    /// SSIMULACRA2-based similarity to the original, `0.0..=1.0`, averaged over sampled frames.
    pub score: f64,
}

/// Decode an animated GIF, WebP or PNG. A file with one frame is [`AnimationError::NotAnimated`].
pub fn load_animation(bytes: &[u8]) -> Result<Animation, AnimationError> {
    let decode = |e: image::ImageError| AnimationError::Decode(e.to_string());
    let format = image::guess_format(bytes).map_err(decode)?;
    let frames = match format {
        ImageFormat::Gif => GifDecoder::new(Cursor::new(bytes)).map_err(decode)?.into_frames().collect_frames(),
        ImageFormat::WebP => {
            let decoder = WebPDecoder::new(Cursor::new(bytes)).map_err(decode)?;
            if !decoder.has_animation() {
                return Err(AnimationError::NotAnimated);
            }
            decoder.into_frames().collect_frames()
        }
        ImageFormat::Png => {
            let decoder = PngDecoder::new(Cursor::new(bytes)).map_err(decode)?;
            if !decoder.is_apng().map_err(decode)? {
                return Err(AnimationError::NotAnimated);
            }
            decoder.apng().map_err(decode)?.into_frames().collect_frames()
        }
        _ => return Err(AnimationError::NotAnimated),
    }
    .map_err(decode)?;
    if frames.len() < 2 {
        return Err(AnimationError::NotAnimated);
    }
    let (width, height) = frames[0].buffer().dimensions();
    if width as u64 * height as u64 * frames.len() as u64 > MAX_TOTAL_PIXELS {
        return Err(AnimationError::TooLarge { frames: frames.len(), width, height });
    }
    let mut rasters = Vec::with_capacity(frames.len());
    let mut delays_ms = Vec::with_capacity(frames.len());
    for frame in &frames {
        let (numer, denom) = frame.delay().numer_denom_ms();
        let delay = if denom == 0 { 100 } else { numer / denom };
        delays_ms.push(if delay < MIN_DELAY_MS { 100 } else { delay });
        let buffer = frame.buffer();
        let rgb: Vec<u8> = buffer.pixels().flat_map(|p| [p.0[0], p.0[1], p.0[2]]).collect();
        let alpha: Vec<u8> = buffer.pixels().map(|p| p.0[3]).collect();
        let alpha = alpha.iter().any(|&a| a != 255).then_some(alpha);
        rasters.push(Raster { width, height, rgb, alpha });
    }
    // The decoders above do not expose the loop count uniformly; an animation that someone is trying to
    // shrink is a looping one.
    Ok(Animation { width, height, frames: rasters, delays_ms, loops: 0 })
}

/// Keep every `step`th frame, adding the dropped frames' delays to the kept one so playback speed is unchanged.
fn step_frames(animation: &Animation, step: usize) -> (Vec<&Raster>, Vec<u32>) {
    let step = step.max(1);
    let mut frames = Vec::new();
    let mut delays = Vec::new();
    for start in (0..animation.frames.len()).step_by(step) {
        frames.push(&animation.frames[start]);
        delays.push(animation.delays_ms[start..(start + step).min(animation.delays_ms.len())].iter().sum());
    }
    (frames, delays)
}

fn to_img(raster: &Raster) -> ImgVec<RGBA8> {
    let pixels: Vec<RGBA8> = raster.rgba().chunks_exact(4).map(|p| RGBA8::new(p[0], p[1], p[2], p[3])).collect();
    ImgVec::new(pixels, raster.width as usize, raster.height as usize)
}

/// Write `animation` as a GIF with the given settings.
pub fn encode_gif(animation: &Animation, settings: GifSettings) -> Result<Vec<u8>, AnimationError> {
    let (kept, delays) = step_frames(animation, settings.frame_step);
    let scaled: Vec<Raster> = kept.iter().map(|f| f.scaled(settings.scale)).collect();
    let options = gifski::Settings {
        width: None,
        height: None,
        quality: settings.quality.clamp(1, 100),
        fast: false,
        repeat: if animation.loops == 0 { gifski::Repeat::Infinite } else { gifski::Repeat::Finite(animation.loops) },
    };
    let (collector, writer) = gifski::new(options).map_err(|e| AnimationError::Encode(e.to_string()))?;
    let mut out = Vec::new();
    let written = std::thread::scope(|scope| {
        let feeder = scope.spawn(move || -> Result<(), String> {
            let mut at = 0.0f64;
            for (index, frame) in scaled.iter().enumerate() {
                collector.add_frame_rgba(index, to_img(frame), at).map_err(|e| e.to_string())?;
                at += delays[index] as f64 / 1000.0;
            }
            Ok(())
        });
        let result = writer.write(&mut out, &mut gifski::progress::NoProgress {});
        let fed = feeder.join().unwrap_or_else(|_| Err("the frame feeder panicked".into()));
        result.map_err(|e| e.to_string()).and(fed)
    });
    written.map_err(AnimationError::Encode)?;
    Ok(out)
}

/// Mean similarity of `gif` to `animation` over a few frames spread through both, matched by how far
/// through the animation they are (so a GIF with dropped frames, or from another encoder, compares fairly).
pub fn gif_similarity(animation: &Animation, gif: &[u8]) -> f64 {
    let Ok(decoder) = GifDecoder::new(Cursor::new(gif)) else { return 0.0 };
    let Ok(decoded) = decoder.into_frames().collect_frames() else { return 0.0 };
    if decoded.is_empty() {
        return 0.0;
    }
    let samples = decoded.len().min(animation.frames.len()).min(SAMPLE_FRAMES);
    let mut total = 0.0;
    for i in 0..samples {
        let fraction = if samples == 1 { 0.0 } else { i as f64 / (samples - 1) as f64 };
        let original = &animation.frames[(fraction * (animation.frames.len() - 1) as f64).round() as usize];
        let buffer = decoded[(fraction * (decoded.len() - 1) as f64).round() as usize].buffer();
        let (w, h) = buffer.dimensions();
        let rgb: Vec<u8> = buffer.pixels().flat_map(|p| [p.0[0], p.0[1], p.0[2]]).collect();
        let alpha: Vec<u8> = buffer.pixels().map(|p| p.0[3]).collect();
        let alpha = alpha.iter().any(|&a| a != 255).then_some(alpha);
        total += Reference::new(original).score_raster(&Raster { width: w, height: h, rgb, alpha });
    }
    total / samples as f64
}

/// When [`optimize_gif`] reports [`AnimationError::NothingFits`]: the smallest GIF this search can make
/// (the smallest picture, lowest quality and fewest frames it will try). Over the limit by definition.
pub fn best_effort_gif(animation: &Animation) -> Result<GifCandidate, AnimationError> {
    let scale = SCALE_FACTORS[SCALE_FACTORS.len() - 1];
    let frame_step = FRAME_STEPS.iter().copied().filter(|&s| s < animation.frames.len()).max().unwrap_or(1);
    let settings = GifSettings { scale, quality: MIN_QUALITY, frame_step };
    let bytes = encode_gif(animation, settings)?;
    let score = gif_similarity(animation, &bytes);
    Ok(GifCandidate { bytes, settings, score })
}

pub struct GifOptions {
    pub limit_bytes: u64,
    /// Set from any thread to abort the search.
    pub cancel: Option<Arc<AtomicBool>>,
}

/// Search for the best-looking GIF under `options.limit_bytes`. `progress` receives `0.0..=1.0`.
///
/// gifski's quality is a cliff, not a slope: from 1 to about 50 the result is the same coarse palette,
/// 75 is a little better, and 100 is far better at several times the size. So the winner is almost always
/// maximum quality at the largest picture that fits, and the search looks for exactly that: it finds the
/// largest scale where quality 100 fits (a bisection over the scale ladder), then also tries the best
/// lower quality at a few larger scales, and lets the score choose. Frames are dropped only when nothing
/// fits with all of them.
pub fn optimize_gif(
    animation: &Animation,
    options: &GifOptions,
    progress: &(dyn Fn(f64) + Sync),
) -> Result<GifCandidate, AnimationError> {
    let cancelled = || options.cancel.as_ref().is_some_and(|c| c.load(Ordering::Relaxed));
    let limit = options.limit_bytes;
    let mut smallest = u64::MAX;
    let steps: Vec<usize> = FRAME_STEPS.iter().copied().filter(|&s| s < animation.frames.len()).collect();
    let phases = steps.len().max(1);
    let last = SCALE_FACTORS.len() - 1;

    for (phase, &frame_step) in steps.iter().enumerate() {
        let report = |done: f64| progress((phase as f64 + done.min(1.0)) / phases as f64);
        let mut encode = |index: usize, quality: u8| -> Result<Vec<u8>, AnimationError> {
            if cancelled() {
                return Err(AnimationError::Cancelled);
            }
            let bytes = encode_gif(animation, GifSettings { scale: SCALE_FACTORS[index], quality, frame_step })?;
            smallest = smallest.min(bytes.len() as u64);
            Ok(bytes)
        };
        let mut best: Option<GifCandidate> = None;
        let mut consider = |bytes: Vec<u8>, index: usize, quality: u8| {
            let settings = GifSettings { scale: SCALE_FACTORS[index], quality, frame_step };
            let score = gif_similarity(animation, &bytes);
            if best.as_ref().is_none_or(|b| score > b.score + 0.001) {
                best = Some(GifCandidate { bytes, settings, score });
            }
        };

        // Everything fits at full size and full quality: nothing to decide.
        report(0.05);
        let full = encode(0, MAX_QUALITY)?;
        if full.len() as u64 <= limit {
            consider(full, 0, MAX_QUALITY);
            progress(1.0);
            return Ok(best.expect("a candidate was just considered"));
        }

        // The largest scale at which maximum quality fits, by bisection (size shrinks with scale).
        report(0.15);
        let smallest_picture = encode(last, MAX_QUALITY)?;
        let top = if smallest_picture.len() as u64 <= limit {
            let (mut lo, mut hi, mut hi_bytes) = (0, last, smallest_picture);
            while hi - lo > 1 {
                let mid = (lo + hi) / 2;
                let bytes = encode(mid, MAX_QUALITY)?;
                if bytes.len() as u64 <= limit {
                    hi = mid;
                    hi_bytes = bytes;
                } else {
                    lo = mid;
                }
            }
            consider(hi_bytes, hi, MAX_QUALITY);
            Some(hi)
        } else {
            None
        };

        // A lower quality at a larger picture can beat maximum quality at a smaller one; try a few.
        report(0.5);
        let ceiling = top.unwrap_or(last + 1);
        let mut indexes: Vec<usize> = vec![0, ceiling / 2, ceiling.saturating_sub(2), ceiling.saturating_sub(1)];
        indexes.retain(|&i| i < ceiling && i <= last);
        indexes.sort_unstable();
        indexes.dedup();
        for (n, &index) in indexes.iter().enumerate() {
            report(0.5 + 0.5 * n as f64 / indexes.len() as f64);
            let fit = fit_quality(animation, limit, SCALE_FACTORS[index], frame_step, MIN_QUALITY, &cancelled, &mut smallest)?;
            if let Some((bytes, quality)) = fit {
                consider(bytes, index, quality);
            }
        }
        if let Some(best) = best {
            progress(1.0);
            return Ok(best);
        }
    }
    if cancelled() {
        return Err(AnimationError::Cancelled);
    }
    Err(AnimationError::NothingFits { limit, smallest })
}

/// The highest quality in `floor..=MAX_QUALITY` whose GIF fits, steering by log-size like the still search.
fn fit_quality(
    animation: &Animation,
    limit: u64,
    scale: f32,
    frame_step: usize,
    floor: u8,
    cancelled: &dyn Fn() -> bool,
    smallest: &mut u64,
) -> Result<Option<(Vec<u8>, u8)>, AnimationError> {
    let mut encode = |quality: u8| -> Result<Vec<u8>, AnimationError> {
        if cancelled() {
            return Err(AnimationError::Cancelled);
        }
        let bytes = encode_gif(animation, GifSettings { scale, quality, frame_step })?;
        *smallest = (*smallest).min(bytes.len() as u64);
        Ok(bytes)
    };
    let low = encode(floor)?;
    // Only just over, a higher quality will not shrink it; far over, this scale is hopeless.
    if low.len() as u64 > limit {
        return Ok(None);
    }
    let mut known_fit = Some((floor, low.len() as u64));
    let mut known_miss: Option<(u8, u64)> = None;
    let mut fit = Some((low, floor));
    let (mut lo, mut hi) = (floor.saturating_add(1), MAX_QUALITY);
    while lo <= hi {
        let q = guess_quality(limit, known_fit, known_miss, lo, hi);
        let bytes = encode(q)?;
        if bytes.len() as u64 <= limit {
            known_fit = Some((q, bytes.len() as u64));
            lo = q.saturating_add(1);
            fit = Some((bytes, q));
        } else {
            known_miss = Some((q, bytes.len() as u64));
            hi = q.saturating_sub(1);
        }
        if q == 0 {
            break;
        }
    }
    Ok(fit)
}
