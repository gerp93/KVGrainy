import { GIFEncoder } from 'gifenc';
import { describe, expect, it } from 'vitest';
import { gifFrameCount } from '../src/engine/frames';
import { applyFrameStep } from '../src/engine/gif';

function gifWithFrames(count: number): Uint8Array {
  const encoder = GIFEncoder();
  const palette = [
    [0, 0, 0],
    [255, 255, 255],
  ];
  for (let i = 0; i < count; i++) {
    encoder.writeFrame(new Uint8Array(16).fill(i % 2), 4, 4, { palette: i === 0 ? palette : undefined, delay: 100, repeat: 0 });
  }
  encoder.finish();
  return encoder.bytes();
}

describe('gifFrameCount', () => {
  it('counts frames without decoding', () => {
    expect(gifFrameCount(gifWithFrames(1))).toBe(1);
    expect(gifFrameCount(gifWithFrames(7))).toBe(7);
  });
  it('returns 0 for non-GIF data', () => {
    expect(gifFrameCount(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(0);
    expect(gifFrameCount(new Uint8Array(0))).toBe(0);
  });
});

describe('applyFrameStep', () => {
  const frames = ['a', 'b', 'c', 'd', 'e'];
  const delays = [10, 20, 30, 40, 50];
  it('keeps everything at step 1', () => {
    expect(applyFrameStep(frames, delays, 1)).toEqual({ frames, delays });
  });
  it('keeps every Nth frame and sums the dropped time into it, so playback speed holds', () => {
    const out = applyFrameStep(frames, delays, 2);
    expect(out.frames).toEqual(['a', 'c', 'e']);
    expect(out.delays).toEqual([30, 70, 50]);
    expect(out.delays.reduce((a, b) => a + b, 0)).toBe(delays.reduce((a, b) => a + b, 0));
  });
});
