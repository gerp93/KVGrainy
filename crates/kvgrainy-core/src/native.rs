//! The native codec set: mozjpeg, libwebp, rav1e (AVIF), and PNG via the `image` crate,
//! `imagequant` (palette quantization) and `oxipng` (lossless recompression). This is the only module that depends on C codecs, so a target without
//! them (a browser build) supplies its own [`Encoder`] instead.

use std::io::Cursor;

use image::{codecs::png as image_png, ExtendedColorType, ImageEncoder};

use crate::encode::{Encoder, Format};
use crate::raster::Raster;

/// Encodes and decodes with the native libraries. Stateless and cheap to copy.
#[derive(Clone, Copy, Debug, Default)]
pub struct NativeEncoder;

impl Encoder for NativeEncoder {
    fn encode(&self, format: Format, raster: &Raster, quality: u8) -> Result<Vec<u8>, String> {
        match format {
            Format::Jpeg => encode_jpeg(raster, quality),
            Format::Webp => Ok(encode_webp(raster, quality)),
            Format::Avif => encode_avif(raster, quality),
            Format::Png => encode_png(raster, None),
            Format::PngPalette => encode_png(raster, Some(quality)),
        }
    }

    fn decode(&self, format: Format, payload: &[u8]) -> Option<Raster> {
        if format == Format::Avif {
            return decode_avif(payload);
        }
        crate::load::decode(payload).ok().map(|loaded| loaded.raster)
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

/// PNG, recompressed by oxipng. `None` is lossless (oxipng can still turn an image with few
/// colours into a palette PNG without changing a pixel); `Some(quality)` quantizes to a palette
/// with imagequant, the way pngquant does, which is what lets flat graphics shrink.
fn encode_png(raster: &Raster, quality: Option<u8>) -> Result<Vec<u8>, String> {
    let base = match quality {
        None => truecolor_png(raster)?,
        Some(quality) => palette_png(raster, quality)?,
    };
    let mut options = oxipng::Options::from_preset(2);
    options.strip = oxipng::StripChunks::Safe;
    oxipng::optimize_from_memory(&base, &options).or(Ok(base))
}

fn truecolor_png(raster: &Raster) -> Result<Vec<u8>, String> {
    let mut out = Cursor::new(Vec::new());
    let encoder = image_png::PngEncoder::new_with_quality(&mut out, image_png::CompressionType::Fast, image_png::FilterType::Adaptive);
    let result = match &raster.alpha {
        Some(_) => encoder.write_image(&raster.rgba(), raster.width, raster.height, ExtendedColorType::Rgba8),
        None => encoder.write_image(&raster.rgb, raster.width, raster.height, ExtendedColorType::Rgb8),
    };
    result.map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

/// Indexed PNG from an imagequant palette. `quality` becomes imagequant's target quality:
/// it uses as few colours (at most 256) as that target allows.
fn palette_png(raster: &Raster, quality: u8) -> Result<Vec<u8>, String> {
    let mut attributes = imagequant::Attributes::new();
    attributes.set_quality(0, quality).map_err(|e| e.to_string())?;
    attributes.set_speed(4).map_err(|e| e.to_string())?;
    let pixels: Vec<imagequant::RGBA> = raster.rgba().chunks_exact(4).map(|p| imagequant::RGBA::new(p[0], p[1], p[2], p[3])).collect();
    let mut image = attributes
        .new_image(pixels, raster.width as usize, raster.height as usize, 0.0)
        .map_err(|e| e.to_string())?;
    let mut quantized = attributes.quantize(&mut image).map_err(|e| e.to_string())?;
    quantized.set_dithering_level(1.0).map_err(|e| e.to_string())?;
    let (palette, indices) = quantized.remapped(&mut image).map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, raster.width, raster.height);
    encoder.set_color(png::ColorType::Indexed);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_palette(palette.iter().flat_map(|c| [c.r, c.g, c.b]).collect::<Vec<u8>>());
    if palette.iter().any(|c| c.a != 255) {
        encoder.set_trns(palette.iter().map(|c| c.a).collect::<Vec<u8>>());
    }
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(&indices).map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())?;
    Ok(out)
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
