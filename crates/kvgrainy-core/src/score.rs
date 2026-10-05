//! Perceptual scoring of an encoded candidate against the original (SSIMULACRA2).

use ssimulacra2::{compute_frame_ssimulacra2, ColorPrimaries, Rgb, TransferCharacteristic};

use crate::encode::Format;
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
        let Some(decoded) = decode_output(payload, format) else {
            return 0.0;
        };
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

fn decode_output(payload: &[u8], format: Format) -> Option<Raster> {
    if format == Format::Avif {
        return decode_avif(payload);
    }
    crate::load::decode(payload).ok().map(|loaded| loaded.raster)
}

fn decode_avif(payload: &[u8]) -> Option<Raster> {
    use avif_decode::Image;
    let image = avif_decode::Decoder::from_avif(payload).ok()?.to_image().ok()?;
    let (width, height, rgb, alpha): (usize, usize, Vec<u8>, Option<Vec<u8>>) = match image {
        Image::Rgb8(img) => {
            let (w, h) = (img.width(), img.height());
            (w, h, img.pixels().flat_map(|p| [p.r, p.g, p.b]).collect(), None)
        }
        Image::Rgb16(img) => {
            let (w, h) = (img.width(), img.height());
            (w, h, img.pixels().flat_map(|p| [(p.r >> 8) as u8, (p.g >> 8) as u8, (p.b >> 8) as u8]).collect(), None)
        }
        Image::Rgba8(img) => {
            let (w, h) = (img.width(), img.height());
            let px: Vec<_> = img.pixels().collect();
            (w, h, px.iter().flat_map(|p| [p.r, p.g, p.b]).collect(), Some(px.iter().map(|p| p.a).collect()))
        }
        Image::Rgba16(img) => {
            let (w, h) = (img.width(), img.height());
            let px: Vec<_> = img.pixels().collect();
            (
                w,
                h,
                px.iter().flat_map(|p| [(p.r >> 8) as u8, (p.g >> 8) as u8, (p.b >> 8) as u8]).collect(),
                Some(px.iter().map(|p| (p.a >> 8) as u8).collect()),
            )
        }
        Image::Gray8(img) => {
            let (w, h) = (img.width(), img.height());
            (w, h, img.pixels().flat_map(|p| [p.value(); 3]).collect(), None)
        }
        Image::Gray16(img) => {
            let (w, h) = (img.width(), img.height());
            (w, h, img.pixels().flat_map(|p| [(p.value() >> 8) as u8; 3]).collect(), None)
        }
    };
    Some(Raster { width: width as u32, height: height as u32, rgb, alpha })
}
