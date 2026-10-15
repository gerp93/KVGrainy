import type { Raster } from './types';

/**
 * A cheap similarity proxy: SSIM on luma (8x8 windows, stride 4) blended with a
 * chroma error term and a block-averaged colour term. Alpha is judged composited over white, as a JPEG viewer
 * would see it. It is NOT SSIMULACRA2; Phase 1 of PLAN.md measures how well it
 * ranks candidates against the real metric.
 */
const ANALYSIS_MAX_PIXELS = 4_000_000;
const WINDOW = 8;
const STRIDE = 4;
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

interface Planes {
  y: Float32Array;
  cb: Float32Array;
  cr: Float32Array;
}

function planes(r: Raster): Planes {
  const n = r.width * r.height;
  const y = new Float32Array(n);
  const cb = new Float32Array(n);
  const cr = new Float32Array(n);
  const d = r.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = d[p + 3]! / 255;
    const red = d[p]! * a + 255 * (1 - a);
    const green = d[p + 1]! * a + 255 * (1 - a);
    const blue = d[p + 2]! * a + 255 * (1 - a);
    y[i] = 0.299 * red + 0.587 * green + 0.114 * blue;
    cb[i] = -0.168736 * red - 0.331264 * green + 0.5 * blue;
    cr[i] = 0.5 * red - 0.418688 * green - 0.081312 * blue;
  }
  return { y, cb, cr };
}

/**
 * Mean colour of each k x k block (alpha composited over white). Comparing these ignores
 * fine noise but catches posterisation and banding, which is what SSIM misses on noisy
 * content and what palette reduction (GIF) mostly does.
 */
const BLOCKS_ACROSS_SHORT_SIDE = 48;
/** RGB error (0..255 scale) at which the colour term reaches zero. */
const BLOCK_ERROR_RANGE = 40;

function blockMeans(r: Raster): Float32Array {
  const k = Math.max(1, Math.floor(Math.min(r.width, r.height) / BLOCKS_ACROSS_SHORT_SIDE));
  const bw = Math.max(1, Math.floor(r.width / k));
  const bh = Math.max(1, Math.floor(r.height / k));
  const out = new Float32Array(bw * bh * 3);
  const d = r.data;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let n = 0;
      for (let y = by * k; y < Math.min(r.height, (by + 1) * k); y++) {
        for (let x = bx * k; x < Math.min(r.width, (bx + 1) * k); x++) {
          const p = (y * r.width + x) * 4;
          const a = d[p + 3]! / 255;
          red += d[p]! * a + 255 * (1 - a);
          green += d[p + 1]! * a + 255 * (1 - a);
          blue += d[p + 2]! * a + 255 * (1 - a);
          n++;
        }
      }
      const o = (by * bw + bx) * 3;
      out[o] = red / n;
      out[o + 1] = green / n;
      out[o + 2] = blue / n;
    }
  }
  return out;
}

function blockColorSimilarity(a: Float32Array, b: Float32Array): number {
  let squares = 0;
  for (let i = 0; i < a.length; i++) squares += (a[i]! - b[i]!) ** 2;
  return Math.max(0, 1 - Math.sqrt(squares / a.length) / BLOCK_ERROR_RANGE);
}

export class Reference {
  readonly width: number;
  readonly height: number;
  private readonly ref: Planes;
  private readonly refBlocks: Float32Array;

  /** `analysis` is the original, already shrunk by {@link Reference.analysisFactor} if it was large. */
  constructor(analysis: Raster) {
    this.width = analysis.width;
    this.height = analysis.height;
    this.ref = planes(analysis);
    this.refBlocks = blockMeans(analysis);
  }

  /** Factor to shrink an original by so scoring stays cheap on big images (1 if already small). */
  static analysisFactor(width: number, height: number): number {
    const pixels = width * height;
    return pixels <= ANALYSIS_MAX_PIXELS ? 1 : Math.sqrt(ANALYSIS_MAX_PIXELS / pixels);
  }

  /** Similarity in 0..1 of `candidate` (same size as the reference) to the original; 1 is identical. */
  score(candidate: Raster): number {
    if (candidate.width !== this.width || candidate.height !== this.height) {
      throw new Error('candidate must be scored at the reference size');
    }
    const cand = planes(candidate);
    const luma =
      this.width < WINDOW || this.height < WINDOW
        ? pixelSimilarity(this.ref.y, cand.y)
        : ssim(this.ref.y, cand.y, this.width, this.height);
    const chroma = chromaSimilarity(this.ref, cand);
    const blocks = blockColorSimilarity(this.refBlocks, blockMeans(candidate));
    return Math.min(1, Math.max(0, 0.5 * luma + 0.15 * chroma + 0.35 * blocks));
  }
}

function ssim(a: Float32Array, b: Float32Array, width: number, height: number): number {
  const count = WINDOW * WINDOW;
  let total = 0;
  let windows = 0;
  for (let y0 = 0; y0 + WINDOW <= height; y0 += STRIDE) {
    for (let x0 = 0; x0 + WINDOW <= width; x0 += STRIDE) {
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      for (let y = y0; y < y0 + WINDOW; y++) {
        let i = y * width + x0;
        for (let x = 0; x < WINDOW; x++, i++) {
          const va = a[i]!;
          const vb = b[i]!;
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
      }
      const ma = sa / count;
      const mb = sb / count;
      const varA = saa / count - ma * ma;
      const varB = sbb / count - mb * mb;
      const cov = sab / count - ma * mb;
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (varA + varB + C2));
      windows++;
    }
  }
  return windows === 0 ? 1 : total / windows;
}

function pixelSimilarity(a: Float32Array, b: Float32Array): number {
  let squares = 0;
  for (let i = 0; i < a.length; i++) squares += (a[i]! - b[i]!) ** 2;
  return Math.max(0, 1 - Math.sqrt(squares / a.length) / 255);
}

function chromaSimilarity(a: Planes, b: Planes): number {
  let squares = 0;
  const n = a.cb.length;
  for (let i = 0; i < n; i++) squares += (a.cb[i]! - b.cb[i]!) ** 2 + (a.cr[i]! - b.cr[i]!) ** 2;
  return Math.max(0, 1 - Math.sqrt(squares / (2 * n)) / 64);
}
