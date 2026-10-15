import { jsquashCodec } from './codecs';
import { searchGif } from './gif';
import { Reference } from './metric';
import { searchFormat } from './search';
import type { Format, FormatResult } from './types';
import { searchAnimatedWebp } from './webpanim';

/**
 * Runs one search off the main thread: either a single still format, or the GIF search for an
 * animation. For stills the main thread starts one of these per format, in parallel, with no
 * shared memory.
 */

export interface StartMessage {
  type: 'start';
  format: Format;
  limit: number;
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
    const source = { width: msg.width, height: msg.height, data: new Uint8ClampedArray(msg.data) };
    const factor = Reference.analysisFactor(source.width, source.height);
    const analysis = factor < 1 ? await jsquashCodec.scale(source, factor) : source;
    const reference = new Reference(analysis);
    const result = await searchFormat(jsquashCodec, reference, source, msg.limit, msg.format, progress);
    scope.postMessage({ type: 'done', result });
  } catch (err) {
    scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
