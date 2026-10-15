import { GifSession } from './gif';
import { GifTuner, type Priority } from './tuner';

/**
 * Holds one animation's frames and a {@link GifTuner} for the Fine-Tune tool, so slider moves
 * are encoded off the main thread and every ladder step is cached.
 */

export interface InitMessage {
  type: 'init';
  width: number;
  height: number;
  delays: number[];
  repeat: number;
  frames: ArrayBuffer[];
}
export type TunerRequest =
  | InitMessage
  | { type: 'bounds'; id: number; priority: Priority; limit: number }
  | { type: 'encode'; id: number; priority: Priority; index: number };
export type TunerReply =
  | { type: 'ready' }
  | { type: 'bounds'; id: number; index: number }
  | { type: 'encoded'; id: number; bytes: Uint8Array }
  /** An encode that was replaced by a newer one before it started, so nobody is waiting on it. */
  | { type: 'skipped'; id: number }
  | { type: 'error'; id?: number; message: string };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<TunerRequest>) => void) | null;
  postMessage(message: TunerReply, transfer?: Transferable[]): void;
};

let tuner: GifTuner | undefined;
let latestEncode = 0;
// Requests run one at a time, in order; a drag across the slider queues many encodes and only the last matters.
let chain: Promise<void> = Promise.resolve();

scope.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'encode') latestEncode = Math.max(latestEncode, msg.id);
  chain = chain.then(() => handle(msg)).catch(() => undefined);
};

async function handle(msg: TunerRequest): Promise<void> {
  try {
    if (msg.type === 'init') {
      const session = new GifSession({
        width: msg.width,
        height: msg.height,
        delays: msg.delays,
        repeat: msg.repeat,
        frames: msg.frames.map((b) => new Uint8ClampedArray(b)),
      });
      tuner = new GifTuner((config) => session.encodeConfig(config));
      scope.postMessage({ type: 'ready' });
      return;
    }
    if (!tuner) throw new Error('The tuner is not ready.');
    if (msg.type === 'bounds') {
      scope.postMessage({ type: 'bounds', id: msg.id, index: await tuner.maxFeasibleIndex(msg.priority, msg.limit) });
      return;
    }
    if (msg.id < latestEncode) {
      scope.postMessage({ type: 'skipped', id: msg.id });
      return;
    }
    const bytes = await tuner.encode(msg.priority, msg.index);
    scope.postMessage({ type: 'encoded', id: msg.id, bytes });
  } catch (err) {
    scope.postMessage({ type: 'error', id: 'id' in msg ? msg.id : undefined, message: err instanceof Error ? err.message : String(err) });
  }
}
