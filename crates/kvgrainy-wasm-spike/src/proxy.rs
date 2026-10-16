//! Cheap similarity proxies for the Phase 1.4 study. Pure Rust, no threads, so they run
//! the same natively and in WASM.
//!
//! [`ProxyKind::Blended`] is a port of `web/src/engine/metric.ts` (luma SSIM + chroma
//! error + block-averaged colour). [`ProxyKind::LumaSsim`] is luma SSIM alone.

use kvgrainy_core::raster::Raster;

const WINDOW: usize = 8;
const STRIDE: usize = 4;
const C1: f32 = (0.01 * 255.0) * (0.01 * 255.0);
const C2: f32 = (0.03 * 255.0) * (0.03 * 255.0);
const BLOCKS_ACROSS_SHORT_SIDE: usize = 48;
const BLOCK_ERROR_RANGE: f32 = 40.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProxyKind {
    /// Luma SSIM only.
    LumaSsim,
    /// 0.5 luma SSIM + 0.15 chroma + 0.35 block colour, as in the web engine.
    Blended,
}

struct Planes {
    y: Vec<f32>,
    cb: Vec<f32>,
    cr: Vec<f32>,
}

fn planes(rgb: &[u8]) -> Planes {
    let n = rgb.len() / 3;
    let (mut y, mut cb, mut cr) = (Vec::with_capacity(n), Vec::with_capacity(n), Vec::with_capacity(n));
    for p in rgb.chunks_exact(3) {
        let (r, g, b) = (p[0] as f32, p[1] as f32, p[2] as f32);
        y.push(0.299 * r + 0.587 * g + 0.114 * b);
        cb.push(-0.168736 * r - 0.331264 * g + 0.5 * b);
        cr.push(0.5 * r - 0.418688 * g - 0.081312 * b);
    }
    Planes { y, cb, cr }
}

/// Mean colour of each k x k block, with `k` chosen so the short side has ~48 blocks.
fn block_means(rgb: &[u8], width: usize, height: usize) -> Vec<f32> {
    let k = (width.min(height) / BLOCKS_ACROSS_SHORT_SIDE).max(1);
    let (bw, bh) = ((width / k).max(1), (height / k).max(1));
    let mut out = Vec::with_capacity(bw * bh * 3);
    for by in 0..bh {
        for bx in 0..bw {
            let (mut r, mut g, mut b, mut n) = (0f32, 0f32, 0f32, 0f32);
            for y in by * k..((by + 1) * k).min(height) {
                for x in bx * k..((bx + 1) * k).min(width) {
                    let i = (y * width + x) * 3;
                    r += rgb[i] as f32;
                    g += rgb[i + 1] as f32;
                    b += rgb[i + 2] as f32;
                    n += 1.0;
                }
            }
            out.extend_from_slice(&[r / n, g / n, b / n]);
        }
    }
    out
}

fn ssim(a: &[f32], b: &[f32], width: usize, height: usize) -> f32 {
    let count = (WINDOW * WINDOW) as f32;
    let (mut total, mut windows) = (0f64, 0u64);
    let mut y0 = 0;
    while y0 + WINDOW <= height {
        let mut x0 = 0;
        while x0 + WINDOW <= width {
            let (mut sa, mut sb, mut saa, mut sbb, mut sab) = (0f32, 0f32, 0f32, 0f32, 0f32);
            for y in y0..y0 + WINDOW {
                let row = y * width + x0;
                for (&va, &vb) in a[row..row + WINDOW].iter().zip(&b[row..row + WINDOW]) {
                    sa += va;
                    sb += vb;
                    saa += va * va;
                    sbb += vb * vb;
                    sab += va * vb;
                }
            }
            let (ma, mb) = (sa / count, sb / count);
            let (var_a, var_b, cov) = (saa / count - ma * ma, sbb / count - mb * mb, sab / count - ma * mb);
            total += (((2.0 * ma * mb + C1) * (2.0 * cov + C2)) / ((ma * ma + mb * mb + C1) * (var_a + var_b + C2))) as f64;
            windows += 1;
            x0 += STRIDE;
        }
        y0 += STRIDE;
    }
    if windows == 0 {
        1.0
    } else {
        (total / windows as f64) as f32
    }
}

fn pixel_similarity(a: &[f32], b: &[f32]) -> f32 {
    let squares: f32 = a.iter().zip(b).map(|(x, y)| (x - y) * (x - y)).sum();
    (1.0 - (squares / a.len() as f32).sqrt() / 255.0).max(0.0)
}

fn chroma_similarity(a: &Planes, b: &Planes) -> f32 {
    let n = a.cb.len() as f32;
    let squares: f32 = a.cb.iter().zip(&b.cb).map(|(x, y)| (x - y) * (x - y)).sum::<f32>()
        + a.cr.iter().zip(&b.cr).map(|(x, y)| (x - y) * (x - y)).sum::<f32>();
    (1.0 - (squares / (2.0 * n)).sqrt() / 64.0).max(0.0)
}

fn block_similarity(a: &[f32], b: &[f32]) -> f32 {
    let squares: f32 = a.iter().zip(b).map(|(x, y)| (x - y) * (x - y)).sum();
    (1.0 - (squares / a.len() as f32).sqrt() / BLOCK_ERROR_RANGE).max(0.0)
}

/// The original prepared once; candidates must be passed at the same size.
pub struct ProxyRef {
    kind: ProxyKind,
    width: usize,
    height: usize,
    planes: Planes,
    blocks: Vec<f32>,
}

impl ProxyRef {
    pub fn new(analysis: &Raster, kind: ProxyKind) -> ProxyRef {
        let (width, height) = (analysis.width as usize, analysis.height as usize);
        let flat = analysis.flattened_rgb();
        let blocks = if kind == ProxyKind::Blended { block_means(&flat, width, height) } else { Vec::new() };
        ProxyRef { kind, width, height, planes: planes(&flat), blocks }
    }

    /// Similarity in `0.0..=1.0`; 1 is identical.
    pub fn score(&self, candidate: &Raster) -> f64 {
        assert_eq!((candidate.width as usize, candidate.height as usize), (self.width, self.height), "score at the reference size");
        let flat = candidate.flattened_rgb();
        let cand = planes(&flat);
        let luma = if self.width < WINDOW || self.height < WINDOW {
            pixel_similarity(&self.planes.y, &cand.y)
        } else {
            ssim(&self.planes.y, &cand.y, self.width, self.height)
        };
        match self.kind {
            ProxyKind::LumaSsim => luma.clamp(0.0, 1.0) as f64,
            ProxyKind::Blended => {
                let chroma = chroma_similarity(&self.planes, &cand);
                let blocks = block_similarity(&self.blocks, &block_means(&flat, self.width, self.height));
                (0.5 * luma + 0.15 * chroma + 0.35 * blocks).clamp(0.0, 1.0) as f64
            }
        }
    }
}
