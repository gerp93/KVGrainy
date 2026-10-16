import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkAds } from '../scripts/check-ads.mjs';

const slot = '<aside class="ad-slot" data-ad-placeholder>Advertisement placeholder</aside>';

function site(pages: Record<string, string>, extra: Record<string, string> = {}): string {
  const dist = mkdtempSync(join(tmpdir(), 'kvg-ads-'));
  for (const [name, html] of Object.entries({ ...pages, ...extra })) {
    mkdirSync(dirname(join(dist, name)), { recursive: true });
    writeFileSync(join(dist, name), html);
  }
  return dist;
}

describe('the ad rules', () => {
  it('pass for a site with no ads', () => {
    expect(checkAds(site({ 'index.html': '<p>tool</p>', 'faq/index.html': '<p>faq</p>' }))).toEqual([]);
  });

  it('allow a placeholder on a guide while developing', () => {
    expect(checkAds(site({ 'index.html': '<p>tool</p>', 'faq/index.html': slot }))).toEqual([]);
  });

  it('never allow a slot on the tool page, even in development', () => {
    const errors = checkAds(site({ 'index.html': slot }));
    expect(errors.join()).toContain('index.html');
  });

  it('never allow a slot on about, privacy, contact or the 404', () => {
    for (const page of ['about/index.html', 'privacy/index.html', 'contact/index.html', '404.html']) {
      expect(checkAds(site({ 'index.html': '<p>x</p>', [page]: slot })).join(), page).toContain(page);
    }
  });

  it('refuse to deploy a placeholder', () => {
    const errors = checkAds(site({ 'index.html': '<p>x</p>', 'faq/index.html': slot }), { deploy: true });
    expect(errors.join()).toContain('cannot be deployed');
  });

  it('need an ads.txt before live ads', () => {
    expect(checkAds(site({ 'index.html': '<p>x</p>' }), { mode: 'live' }).join()).toContain('ads.txt');
    expect(checkAds(site({ 'index.html': '<p>x</p>' }, { 'ads.txt': 'example.com, pub-0, DIRECT' }), { mode: 'live' })).toEqual([]);
  });
});
