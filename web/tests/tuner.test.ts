import { describe, expect, it } from 'vitest';
import { SCALE_FACTORS } from '../src/engine/search';
import { GIF_COLOR_STEPS, GIF_FRAME_STEPS, GifTuner, buildGifLadder, effectiveIndex, type GifConfig, type Priority } from '../src/engine/tuner';

describe('buildGifLadder', () => {
  const total = SCALE_FACTORS.length + GIF_COLOR_STEPS.length + GIF_FRAME_STEPS.length - 3 + 1;

  it('starts at the original on every axis and covers every step once', () => {
    for (const priority of ['frames', 'colors', 'resolution'] as Priority[]) {
      const ladder = buildGifLadder(priority);
      expect(ladder[0]).toEqual({ scale: 1, colors: 256, frameStep: 1 });
      expect(ladder).toHaveLength(total);
      const last = ladder[ladder.length - 1]!;
      expect(last).toEqual({ scale: SCALE_FACTORS.at(-1), colors: GIF_COLOR_STEPS.at(-1), frameStep: GIF_FRAME_STEPS.at(-1) });
    }
  });

  it('degrades the chosen axis completely before touching the next', () => {
    const ladder = buildGifLadder('frames');
    // First the frame axis alone...
    for (let i = 1; i < GIF_FRAME_STEPS.length; i++) {
      expect(ladder[i]).toEqual({ scale: 1, colors: 256, frameStep: GIF_FRAME_STEPS[i] });
    }
    // ...then colours, with frames already at their floor, and resolution still untouched.
    const afterFrames = ladder[GIF_FRAME_STEPS.length]!;
    expect(afterFrames).toEqual({ scale: 1, colors: GIF_COLOR_STEPS[1], frameStep: GIF_FRAME_STEPS.at(-1) });
  });

  it('puts the other axes in the documented secondary order', () => {
    const byColors = buildGifLadder('colors');
    expect(byColors[GIF_COLOR_STEPS.length]).toEqual({ scale: 1, colors: GIF_COLOR_STEPS.at(-1), frameStep: GIF_FRAME_STEPS[1] });
    const byResolution = buildGifLadder('resolution');
    expect(byResolution[SCALE_FACTORS.length]).toEqual({ scale: SCALE_FACTORS.at(-1), colors: GIF_COLOR_STEPS[1], frameStep: 1 });
  });

  it('never improves on any axis as the index grows', () => {
    const ladder = buildGifLadder('colors');
    for (let i = 1; i < ladder.length; i++) {
      const a = ladder[i - 1]!;
      const b = ladder[i]!;
      expect(b.scale).toBeLessThanOrEqual(a.scale);
      expect(b.colors).toBeLessThanOrEqual(a.colors);
      expect(b.frameStep).toBeGreaterThanOrEqual(a.frameStep);
    }
  });
});

describe('effectiveIndex', () => {
  it('maps 100% to the best config that fits and 0% to the most compressed', () => {
    expect(effectiveIndex(100, 7, 43)).toBe(7);
    expect(effectiveIndex(0, 7, 43)).toBe(42);
    expect(effectiveIndex(0, 0, 43)).toBe(42);
  });
  it('spans the usable range even when almost nothing fits', () => {
    expect(effectiveIndex(100, 42, 43)).toBe(42);
    expect(effectiveIndex(0, 42, 43)).toBe(43); // span floors at 1, matching the desktop app
  });
  it('rounds halves to even, like Python', () => {
    // percent 50 over a span of 5 is 2.5 steps: Python's round(2.5) is 2, round(3.5) is 4
    expect(effectiveIndex(50, 0, 6)).toBe(2);
    expect(effectiveIndex(30, 0, 6)).toBe(4); // 0.7 * 5 = 3.5
  });
});

/** A fake encoder whose size shrinks with the index, so the expected answer is easy to state. */
function fakeEncoder(sizeAt: (config: GifConfig) => number) {
  const calls: GifConfig[] = [];
  const encode = async (config: GifConfig) => {
    calls.push(config);
    return new Uint8Array(sizeAt(config));
  };
  return { encode, calls };
}

describe('GifTuner', () => {
  const sizeBy = (priority: Priority) => (config: GifConfig) => {
    const ladder = buildGifLadder(priority);
    const index = ladder.findIndex((c) => c.scale === config.scale && c.colors === config.colors && c.frameStep === config.frameStep);
    return 100_000 - index * 2_000;
  };

  it('finds the same index as scanning from the top, with far fewer encodes', async () => {
    const { encode, calls } = fakeEncoder(sizeBy('frames'));
    const tuner = new GifTuner(encode);
    const limit = 40_000;
    const found = await tuner.maxFeasibleIndex('frames', limit);

    const ladder = tuner.ladder('frames');
    let scanned = ladder.length - 1;
    for (let i = 0; i < ladder.length; i++) {
      if (sizeBy('frames')(ladder[i]!) <= limit) {
        scanned = i;
        break;
      }
    }
    expect(found).toBe(scanned);
    expect(calls.length).toBeLessThan(15);
  });

  it('returns index 0 when the original already fits and the last index when nothing does', async () => {
    expect(await new GifTuner(fakeEncoder(() => 10).encode).maxFeasibleIndex('colors', 1000)).toBe(0);
    expect(await new GifTuner(fakeEncoder(() => 5000).encode).maxFeasibleIndex('colors', 1000)).toBe(42);
  });

  it('caches encodes, so revisiting a slider position costs nothing', async () => {
    const { encode, calls } = fakeEncoder(() => 100);
    const tuner = new GifTuner(encode);
    await tuner.encode('frames', 5);
    await tuner.encode('frames', 5);
    await tuner.encode('colors', 5);
    expect(calls).toHaveLength(2);
  });

  it('does not remember a failed encode', async () => {
    let fail = true;
    const tuner = new GifTuner(async () => {
      if (fail) throw new Error('cancelled');
      return new Uint8Array(1);
    });
    await expect(tuner.encode('frames', 3)).rejects.toThrow();
    fail = false;
    await expect(tuner.encode('frames', 3)).resolves.toHaveLength(1);
  });
});
