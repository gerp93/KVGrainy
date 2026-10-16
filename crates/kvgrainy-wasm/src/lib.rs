//! The shared KVGrainy search core for the browser.
//!
//! `kvgrainy-core` does the search, scoring, resizing and colour handling; this crate only
//! exposes it to JavaScript. The codecs are the one thing a browser build cannot bring along
//! (the native C encoders do not build for `wasm32-unknown-unknown`), so JavaScript supplies
//! them as a [`JsCodec`] object whose methods are **synchronous**: the Rust search calls them
//! mid-loop. In a Web Worker, initialise each jSquash module once with `await`, then wrap its
//! sync `encode` function.
//!
//! One worker per format keeps the browser's cores busy without threaded WASM (which would
//! need cross-origin isolation, and that breaks third-party ad iframes): each worker calls
//! [`search_format`] for its format, and the main thread combines the outcomes with
//! [`pick_best`].
#![cfg(target_arch = "wasm32")]

use kvgrainy_core::encode::{Encoder, Format};
use kvgrainy_core::load::decode;
use kvgrainy_core::raster::Raster;
use kvgrainy_core::search::{self, Candidate, Effort, Options};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    /// Codecs supplied by JavaScript. Every method is synchronous.
    pub type JsCodec;

    /// Encode `rgba` (`width` x `height`, tightly packed, already flattened for JPEG) as
    /// `format` ("jpeg", "webp", "avif" or "png") at `quality` 1..=100 (ignored for PNG).
    /// Returns the file bytes. The `rgba` view is only valid during the call: copy it.
    #[wasm_bindgen(method, catch)]
    fn encode(this: &JsCodec, format: &str, width: u32, height: u32, rgba: &[u8], quality: u8) -> Result<Vec<u8>, JsValue>;

    /// Decode AVIF bytes to `{ width, height, data: Uint8Array | Uint8ClampedArray }` (RGBA),
    /// or return `null`. JPEG, WebP and PNG are decoded in Rust.
    #[wasm_bindgen(method, catch, js_name = decodeAvif)]
    fn decode_avif(this: &JsCodec, bytes: &[u8]) -> Result<JsValue, JsValue>;

    /// Whether `format` can be encoded here.
    #[wasm_bindgen(method)]
    fn supports(this: &JsCodec, format: &str) -> bool;
}

/// Adapts a [`JsCodec`] to the core's [`Encoder`] trait.
struct Bridge<'a>(&'a JsCodec);

// SAFETY: wasm32-unknown-unknown without the atomics feature has exactly one thread, so a JS
// object can never be touched from two threads. The core's `Encoder` trait requires `Sync`
// because its native build searches formats on a thread pool.
unsafe impl Sync for Bridge<'_> {}

fn name(format: Format) -> &'static str {
    match format {
        Format::Jpeg => "jpeg",
        Format::Webp => "webp",
        Format::Avif => "avif",
        Format::Png | Format::PngPalette => "png",
    }
}

impl Encoder for Bridge<'_> {
    fn encode(&self, format: Format, raster: &Raster, quality: u8) -> Result<Vec<u8>, String> {
        let rgba = if format == Format::Jpeg && raster.alpha.is_some() {
            // JPEG has no alpha: composite over white, as every viewer would.
            raster.flattened_rgb().chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect()
        } else {
            raster.rgba()
        };
        self.0
            .encode(name(format), raster.width, raster.height, &rgba, quality)
            .map_err(|e| e.as_string().unwrap_or_else(|| "the JavaScript encoder threw".to_string()))
    }

    fn decode(&self, format: Format, payload: &[u8]) -> Option<Raster> {
        if format != Format::Avif {
            return decode(payload).ok().map(|loaded| loaded.raster);
        }
        let value = self.0.decode_avif(payload).ok().filter(|v| !v.is_null() && !v.is_undefined())?;
        let width = js_sys::Reflect::get(&value, &"width".into()).ok()?.as_f64()? as u32;
        let height = js_sys::Reflect::get(&value, &"height".into()).ok()?.as_f64()? as u32;
        let data = js_sys::Uint8Array::new(&js_sys::Reflect::get(&value, &"data".into()).ok()?).to_vec();
        raster_from_rgba(width, height, &data)
    }

    fn supports(&self, format: Format) -> bool {
        // Palette PNG needs a quantizer the browser build does not have; lossless PNG covers "png".
        format != Format::PngPalette && self.0.supports(name(format))
    }
}

