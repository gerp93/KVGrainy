//! Perceptual scoring of an encoded candidate against the original.
//!
//! Scores are measured on a copy of the original capped at [`SCORE_CAP_PIXELS`]
//! (docs/metric-study.md): SSIMULACRA2 (what the search ranks by, ~280 ms per score at the
//! cap) and a luma-SSIM proxy (about 20x cheaper) that is validated for JPEG photos only and
//! not used by the search. Capping bounds memory and time regardless of source size: a 12 MP
//! photo needs about 240 MB to score in WASM instead of about 2 GB.

use std::borrow::Cow;

use ssimulacra2::{compute_frame_ssimulacra2, ColorPrimaries, Rgb, TransferCharacteristic};

use crate::encode::{Encoder, Format};
use crate::proxy::{ProxyKind, ProxyRef};
use crate::raster::Raster;

/// Scoring works on a copy of the original with at most this many pixels.
pub const SCORE_CAP_PIXELS: f64 = 1_000_000.0;

/// The original, prepared once so scoring many candidates doesn't redo the conversion.
pub struct Reference {
    width: u32,
    height: u32,
    flat: Vec<u8>,
    xyb_input: Option<Rgb>,
    proxy: ProxyRef,
}

/// Dimensions of `width` x `height` reduced (keeping aspect ratio) to at most `cap` pixels.
fn capped_dims(width: u32, height: u32, cap: f64) -> (u32, u32) {
    let pixels = width as f64 * height as f64;
    if pixels <= cap {
        return (width, height);
    }
    let factor = (cap / pixels).sqrt();
    (((width as f64 * factor) as u32).max(1), ((height as f64 * factor) as u32).max(1))
}

impl Reference {
    pub fn new(original: &Raster) -> Reference {
        Reference::with_cap(original, SCORE_CAP_PIXELS)
    }

    /// Like [`Reference::new`] with an explicit pixel cap. Use [`f64::INFINITY`] to score
    /// at full resolution (slow and memory hungry; for tests and studies).
    pub fn with_cap(original: &Raster, cap_pixels: f64) -> Reference {
        let (width, height) = capped_dims(original.width, original.height, cap_pixels);
        let base: Cow<Raster> = if (width, height) == (original.width, original.height) {
            Cow::Borrowed(original)
        } else {
            Cow::Owned(original.resized(width, height))
        };
        let flat = base.flattened_rgb();
        let xyb_input = to_rgb(&flat, width, height);
        let proxy = ProxyRef::new(&base, ProxyKind::LumaSsim);
        Reference { width, height, flat, xyb_input, proxy }
    }

    /// Dimensions candidates are compared at (the original's, or its capped copy's).
    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// Visual similarity in `0.0..=1.0` (SSIMULACRA2 / 100, clamped); 1.0 is indistinguishable.
    ///
    /// The candidate is decoded and scaled to the reference size first, so
    /// downscaling is penalized by the metric itself. Transparency is judged
    /// composited over white. Images under 8x8 pixels, which SSIMULACRA2
    /// rejects, fall back to a pixel-error score.
    #[cfg(feature = "native")]
    pub fn score(&self, payload: &[u8], format: Format) -> f64 {
        self.score_with(&crate::native::NativeEncoder, payload, format)
    }

    /// Like [`Reference::score`], decoding the candidate with `encoder`.
    pub fn score_with(&self, encoder: &dyn Encoder, payload: &[u8], format: Format) -> f64 {
        match encoder.decode(format, payload) {
            Some(decoded) => self.score_raster(&decoded),
            None => 0.0,
        }
    }

    /// Score an already-decoded candidate (any size; it is scaled to the reference size).
    pub fn score_raster(&self, decoded: &Raster) -> f64 {
        let decoded = decoded.resized(self.width, self.height);
        let distorted = decoded.flattened_rgb();
        if let (Some(reference), Some(distorted)) = (&self.xyb_input, to_rgb(&distorted, self.width, self.height)) {
            if let Ok(score) = compute_frame_ssimulacra2(reference.clone(), distorted) {
                return (score / 100.0).clamp(0.0, 1.0);
            }
        }
        pixel_similarity(&self.flat, &distorted)
    }

    /// Cheap luma-SSIM similarity in `0.0..=1.0`. On JPEG photos it orders candidates like
    /// [`Reference::score_with`] (docs/metric-study.md) but it cannot see colour damage such as
    /// palette banding, and its values are not on the same scale; never compare the two.
    pub fn proxy_with(&self, encoder: &dyn Encoder, payload: &[u8], format: Format) -> f64 {
        match encoder.decode(format, payload) {
            Some(decoded) => self.proxy_raster(&decoded),
            None => 0.0,
        }
    }

    /// Like [`Reference::proxy_with`] for an already-decoded candidate.
    pub fn proxy_raster(&self, decoded: &Raster) -> f64 {
        self.proxy.score(&decoded.resized(self.width, self.height))
    }
}

fn to_rgb(rgb: &[u8], width: u32, height: u32) -> Option<Rgb> {
    let data: Vec<[f32; 3]> = rgb
        .chunks_exact(3)
        .map(|p| [p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0])
        .collect();
    Rgb::new(data, width as usize, height as usize, TransferCharacteristic::SRGB, ColorPrimaries::BT709).ok()
}

fn pixel_similarity(a: &[u8], b: &[u8]) -> f64 {
    let squares: u64 = a
        .iter()
        .zip(b)
        .map(|(&x, &y)| {
            let d = x as i32 - y as i32;
            (d * d) as u64
        })
        .sum();
    (1.0 - (squares as f64 / a.len() as f64).sqrt() / 255.0).max(0.0)
}

#[cfg(test)]
mod tests {
    use super::capped_dims;

    #[test]
    fn small_images_are_not_capped() {
        assert_eq!(capped_dims(1000, 1000, 1_000_000.0), (1000, 1000));
        assert_eq!(capped_dims(640, 480, 1_000_000.0), (640, 480));
    }

    #[test]
    fn large_images_are_reduced_to_the_cap_keeping_aspect() {
        let (w, h) = capped_dims(4000, 3000, 1_000_000.0);
        assert!((w as f64 * h as f64) <= 1_000_000.0);
        assert!(((w as f64 / h as f64) - 4.0 / 3.0).abs() < 0.01);
        assert_eq!(capped_dims(10, 100_000_000, 1_000_000.0).0, 1);
    }
}
