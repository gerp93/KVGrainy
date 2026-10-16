use crate::raster::Raster;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Format {
    Jpeg,
    Webp,
    Avif,
    /// Lossless PNG (oxipng-recompressed; a palette is used only when it changes no pixel).
    Png,
    /// Lossy palette PNG, like pngquant: `quality` sets how closely the palette must match.
    PngPalette,
}

impl Format {
    pub fn extension(self) -> &'static str {
        match self {
            Format::Jpeg => "jpg",
            Format::Webp => "webp",
            Format::Avif => "avif",
            Format::Png | Format::PngPalette => "png",
        }
    }

    /// Whether quality is a tunable knob (lossless PNG has none).
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

/// The codec layer the search runs on top of. Search, scoring, resizing and
/// colour handling are codec-agnostic; everything that touches an image codec
/// goes through this trait, so a target without the native C libraries (a browser
/// build) can supply its own implementation.
///
/// `Sync` because the search encodes different formats on different threads.
pub trait Encoder: Sync {
    /// Encode `raster` as `format`. `quality` is `1..=100`; formats without a
    /// quality knob (see [`Format::has_quality`]) ignore it.
    fn encode(&self, format: Format, raster: &Raster, quality: u8) -> Result<Vec<u8>, String>;

    /// Decode an output this encoder produced, so the scorer can compare it to the
    /// original. `None` if the payload cannot be decoded (it then scores 0).
    fn decode(&self, format: Format, payload: &[u8]) -> Option<Raster>;

    /// Whether this encoder can produce `format`. The search skips formats it cannot (a
    /// browser build has no palette-PNG quantizer, for one).
    fn supports(&self, _format: Format) -> bool {
        true
    }
}

/// Encode with the native codecs. Shorthand for `NativeEncoder.encode(..)`.
#[cfg(feature = "native")]
pub fn encode(format: Format, raster: &Raster, quality: u8) -> Result<Vec<u8>, String> {
    crate::native::NativeEncoder.encode(format, raster, quality)
}
