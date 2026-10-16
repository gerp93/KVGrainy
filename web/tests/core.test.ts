// The web app's stills run on the shared Rust core compiled to WebAssembly (crates/kvgrainy-wasm),
// calling the real jSquash codecs. These tests run that exact stack in Node: the core loops, the
// codecs encode and decode. Browser-only concerns (workers, canvas, layout) are in the Playwright tests.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { simd } from 'wasm-feature-detect';
import { beforeAll, describe, expect, it } from 'vitest';
import { chooseBest, formatsFor, type Effort } from '../src/engine/search';
import { createSyncCodec, type SyncCodec, type WasmModules } from '../src/engine/syncCodec';
import type { Candidate, Format } from '../src/engine/types';
import { Source, bestEffort, candidateFormats, initSync, pickBest, scaleSteps, searchFormat } from '../src/wasm/kvgrainy_wasm.js';

const require = createRequire(import.meta.url);
const jsquash = (pkg: string) => dirname(require.resolve(`${pkg}/package.json`));
const compile = (path: string) => WebAssembly.compile(readFileSync(path));

/** Pre-compiled codec modules: Node cannot fetch a .wasm by URL the way a browser does. */
async function loadModules(): Promise<WasmModules> {
  const jpeg = jsquash('@jsquash/jpeg');
  const webp = jsquash('@jsquash/webp');
  const avif = jsquash('@jsquash/avif');
  const png = jsquash('@jsquash/png');
  const oxipng = jsquash('@jsquash/oxipng');
  const webpFile = (await simd()) ? 'webp_enc_simd.wasm' : 'webp_enc.wasm';
  const [jpegModule, webpModule, avifModule, avifDecode, pngModule, oxipngModule] = await Promise.all([
    compile(resolve(jpeg, 'codec/enc/mozjpeg_enc.wasm')),
    compile(resolve(webp, 'codec/enc', webpFile)),
    compile(resolve(avif, 'codec/enc/avif_enc.wasm')),
    compile(resolve(avif, 'codec/dec/avif_dec.wasm')),
    compile(resolve(png, 'codec/pkg/squoosh_png_bg.wasm')),
    compile(resolve(oxipng, 'codec/pkg/squoosh_oxipng_bg.wasm')),
  ]);
  return { jpeg: jpegModule, webp: webpModule, avif: avifModule, avifDecode, png: pngModule, oxipng: oxipngModule };
}

/** A smooth image with a little noise, so it compresses like a photo rather than like static. */
function photoLike(width: number, height: number, alpha = false): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  let seed = 12345;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const noise = (seed >>> 24) % 12;
      const i = (y * width + x) * 4;
      data[i] = Math.min(255, 40 + (x * 180) / width + noise);
      data[i + 1] = Math.min(255, 60 + (y * 150) / height + noise);
      data[i + 2] = Math.min(255, 120 + ((x + y) * 60) / (width + height) + noise);
      data[i + 3] = alpha ? Math.round((x / width) * 255) : 255;
    }
  }
  return data;
}

const startsWith = (bytes: Uint8Array, ...prefix: number[]) => prefix.every((b, i) => bytes[i] === b);
const MAGIC: Record<Format, (bytes: Uint8Array) => boolean> = {
  jpeg: (b) => startsWith(b, 0xff, 0xd8, 0xff),
  png: (b) => startsWith(b, 0x89, 0x50, 0x4e, 0x47),
  webp: (b) => startsWith(b, 0x52, 0x49, 0x46, 0x46) && startsWith(b.subarray(8), 0x57, 0x45, 0x42, 0x50),
  avif: (b) => startsWith(b.subarray(4), 0x66, 0x74, 0x79, 0x70),
};

let modules: WasmModules;
beforeAll(async () => {
  initSync({ module: readFileSync(resolve(import.meta.dirname, '../src/wasm/kvgrainy_wasm_bg.wasm')) });
  modules = await loadModules();
}, 60_000);

const codecs = new Map<Format, SyncCodec>();
async function codecFor(format: Format): Promise<SyncCodec> {
  let codec = codecs.get(format);
  if (!codec) {
    codec = await createSyncCodec(format, modules);
    codecs.set(format, codec);
  }
  return codec;
}

