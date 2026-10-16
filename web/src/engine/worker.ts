import { searchGif } from './gif';
import type { Effort } from './search';
import { createSyncCodec } from './syncCodec';
import type { Format, FormatResult } from './types';
import { searchAnimatedWebp } from './webpanim';
import init, { Source, bestEffort, initPanicHook, searchFormat } from '@core-wasm';

/**
 * Runs one search off the main thread: either a single still format, or the GIF search for an
 * animation. For stills the main thread starts one of these per format, in parallel, with no
 * shared memory. A still search is the shared Rust core (crates/kvgrainy-core, via
 * crates/kvgrainy-wasm) calling this format's synchronous codec; cancelling means terminating
 * the worker, since the core never yields to the event loop.
 */

export interface StartMessage {
  type: 'start';
  format: Format;
  limit: number;
  effort: Effort;
  width: number;
  height: number;
  data: ArrayBuffer;
}
export interface StartGifMessage {
  type: 'start-gif';
  /** What to write: a GIF, or an animated WebP. */
  output: 'gif' | 'webp';
  /** GIF-style loop value: 0 forever, -1 once, n times. */
  repeat: number;
  hasAlpha: boolean;
  limit: number;
  width: number;
  height: number;
  delays: number[];
  frames: ArrayBuffer[];
}
export type ToWorker = StartMessage | StartGifMessage | { type: 'cancel' };
export type FromWorker =
  | { type: 'progress'; steps: number }
  | { type: 'status'; text: string }
  | { type: 'done'; result: FormatResult }
  | { type: 'error'; message: string };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: FromWorker): void;
};

let cancelled = false;

scope.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type === 'cancel') {
    cancelled = true;
    return;
  }
  const progress = { cancelled: () => cancelled, report: (steps: number) => scope.postMessage({ type: 'progress', steps }) };
  try {
    if (msg.type === 'start-gif') {
      const search = msg.output === 'webp' ? searchAnimatedWebp : searchGif;
      const result = await search(
        {
          width: msg.width,
          height: msg.height,
          delays: msg.delays,
          frames: msg.frames.map((b) => new Uint8ClampedArray(b)),
          repeat: msg.repeat,
          hasAlpha: msg.hasAlpha,
        },
        msg.limit,
        { ...progress, status: (text) => scope.postMessage({ type: 'status', text }) },
      );
      scope.postMessage({ type: 'done', result });
      return;
    }
    await init();
    initPanicHook();
    const codec = await createSyncCodec(msg.format);
    const source = Source.fromRgba(msg.width, msg.height, new Uint8Array(msg.data));
    try {
      const outcome = searchFormat(source, codec, msg.format, msg.limit, msg.effort, progress.report);
      let result: FormatResult;
      if (outcome.found) {
        const quality = outcome.quality;
        result = {
          best: {
            bytes: outcome.bytes,
            format: outcome.format as Format,
            quality: quality >= 0 ? quality : undefined,
            scale: outcome.scale,
            score: outcome.score,
          },
          smallest: outcome.smallest,
        };
      } else {
        // Nothing fit: offer the smallest this format can make, clearly over the limit.
        const fallback = bestEffort(source, codec, msg.format, msg.effort);
        result = {
          smallest: fallback.found ? fallback.bytes.length : outcome.smallest,
          smallestBytes: fallback.found ? fallback.bytes : undefined,
          smallestFormat: msg.format,
        };
        fallback.free();
      }
      outcome.free();
      scope.postMessage({ type: 'done', result });
    } finally {
      source.free();
    }
  } catch (err) {
    scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
