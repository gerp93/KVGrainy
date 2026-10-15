//! Perceptual scoring of an encoded candidate against the original (SSIMULACRA2).

use ssimulacra2::{compute_frame_ssimulacra2, ColorPrimaries, Rgb, TransferCharacteristic};

use crate::encode::{Encoder, Format};
use crate::native::NativeEncoder;
use crate::raster::Raster;

/// The original, prepared once so scoring many candidates doesn't redo the conversion.
pub struct Reference {
    width: u32,
    height: u32,
    flat: Vec<u8>,
    xyb_input: Option<Rgb>,
}

impl Reference {
    pub fn new(original: &Raster) -> Reference {
        let flat = original.flattened_rgb();
        let xyb_input = to_rgb(&flat, original.width, original.height);
        Reference { width: original.width, height: original.height, flat, xyb_input }
    }

    /// Visual similarity in `0.0..=1.0` (SSIMULACRA2 / 100, clamped); 1.0 is indistinguishable.
    ///
    /// The candidate is decoded and scaled back to the original size first, so
    /// downscaling is penalized by the metric itself. Transparency is judged
    /// composited over white. Images under 8x8 pixels, which SSIMULACRA2
    /// rejects, fall back to a pixel-error score.
    pub fn score(&self, payload: &[u8], format: Format) -> f64 {
        self.score_with(&NativeEncoder, payload, format)
    }

    /// Like [`Reference::score`], decoding the candidate with `encoder`.
    pub fn score_with(&self, encoder: &dyn Encoder, payload: &[u8], format: Format) -> f64 {
        match encoder.decode(format, payload) {
            Some(decoded) => self.score_raster(&decoded),
            None => 0.0,
        }
    }

    /// Score an already-decoded candidate (any size; it is scaled back to the original's).
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
