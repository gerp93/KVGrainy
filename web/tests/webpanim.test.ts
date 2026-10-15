import { describe, expect, it } from 'vitest';
import { frameChunks, loopCount, muxAnimatedWebp } from '../src/engine/webpanim';

describe('loopCount', () => {
  it('turns a GIF-style repeat into a WebP play count', () => {
    expect(loopCount(0)).toBe(0); // forever stays forever
    expect(loopCount(-1)).toBe(1); // no repeat is a single play
    expect(loopCount(3)).toBe(4); // 3 repeats after the first play
  });
});

const tag = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);
const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getUint32(at, true);
const u24 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);

function chunk(name: string, payload: number[]): number[] {
  const out = [...name].map((c) => c.charCodeAt(0));
  out.push(payload.length & 255, (payload.length >> 8) & 255, 0, 0, ...payload);
  if (payload.length & 1) out.push(0);
  return out;
}

/** A stand-in for a single-frame WebP: RIFF header plus the given chunks. */
function fakeWebp(chunks: number[][]): Uint8Array {
  const body = [...'WEBP'].map((c) => c.charCodeAt(0)).concat(...chunks);
  const size = body.length;
  return Uint8Array.from([...'RIFF'].map((c) => c.charCodeAt(0)).concat(size & 255, (size >> 8) & 255, 0, 0, ...body));
}

describe('frameChunks', () => {
  it('keeps the image chunks and drops container-level ones', () => {
    const file = fakeWebp([chunk('VP8X', [0x10, 0, 0, 0, 9, 0, 0, 9, 0, 0]), chunk('ALPH', [1, 2, 3]), chunk('VP8 ', [9, 8, 7, 6]), chunk('EXIF', [5])]);
    const kept = frameChunks(file);
    expect(tag(kept, 0)).toBe('ALPH');
    expect(kept.length).toBe(8 + 3 + 1 + 8 + 4); // ALPH padded to even, then VP8
    expect(tag(kept, 12)).toBe('VP8 ');
  });
  it('rejects a file that is not WebP', () => {
    expect(() => frameChunks(new Uint8Array(20))).toThrow();
  });
});

describe('muxAnimatedWebp', () => {
  const frames = [
    { file: fakeWebp([chunk('VP8 ', [1, 2, 3, 4])]), duration: 80 },
    { file: fakeWebp([chunk('VP8 ', [5, 6, 7, 8])]), duration: 120 },
  ];
  const out = muxAnimatedWebp(frames, 320, 200, 0, false);

  it('writes a RIFF WEBP whose declared size matches its length', () => {
    expect(tag(out, 0)).toBe('RIFF');
    expect(tag(out, 8)).toBe('WEBP');
    expect(u32(out, 4)).toBe(out.length - 8);
  });

  it('starts with VP8X flagged animated, with the canvas size, then ANIM, then one ANMF per frame', () => {
    expect(tag(out, 12)).toBe('VP8X');
    expect(out[20]! & 0x02).toBe(0x02); // animation
    expect(out[20]! & 0x10).toBe(0); // no alpha
    expect(u24(out, 24)).toBe(319);
    expect(u24(out, 27)).toBe(199);
    expect(tag(out, 12 + 18)).toBe('ANIM');
    const first = 12 + 18 + 14;
    expect(tag(out, first)).toBe('ANMF');
    const size = u32(out, first + 4);
    expect(u24(out, first + 8 + 6)).toBe(319); // frame width - 1
    expect(u24(out, first + 8 + 12)).toBe(80); // duration
    const second = first + 8 + size + (size & 1);
    expect(tag(out, second)).toBe('ANMF');
    expect(u24(out, second + 8 + 12)).toBe(120);
  });

  it('flags alpha when asked and writes the loop count', () => {
    const withAlpha = muxAnimatedWebp(frames, 10, 10, 3, true);
    expect(withAlpha[20]! & 0x10).toBe(0x10);
    expect(withAlpha[12 + 18 + 8 + 4]).toBe(3); // ANIM loop count, low byte
  });

  it('refuses to write an empty animation', () => {
    expect(() => muxAnimatedWebp([], 1, 1, 0, false)).toThrow();
  });
});
