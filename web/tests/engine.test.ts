import { describe, expect, it } from 'vitest';
import { parseSizeLimit } from '../src/engine/limit';
import { Reference } from '../src/engine/metric';
import { SCALE_FACTORS, chooseBest, formatsFor, searchFormat } from '../src/engine/search';
import type { Codec, Format, Raster } from '../src/engine/types';

function noise(width: number, height: number, seed = 1): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  let s = seed;
  for (let i = 0; i < data.length; i += 4) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[i] = (s >>> 8) & 255;
    data[i + 1] = (s >>> 16) & 255;
    data[i + 2] = (s >>> 24) & 255;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

describe('parseSizeLimit', () => {
  it('parses units like the desktop engine', () => {
    expect(parseSizeLimit('500kb')).toBe(500 * 1024);
    expect(parseSizeLimit('1.5mb')).toBe(1_572_864);
    expect(parseSizeLimit('2048')).toBe(2048);
    expect(parseSizeLimit(' 12 B ')).toBe(12);
  });
  it('rejects bad input', () => {
    for (const bad of ['', 'abc', '-10kb', '0', 'kb']) expect(() => parseSizeLimit(bad), bad).toThrow();
  });
});

describe('Reference', () => {
  it('scores identical images 1 and degraded images lower', () => {
    const image = noise(64, 64);
    const ref = new Reference(image);
    expect(ref.score(image)).toBeGreaterThan(0.999);
    const noisy = { ...image, data: new Uint8ClampedArray(image.data) };
    for (let i = 0; i < noisy.data.length; i += 4) noisy.data[i] = Math.min(255, noisy.data[i]! + 40);
    const worse = new Uint8ClampedArray(image.data);
    for (let i = 0; i < worse.length; i += 4) worse[i] = 255 - worse[i]!;
    expect(ref.score(noisy)).toBeLessThan(ref.score(image));
    expect(ref.score({ ...image, data: worse })).toBeLessThan(ref.score(noisy));
  });
  it('falls back to a pixel score under 8x8', () => {
    const tiny = noise(4, 4);
    expect(new Reference(tiny).score(tiny)).toBeGreaterThan(0.999);
  });
  it('only shrinks large images for analysis', () => {
    expect(Reference.analysisFactor(1000, 1000)).toBe(1);
    expect(Reference.analysisFactor(4000, 3000)).toBeLessThan(1);
  });
});

/**
 * A fake codec with a predictable size model: bytes = pixels * (quality / 100) / 4 for lossy
 * formats, and a decode that degrades pixels in proportion to (100 - quality).
 */
const fake: Codec & { encodes: number } = {
  encodes: 0,
  async encode(format: Format, raster: Raster, quality: number) {
    this.encodes++;
    const q = format === 'png' ? 100 : quality;
    const bytes = new Uint8Array(Math.max(1, Math.floor((raster.width * raster.height * q) / 400)));
    bytes[0] = q;
    return bytes;
  },
  async scale(raster: Raster, factor: number) {
    const width = Math.max(1, Math.floor(raster.width * factor));
    const height = Math.max(1, Math.floor(raster.height * factor));
    if (width === raster.width && height === raster.height) return raster;
    return noise(width, height, 7);
  },
  async decode(_format: Format, bytes: Uint8Array, width: number, height: number) {
    const base = noise(width, height);
    const loss = 100 - bytes[0]!;
    for (let i = 0; i < base.data.length; i += 4) base.data[i] = Math.min(255, base.data[i]! + loss);
    return base;
  },
};

const hooks = (cancelled = false) => ({ cancelled: () => cancelled, report: () => {} });

describe('searchFormat', () => {
  it('finds the highest quality that fits and reports a smallest size', async () => {
    const source = noise(64, 64);
    const reference = new Reference(source);
    const limit = 64 * 64 * 0.5 * 0.25; // fits at quality ~50
    const result = await searchFormat(fake, reference, source, limit, 'jpeg', hooks());
    expect(result.best).toBeDefined();
    expect(result.best!.bytes.length).toBeLessThanOrEqual(limit);
    expect(result.best!.quality).toBeGreaterThanOrEqual(45);
    expect(result.smallest).toBeLessThanOrEqual(result.best!.bytes.length);
  });

  it('stops at full scale when the limit is generous', async () => {
    const source = noise(64, 64);
    const result = await searchFormat(fake, new Reference(source), source, 1e9, 'webp', hooks());
    expect(result.best!.scale).toBe(1);
    expect(result.best!.quality).toBe(100);
  });

  it('reports progress up to the full ladder', async () => {
    const source = noise(64, 64);
    let steps = 0;
    await searchFormat(fake, new Reference(source), source, 700, 'jpeg', { cancelled: () => false, report: (n) => (steps += n) });
    expect(steps).toBe(SCALE_FACTORS.length);
  });

  it('returns nothing and keeps the smallest output when no scale fits', async () => {
    const source = noise(64, 64);
    const result = await searchFormat(fake, new Reference(source), source, 1, 'jpeg', hooks());
    expect(result.best).toBeUndefined();
    expect(result.smallestBytes).toBeDefined();
    const chosen = chooseBest([result], 1);
    expect(chosen.ok).toBe(false);
    if (!chosen.ok) {
      expect(chosen.smallest).toBeGreaterThan(1);
      expect(chosen.bestEffort?.format).toBe('jpeg');
    }
  });

  it('stops encoding once cancelled', async () => {
    fake.encodes = 0;
    const source = noise(64, 64);
    await searchFormat(fake, new Reference(source), source, 700, 'jpeg', hooks(true));
    expect(fake.encodes).toBe(0);
  });
});

describe('formatsFor', () => {
  it('picks suitable formats and honours a forced one', () => {
    expect(formatsFor(false, undefined, 'best')).toEqual(['jpeg', 'webp', 'avif', 'png']);
    expect(formatsFor(true, undefined, 'best')).toEqual(['webp', 'avif', 'png']);
    expect(formatsFor(false, undefined, 'quick')).toEqual(['jpeg', 'webp', 'png']);
    expect(formatsFor(false, 'avif', 'quick')).toEqual(['avif']);
  });
});
