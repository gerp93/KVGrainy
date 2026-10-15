import { describe, expect, it } from 'vitest';
import { parseSizeLimit } from '../src/engine/limit';
import { PRESETS, limitText } from '../src/engine/presets';

describe('PRESETS', () => {
  it('every entry cites a page and a check date', () => {
    for (const p of PRESETS) {
      expect(p.source.url, p.id).toMatch(/^https:\/\//);
      expect(p.source.title, p.id).not.toBe('');
      expect(p.verifiedOn, p.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(p.verifiedOn)), p.id).toBe(false);
      expect(p.bytes, p.id).toBeGreaterThan(0);
      expect(p.detail, p.id).not.toBe('');
    }
  });
  it('has unique ids', () => {
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
  });
  it('fills the size box with a value that never exceeds the limit and is close to it', () => {
    for (const p of PRESETS) {
      const parsed = parseSizeLimit(limitText(p.bytes));
      expect(parsed, p.id).toBeLessThanOrEqual(p.bytes);
      expect(parsed, p.id).toBeGreaterThan(p.bytes * 0.99);
    }
  });
});

describe('limitText', () => {
  it('uses kb under a megabyte and mb above', () => {
    expect(limitText(262_144)).toBe('256kb');
    expect(limitText(128_000)).toBe('125kb');
    expect(limitText(25_000_000)).toBe('23.84mb');
  });
});
