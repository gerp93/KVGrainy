use fast_image_resize::{images::Image, FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};

/// An 8-bit sRGB image: tightly packed RGB plus an optional alpha plane.
#[derive(Clone, Debug)]
pub struct Raster {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
    pub alpha: Option<Vec<u8>>,
}

impl Raster {
    /// Scale to `factor` of the current size (never below 1x1) using Lanczos3.
    pub fn scaled(&self, factor: f32) -> Raster {
        if (factor - 1.0).abs() < f32::EPSILON {
            return self.clone();
        }
        let width = ((self.width as f32 * factor) as u32).max(1);
        let height = ((self.height as f32 * factor) as u32).max(1);
        self.resized(width, height)
    }

    pub fn resized(&self, width: u32, height: u32) -> Raster {
        if (width, height) == (self.width, self.height) {
            return self.clone();
        }
        Raster {
            width,
            height,
            rgb: resize_plane(&self.rgb, self.width, self.height, width, height, PixelType::U8x3),
            alpha: self
                .alpha
                .as_ref()
                .map(|a| resize_plane(a, self.width, self.height, width, height, PixelType::U8)),
        }
    }

    /// RGB with transparency composited over white (what a JPEG viewer sees).
    pub fn flattened_rgb(&self) -> Vec<u8> {
        let Some(alpha) = &self.alpha else {
            return self.rgb.clone();
        };
        self.rgb
            .chunks_exact(3)
            .zip(alpha)
            .flat_map(|(px, &a)| {
                let a = a as u32;
                px.iter().map(move |&c| ((c as u32 * a + 255 * (255 - a) + 127) / 255) as u8)
            })
            .collect()
    }

    pub fn rgba(&self) -> Vec<u8> {
        let alpha = self.alpha.as_deref();
        self.rgb
            .chunks_exact(3)
            .enumerate()
            .flat_map(|(i, px)| [px[0], px[1], px[2], alpha.map_or(255, |a| a[i])])
            .collect()
    }
}

fn resize_plane(data: &[u8], sw: u32, sh: u32, dw: u32, dh: u32, pixel: PixelType) -> Vec<u8> {
    let src = Image::from_vec_u8(sw, sh, data.to_vec(), pixel).expect("plane size matches dimensions");
    let mut dst = Image::new(dw, dh, pixel);
    let options = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3));
    Resizer::new()
        .resize(&src, &mut dst, &options)
        .expect("resize of matching pixel types cannot fail");
    dst.into_vec()
}
