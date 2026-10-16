import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Source } from './engine';
import type { OptimizeOptions } from './engine';
import type { OptimizeResult, OutputFormat } from './types';

/**
 * The desktop build's stills engine: the same Rust core as the web build, run natively (mozjpeg,
 * libwebp, rav1e, imagequant, oxipng) on every core, through the commands in desktop/src-tauri.
 * The original file goes over as raw bytes, so the Rust side does the decoding: EXIF orientation,
 * ICC colour conversion, full resolution, no canvas limits.
 */

export type { Source };

/** Read just enough of the image to show its size; the pixels are never held here. */
export async function loadSource(file: Blob): Promise<Source> {
  const bitmap = await createImageBitmap(file);
  try {
    return { raster: { width: bitmap.width, height: bitmap.height, data: new Uint8ClampedArray(0) }, hasAlpha: false, file };
  } finally {
    bitmap.close();
  }
}

interface Meta {
  outcome: 'ok' | 'nothing-fits' | 'cancelled' | 'not-animated';
  format?: OutputFormat;
  /** `null` for a format without a quality (lossless PNG): Rust serializes its `None` that way. */
  quality?: number | null;
  scale: number;
  score: number;
  limit: number;
  smallest: number;
}

/** Reply layout from `optimize_image`: u32 little-endian JSON length, the JSON, then the file bytes. */
function parseReply(reply: ArrayBuffer): { meta: Meta; bytes: Uint8Array } {
  const metaLength = new DataView(reply).getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(reply, 4, metaLength))) as Meta;
  return { meta, bytes: new Uint8Array(reply, 4 + metaLength) };
}

export async function optimizeImage(
  source: Source,
  options: OptimizeOptions,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<OptimizeResult> {
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  if (!source.file) throw new Error('The desktop engine needs the original file.');
  const id = crypto.randomUUID();
  const body = await source.file.arrayBuffer();
  const name = (source.file as File).name ?? '';
  const mayAnimate = ['image/gif', 'image/webp', 'image/png'].includes(source.file.type) || /\.(gif|webp|png)$/i.test(name);

  const unlisten = await listen<{ id: string; fraction: number }>('optimize-progress', (event) => {
    if (event.payload.id === id) onProgress(Math.min(1, event.payload.fraction));
  });
  const cancel = () => void invoke('cancel_optimize', { id });
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const headers = { 'x-job-id': id, 'x-limit': String(options.limit), 'x-format': options.format ?? '', 'x-effort': options.effort };
    // An animated GIF, WebP or PNG is fitted as a GIF by the native animation search; a still reports
    // "not-animated" after a header read and goes on to the still search.
    let parsed = mayAnimate ? parseReply(await invoke<ArrayBuffer>('optimize_animation', body, { headers })) : undefined;
    if (!parsed || parsed.meta.outcome === 'not-animated') parsed = parseReply(await invoke<ArrayBuffer>('optimize_image', body, { headers }));
    const { meta, bytes } = parsed;
    if (meta.outcome === 'cancelled') throw new DOMException('Cancelled', 'AbortError');
    onProgress(1);
    if (meta.outcome === 'ok' && meta.format) {
      return { ok: true, candidate: { bytes, format: meta.format, quality: meta.quality ?? undefined, scale: meta.scale, score: meta.score } };
    }
    return {
      ok: false,
      limit: options.limit,
      smallest: meta.smallest,
      bestEffort: bytes.length > 0 && meta.format ? { bytes, format: meta.format } : undefined,
    };
  } finally {
    signal.removeEventListener('abort', cancel);
    unlisten();
  }
}
