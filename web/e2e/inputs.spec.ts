import { expect, test } from './fixtures';
import { flatPng, photoPng } from './fixture';

const notice = (page: import('@playwright/test').Page) => page.locator('#drop-notice');
const finished = (page: import('@playwright/test').Page) => page.locator('#finished-list .card');

test('a file that is not an image is said to be skipped, not silently ignored', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(notice(page)).toBeVisible();
  await expect(notice(page)).toContainText('"notes.txt" is not an image or a clip');
  await expect(page.locator('#jobs')).toBeHidden();
});

test('a mixed drop reduces the image and names what it skipped', async ({ page }) => {
  await page.goto('/');
  await page.locator('#reduce-limit').fill('2');
  await page.locator('#reduce-limit').press('Enter');
  await page.locator('#effort').selectOption('quick');
  await page.locator('#file').setInputFiles([
    { name: 'photo.png', mimeType: 'image/png', buffer: photoPng(320, 240) },
    { name: 'paper.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') },
  ]);
  await expect(notice(page)).toContainText('"paper.pdf"');
  await expect(finished(page).filter({ has: page.locator('a[download]') })).toHaveCount(1);
  // The next drop that has nothing wrong with it clears the message.
  await page.locator('#file').setInputFiles({ name: 'again.png', mimeType: 'image/png', buffer: photoPng(160, 120) });
  await expect(notice(page)).toBeHidden();
});

test('an empty file says it is empty, not "ImageDecoder"', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file').setInputFiles({ name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0) });
  await expect(finished(page)).toContainText('This file is empty');
  await expect(finished(page)).not.toContainText('ImageDecoder');
});

test('a damaged image gets a plain message, and HEIC says what to do', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file').setInputFiles({ name: 'broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not really a jpeg at all') });
  await expect(finished(page).first()).toContainText('could not be read as an image');

  // Chrome gives a HEIC file an empty type; it still gets a card, and a message about JPEG.
  await page.locator('#file').setInputFiles({ name: 'IMG_0001.HEIC', mimeType: '', buffer: Buffer.from('\0\0\0\x18ftypheic' + '\0'.repeat(64)) });
  await expect(finished(page).first()).toContainText('cannot open HEIC photos');
});

test('an image over the browser cap is refused with a way forward', async ({ page }) => {
  await page.goto('/');
  // 5000 x 5000 = 25 MP, just over the 24 MP cap; flat colour keeps the file small.
  await page.locator('#file').setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: flatPng(5000, 5000) });
  await expect(finished(page).first()).toContainText('25 megapixels');
  await expect(finished(page).first()).toContainText('desktop app');
});