describe('the Rust core in WebAssembly, with the real browser codecs', () => {
  for (const format of ['jpeg', 'webp', 'avif', 'png'] as const) {
    it(`fits ${format} under the limit with a valid file`, async () => {
      const source = Source.fromRgba(160, 120, photoLike(160, 120));
      const limit = format === 'png' ? 40_000 : 3_000;
      let steps = 0;
      const outcome = searchFormat(source, await codecFor(format), format, limit, 'best', (n: number) => (steps += n));
      expect(outcome.found).toBe(true);
      expect(outcome.format).toBe(format);
      expect(outcome.bytes.length).toBeGreaterThan(0);
      expect(outcome.bytes.length).toBeLessThanOrEqual(limit);
      expect(MAGIC[format](outcome.bytes)).toBe(true);
      expect(outcome.score).toBeGreaterThan(0.3);
      expect(steps).toBe(scaleSteps());
      outcome.free();
      source.free();
    }, 60_000);
  }

  it('keeps transparency for WebP', async () => {
    const source = Source.fromRgba(96, 96, photoLike(96, 96, true));
    expect(source.hasAlpha).toBe(true);
    const outcome = searchFormat(source, await codecFor('webp'), 'webp', 4_000, 'best', () => {});
    expect(outcome.found).toBe(true);
    expect(MAGIC.webp(outcome.bytes)).toBe(true);
    outcome.free();
  }, 60_000);

  it('is deterministic: the same input and settings give the same bytes', async () => {
    const source = Source.fromRgba(120, 90, photoLike(120, 90));
    const codec = await codecFor('jpeg');
    const first = searchFormat(source, codec, 'jpeg', 2_500, 'quick', () => {});
    const second = searchFormat(source, codec, 'jpeg', 2_500, 'quick', () => {});
    expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);
    expect([first.quality, first.scale]).toEqual([second.quality, second.scale]);
  }, 60_000);

  it('says so, and offers the smallest possible file, when nothing fits', async () => {
    const source = Source.fromRgba(120, 90, photoLike(120, 90));
    const codec = await codecFor('jpeg');
    const outcome = searchFormat(source, codec, 'jpeg', 1, 'quick', () => {});
    expect(outcome.found).toBe(false);
    const fallback = bestEffort(source, codec, 'jpeg', 'quick');
    expect(fallback.found).toBe(true);
    expect(fallback.bytes.length).toBeGreaterThan(1);
    expect(MAGIC.jpeg(fallback.bytes)).toBe(true);
  }, 60_000);

  it('rejects a pixel buffer that does not match the size', () => {
    expect(() => Source.fromRgba(10, 10, new Uint8Array(10))).toThrow();
  });
});

describe('the TypeScript helpers agree with the core', () => {
  const noopCodec = { encode: () => new Uint8Array(), decodeAvif: () => null, supports: () => true } as unknown as SyncCodec;

  it('formatsFor matches candidateFormats for a codec without palette PNG', () => {
    for (const alpha of [false, true]) {
      const source = Source.fromRgba(8, 8, photoLike(8, 8, alpha));
      expect(source.hasAlpha).toBe(alpha);
      for (const forced of [undefined, 'jpeg', 'webp', 'avif', 'png'] as const) {
        for (const effort of ['quick', 'best'] as Effort[]) {
          expect(candidateFormats(source, noopCodec, forced ?? '', effort), `${alpha} ${forced} ${effort}`).toEqual(formatsFor(alpha, forced, effort));
        }
      }
      source.free();
    }
  });

  it('chooseBest picks the same winner as pickBest', () => {
    let seed = 99;
    const next = (n: number) => ((seed = (seed * 1664525 + 1013904223) >>> 0) >>> 8) % n;
    for (let trial = 0; trial < 300; trial++) {
      const candidates: Candidate[] = Array.from({ length: 1 + next(4) }, () => ({
        bytes: new Uint8Array(1 + next(5000)),
        format: 'jpeg' as const,
        scale: [0.3, 0.5, 0.75, 1][next(4)]!,
        score: [0.5, 0.8, 0.8004, 0.9, 0.9996, 1][next(6)]!,
      }));
      const winner = chooseBest(candidates.map((best) => ({ best, smallest: best.bytes.length })), 1e9);
      // chooseBest takes the later of equal keys, as the Rust max_by_key does.
      const expected = pickBest(
        Float64Array.from(candidates.map((c) => c.score)),
        Float32Array.from(candidates.map((c) => c.scale)),
        Uint32Array.from(candidates.map((c) => c.bytes.length)),
      );
      expect(winner.ok && candidates.indexOf(winner.candidate), JSON.stringify(candidates.map((c) => [c.score, c.scale, c.bytes.length]))).toBe(expected);
    }
  });

  it('pickBest returns -1 for no candidates', () => {
    expect(pickBest(new Float64Array(), new Float32Array(), new Uint32Array())).toBe(-1);
  });
});
