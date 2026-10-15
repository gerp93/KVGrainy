//! Phase 1 spike harness. Runs the codec-agnostic core with a pure-Rust `Encoder`
//! so the same code can be timed natively and as WASM. The codecs here are
//! stand-ins (the `image` crate's own encoders), not the production ones; the point is
//! to measure the core's search, scoring, resize and colour code, not the encoders.

use image::{codecs::jpeg::JpegEncoder, codecs::png::PngEncoder, codecs::webp::WebPEncoder, ExtendedColorType, ImageEncoder};
use kvgrainy_core::load::decode;
use kvgrainy_core::raster::Raster;
use kvgrainy_core::score::Reference;
use kvgrainy_core::search::{optimize_with, Options};
use kvgrainy_core::{Encoder, Format};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

/// Pure-Rust stand-in codecs. WebP is lossless (the `image` crate has no lossy encoder)
/// and AVIF is unavailable, so searches here use JPEG or PNG.
pub struct PureEncoder;

impl Encoder for PureEncoder {
    fn encode(&self, format: Format, raster: &Raster, quality: u8) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        let (w, h) = (raster.width, raster.height);
        match format {
            Format::Jpeg => JpegEncoder::new_with_quality(&mut out, quality)
                .write_image(&raster.flattened_rgb(), w, h, ExtendedColorType::Rgb8),
            Format::Png => match &raster.alpha {
                Some(_) => PngEncoder::new(&mut out).write_image(&raster.rgba(), w, h, ExtendedColorType::Rgba8),
                None => PngEncoder::new(&mut out).write_image(&raster.rgb, w, h, ExtendedColorType::Rgb8),
            },
            Format::Webp => match &raster.alpha {
                Some(_) => WebPEncoder::new_lossless(&mut out).write_image(&raster.rgba(), w, h, ExtendedColorType::Rgba8),
                None => WebPEncoder::new_lossless(&mut out).write_image(&raster.rgb, w, h, ExtendedColorType::Rgb8),
            },
            Format::Avif => return Err("AVIF is not available in the pure-Rust stand-in encoder".into()),
        }
        .map_err(|e| e.to_string())?;
        Ok(out)
    }

    fn decode(&self, _format: Format, payload: &[u8]) -> Option<Raster> {
        decode(payload).ok().map(|loaded| loaded.raster)
    }
}

/// One loaded image plus the state the timing script drives step by step.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub struct Spike {
    source: Raster,
    reference: Option<Reference>,
    last: Option<(Vec<u8>, Format)>,
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
impl Spike {
    /// Decode (EXIF orientation + ICC to sRGB included).
    #[cfg_attr(target_arch = "wasm32", wasm_bindgen(constructor))]
    pub fn new(bytes: &[u8]) -> Result<Spike, String> {
        let loaded = decode(bytes).map_err(|e| e.to_string())?;
        Ok(Spike { source: loaded.raster, reference: None, last: None })
    }

    pub fn width(&self) -> u32 {
        self.source.width
    }

    pub fn height(&self) -> u32 {
        self.source.height
    }

    /// Convert the original to the scorer's input once.
    pub fn prepare_reference(&mut self) {
        self.reference = Some(Reference::new(&self.source));
    }

    /// Encode the full-size image; returns the output size. Keeps it for [`Spike::score_last`].
    pub fn encode(&mut self, format: &str, quality: u8) -> Result<usize, String> {
        let format = Format::parse(format).ok_or("unknown format")?;
        let bytes = PureEncoder.encode(format, &self.source, quality)?;
        let len = bytes.len();
        self.last = Some((bytes, format));
        Ok(len)
    }

    /// SSIMULACRA2 similarity (0..1) of the last encoded output against the original.
    pub fn score_last(&mut self) -> Result<f64, String> {
        if self.reference.is_none() {
            self.prepare_reference();
        }
        let (bytes, format) = self.last.as_ref().ok_or("encode first")?;
        Ok(self.reference.as_ref().unwrap().score_with(&PureEncoder, bytes, *format))
    }

    /// Full single-format search under `limit` bytes. Returns `format,quality,scale,score,bytes`.
    pub fn search(&self, limit: u64, format: &str) -> Result<String, String> {
        let mut options = Options::new(limit);
        options.format = Some(Format::parse(format).ok_or("unknown format")?);
        let best = optimize_with(&PureEncoder, &self.source, &options, &|_| {}).map_err(|e| e.to_string())?;
        Ok(format!(
            "{},{},{},{:.4},{}",
            best.format.extension(),
            best.quality.map_or(-1, |q| q as i32),
            best.scale,
            best.score,
            best.bytes.len()
        ))
    }
}

/// Current size of the WASM linear memory in bytes. It only grows, so after a run this is
/// the high-water mark the engine needed.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn wasm_memory_bytes() -> usize {
    core::arch::wasm32::memory_size(0) * 65536
}
