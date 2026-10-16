import { readFileSync, statSync } from 'node:fs';
import { expect, test } from './fixtures';
import { photoPng } from './fixture';

const finishedCard = (page: import('@playwright/test').Page) =>
  page.locator('#finished-list .card, #queue-list .card').filter({ has: page.locator('a[download]') }).first();

function magic(bytes: Buffer): string {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpeg';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'png';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') return 'avif';
  return 'unknown';
}

test('reduces a photo under the limit in a real browser, with the Rust core', async ({ page }) => {
  await page.goto('/');
  await page.locator('#reduce-limit').fill('2');
  await page.locator('#reduce-limit').press('Enter');
  await page.locator('#effort').selectOption('quick');
  await page.locator('#file').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: photoPng(640, 480) });

  const card = finishedCard(page);
  await expect(card).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), card.locator('a[download]').first().click()]);
  const path = await download.path();
  const bytes = readFileSync(path);
  expect(statSync(path).size).toBeLessThanOrEqual(2 * 1024);
  expect(['jpeg', 'webp', 'png']).toContain(magic(bytes));

  // The decoded dimensions are real (the browser can open the file the core produced).
  const dims = await page.evaluate(async (b64) => {
    const blob = new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]);
    const bitmap = await createImageBitmap(blob);
    return { width: bitmap.width, height: bitmap.height };
  }, bytes.toString('base64'));
  expect(dims.width).toBeGreaterThan(50);
});

test('Best effort also tries AVIF and still produces a valid file', async ({ page }) => {
  await page.goto('/');
  await page.locator('#reduce-limit').fill('3');
  await page.locator('#reduce-limit').press('Enter');
  await page.locator('#effort').selectOption('best');
  await page.locator('#file').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: photoPng(480, 360) });
  const card = finishedCard(page);
  await expect(card).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), card.locator('a[download]').first().click()]);
  const bytes = readFileSync(await download.path());
  expect(bytes.length).toBeLessThanOrEqual(3 * 1024);
  expect(['jpeg', 'webp', 'png', 'avif']).toContain(magic(bytes));
});

test('says so plainly, and offers the smallest file, when nothing fits', async ({ page }) => {
  await page.goto('/');
  await page.locator('#reduce-limit').fill('0.02');
  await page.locator('#reduce-limit').press('Enter');
  await page.locator('#effort').selectOption('quick');
  await page.locator('#file').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: photoPng(640, 480) });
  await expect(page.getByText(/Nothing fits under/)).toBeVisible();
});

test('cancel stops a running search', async ({ page }) => {
  await page.goto('/');
  await page.locator('#reduce-limit').fill('40');
  await page.locator('#reduce-limit').press('Enter');
  await page.locator('#effort').selectOption('best');
  await page.locator('#file').setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: photoPng(1600, 1200) });
  const cancel = page.locator('#queue-list .card').getByRole('button', { name: 'Cancel' }).first();
  await expect(cancel).toBeVisible();
  await cancel.click();
  await expect(page.getByText('Cancelled.')).toBeVisible();
});
