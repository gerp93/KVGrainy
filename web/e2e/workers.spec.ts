import { devices, type Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { photoPng } from './fixture';

// 4.3 MP: over the 4 MP line where a constrained device stops running every format worker at once.
const IMAGE = () => ({ name: 'photo.png', mimeType: 'image/png', buffer: photoPng(2400, 1800) });

/** Reduce the image and report the most format workers that were alive at the same moment. */
async function mostWorkersAtOnce(page: Page): Promise<number> {
  await page.goto('/');
  await page.locator('#reduce-limit').fill('200');
  await page.locator('#reduce-limit').press('Enter');
  await page.locator('#effort').selectOption('quick');
  let most = 0;
  const sample = setInterval(() => {
    most = Math.max(most, page.workers().length);
  }, 25);
  try {
    await page.locator('#file').setInputFiles(IMAGE());
    await expect(page.locator('#finished-list .card a[download]').first()).toBeVisible({ timeout: 110_000 });
  } finally {
    clearInterval(sample);
  }
  return most;
}

test('a desktop runs the format workers in parallel, even for a large image', async ({ page }) => {
  expect(await mostWorkersAtOnce(page)).toBeGreaterThanOrEqual(2);
});

test.describe('a phone', () => {
  // The device descriptor names WebKit; these tests run in Chromium, which can still pose as the phone.
  const { defaultBrowserType: _ignored, ...iphone } = devices['iPhone 13'];
  test.use(iphone);

  test('runs the format workers one after another for a large image, and still finishes', async ({ page }) => {
    expect(await mostWorkersAtOnce(page)).toBe(1);
  });
});
