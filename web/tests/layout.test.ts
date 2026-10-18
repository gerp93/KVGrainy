import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('page layout', () => {
  it('keeps the scrollbar gutter, so the tab bar does not jump when a page stops scrolling', () => {
    // Reduce is tall and scrolls on a small window; About is short and does not. Without a reserved gutter the
    // centred content shifts by half a scrollbar when switching between them (the desktop end-to-end test measures this).
    const css = readFileSync(resolve(import.meta.dirname, '../src/styles/global.css'), 'utf8');
    const html = /(^|\n)html\s*\{([^}]*)\}/.exec(css)?.[2] ?? '';
    expect(html).toMatch(/scrollbar-gutter:\s*stable/);
  });
});
