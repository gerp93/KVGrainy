import type { FrameSource } from './frames';
import { buildGifLadder, type GifConfig, type Priority } from './tuner';
import type { TunerReply, TunerRequest } from './tuner-worker';

/** Main-thread handle on the Fine-Tune worker. Every call returns a promise; `encode` resolves null if a newer one replaced it. */
export class TunerClient {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
  private readonly ready: Promise<void>;
  private failure?: Error;

  constructor(source: FrameSource) {
    this.worker = new Worker(new URL('./tuner-worker.ts', import.meta.url), { type: 'module' });
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (event: MessageEvent<TunerReply>) => {
        const msg = event.data;
        if (msg.type === 'ready') return resolve();
        if (msg.type === 'error') {
          const error = new Error(msg.message);
          if (msg.id === undefined) {
            this.failure = error;
            reject(error);
            return;
          }
          this.waiting.get(msg.id)?.reject(error);
          this.waiting.delete(msg.id);
          return;
        }
        const entry = this.waiting.get(msg.id);
        if (!entry) return;
        this.waiting.delete(msg.id);
        if (msg.type === 'skipped') entry.resolve(null as never);
        else if (msg.type === 'bounds') entry.resolve(msg.index as never);
        else entry.resolve(msg.bytes as never);
      };
      this.worker.onerror = (e) => {
        this.failure = new Error(e.message || 'The tuner worker crashed.');
        reject(this.failure);
        for (const { reject: r } of this.waiting.values()) r(this.failure);
        this.waiting.clear();
      };
    });
    // Copies, so the frames the page keeps (for re-decoding settings) are untouched.
    const frames = source.frames.map((f) => f.slice().buffer as ArrayBuffer);
    const init: TunerRequest = { type: 'init', width: source.width, height: source.height, delays: source.delays, repeat: source.repeat, frames };
    this.worker.postMessage(init, frames);
  }

  ladder(priority: Priority): GifConfig[] {
    return buildGifLadder(priority);
  }

  /** The best (lowest) ladder index whose GIF fits `limitBytes`. */
  async bounds(priority: Priority, limitBytes: number): Promise<number> {
    await this.ready;
    return this.request<number>({ type: 'bounds', priority, limit: limitBytes });
  }

  /** The GIF for one ladder step, or null if a newer request replaced this one before it started. */
  async encode(priority: Priority, index: number): Promise<Uint8Array | null> {
    await this.ready;
    return this.request<Uint8Array | null>({ type: 'encode', priority, index });
  }

  private request<T>(body: { type: 'bounds'; priority: Priority; limit: number } | { type: 'encode'; priority: Priority; index: number }): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: never) => void, reject });
      this.worker.postMessage({ ...body, id } as TunerRequest);
    });
  }

  dispose() {
    this.worker.terminate();
    for (const { reject } of this.waiting.values()) reject(new DOMException('Closed', 'AbortError'));
    this.waiting.clear();
  }
}
