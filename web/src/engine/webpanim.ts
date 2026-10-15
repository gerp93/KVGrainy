import { jsquashCodec } from './codecs';
import { FRAME_STEPS, GifSession, sampleIndices, type GifHooks, type GifInput, type GifResult, type ScaledSet } from './gif';
import { Reference } from './metric';
import { SCALE_FACTORS } from './search';
import type { Candidate, Raster } from './types';

/**
 * Animated WebP output. The browser WebP encoder (libwebp via jSquash) only writes single
 * frames, so each frame is encoded on its own and then wrapped in the animation container
 * (RIFF "WEBP" holding VP8X + ANIM + one ANMF chunk per frame). Every frame is stored in full:
 * no inter-frame cropping yet, which leaves some size on the table for mostly static clips.
 *
 * The search has the same shape as the still-image one: walk the scale ladder and bisect the
 * quality that fits, then drop frames if nothing fits at any scale.
 */

const FOURCC = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];

function chunk(fourcc: string, payload: Uint8Array | number[]): Uint8Array {
  const size = payload.length;
  const out = new Uint8Array(8 + size + (size & 1));
  out.set(FOURCC(fourcc), 0);
  out.set(u32(size), 4);
  out.set(payload, 8);
  return out;
}

/**
 * The image chunks (ALPH, VP8, VP8L) of a single-frame WebP file, kept as they are with their
 * headers and padding. Container-level chunks (VP8X, ICCP, EXIF, XMP) are dropped.
 */
