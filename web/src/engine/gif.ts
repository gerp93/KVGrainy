import { GIFEncoder, applyPalette, quantize, type Palette } from 'gifenc';
import { jsquashCodec } from './codecs';
import { Reference } from './metric';
import { SCALE_FACTORS } from './search';
import type { GifConfig } from './tuner';
import type { Candidate, Raster, SearchHooks } from './types';

/**
 * Fit an animation under a size limit as a GIF. The same shape as the still-image search:
 * walk the scale ladder from large to small and, at each scale, bisect the palette size for
 * the largest one that fits. If nothing fits at any scale, drop frames (every 2nd, 3rd...)
 * and walk again.
 *
 * `GifSession` is the shared encoder: the automatic search and the manual Fine-Tune tool both
 * go through it, so a ladder step and a search candidate with the same settings are the same file.
 *
 * Two things keep files small without a dedicated GIF optimiser: one global palette, and
 * frame differencing (pixels unchanged since the previous frame are written as transparent,
 * so each frame only costs what actually moved). The desktop engine instead quantises every
 * frame on its own with PIL; that suits changing scenes better but costs a palette per frame
 * and can't be differenced.
 */

export interface GifInput {
  width: number;
  height: number;
  /** RGBA frames, all `width` x `height`. */
  frames: Uint8ClampedArray[];
  delays: number[];
  /** gifenc's loop value: 0 forever (the default), -1 play once, n repeat n times. */
  repeat?: number;
  /** Whether any frame has transparency (animated WebP keeps it; GIF flattens it onto white). */
  hasAlpha?: boolean;
}

export interface GifResult {
  best?: Candidate;
  smallest: number;
  smallestBytes?: Uint8Array;
}

export interface GifHooks extends SearchHooks {
  status(text: string): void;
  /** Optional: told about each scale that produced a fit (for tuning and tests). */
  candidate?(info: { frameStep: number; scale: number; colors: number; bytes: number; score: number }): void;
}

/** When nothing fits with every frame, retry keeping every Nth frame. Shared with the animated-WebP search. */
export const FRAME_STEPS = [1, 2, 3, 4, 6];
const SAMPLE_FRAMES = 5;
const MIN_COLORS = 2;
/** One palette slot is kept back for the transparent index used by frame differencing. */
export const MAX_COLORS = 255;
/** More patient than stills: GIF scores dip and recover as the palette grows with each smaller scale. */
const DEFAULT_PATIENCE = 3;

interface Tracker {
  smallest: number;
  smallestBytes?: Uint8Array;
}

/** Keep every `step`th frame; dropped frames' time is added to the kept frame so playback speed holds. */
export function applyFrameStep<T>(frames: T[], delays: number[], step: number): { frames: T[]; delays: number[] } {
  if (step <= 1) return { frames, delays };
  const outFrames: T[] = [];
  const outDelays: number[] = [];
  for (let i = 0; i < frames.length; i += step) {
    outFrames.push(frames[i]!);
    let total = 0;
    for (let j = i; j < Math.min(i + step, frames.length); j++) total += delays[j]!;
    outDelays.push(total);
  }
  return { frames: outFrames, delays: outDelays };
}

/** GIF has no partial transparency: composite over white once, up front. */
function flatten(data: Uint8ClampedArray): Uint8ClampedArray {
  let opaque = true;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) {
      opaque = false;
      break;
    }
  }
  if (opaque) return data;
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]! / 255;
    out[i] = data[i]! * a + 255 * (1 - a);
    out[i + 1] = data[i + 1]! * a + 255 * (1 - a);
    out[i + 2] = data[i + 2]! * a + 255 * (1 - a);
    out[i + 3] = 255;
  }
  return out;
}

export function sampleIndices(count: number): number[] {
  const n = Math.min(SAMPLE_FRAMES, count);
  if (n <= 1) return [0];
  return Array.from({ length: n }, (_, k) => Math.round((k * (count - 1)) / (n - 1)));
}

