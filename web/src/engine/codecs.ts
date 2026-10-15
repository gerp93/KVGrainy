import { FORMAT_INFO, type Codec, type Format, type Raster } from './types';

/**
 * Browser codecs: the jSquash WASM packages (mozjpeg, libwebp, libavif, oxipng, lanczos
 * resize; all Apache-2.0). Each is imported on first use, so a worker that only searches
 * one format never downloads the others. Runs inside a Web Worker.
 */

function toImageData(r: Raster): ImageData {
  return new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, r.width, r.height);
}

function fromImageData(d: ImageData): Raster {
  return { width: d.width, height: d.height, data: d.data };
}

/** Composite over white (what a JPEG viewer sees); returns the input untouched when fully opaque. */
function flattenOverWhite(r: Raster): Raster {
  const d = r.data;
  let opaque = true;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] !== 255) {
      opaque = false;
      break;
    }
  }
  if (opaque) return r;
  const out = new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]! / 255;
    out[i] = d[i]! * a + 255 * (1 - a);
    out[i + 1] = d[i + 1]! * a + 255 * (1 - a);
    out[i + 2] = d[i + 2]! * a + 255 * (1 - a);
    out[i + 3] = 255;
  }
  return { width: r.width, height: r.height, data: out };
}

async function encode(format: Format, raster: Raster, quality: number): Promise<Uint8Array> {
  switch (format) {
    case 'jpeg': {
      const { encode: encodeJpeg } = await import('@jsquash/jpeg');
      return new Uint8Array(await encodeJpeg(toImageData(flattenOverWhite(raster)), { quality }));
    }
    case 'webp': {
      const { encode: encodeWebp } = await import('@jsquash/webp');
      return new Uint8Array(await encodeWebp(toImageData(raster), { quality }));
    }
    case 'avif': {
      const { encode: encodeAvif } = await import('@jsquash/avif');
      // Speed 8 trades a little size for search throughput, as in the desktop engine.
      return new Uint8Array(await encodeAvif(toImageData(raster), { quality, speed: 8 }));
    }
    case 'png': {
      const [{ encode: encodePng }, { optimise }] = await Promise.all([import('@jsquash/png'), import('@jsquash/oxipng')]);
      const png = await encodePng(toImageData(raster));
      return new Uint8Array(await optimise(png, { level: 2 }));
    }
  }
}

async function scale(raster: Raster, factor: number): Promise<Raster> {
  if (Math.abs(factor - 1) < Number.EPSILON) return raster;
  const width = Math.max(1, Math.floor(raster.width * factor));
  const height = Math.max(1, Math.floor(raster.height * factor));
  if (width === raster.width && height === raster.height) return raster;
  const { default: resize } = await import('@jsquash/resize');
  return fromImageData(await resize(toImageData(raster), { width, height, method: 'lanczos3' }));
}

/** Decode with the browser's own decoder and draw at the requested size. */
async function decode(format: Format, bytes: Uint8Array, width: number, height: number): Promise<Raster | null> {
  try {
    const blob = new Blob([bytes as BlobPart], { type: FORMAT_INFO[format].mime });
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, width, height);
      return fromImageData(ctx.getImageData(0, 0, width, height));
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

export const jsquashCodec: Codec = { encode, scale, decode };
