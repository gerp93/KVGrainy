/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REQUIRED_TOKENS, contrast, deriveColors, parseRgb, type Rgb, type Tokens } from '../src/ui/themecolors';

// The vendored VisualAssault stylesheet and theme list, exactly as the page loads them.
const css = readFileSync(new URL('../src/styles/visual-assault.css', import.meta.url), 'utf8');
const list = JSON.parse(readFileSync(new URL('../src/ui/visual-assault-themes.json', import.meta.url), 'utf8')) as { tag: string; themes: { id: string; name: string }[] };
const themes = new Map<string, Tokens>();
for (const block of css.matchAll(/body\.([a-z0-9-]+)-theme\s*\{([^}]*)\}/g)) {
  const tokens: Tokens = {};
  for (const v of block[2]!.matchAll(/--color-([a-z-]+):\s*(rgb\([^)]*\))/g)) tokens[v[1]!] = parseRgb(v[2]!)!;
  themes.set(block[1]!, tokens);
}

const rgb = (text: string): Rgb => {
  const parsed = parseRgb(text);
  if (!parsed) throw new Error(`not an rgb colour: ${text}`);
  return parsed;
};

describe('the vendored VisualAssault copy', () => {
  it('is pinned to a release tag, never main', () => {
    expect(list.tag).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(css).toContain(`at tag ${list.tag}`);
    expect(css).toMatch(/Do not hand-edit/);
  });
  it('has a CSS block for every listed theme and no others', () => {
    expect([...themes.keys()].sort()).toEqual(list.themes.map((t) => t.id).sort());
    expect(list.themes.length).toBeGreaterThan(0);
  });
  it('defines every token this site needs, in every theme', () => {
    for (const [id, tokens] of themes) for (const name of REQUIRED_TOKENS) expect(tokens[name], `${id}: --color-${name}`).toBeTruthy();
  });
});

describe('parseRgb', () => {
  it('reads rgb() and nothing else', () => {
    expect(parseRgb('rgb(13, 71, 161)')).toEqual([13, 71, 161]);
    expect(parseRgb(' rgb(0,0,0) ')).toEqual([0, 0, 0]);
    expect(parseRgb('#0d47a1')).toBeNull();
    expect(parseRgb('rgb(1, 2)')).toBeNull();
  });
});

describe('contrast', () => {
  it('matches the WCAG extremes', () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrast([120, 120, 120], [120, 120, 120])).toBeCloseTo(1, 5);
  });
});

describe('deriveColors', () => {
  it("passes a theme's own colours through untouched", () => {
    for (const [id, tokens] of themes) {
      const { vars } = deriveColors(tokens);
      expect(vars['--bg'], id).toBe(`rgb(${tokens['bg']!.join(', ')})`);
      expect(vars['--surface'], id).toBe(`rgb(${tokens['surface']!.join(', ')})`);
      expect(vars['--text'], id).toBe(`rgb(${tokens['text']!.join(', ')})`);
      expect(vars['--accent'], id).toBe(`rgb(${tokens['primary-action']!.join(', ')})`);
    }
  });

  it('always leaves button text readable on the button', () => {
    for (const [id, tokens] of themes) {
      const { vars } = deriveColors(tokens);
      expect(contrast(rgb(vars['--accent-ink']!), rgb(vars['--accent']!)), id).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps error, success, link and secondary text readable on a card', () => {
    for (const [id, tokens] of themes) {
      const { vars } = deriveColors(tokens);
      const surface = rgb(vars['--surface']!);
      for (const name of ['--danger', '--ok', '--link'] as const) {
        const color = rgb(vars[name]!);
        const isThemeText = vars[name] === vars['--text'];
        // Either the theme's own colour read fine, or it fell back to the theme's body text.
        expect(isThemeText || contrast(color, surface) >= 3, `${id} ${name}`).toBe(true);
      }
      const muted = rgb(vars['--muted']!);
      expect(vars['--muted'] === vars['--text'] || (contrast(muted, surface) >= 3 && contrast(muted, rgb(vars['--bg']!)) >= 3), `${id} --muted`).toBe(true);
    }
  });

  it('keeps the logo colour readable on the page', () => {
    for (const [id, tokens] of themes) {
      const { vars } = deriveColors(tokens);
      const text = rgb(vars['--accent-text']!);
      expect(vars['--accent-text'] === vars['--text'] || contrast(text, rgb(vars['--bg']!)) >= 3, id).toBe(true);
    }
  });

  it("uses the theme's own button text when it reads, and black or white when it does not", () => {
    // Electric Lime's near-black text on dark purple would be 1.5:1, so it must be replaced.
    const lime = deriveColors(themes.get('electric-lime')!).vars;
    expect(lime['--accent-ink']).toMatch(/^rgb\((0, 0, 0|255, 255, 255)\)$/);
    // Hacker's own pairing is fine, so it is kept as published.
    const hacker = themes.get('hacker')!;
    expect(deriveColors(hacker).vars['--accent-ink']).toBe(`rgb(${(hacker['primary-action-text'] ?? hacker['text']!).join(', ')})`);
  });

  it('picks the native control palette from the background', () => {
    expect(deriveColors(themes.get('electric-lime')!).scheme).toBe('light');
    expect(deriveColors(themes.get('hacker')!).scheme).toBe('dark');
  });

  it('refuses a theme that is missing a token', () => {
    const broken = { ...themes.get('hacker')! };
    delete broken['surface'];
    expect(() => deriveColors(broken)).toThrow(/surface/);
  });
});
