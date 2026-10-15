import { GIFEncoder } from 'gifenc';
import { describe, expect, it } from 'vitest';
import { probeAnimation } from '../src/engine/frames';

const bytes = (...parts: (string | number[])[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
const u32be = (n: number) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const u32le = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const file = (data: Uint8Array, name: string, type = '') => new File([data as BlobPart], name, { type });

function gif(frames: number): Uint8Array {
  const encoder = GIFEncoder();
  const palette = [
    [0, 0, 0],
    [255, 255, 255],
  ];
  for (let i = 0; i < frames; i++) encoder.writeFrame(new Uint8Array(16).fill(i % 2), 4, 4, { palette: i === 0 ? palette : undefined, delay: 100 });
  encoder.finish();
  return encoder.bytes();
}

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const pngChunk = (type: string, data: number[]) => [...u32be(data.length), ...bytes(type), ...data, 0, 0, 0, 0];

describe('probeAnimation', () => {
  it('tells a one-frame GIF from an animated one', async () => {
    expect(await probeAnimation(file(gif(1), 'one.gif', 'image/gif'))).toBe('still');
    expect(await probeAnimation(file(gif(2), 'two.gif', 'image/gif'))).toBe('animated');
    expect(await probeAnimation(file(gif(9), 'nine.gif', 'image/gif'))).toBe('animated');
  });

  it('judges a PNG by whether an animation chunk comes before the pixel data', async () => {
    const ihdr = pngChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
    const still = Uint8Array.from([...pngSignature, ...ihdr, ...pngChunk('IDAT', [1, 2, 3]), ...pngChunk('IEND', [])]);
    const apng = Uint8Array.from([...pngSignature, ...ihdr, ...pngChunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0]), ...pngChunk('IDAT', [1, 2, 3]), ...pngChunk('IEND', [])]);
    expect(await probeAnimation(file(still, 'still.png', 'image/png'))).toBe('still');
    expect(await probeAnimation(file(apng, 'anim.png', 'image/png'))).toBe('animated');
  });

  it('reads the WebP animation flag', async () => {
    const riff = (chunk: number[]) => bytes('RIFF', u32le(chunk.length + 4), 'WEBP', chunk);
    const vp8x = (flags: number) => [...bytes('VP8X'), ...u32le(10), flags, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    expect(await probeAnimation(file(riff(vp8x(0x02)), 'a.webp', 'image/webp'))).toBe('animated');
    expect(await probeAnimation(file(riff(vp8x(0x10)), 'alpha.webp', 'image/webp'))).toBe('still');
    expect(await probeAnimation(file(riff([...bytes('VP8 '), ...u32le(4), 1, 2, 3, 4]), 'plain.webp', 'image/webp'))).toBe('still');
  });

  it('tells an AVIF sequence from a single image', async () => {
    const ftyp = (major: string, ...compatible: string[]) => {
      const body = [...bytes(major), 0, 0, 0, 0, ...compatible.flatMap((c) => [...bytes(c)])];
      return Uint8Array.from([...u32be(8 + body.length), ...bytes('ftyp'), ...body]);
    };
    expect(await probeAnimation(file(ftyp('avis', 'avif', 'msf1'), 'seq.avif', 'image/avif'))).toBe('animated');
    expect(await probeAnimation(file(ftyp('avif', 'mif1'), 'one.avif', 'image/avif'))).toBe('still');
  });

  it('treats JPEG and BMP as stills and video as animated', async () => {
    expect(await probeAnimation(file(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'p.jpg', 'image/jpeg'))).toBe('still');
    expect(await probeAnimation(file(bytes('BM', [0, 0, 0, 0]), 'p.bmp', 'image/bmp'))).toBe('still');
    expect(await probeAnimation(file(new Uint8Array(8), 'clip.mp4', 'video/mp4'))).toBe('animated');
    expect(await probeAnimation(file(new Uint8Array(8), 'clip.webm'))).toBe('animated');
  });

  it("says unknown rather than guessing when the header doesn't tell", async () => {
    expect(await probeAnimation(file(new Uint8Array(40), 'mystery.bin'))).toBe('unknown');
    expect(await probeAnimation(file(bytes('GIF89a'), 'truncated.gif', 'image/gif'))).toBe('unknown');
  });
});
