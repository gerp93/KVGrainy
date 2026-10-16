import { describe, expect, it } from 'vitest';
import { parseSizeLimit } from '../src/engine/limit';
import { Reference } from '../src/engine/metric';
import { chooseBest, formatsFor } from '../src/engine/search';
import type { Candidate, FormatResult, Raster } from '../src/engine/types';

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

describe('formatsFor', () => {
  it('picks suitable formats and honours a forced one', () => {
    expect(formatsFor(false, undefined, 'best')).toEqual(['jpeg', 'webp', 'avif', 'png']);
    expect(formatsFor(true, undefined, 'best')).toEqual(['webp', 'avif', 'png']);
    expect(formatsFor(false, undefined, 'quick')).toEqual(['jpeg', 'webp', 'png']);
    expect(formatsFor(false, 'avif', 'quick')).toEqual(['avif']);
  });
});

describe('chooseBest', () => {
  const candidate = (score: number, scale: number, size: number): Candidate => ({ bytes: new Uint8Array(size), format: 'jpeg', scale, score });
  const results = (...cs: Candidate[]): FormatResult[] => cs.map((best) => ({ best, smallest: best.bytes.length }));

  it('prefers the higher score, then the higher scale, then the larger file', () => {
    const pick = (...cs: Candidate[]) => {
      const out = chooseBest(results(...cs), 1000);
      return out.ok ? cs.indexOf(out.candidate) : -1;
    };
    expect(pick(candidate(0.8, 1, 100), candidate(0.9, 0.5, 100))).toBe(1);
    expect(pick(candidate(0.9, 0.5, 100), candidate(0.9, 1, 100))).toBe(1);
    expect(pick(candidate(0.9, 1, 100), candidate(0.9, 1, 200))).toBe(1);
  });

  it('prefers the smaller file when the scores are visually lossless', () => {
    const out = chooseBest(results(candidate(1, 1, 500), candidate(1, 1, 100)), 1000);
    expect(out.ok && out.candidate.bytes.length).toBe(100);
  });

  it('reports the smallest attempt when nothing fits', () => {
    const none: FormatResult[] = [
      { smallest: 900, smallestBytes: new Uint8Array(900), smallestFormat: 'png' },
      { smallest: 400, smallestBytes: new Uint8Array(400), smallestFormat: 'webp' },
    ];
    const out = chooseBest(none, 100);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.smallest).toBe(400);
      expect(out.bestEffort?.format).toBe('webp');
    }
  });
});
