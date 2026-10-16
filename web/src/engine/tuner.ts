import { SCALE_FACTORS } from './search';

/**
 * The manual "Fine-Tune GIF" logic, originally a Python `GifTuner` / `build_gif_ladder` (removed from
 * the repo once this port shipped; see git history). Instead of searching for one optimum, it builds a fixed, ordered list of
 * configurations from best to worst across three independent axes (resolution, colours, frame
 * rate), degrading whichever axis the user picked first before touching the other two.
 */

export const GIF_COLOR_STEPS = [256, 220, 180, 140, 110, 90, 70, 55, 45, 35, 28, 22, 17, 13, 10, 8, 6, 4, 2];
export const GIF_FRAME_STEPS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20];

export type Priority = 'frames' | 'colors' | 'resolution';

export const PRIORITY_LABELS: Record<Priority, string> = {
  frames: 'Prioritize dropping frames (keep colors & detail)',
  colors: 'Prioritize dropping colors (keep motion & detail)',
  resolution: 'Prioritize shrinking resolution (keep colors & motion)',
};

export interface GifConfig {
  scale: number;
  colors: number;
  /** Keep every Nth frame. */
  frameStep: number;
}

/** Order configs from best (index 0) to worst, degrading `priority` first. */
export function buildGifLadder(priority: Priority): GifConfig[] {
  const axisSteps = { resolution: SCALE_FACTORS, colors: GIF_COLOR_STEPS, frames: GIF_FRAME_STEPS };
  const order: Record<Priority, Array<keyof typeof axisSteps>> = {
    frames: ['frames', 'colors', 'resolution'],
    colors: ['colors', 'frames', 'resolution'],
    resolution: ['resolution', 'colors', 'frames'],
  };
  const current = { resolution: SCALE_FACTORS[0]!, colors: GIF_COLOR_STEPS[0]!, frames: GIF_FRAME_STEPS[0]! };
  const snapshot = (): GifConfig => ({ scale: current.resolution, colors: current.colors, frameStep: current.frames });
  const ladder = [snapshot()];
  for (const axis of order[priority]) {
    for (const value of axisSteps[axis].slice(1)) {
      current[axis] = value;
      ladder.push(snapshot());
    }
  }
  return ladder;
}

/** Round halves to the even neighbour (banker's rounding, as Python's round() does), the rule the slider has always used, so existing step positions do not shift. */
function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Map the quality slider (0..100) to a ladder index. 100 is `maxFeasible`, the best config that
 * still fits the size limit, not index 0, so the slider always spans a fully usable range
 * whatever the limit is. 0 is the most compressed config.
 */
export function effectiveIndex(percent: number, maxFeasible: number, ladderLength: number): number {
  const span = Math.max(1, ladderLength - 1 - maxFeasible);
  return maxFeasible + roundHalfEven(((100 - percent) / 100) * span);
}

/** Caches ladder encodes so scrubbing the slider never re-encodes a config it has already done. */
export class GifTuner {
  private readonly ladders = new Map<Priority, GifConfig[]>();
  private readonly cache = new Map<string, Promise<Uint8Array>>();

  constructor(private readonly encodeConfig: (config: GifConfig) => Promise<Uint8Array>) {}

  ladder(priority: Priority): GifConfig[] {
    let ladder = this.ladders.get(priority);
    if (!ladder) {
      ladder = buildGifLadder(priority);
      this.ladders.set(priority, ladder);
    }
    return ladder;
  }

  encode(priority: Priority, index: number): Promise<Uint8Array> {
    const key = `${priority}:${index}`;
    let result = this.cache.get(key);
    if (!result) {
      result = this.encodeConfig(this.ladder(priority)[index]!);
      // A failed or cancelled encode must not be remembered.
      result.catch(() => this.cache.delete(key));
      this.cache.set(key, result);
    }
    return result;
  }

  /**
   * The lowest-index (best) config whose encode fits `limitBytes`, or the last config if none does.
   *
   * The desktop engine scans from index 0 upward. That costs up to 43 full encodes, which is far
   * too slow in a browser, so this bisects instead and then looks a few steps back, because
   * encoded size is only roughly monotone along the ladder. On a strictly monotone ladder the
   * answer is identical.
   */
  async maxFeasibleIndex(priority: Priority, limitBytes: number): Promise<number> {
    const last = this.ladder(priority).length - 1;
    const fits = async (i: number) => (await this.encode(priority, i)).length <= limitBytes;
    if (await fits(0)) return 0;
    if (!(await fits(last))) return last;
    let lo = 0; // known not to fit
    let hi = last; // known to fit
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (await fits(mid)) hi = mid;
      else lo = mid;
    }
    for (let i = Math.max(0, hi - 3); i < hi; i++) {
      if (await fits(i)) return i;
    }
    return hi;
  }
}
