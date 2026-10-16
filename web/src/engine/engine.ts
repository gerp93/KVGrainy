import type { FrameSource } from './frames';
import { SCALE_FACTORS, chooseBest, formatsFor, type Effort } from './search';
import type { Format, FormatResult, OptimizeResult, Raster } from './types';
import type { FromWorker, ToWorker } from './worker';

/** Refuse inputs above this many pixels: the working copies would not fit in a phone's memory. */
const MAX_PIXELS = 50_000_000;

export interface Source {
  raster: Raster;
  hasAlpha: boolean;
  /** The original file, kept for hosts that decode it themselves (the desktop app sends it to the native core). */
  file?: Blob;
}

export interface OptimizeOptions {
  limit: number;
  /** Force one output format; otherwise the best of the suitable ones. */
  format?: Format;
  effort: Effort;
}

/**
 * Decode an image file to RGBA with the browser's decoder: EXIF orientation applied and
 * colour converted to sRGB. Metadata is never carried to the output, because outputs are
 * re-encoded from pixels.
 */
export async function loadSource(file: Blob): Promise<Source> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image', colorSpaceConversion: 'default' });
  try {
    const { width, height } = bitmap;
    if (width * height > MAX_PIXELS) {
      throw new Error(`This image is ${(width * height / 1e6).toFixed(0)} megapixels; the limit here is ${MAX_PIXELS / 1e6}.`);
    }
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not read the image (no canvas available).');
    ctx.drawImage(bitmap, 0, 0);
    const image = ctx.getImageData(0, 0, width, height);
    return { raster: { width, height, data: image.data }, hasAlpha: hasTransparency(image.data) };
  } finally {
    bitmap.close();
  }
}

function hasTransparency(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true;
  return false;
}

/**
 * Search for the best version of `source` under `options.limit` bytes. One Web Worker per
 * format, run in parallel. Aborting `signal` stops the workers and rejects with an AbortError.
 */
export function optimizeImage(
  source: Source,
  options: OptimizeOptions,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<OptimizeResult> {
  const formats = formatsFor(source.hasAlpha, options.format, options.effort);
  const total = formats.length * SCALE_FACTORS.length;
  return new Promise((resolve, reject) => {
    const workers: Worker[] = [];
    const results: FormatResult[] = [];
    let completed = 0;
    let settled = false;

    const stop = () => workers.forEach((w) => w.terminate());
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      stop();
      reject(error);
    };
    if (signal.aborted) return fail(new DOMException('Cancelled', 'AbortError'));
    signal.addEventListener('abort', () => fail(new DOMException('Cancelled', 'AbortError')), { once: true });

    for (const format of formats) {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      workers.push(worker);
      worker.onmessage = (event: MessageEvent<FromWorker>) => {
        const msg = event.data;
        if (msg.type === 'progress') {
          completed += msg.steps;
          onProgress(Math.min(1, completed / total));
        } else if (msg.type === 'done') {
          results.push(msg.result);
          worker.terminate();
          if (results.length === formats.length && !settled) {
            settled = true;
            onProgress(1);
            resolve(chooseBest(results, options.limit));
          }
        } else if (msg.type === 'error') {
          fail(new Error(msg.message));
        }
      };
      worker.onerror = (e) => fail(new Error(e.message || 'The image worker crashed.'));
      // Each worker gets its own copy of the pixels: no shared memory, so no cross-origin isolation needed.
      const copy = source.raster.data.slice().buffer as ArrayBuffer;
      const message: ToWorker = {
        type: 'start',
        format,
        limit: options.limit,
        effort: options.effort,
        width: source.raster.width,
        height: source.raster.height,
        data: copy,
      };
      worker.postMessage(message, [copy]);
    }
  });
}

/**
 * Fit an animation (a GIF, animated WebP or video, already turned into frames) under
 * `limit` bytes as a GIF. One worker; aborting `signal` stops it and rejects with an AbortError.
 */
export function optimizeAnimation(
  source: FrameSource,
  limit: number,
  output: 'gif' | 'webp',
  onProgress: (fraction: number) => void,
  onStatus: (text: string) => void,
  signal: AbortSignal,
): Promise<OptimizeResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    let completed = 0;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(error);
    };
    if (signal.aborted) return fail(new DOMException('Cancelled', 'AbortError'));
    signal.addEventListener('abort', () => fail(new DOMException('Cancelled', 'AbortError')), { once: true });

    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const msg = event.data;
      if (msg.type === 'progress') {
        completed += msg.steps;
        onProgress(Math.min(1, completed / SCALE_FACTORS.length));
      } else if (msg.type === 'status') {
        onStatus(msg.text);
      } else if (msg.type === 'done') {
        if (settled) return;
        settled = true;
        worker.terminate();
        onProgress(1);
        const { best, smallest, smallestBytes } = msg.result;
        resolve(
          best
            ? { ok: true, candidate: best }
            : { ok: false, limit, smallest, bestEffort: smallestBytes ? { bytes: smallestBytes, format: output } : undefined },
        );
      } else {
        fail(new Error(msg.message));
      }
    };
    worker.onerror = (e) => fail(new Error(e.message || 'The image worker crashed.'));
    // Copies, so "Run again" still has the original frames.
    const frames = source.frames.map((f) => f.slice().buffer as ArrayBuffer);
    const message: ToWorker = {
      type: 'start-gif',
      output,
      repeat: source.repeat,
      hasAlpha: source.hasAlpha,
      limit,
      width: source.width,
      height: source.height,
      delays: source.delays,
      frames,
    };
    worker.postMessage(message, frames);
  });
}
