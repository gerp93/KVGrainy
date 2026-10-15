/**
 * Turns a VisualAssault theme's tokens into this site's colour variables.
 *
 * The theme's own colours are used exactly as published. The only thing added is a guard for
 * pairings THIS site creates and the theme never promised to keep legible: button text on the
 * primary-action colour, and the error, success and link colours on a card. Where one would be
 * unreadable it falls back to black or white (button text) or to the theme's own text colour.
 * VisualAssault's own pairs (text on background, and so on) are never altered, even where a theme
 * is deliberately harsh.
 */

export type Rgb = [number, number, number];

/** The `--color-*` tokens VisualAssault defines, by name without the prefix. */
export type Tokens = Partial<Record<string, Rgb>>;

export interface DerivedColors {
  /** This site's custom properties, as `rgb(...)` strings, keyed by property name. */
  vars: Record<string, string>;
  /** Which native control palette fits the background. */
  scheme: 'light' | 'dark';
}

const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];

/** Parse `rgb(r, g, b)` as VisualAssault writes it. Null for anything else. */
export function parseRgb(text: string): Rgb | null {
  const m = /^\s*rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)\s*$/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const linear = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => a.map((c, i) => Math.round(c * (1 - t) + b[i]! * t)) as Rgb;
const css = ([r, g, b]: Rgb) => `rgb(${r}, ${g}, ${b})`;

/** Every token a theme must define for this to work. */
export const REQUIRED_TOKENS = ['bg', 'surface', 'border', 'text', 'text-muted', 'primary-action', 'accent-red', 'accent-green', 'accent-blue'] as const;

/** The custom properties this module sets, so a switch back to a built-in theme can clear them all. */
export const DERIVED_VARS = ['--bg', '--surface', '--surface-2', '--border', '--text', '--muted', '--accent', '--accent-ink', '--accent-text', '--danger', '--ok', '--link'] as const;

export function deriveColors(tokens: Tokens): DerivedColors {
  for (const name of REQUIRED_TOKENS) if (!tokens[name]) throw new Error(`theme is missing --color-${name}`);
  const bg = tokens['bg']!;
  const surface = tokens['surface']!;
  const border = tokens['border']!;
  const text = tokens['text']!;
  const accent = tokens['primary-action']!;

  // Button text: the theme's own choice (or its body text when it makes none), unless that can't be read on the button.
  const wantedInk = tokens['primary-action-text'] ?? text;
  const ink = contrast(wantedInk, accent) >= 4.5 ? wantedInk : contrast(BLACK, accent) >= contrast(WHITE, accent) ? BLACK : WHITE;

  // Colours that carry meaning in text on a card: keep the theme's, unless they vanish into the card.
  const onCard = (color: Rgb) => (contrast(color, surface) >= 3 ? color : text);
  // Secondary text has to stay readable on both the page and a card.
  const muted = tokens['text-muted']!;
  const mutedOk = contrast(muted, bg) >= 3 && contrast(muted, surface) >= 3;

  const vars: Record<string, string> = {
    '--bg': css(bg),
    '--surface': css(surface),
    '--surface-2': css(mix(surface, border, 0.5)),
    '--border': css(border),
    '--text': css(text),
    '--muted': css(mutedOk ? muted : text),
    '--accent': css(accent),
    '--accent-ink': css(ink),
    // The accent used as text on the page (the logo): the theme's own colour if it shows against the page, else its body text.
    '--accent-text': css(contrast(accent, bg) >= 3 ? accent : text),
    '--danger': css(onCard(tokens['accent-red']!)),
    '--ok': css(onCard(tokens['accent-green']!)),
    '--link': css(onCard(tokens['accent-blue']!)),
  };
  return { vars, scheme: contrast(WHITE, bg) < contrast(BLACK, bg) ? 'light' : 'dark' };
}
