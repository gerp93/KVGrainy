// Guards the ad rules (PLAN.md Phase 6) against the built site. Run after `astro build`:
//   node scripts/check-ads.mjs [dist-dir]
//
//   - the tool page never carries an ad slot, in any mode;
//   - pages with no real content of their own (about, privacy, contact, 404) never carry one;
//   - a deployed build (KVG_DEPLOY=production) can never contain a placeholder;
//   - live ads (PUBLIC_ADS=live) need an ads.txt, because without one most networks will not serve.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NO_AD_PAGES = ['index.html', 'about/index.html', 'privacy/index.html', 'contact/index.html', '404.html'];

function htmlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...htmlFiles(path));
    else if (entry.endsWith('.html')) out.push(path);
  }
  return out;
}

/** Problems with the ads in a built site; an empty list means it is fine. */
export function checkAds(dist, { deploy = false, mode = 'off' } = {}) {
  const errors = [];
  const files = htmlFiles(dist);
  for (const file of files) {
    const name = relative(dist, file).replaceAll('\\', '/');
    const html = readFileSync(file, 'utf8');
    const hasPlaceholder = html.includes('data-ad-placeholder');
    const hasSlot = hasPlaceholder || /class="[^"]*\bad-slot\b/.test(html) || html.includes('data-ad-slot');
    if (hasSlot && NO_AD_PAGES.includes(name)) errors.push(`${name}: this page must never carry an ad slot`);
    if (hasPlaceholder && deploy) errors.push(`${name}: an ad placeholder cannot be deployed`);
  }
  if (mode === 'live' && !existsSync(join(dist, 'ads.txt'))) errors.push('PUBLIC_ADS=live needs an ads.txt with the publisher id');
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
  const errors = checkAds(dist, { deploy: process.env.KVG_DEPLOY === 'production', mode: process.env.PUBLIC_ADS ?? 'off' });
  if (errors.length) {
    console.error(`Ad rules broken:\n  ${errors.join('\n  ')}`);
    process.exit(1);
  }
  console.log('Ad rules hold.');
}
