use std::io::Cursor;

use image::{codecs::png, ExtendedColorType, ImageEncoder};

use crate::raster::Raster;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Format {
    Jpeg,
    Webp,
    Avif,
    Png,
}

impl Format {
    pub fn extension(self) -> &'static str {
        match self {
            Format::Jpeg => "jpg",
            Format::Webp => "webp",
            Format::Avif => "avif",
            Format::Png => "png",
        }
    }

    /// Whether quality is a tunable knob (PNG is lossless here).
    pub fn has_quality(self) -> bool {
        self != Format::Png
    }

    pub fn parse(text: &str) -> Option<Format> {
        match text.to_lowercase().as_str() {
            "jpeg" | "jpg" => Some(Format::Jpeg),
            "webp" => Some(Format::Webp),
            "avif" => Some(Format::Avif),
            "png" => Some(Format::Png),
            _ => None,
        }
    }
}

pub fn encode(format: Format, raster: &Raster, quality: u8) -> Result<Vec<u8>, String> {
    match format {
        Format::Jpeg => encode_jpeg(raster, quality),
        Format::Webp => Ok(encode_webp(raster, quality)),
        Format::Avif => encode_avif(raster, quality),
        Format::Png => encode_png(raster),
    }
}

fn encode_jpeg(raster: &Raster, quality: u8) -> Result<Vec<u8>, String> {
    let rgb = raster.flattened_rgb();
    std::panic::catch_unwind(|| {
        let mut compress = mozjpeg::Compress::new(mozjpeg::ColorSpace::JCS_RGB);
        compress.set_size(raster.width as usize, raster.height as usize);
        compress.set_quality(quality as f32);
        compress.set_progressive_mode();
        compress.set_optimize_scans(true);
        let mut started = compress.start_compress(Vec::new())?;
        started.write_scanlines(&rgb)?;
        started.finish()
    })
    .map_err(|_| "mozjpeg failed".to_string())?
    .map_err(|e| e.to_string())
}

fn encode_webp(raster: &Raster, quality: u8) -> Vec<u8> {
    let memory = if raster.alpha.is_some() {
        webp::Encoder::from_rgba(&raster.rgba(), raster.width, raster.height).encode(quality as f32)
    } else {
        webp::Encoder::from_rgb(&raster.rgb, raster.width, raster.height).encode(quality as f32)
    };
    memory.to_vec()
}

fn encode_png(raster: &Raster) -> Result<Vec<u8>, String> {
    let mut out = Cursor::new(Vec::new());
    let encoder = png::PngEncoder::new_with_quality(&mut out, png::CompressionType::Best, png::FilterType::Adaptive);
    let result = match &raster.alpha {
        Some(_) => encoder.write_image(&raster.rgba(), raster.width, raster.height, ExtendedColorType::Rgba8),
        None => encoder.write_image(&raster.rgb, raster.width, raster.height, ExtendedColorType::Rgb8),
    };
    result.map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

/// AVIF via rav1e at speed 8, which trades a little size for search throughput.
/// Pinned to one thread per encode: rav1e's output depends on its thread count,
/// and results must not vary with the machine's core count. The search runs
/// formats in parallel instead.
fn encode_avif(raster: &Raster, quality: u8) -> Result<Vec<u8>, String> {
    let (w, h) = (raster.width as usize, raster.height as usize);
    let encoder = ravif::Encoder::new()
        .with_quality(quality as f32)
        .with_alpha_quality(quality as f32)
        .with_speed(8)
        .with_num_threads(Some(1));
    let encoded = match &raster.alpha {
        Some(alpha) => {
            let pixels: Vec<rgb::RGBA8> = raster
                .rgb
                .chunks_exact(3)
                .zip(alpha)
                .map(|(p, &a)| rgb::RGBA8::new(p[0], p[1], p[2], a))
                .collect();
            encoder.encode_rgba(imgref::Img::new(pixels.as_slice(), w, h))
        }
        None => {
            let pixels: Vec<rgb::RGB8> = raster.rgb.chunks_exact(3).map(|p| rgb::RGB8::new(p[0], p[1], p[2])).collect();
            encoder.encode_rgb(imgref::Img::new(pixels.as_slice(), w, h))
        }
    };
    encoded.map(|e| e.avif_file).map_err(|e| e.to_string())
}
