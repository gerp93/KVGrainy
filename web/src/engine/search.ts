import type { Candidate, Format, FormatResult, OptimizeResult } from './types';

/** Mirrors SCALE_FACTORS in crates/kvgrainy-core/src/search.rs. */
export const SCALE_FACTORS = [1.0, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3];

/** A score at or above this is indistinguishable from the original (VISUALLY_LOSSLESS in the core). */
const VISUALLY_LOSSLESS = 0.999;

export type Effort = 'quick' | 'best';

/**
 * Formats worth trying. Quick skips AVIF, whose browser encoder is slow. A forced format is always
 * honoured. Mirrors `candidate_formats` in crates/kvgrainy-core/src/search.rs for a codec that has
 * no palette PNG; tests/core.test.ts checks the two agree.
 */
export function formatsFor(hasAlpha: boolean, forced: Format | undefined, effort: Effort): Format[] {
  if (forced) return [forced];
  const formats: Format[] = hasAlpha ? ['webp', 'avif', 'png'] : ['jpeg', 'webp', 'avif', 'png'];
  return effort === 'quick' ? formats.filter((f) => f !== 'avif') : formats;
}

/**
 * Pick the winner across formats: the same rule as `pick_best` in the Rust core (scores within 0.001
 * are a tie, so noise can't pick a needlessly smaller image; ties go to the higher scale, then the
 * larger file, or the smaller one when visually lossless). tests/core.test.ts checks they agree.
 */
export function chooseBest(results: FormatResult[], limit: number): OptimizeResult {
  let winner: Candidate | undefined;
  let winnerKey: [number, number, number] | undefined;
  for (const result of results) {
    const c = result.best;
    if (!c) continue;
    const key: [number, number, number] = [Math.round(c.score * 1000), Math.round(c.scale * 100), c.score >= VISUALLY_LOSSLESS ? -c.bytes.length : c.bytes.length];
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
