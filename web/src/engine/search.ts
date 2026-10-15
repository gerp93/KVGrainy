import type { Candidate, Codec, Format, FormatResult, OptimizeResult, Raster, SearchHooks } from './types';
import type { Reference } from './metric';

/** Mirrors SCALE_FACTORS in crates/kvgrainy-core/src/search.rs. */
export const SCALE_FACTORS = [1.0, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3];

/** A full-scale fit at this quality ends the search (only maximum quality qualifies; see search.rs). */
const GOOD_ENOUGH_QUALITY = 100;
/** Stop walking down the ladder after this many scales in a row fail to improve the score. */
const PATIENCE = 2;
const MIN_QUALITY = 20;

export type Effort = 'quick' | 'best';

/** Formats worth trying. Quick skips AVIF, whose browser encoder is slow. A forced format is always honoured. */
export function formatsFor(hasAlpha: boolean, forced: Format | undefined, effort: Effort): Format[] {
  if (forced) return [forced];
  const formats: Format[] = hasAlpha ? ['webp', 'avif', 'png'] : ['jpeg', 'webp', 'avif', 'png'];
  return effort === 'quick' ? formats.filter((f) => f !== 'avif') : formats;
}

interface Tracker {
  smallest: number;
  smallestBytes?: Uint8Array;
}

/**
 * Walk the scale ladder for one format from large to small, stopping once more
 * shrinking can't help. A fit at high quality ends the search, a scale that
 * cannot fit costs one encode, and each smaller scale only searches quality
 * upward from the previous scale's result.
 */
export async function searchFormat(
  codec: Codec,
  reference: Reference,
  source: Raster,
  limit: number,
  format: Format,
  hooks: SearchHooks,
): Promise<FormatResult> {
  const track: Tracker = { smallest: Number.POSITIVE_INFINITY };
  let best: Candidate | undefined;
  let misses = 0;
  let minQuality = MIN_QUALITY;
  let index = 0;
  const hasQuality = format !== 'png';

  while (index < SCALE_FACTORS.length && !hooks.cancelled()) {
    const scale = SCALE_FACTORS[index]!;
    const resized = await codec.scale(source, scale);
    let attempt = await fitAtScale(codec, resized, limit, format, minQuality, hooks, track);
    if (!attempt && minQuality > MIN_QUALITY) {
      // The warm start can be too optimistic; retry from the floor before giving up on this scale.
      attempt = await fitAtScale(codec, resized, limit, format, MIN_QUALITY, hooks, track);
    }

    let next = index + 1;
    if (attempt) {
      if (hooks.cancelled()) break;
      minQuality = attempt.quality;
      const decoded = await codec.decode(format, attempt.bytes, reference.width, reference.height);
      const score = decoded ? reference.score(decoded) : 0;
      if (!best || score > best.score + 0.001) {
        best = { bytes: attempt.bytes, format, quality: hasQuality ? attempt.quality : undefined, scale, score };
        misses = 0;
      } else {
        misses++;
      }
      const goodEnough = index === 0 && (!hasQuality || attempt.quality >= GOOD_ENOUGH_QUALITY);
      if (goodEnough || misses >= PATIENCE) next = SCALE_FACTORS.length;
    }
    // Otherwise nothing fit even at the lowest quality: a hopeless scale costs a single
    // encode, and size is not reliably proportional to pixel count, so just step down.
    hooks.report(next - index);
    index = next;
  }
  // Account for scales never visited so progress reaches its total.
  hooks.report(Math.max(0, SCALE_FACTORS.length - index));
  return { best, smallest: track.smallest, smallestBytes: track.smallestBytes, smallestFormat: format };
}

/** Highest quality in `minQuality..=100` whose output fits, or null. Formats without a quality knob encode once. */
async function fitAtScale(
  codec: Codec,
  resized: Raster,
  limit: number,
  format: Format,
  minQuality: number,
  hooks: SearchHooks,
  track: Tracker,
): Promise<{ bytes: Uint8Array; quality: number } | null> {
  let fit: { bytes: Uint8Array; quality: number } | null = null;
  let lastLen = 0;

  const tryQuality = async (quality: number): Promise<boolean> => {
    if (hooks.cancelled()) return false;
    let bytes: Uint8Array;
    try {
      bytes = await codec.encode(format, resized, quality);
    } catch {
      return false;
    }
    lastLen = bytes.length;
    if (bytes.length < track.smallest) {
      track.smallest = bytes.length;
      track.smallestBytes = bytes;
    }
    if (bytes.length > limit) return false;
    fit = { bytes, quality };
    return true;
  };

  if (format === 'png') {
    await tryQuality(100);
    return fit;
  }
  // Check the floor first so a hopeless scale costs one encode rather than a full bisection.
  // Encoded size is not strictly monotone in quality (small AVIFs especially), so a floor
  // that only just misses the limit still gets the full search.
  if (!(await tryQuality(minQuality)) && lastLen > limit + limit / 4) return null;
  let lo = minQuality + 1;
  let hi = 100;
  while (lo <= hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (await tryQuality(mid)) lo = mid + 1;
    else hi = mid - 1;
  }
  return fit;
}

/**
 * Pick the winner across formats. Scores within 0.001 are a tie, so noise can't pick a
 * needlessly smaller image; ties go to the higher scale, then the larger file.
 */
export function chooseBest(results: FormatResult[], limit: number): OptimizeResult {
  let winner: Candidate | undefined;
  let winnerKey: [number, number, number] | undefined;
  for (const result of results) {
    const c = result.best;
    if (!c) continue;
    const key: [number, number, number] = [Math.round(c.score * 1000), Math.round(c.scale * 100), c.bytes.length];
    if (!winnerKey || compareKeys(key, winnerKey) >= 0) {
      winner = c;
      winnerKey = key;
    }
  }
  if (winner) return { ok: true, candidate: winner };

  let smallest = Number.POSITIVE_INFINITY;
  let bestEffort: { bytes: Uint8Array; format: Format } | undefined;
  for (const r of results) {
    if (r.smallestBytes && r.smallestFormat && r.smallest < smallest) {
      smallest = r.smallest;
      bestEffort = { bytes: r.smallestBytes, format: r.smallestFormat };
    }
  }
  return { ok: false, limit, smallest: Number.isFinite(smallest) ? smallest : 0, bestEffort };
}

function compareKeys(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}
