// Records a short scripted run of the real page to web/demo/demo.webm: drop a photo, ask for 100 KB, show the result.
// Needs a built site and Playwright's browser:  npm run build && node scripts/record-demo.mjs
// The photo is generated here (no real image is used), so the demo can be shared freely.
import { spawn } from 'node:child_process';
import { mkdirSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { photoPng } from '../e2e/fixture.ts';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(web, 'demo');
const tmp = join(out, '.tmp');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const server = spawn('npx', ['astro', 'preview', '--host', '127.0.0.1', '--port', '4330'], { cwd: web, shell: true, stdio: 'ignore', detached: false });
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch('http://127.0.0.1:4330/')).ok) break;
    } catch {
      await sleep(500);
    }
  }
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, recordVideo: { dir: tmp, size: { width: 1100, height: 760 } } });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4330/');
  await sleep(800);
  await page.locator('#reduce-limit').fill('100');
  await page.locator('#reduce-limit').press('Enter');
  await sleep(600);
  await page.locator('#file').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: photoPng(1600, 1200) });
  await page.locator('#finished-list .card a[download]').first().waitFor({ timeout: 60_000 });
  await sleep(2500);
  await context.close();
  await browser.close();
  const [video] = readdirSync(tmp).filter((f) => f.endsWith('.webm'));
  renameSync(join(tmp, video), join(out, 'demo.webm'));
  console.log(`wrote ${join(out, 'demo.webm')}`);
} finally {
  // With shell:true on Windows, kill() only stops the shell; end the whole tree.
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(server.pid), '/t', '/f'], { stdio: 'ignore' });
  else server.kill();
  rmSync(tmp, { recursive: true, force: true });
}