export function frameChunks(file: Uint8Array): Uint8Array {
  const tag = (at: number) => String.fromCharCode(file[at]!, file[at + 1]!, file[at + 2]!, file[at + 3]!);
  if (file.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP') throw new Error('Not a WebP file');
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const kept: Uint8Array[] = [];
  let at = 12;
  while (at + 8 <= file.length) {
    const name = tag(at);
    const size = view.getUint32(at + 4, true);
    const end = at + 8 + size + (size & 1);
    if (name === 'ALPH' || name === 'VP8 ' || name === 'VP8L') kept.push(file.subarray(at, Math.min(end, file.length)));
    at = end;
  }
  if (kept.length === 0) throw new Error('WebP file has no image data');
  return concatBytes(kept);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface WebpFrame {
  /** A complete single-frame .webp file. */
  file: Uint8Array;
  /** Milliseconds this frame is shown. */
  duration: number;
}

/** Wrap single-frame WebP files into one animation. `loop` is 0 for forever. */
export function muxAnimatedWebp(frames: WebpFrame[], width: number, height: number, loop: number, hasAlpha: boolean): Uint8Array {
  if (frames.length === 0) throw new Error('No frames to write');
  const vp8x = chunk('VP8X', [(hasAlpha ? 0x10 : 0) | 0x02, 0, 0, 0, ...u24(width - 1), ...u24(height - 1)]);
  const anim = chunk('ANIM', [0, 0, 0, 0, loop & 255, (loop >> 8) & 255]);
  const anmf = frames.map((f) => {
    // x/2, y/2, width-1, height-1, duration, then flags: bit 1 = do not blend, bit 0 = do not dispose.
    const header = [...u24(0), ...u24(0), ...u24(width - 1), ...u24(height - 1), ...u24(Math.max(0, Math.round(f.duration))), 0b10];
    return chunk('ANMF', concatBytes([Uint8Array.from(header), frameChunks(f.file)]));
  });
  const body = concatBytes([Uint8Array.from(FOURCC('WEBP')), vp8x, anim, ...anmf]);
  return concatBytes([Uint8Array.from(FOURCC('RIFF')), Uint8Array.from(u32(body.length)), body]);
}

// ---- Search ------------------------------------------------------------------------------

const MIN_QUALITY = 20;
const DEFAULT_PATIENCE = 3;

interface Tracker {
  smallest: number;
  smallestBytes?: Uint8Array;
}

/**
 * WebP loop count (total plays, 0 = forever) from the GIF-style value (repeats after the first
 * play: 0 = forever, -1 = no repeat, n = n repeats). So "repeat 3" is 4 plays.
 */
export function loopCount(repeat: number): number {
  if (repeat < 0) return 1;
  return repeat === 0 ? 0 : repeat + 1;
}

export async function searchAnimatedWebp(input: GifInput, limit: number, hooks: GifHooks, patience = DEFAULT_PATIENCE): Promise<GifResult> {
  const track: Tracker = { smallest: Number.POSITIVE_INFINITY };
  const session = new GifSession(input, { keepAlpha: true });
  for (let s = 0; s < FRAME_STEPS.length && !hooks.cancelled(); s++) {
    const step = FRAME_STEPS[s]!;
    if (step > 1 && session.frameCount / step < 2) break;
    if (step > 1) hooks.status(`Still too big. Trying every ${step === 2 ? '2nd' : `${step}th`} frame…`);
    const best = await searchScales(session, input, limit, step, hooks, track, patience);
    if (best) return { best, smallest: track.smallest, smallestBytes: track.smallestBytes };
  }
  return { smallest: track.smallest, smallestBytes: track.smallestBytes };
}

async function searchScales(
  session: GifSession,
  input: GifInput,
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
    const fit = await fitQuality(set, input, limit, hooks, track);

    let next = index + 1;
    if (fit) {
      if (hooks.cancelled()) break;
      let total = 0;
      for (let k = 0; k < sample.length; k++) {
        const ref = references[k]!;
        const decoded = await jsquashCodec.decode('webp', fit.files[sample[k]!]!, ref.width, ref.height);
        total += decoded ? ref.score(decoded) : 0;
      }
      const score = total / sample.length;
      hooks.candidate?.({ frameStep, scale, colors: fit.quality, bytes: fit.bytes.length, score });
      if (!best || score > best.score + 0.001) {
        best = { bytes: fit.bytes, format: 'webp', quality: fit.quality, frameStep, scale, score };
        misses = 0;
      } else {
        misses++;
      }
      if ((index === 0 && fit.quality >= 100) || misses >= patience) next = SCALE_FACTORS.length;
    }
    hooks.report(next - index);
    index = next;
  }
  hooks.report(Math.max(0, SCALE_FACTORS.length - index));
  return best;
}

interface QualityFit {
  bytes: Uint8Array;
  quality: number;
  files: Uint8Array[];
}

/** Highest quality in `MIN_QUALITY..=100` whose whole animation fits, or null. */
async function fitQuality(set: ScaledSet, input: GifInput, limit: number, hooks: GifHooks, track: Tracker): Promise<QualityFit | null> {
  let fit: QualityFit | null = null;
  let lastLen = 0;

  const tryQuality = async (quality: number): Promise<boolean> => {
    if (hooks.cancelled()) return false;
    const files: Uint8Array[] = [];
    for (const data of set.frames) {
      if (hooks.cancelled()) return false;
      files.push(await jsquashCodec.encode('webp', { width: set.width, height: set.height, data }, quality));
    }
    const bytes = muxAnimatedWebp(
      files.map((file, i) => ({ file, duration: set.delays[i]! })),
      set.width,
      set.height,
      loopCount(input.repeat ?? 0),
      input.hasAlpha ?? false,
    );
    lastLen = bytes.length;
    if (bytes.length < track.smallest) {
      track.smallest = bytes.length;
      track.smallestBytes = bytes;
    }
    if (bytes.length > limit) return false;
    fit = { bytes, quality, files };
    return true;
  };

  if (!(await tryQuality(MIN_QUALITY)) && lastLen > limit + limit / 4) return null;
  let lo = MIN_QUALITY + 1;
  let hi = 100;
  while (lo <= hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (await tryQuality(mid)) lo = mid + 1;
    else hi = mid - 1;
  }
  return fit;
}