/// Split tightly packed RGBA into the core's RGB plus an alpha plane (dropped when fully opaque).
fn raster_from_rgba(width: u32, height: u32, rgba: &[u8]) -> Option<Raster> {
    if rgba.len() != (width as usize) * (height as usize) * 4 {
        return None;
    }
    let mut rgb = Vec::with_capacity(rgba.len() / 4 * 3);
    let mut alpha = Vec::with_capacity(rgba.len() / 4);
    for px in rgba.chunks_exact(4) {
        rgb.extend_from_slice(&px[..3]);
        alpha.push(px[3]);
    }
    let alpha = alpha.iter().any(|&a| a != 255).then_some(alpha);
    Some(Raster { width, height, rgb, alpha })
}

fn parse_effort(text: &str) -> Effort {
    if text == "quick" {
        Effort::Quick
    } else {
        Effort::Best
    }
}

fn parse_format(text: &str) -> Result<Option<Format>, JsError> {
    if text.is_empty() {
        return Ok(None);
    }
    Format::parse(text).map(Some).ok_or_else(|| JsError::new(&format!("unknown format {text:?}")))
}

fn options(limit: f64, format: &str, effort: &str) -> Result<Options, JsError> {
    Ok(Options { format: parse_format(format)?, effort: parse_effort(effort), ..Options::new(limit.max(0.0) as u64) })
}

/// Install a panic hook that writes to the browser console. Call once per worker.
#[wasm_bindgen(js_name = initPanicHook)]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}

/// A decoded, upright, sRGB image ready to be searched.
#[wasm_bindgen]
pub struct Source {
    raster: Raster,
    warnings: Vec<String>,
}

#[wasm_bindgen]
impl Source {
    /// From pixels the browser already decoded (tightly packed RGBA, EXIF orientation applied,
    /// colour converted to sRGB).
    #[wasm_bindgen(js_name = fromRgba)]
    pub fn from_rgba(width: u32, height: u32, rgba: &[u8]) -> Result<Source, JsError> {
        let raster = raster_from_rgba(width, height, rgba).ok_or_else(|| JsError::new("pixel buffer does not match the image size"))?;
        Ok(Source { raster, warnings: Vec::new() })
    }

    /// From an image file's bytes, decoded in Rust: EXIF orientation applied, any embedded ICC
    /// profile converted to sRGB. JPEG, PNG and WebP only: this build leaves out the GIF, BMP and
    /// TIFF decoders to stay small, and the web app decodes its inputs with the browser anyway.
    #[wasm_bindgen(js_name = fromFile)]
    pub fn from_file(bytes: &[u8]) -> Result<Source, JsError> {
        let loaded = decode(bytes).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(Source { raster: loaded.raster, warnings: loaded.warnings })
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.raster.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.raster.height
    }

    #[wasm_bindgen(getter, js_name = hasAlpha)]
    pub fn has_alpha(&self) -> bool {
        self.raster.alpha.is_some()
    }

    /// Things worth telling the user that happened on load (an unreadable ICC profile).
    #[wasm_bindgen(getter)]
    pub fn warnings(&self) -> Vec<String> {
        self.warnings.clone()
    }
}

/// One format's search result. `found` is false when no scale fit the limit; then only
/// `smallest` is meaningful.
#[wasm_bindgen]
pub struct Outcome {
    found: bool,
    bytes: Vec<u8>,
    format: String,
    quality: i32,
    scale: f32,
    score: f64,
    smallest: f64,
}

#[wasm_bindgen]
impl Outcome {
    #[wasm_bindgen(getter)]
    pub fn found(&self) -> bool {
        self.found
    }

