// Builds the site with ad placeholders on and checks the rules hold in the real output:
//   - placeholders appear on guide pages and nowhere else (the tool, about, privacy, contact, 404 stay clean);
//   - the ad check passes in development and FAILS for a deployed build, so a placeholder can never ship.
// Run by CI after the normal build: `npm run test:ads`.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = 'dist-ads';
const run = (command, args, env = {}) =>
  spawnSync(command, args, { cwd: web, shell: true, encoding: 'utf8', env: { ...process.env, ...env } });

const build = run('npx', ['astro', 'build', '--outDir', out], { PUBLIC_ADS: 'placeholder' });
if (build.status !== 0) {
  console.error(build.stdout, build.stderr);
  throw new Error('the placeholder build failed');
}

const html = (page) => readFileSync(join(web, out, page), 'utf8');
const has = (page) => html(page).includes('data-ad-placeholder');
const check = (cond, message) => {
  if (!cond) throw new Error(message);
  console.log('ok  ', message);
};

for (const page of ['how-it-works/index.html', 'faq/index.html', 'compress-image-to-100kb/index.html', 'make-gif-smaller/index.html']) {
  check(has(page), `${page} has a placeholder`);
}
for (const page of ['index.html', 'about/index.html', 'privacy/index.html', 'contact/index.html', '404.html']) {
  check(!has(page), `${page} has no placeholder`);
}

const development = run('node', ['scripts/check-ads.mjs', out], { PUBLIC_ADS: 'placeholder' });
check(development.status === 0, 'the ad check passes while developing with placeholders');
const deployed = run('node', ['scripts/check-ads.mjs', out], { PUBLIC_ADS: 'placeholder', KVG_DEPLOY: 'production' });
check(deployed.status !== 0, 'the ad check refuses to deploy a build with placeholders');
console.log('ad rules verified');
