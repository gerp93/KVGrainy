import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type Browser, type Page, chromium, expect, test } from '@playwright/test';
import { flatPng, photoPng } from '../../web/e2e/fixture';

// These tests drive the real desktop window: the shared web UI hosted in Tauri, with the search
// running in the native Rust core through Tauri commands (not the WebAssembly build).

const exe = resolve(import.meta.dirname, '../src-tauri/target/debug/kvgrainy-desktop.exe');
const PORT = 9223;
let app: ChildProcess;
let browser: Browser;
let page: Page;
const work = mkdtempSync(join(tmpdir(), 'kvgrainy-desktop-e2e-'));

test.beforeAll(async () => {
  app = spawn(exe, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: join(work, 'webview'),
    },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 120 && !browser; attempt++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    } catch {
      await sleep(500);
    }
  }
  if (!browser) throw new Error('could not reach the app over the WebView2 DevTools port');
  page = browser.contexts()[0]!.pages()[0]!;
  await page.waitForSelector('#file', { state: 'attached' });
});

test.afterAll(async () => {
  await browser?.close().catch(() => {});
  app?.kill();
});

const finished = (name: string) => page.locator('#finished-list .card').filter({ hasText: name }).first();

async function reduce(name: string, buffer: Buffer, limitKb: string, effort: 'quick' | 'best' = 'quick') {
  await page.locator('#reduce-limit').fill(limitKb);
  await page.locator('#reduce-limit').press('Enter');
  await page.locator('#effort').selectOption(effort);
  await page.locator('#file').setInputFiles({ name, mimeType: 'image/png', buffer });
}

test('is the desktop build: no WebAssembly core, a native bridge instead', async () => {
  const bridge = await page.evaluate(() => typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  expect(bridge).toBe('object');
});

test('a photo is reduced under the limit by the native core', async () => {
  await reduce('native-photo.png', photoPng(800, 600), '5');
  const card = finished('native-photo.png');
  await expect(card).toBeVisible();
  await expect(card.locator('a[download]')).toBeVisible();
  const sizes = (await card.locator('p', { hasText: '→' }).first().innerText()).match(/→\s*([\d.]+)\s*(B|KB|MB)/);
  expect(sizes, 'the card should show the new size').not.toBeNull();
  const bytes = Number(sizes![1]) * ({ B: 1, KB: 1024, MB: 1024 * 1024 } as const)[sizes![2] as 'B' | 'KB' | 'MB'];
  expect(bytes).toBeLessThanOrEqual(5 * 1024);
});

test('a flat-colour screenshot comes out as a palette PNG, which only the native core can make', async () => {
  await reduce('native-flat.png', flatPng(480, 360), '1');
  const card = finished('native-flat.png');
  await expect(card).toBeVisible();
  // The web build's PNG has no quality knob; a palette PNG reports one.
  await expect(card.getByText(/PNG · quality/)).toBeVisible();
});

test('says so plainly, and keeps the smallest file, when nothing fits', async () => {
  await reduce('native-impossible.png', photoPng(640, 480), '0.02');
  await expect(page.getByText(/Nothing fits under/).first()).toBeVisible();
});

test('a second launch with a file hands it to the open window', async () => {
  const path = join(work, 'from-explorer.png');
  writeFileSync(path, flatPng(320, 240));
  const second = spawn(exe, [path], { env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: join(work, 'webview2') }, stdio: 'ignore' });
  try {
    await expect(finished('from-explorer.png')).toBeVisible();
  } finally {
    second.kill();
  }
});