    #[wasm_bindgen(getter)]
    pub fn bytes(&self) -> Vec<u8> {
        self.bytes.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn format(&self) -> String {
        self.format.clone()
    }

    /// The encoder quality used, or -1 for a format without one.
    #[wasm_bindgen(getter)]
    pub fn quality(&self) -> i32 {
        self.quality
    }

    #[wasm_bindgen(getter)]
    pub fn scale(&self) -> f32 {
        self.scale
    }

    /// SSIMULACRA2-based similarity, 0..1.
    #[wasm_bindgen(getter)]
    pub fn score(&self) -> f64 {
        self.score
    }

    /// Size in bytes of the smallest output tried (for the "nothing fits" message); -1 if none.
    #[wasm_bindgen(getter)]
    pub fn smallest(&self) -> f64 {
        self.smallest
    }
}

fn outcome_of(candidate: Option<Candidate>, smallest: u64) -> Outcome {
    let smallest = if smallest == u64::MAX { -1.0 } else { smallest as f64 };
    match candidate {
        Some(c) => Outcome {
            found: true,
            format: name(c.format).to_string(),
            quality: c.quality.map_or(-1, i32::from),
            scale: c.scale,
            score: c.score,
            smallest,
            bytes: c.bytes,
        },
        None => Outcome { found: false, bytes: Vec::new(), format: String::new(), quality: -1, scale: 0.0, score: 0.0, smallest },
    }
}

/// The formats a search would try, in order: `format` forces one (or "" for automatic),
/// `effort` is "quick" or "best", and formats the codec cannot encode are left out.
#[wasm_bindgen(js_name = candidateFormats)]
pub fn candidate_formats(source: &Source, codec: &JsCodec, format: &str, effort: &str) -> Result<Vec<String>, JsError> {
    let options = options(0.0, format, effort)?;
    let formats = search::candidate_formats(&Bridge(codec), &source.raster, &options);
    let mut names: Vec<String> = formats.into_iter().map(|f| name(f).to_string()).collect();
    names.dedup();
    Ok(names)
}

/// The number of scale steps one format's search reports in total.
#[wasm_bindgen(js_name = scaleSteps)]
pub fn scale_steps() -> u32 {
    search::SCALE_FACTORS.len() as u32
}

/// Search one format for the best output under `limit` bytes. `report` is called with the
/// number of scale steps just completed. This blocks the worker until done; cancel a search
/// by terminating the worker.
#[wasm_bindgen(js_name = searchFormat)]
pub fn search_format(
    source: &Source,
    codec: &JsCodec,
    format: &str,
    limit: f64,
    effort: &str,
    report: &js_sys::Function,
) -> Result<Outcome, JsError> {
    let format = parse_format(format)?.ok_or_else(|| JsError::new("a format is required"))?;
    let options = options(limit, name(format), effort)?;
    let notify = |steps: usize| {
        let _ = report.call1(&JsValue::NULL, &JsValue::from(steps as u32));
    };
    let outcome = search::search_one_format(&Bridge(codec), &source.raster, &options, format, &|| false, &notify);
    Ok(outcome_of(outcome.best, outcome.smallest))
}

/// When nothing fits: the smallest output the search can make, over the limit by definition.
#[wasm_bindgen(js_name = bestEffort)]
pub fn best_effort(source: &Source, codec: &JsCodec, format: &str, effort: &str) -> Result<Outcome, JsError> {
    let options = options(0.0, format, effort)?;
    let candidate = search::best_effort_with(&Bridge(codec), &source.raster, &options);
    let smallest = candidate.as_ref().map_or(u64::MAX, |c| c.bytes.len() as u64);
    Ok(outcome_of(candidate, smallest))
}

/// The index of the best of several formats' results, by the engine's own rule (highest
/// SSIMULACRA2 score; ties to the higher scale, then the larger file, or the smaller file
/// when visually lossless). `-1` for an empty list.
#[wasm_bindgen(js_name = pickBest)]
pub fn pick_best(scores: &[f64], scales: &[f32], sizes: &[u32]) -> i32 {
    let items = scores.iter().zip(scales).zip(sizes).map(|((&score, &scale), &size)| (score, scale, size as usize));
    search::pick_best_of(items).map_or(-1, |i| i as i32)
}