function concat(parts: Uint8ClampedArray[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function encodeGif(
  frames: Uint8ClampedArray[],
  width: number,
  height: number,
  delays: number[],
  palette: Palette,
  samples: Set<number>,
  repeat: number,
): { bytes: Uint8Array; sampled: Map<number, Uint8Array> } {
  const transparentIndex = palette.length;
  const withTransparent: Palette = [...palette, [0, 0, 0]];
  const encoder = GIFEncoder();
  const sampled = new Map<number, Uint8Array>();
  let previous: Uint8Array | undefined;
  for (let i = 0; i < frames.length; i++) {
    const indices = applyPalette(frames[i]!, palette);
    if (samples.has(i)) sampled.set(i, indices);
    let out = indices;
    if (previous) {
      out = indices.slice();
      for (let p = 0; p < out.length; p++) if (indices[p] === previous[p]) out[p] = transparentIndex;
    }
    encoder.writeFrame(out, width, height, {
      palette: i === 0 ? withTransparent : undefined,
      delay: delays[i]!,
      transparent: i > 0,
      transparentIndex,
      dispose: 1,
      repeat,
    });
    previous = indices;
  }
  encoder.finish();
  return { bytes: encoder.bytes(), sampled };
}

/** Draw `raster` at `width` x `height` (to compare a shrunken candidate with the original). */
function resizeTo(raster: Raster, width: number, height: number): Raster {
  if (raster.width === width && raster.height === height) return raster;
  const source = new OffscreenCanvas(raster.width, raster.height);
  source.getContext('2d')!.putImageData(new ImageData(raster.data as Uint8ClampedArray<ArrayBuffer>, raster.width, raster.height), 0, 0);
  const target = new OffscreenCanvas(width, height);
  const ctx = target.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  const image = ctx.getImageData(0, 0, width, height);
  return { width, height, data: image.data };
}

function render(indices: Uint8Array, palette: Palette, width: number, height: number): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < indices.length; i++) {
    const color = palette[indices[i]!]!;
    data[i * 4] = color[0]!;
    data[i * 4 + 1] = color[1]!;
    data[i * 4 + 2] = color[2]!;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** Frames after dropping and scaling, ready to quantise and encode. */
export interface ScaledSet {
  frames: Uint8ClampedArray[];
  delays: number[];
  width: number;
  height: number;
}

export interface EncodeResult {
  bytes: Uint8Array;
  palette: Palette;
  colors: number;
  /** Palette indices of the sampled frames (full frames, before differencing), for scoring. */
  sampled: Map<number, Uint8Array>;
  sample: number[];
}

export class GifSession {
  readonly width: number;
  readonly height: number;
  readonly repeat: number;
  private readonly frames: Uint8ClampedArray[];
  private readonly delays: number[];
  private last?: { key: string; set: Promise<ScaledSet> };

  /** `keepAlpha` leaves transparency alone (animated WebP); otherwise frames are flattened onto white for GIF. */
  constructor(input: GifInput, options: { keepAlpha?: boolean } = {}) {
    this.width = input.width;
    this.height = input.height;
    this.repeat = input.repeat ?? 0;
    this.frames = options.keepAlpha ? input.frames : input.frames.map(flatten);
    this.delays = input.delays;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  /** Original frames after dropping, at full size. */
  stepped(step: number): { frames: Uint8ClampedArray[]; delays: number[] } {
    return applyFrameStep(this.frames, this.delays, step);
  }

  /**
   * Frames after dropping and scaling. The last result is kept, so moving along the colour axis
   * (the common slider move) doesn't resize every frame again.
   */
  scaledSet(step: number, scale: number): Promise<ScaledSet> {
    const key = `${step}@${scale}`;
    if (this.last?.key === key) return this.last.set;
    const set = this.buildScaled(step, scale);
    this.last = { key, set };
    set.catch(() => {
      if (this.last?.set === set) this.last = undefined;
    });
    return set;
  }

  private async buildScaled(step: number, scale: number): Promise<ScaledSet> {
    const { frames, delays } = this.stepped(step);
    if (Math.abs(scale - 1) < Number.EPSILON) return { frames, delays, width: this.width, height: this.height };
    const out: Uint8ClampedArray[] = [];
    let width = this.width;
    let height = this.height;
    for (const data of frames) {
      const scaled = await jsquashCodec.scale({ width: this.width, height: this.height, data }, scale);
      out.push(scaled.data);
      width = scaled.width;
      height = scaled.height;
    }
    return { frames: out, delays, width, height };
  }

  /** Quantise (one palette trained on a few sample frames) and encode every frame. */
  encode(set: ScaledSet, colors: number): EncodeResult {
    const sample = sampleIndices(set.frames.length);
    const palette = quantize(concat(sample.map((i) => set.frames[i]!)), Math.min(colors, MAX_COLORS));
    const { bytes, sampled } = encodeGif(set.frames, set.width, set.height, set.delays, palette, new Set(sample), this.repeat);
    return { bytes, palette, colors: Math.min(colors, MAX_COLORS), sampled, sample };
  }

  /** Encode one Fine-Tune ladder step. 256 colours is capped at 255 (one slot is the transparent index). */
  async encodeConfig(config: GifConfig): Promise<Uint8Array> {
    const set = await this.scaledSet(config.frameStep, config.scale);
    return this.encode(set, config.colors).bytes;
  }
}

export async function searchGif(input: GifInput, limit: number, hooks: GifHooks, patience = DEFAULT_PATIENCE): Promise<GifResult> {
  const track: Tracker = { smallest: Number.POSITIVE_INFINITY };
  const session = new GifSession(input);

  for (let s = 0; s < FRAME_STEPS.length && !hooks.cancelled(); s++) {
    const step = FRAME_STEPS[s]!;
    if (step > 1 && session.frameCount / step < 2) break;
    if (step > 1) hooks.status(`Still too big. Trying every ${step === 2 ? '2nd' : `${step}th`} frame…`);
    const best = await searchScales(session, limit, step, hooks, track, patience);
    if (best) return { best, smallest: track.smallest, smallestBytes: track.smallestBytes };
  }
  return { smallest: track.smallest, smallestBytes: track.smallestBytes };
}

async function searchScales(
  session: GifSession,
  limit: number,
  frameStep: number,
  hooks: GifHooks,
  track: Tracker,
  patience: number,
): Promise<Candidate | undefined> {
  const stepped = session.stepped(frameStep);
  const sample = sampleIndices(stepped.frames.length);
  const factor = Reference.analysisFactor(session.width, session.height);
  const references: Reference[] = [];
  for (const i of sample) {
    const base: Raster = { width: session.width, height: session.height, data: stepped.frames[i]! };
    references.push(new Reference(factor < 1 ? await jsquashCodec.scale(base, factor) : base));
  }

  let best: Candidate | undefined;
  let misses = 0;
  let index = 0;
  while (index < SCALE_FACTORS.length && !hooks.cancelled()) {
    const scale = SCALE_FACTORS[index]!;
    const set = await session.scaledSet(frameStep, scale);
    const fit = await fitColors(session, set, limit, hooks, track);

    let next = index + 1;
    if (fit) {
      if (hooks.cancelled()) break;
      let total = 0;
      sample.forEach((frameIndex, k) => {
        const shown = render(fit.sampled.get(frameIndex)!, fit.palette, set.width, set.height);
        const ref = references[k]!;
        total += ref.score(resizeTo(shown, ref.width, ref.height));
      });
      const score = total / sample.length;
      hooks.candidate?.({ frameStep, scale, colors: fit.colors, bytes: fit.bytes.length, score });
      if (!best || score > best.score + 0.001) {
        best = { bytes: fit.bytes, format: 'gif', colors: fit.colors, frameStep, scale, score };
        misses = 0;
      } else {
        misses++;
      }
      if ((index === 0 && fit.colors >= MAX_COLORS) || misses >= patience) next = SCALE_FACTORS.length;
    }
    hooks.report(next - index);
    index = next;
  }
  hooks.report(Math.max(0, SCALE_FACTORS.length - index));
  return best;
}

/** Largest palette in `MIN_COLORS..=MAX_COLORS` whose GIF fits, or null. */
async function fitColors(session: GifSession, set: ScaledSet, limit: number, hooks: GifHooks, track: Tracker): Promise<EncodeResult | null> {
  let fit: EncodeResult | null = null;
  let lastLen = 0;

  const tryColors = async (colors: number): Promise<boolean> => {
    if (hooks.cancelled()) return false;
    // Yield so a cancel message can be delivered between the heavy synchronous steps.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = session.encode(set, colors);
    lastLen = result.bytes.length;
    if (result.bytes.length < track.smallest) {
      track.smallest = result.bytes.length;
      track.smallestBytes = result.bytes;
    }
    if (result.bytes.length > limit) return false;
    fit = result;
    return true;
  };

  // Check the floor first so a hopeless scale costs one encode rather than a full bisection.
  if (!(await tryColors(MIN_COLORS)) && lastLen > limit + limit / 4) return null;
  let lo = MIN_COLORS + 1;
  let hi = MAX_COLORS;
  while (lo <= hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (await tryColors(mid)) lo = mid + 1;
    else hi = mid - 1;
  }
  return fit;
}
