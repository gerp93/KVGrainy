// Times a full search in the real page, in Chromium: how long from adding a photo to the finished card.
// usage: npm run build && node scripts/time-search.mjs <photo>... [--limit 300] [--runs 1]
// Prints one row per photo and effort. The photo is read from disk and never leaves this machine; file
// names are not printed (img01, img02...), so the output can be pasted into docs.
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const limit = flag('--limit', '300');
const photos = args.filter((a, i) => !a.startsWith('--') && !['--limit', '--runs'].includes(args[i - 1]));
if (photos.length === 0) throw new Error('give at least one photo');

const server = spawn('npx', ['astro', 'preview', '--host', '127.0.0.1', '--port', '4340'], { cwd: web, shell: true, stdio: 'ignore', detached: false });
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch('http://127.0.0.1:4340/')).ok) break;
    } catch {
      await sleep(500);
    }
  }
  const browser = await chromium.launch();
  console.log(`limit ${limit} KB, ${await browser.version()}, ${(await import('node:os')).cpus().length} logical cores`);
  console.log('photo   input     effort  seconds  result');
  for (const [index, path] of photos.entries()) {
    for (const effort of ['quick', 'best']) {
      const page = await (await browser.newContext()).newPage();
      await page.goto('http://127.0.0.1:4340/');
      await page.locator('#reduce-limit').fill(limit);
      await page.locator('#reduce-limit').press('Enter');
      await page.locator('#effort').selectOption(effort);
      const started = Date.now();
      await page.locator('#file').setInputFiles(path);
      const card = page.locator('#finished-list .card').first();
      await card.waitFor({ timeout: 900_000 });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const detail = (await card.locator('p.detail').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
      const sizes = (await card.locator('p', { hasText: '→' }).first().innerText().catch(() => '')).replace(/\s+/g, ' ');
      console.log(`img${String(index + 1).padStart(2, '0')}   ${(statSync(path).size / 1e6).toFixed(1).padStart(4)} MB   ${effort.padEnd(6)}  ${seconds.padStart(7)}  ${sizes} | ${detail}`);
      await page.context().close();
    }
  }
  await browser.close();
} finally {
  // With shell:true on Windows, kill() only stops the shell; end the whole tree.
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(server.pid), '/t', '/f'], { stdio: 'ignore' });
  else server.kill();
}
void basename;
