use std::io::Cursor;
use std::path::Path;

use image::{DynamicImage, ImageDecoder, ImageReader};
use moxcms::{ColorProfile, Layout, TransformOptions};

use crate::raster::Raster;

#[derive(Debug, thiserror::Error)]
pub enum LoadError {
    #[error("could not read image: {0}")]
    Io(#[from] std::io::Error),
    #[error("could not decode image: {0}")]
    Decode(#[from] image::ImageError),
}

/// A decoded, upright, sRGB image plus anything notable that happened on load.
pub struct Loaded {
    pub raster: Raster,
    pub warnings: Vec<String>,
}

pub fn load_image(path: &Path) -> Result<Loaded, LoadError> {
    decode(&std::fs::read(path)?)
}

/// Decode `bytes`, apply EXIF orientation, and convert any embedded ICC profile to sRGB.
///
/// Encoders here never embed the source profile, so wide-gamut sources must be
/// converted up front or their colors shift in every viewer. Metadata (EXIF, GPS)
/// is never carried to the output.
pub fn decode(bytes: &[u8]) -> Result<Loaded, LoadError> {
    let mut decoder = ImageReader::new(Cursor::new(bytes)).with_guessed_format()?.into_decoder()?;
    let orientation = decoder.orientation()?;
    let icc = decoder.icc_profile()?;
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);

    let mut warnings = Vec::new();
    let (width, height) = (image.width(), image.height());
    let mut rgb = image.to_rgb8().into_raw();
    if let Some(icc) = icc {
        match to_srgb(&icc, &rgb) {
            Ok(converted) => rgb = converted,
            Err(why) => warnings.push(format!("unusable ICC profile ({why}); assuming sRGB")),
        }
    }
    let alpha = image.color().has_alpha().then(|| {
        let a: Vec<u8> = image.to_rgba8().pixels().map(|p| p.0[3]).collect();
        a
    });
    let alpha = alpha.filter(|a| a.iter().any(|&v| v != 255));
    Ok(Loaded { raster: Raster { width, height, rgb, alpha }, warnings })
}

fn to_srgb(icc: &[u8], rgb: &[u8]) -> Result<Vec<u8>, String> {
    let source = ColorProfile::new_from_slice(icc).map_err(|e| e.to_string())?;
    let transform = source
        .create_transform_8bit(Layout::Rgb, &ColorProfile::new_srgb(), Layout::Rgb, TransformOptions::default())
        .map_err(|e| e.to_string())?;
    let mut out = vec![0u8; rgb.len()];
    transform.transform(rgb, &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}
