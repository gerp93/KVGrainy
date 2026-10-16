import { PAGES } from '../src/pages-data';
import { expect, test } from './fixtures';

// The content pages (PLAN.md Phase 6): every page in the registry is real, distinct, well-formed, closed to
// search engines until launch, free of ads, and linked only to pages that exist. Each runs under the
// production CSP (fixtures.ts) and fails on any console error or CSP violation.

const SITE_URL = 'https://kvgrainy.example'; // the default when PUBLIC_SITE_URL is unset

for (const page of PAGES) {
  test(`${page.path} is a well-formed page`, async ({ page: browser, request, baseURL }) => {
    const response = await browser.goto(page.path);
    expect(response?.status()).toBe(200);

    expect(await browser.locator('h1').count(), 'exactly one h1').toBe(1);
    expect(await browser.title()).toBe(page.title);
    expect(await browser.locator('meta[name="description"]').getAttribute('content')).toBe(page.description);
    expect(await browser.locator('link[rel="canonical"]').getAttribute('href')).toBe(SITE_URL + page.path);
    expect(await browser.locator('meta[name="robots"]').getAttribute('content'), 'closed until launch').toBe('noindex');
    await expect(browser.locator('main')).toHaveCount(1);
    await expect(browser.locator('footer')).toHaveCount(1);
    expect(await browser.locator('html').getAttribute('lang')).toBe('en');

    // No ads in the default build, on any page.
    await expect(browser.locator('[data-ad-placeholder], .ad-slot')).toHaveCount(0);

    // Every internal link goes somewhere that exists.
    const hrefs = await browser.locator('a[href]').evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''));
    const internal = [...new Set(hrefs.filter((h) => h.startsWith('/') && !h.startsWith('//')).map((h) => h.split('#')[0]!))];
    for (const href of internal) {
      const target = await request.get(new URL(href, baseURL).toString());
      expect(target.status(), `${page.path} links to ${href}`).toBe(200);
    }

    // Structured data, where present, is valid JSON.
    for (const raw of await browser.locator('script[type="application/ld+json"]').allTextContents()) {
      expect(() => JSON.parse(raw), 'valid JSON-LD').not.toThrow();
    }
  });
}

test('titles and descriptions are unique, so no two pages compete with each other', () => {
  expect(new Set(PAGES.map((p) => p.title)).size).toBe(PAGES.length);
  expect(new Set(PAGES.map((p) => p.description)).size).toBe(PAGES.length);
  expect(new Set(PAGES.map((p) => p.path)).size).toBe(PAGES.length);
  for (const p of PAGES) {
    expect(p.path.startsWith('/') && p.path.endsWith('/'), p.path).toBe(true);
    expect(p.title.length, p.path).toBeLessThanOrEqual(70);
    expect(p.description.length, p.path).toBeGreaterThan(60);
    expect(p.description.length, p.path).toBeLessThanOrEqual(260);
  }
});

test('robots.txt and the sitemap keep crawlers out until launch', async ({ request }) => {
  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toMatch(/Disallow: \/\s/);
  expect(robots).not.toMatch(/Sitemap:/);
  const sitemap = await (await request.get('/sitemap.xml')).text();
  expect(sitemap).toContain('<urlset');
  expect(sitemap).not.toContain('<loc>');
});

test('a page that does not exist gets the 404 page, which is never indexed', async ({ page }) => {
  const response = await page.goto('/404.html');
  expect(response?.status()).toBe(200);
  await expect(page.locator('h1')).toHaveText('Page not found');
  expect(await page.locator('meta[name="robots"]').getAttribute('content')).toBe('noindex');
});

test('the tool page carries WebApplication data and honours ?limit=', async ({ page }) => {
  await page.goto('/?limit=100kb');
  const data = JSON.parse((await page.locator('script[type="application/ld+json"]').first().textContent()) ?? '{}');
  expect(data['@type']).toBe('WebApplication');
  expect(data.isAccessibleForFree).toBe(true);
  await expect(page.locator('#reduce-limit')).toHaveValue('100');
  await expect(page.locator('input[name="reduce-unit"][value="kb"]')).toBeChecked();

  await page.goto('/?limit=2mb');
  await expect(page.locator('#reduce-limit')).toHaveValue('2');
  await expect(page.locator('input[name="reduce-unit"][value="mb"]')).toBeChecked();

  await page.goto('/?limit=banana');
  await expect(page.locator('#reduce-limit')).toHaveValue('500'); // ignored: the default stays
});

test('the FAQ page lists the same questions in its structured data as on the page', async ({ page }) => {
  await page.goto('/faq/');
  const data = JSON.parse((await page.locator('script[type="application/ld+json"]').first().textContent()) ?? '{}');
  expect(data['@type']).toBe('FAQPage');
  const asked: string[] = data.mainEntity.map((q: { name: string }) => q.name);
  const shown = await page.locator('dt').allTextContents();
  expect(shown).toEqual(asked);
});

test('the theme switcher works on a content page', async ({ page }) => {
  await page.goto('/how-it-works/');
  await page.locator('[data-theme-choice="light"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  // The choice carries over to the tool page.
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('common-size-limits cites a source and a date for every limit', async ({ page }) => {
  await page.goto('/common-size-limits/');
  const rows = page.locator('tbody tr');
  expect(await rows.count()).toBeGreaterThanOrEqual(6);
  for (const row of await rows.all()) {
    await expect(row.locator('a[href^="https://"]').first()).toBeVisible();
    await expect(row).toContainText(/\(20\d\d-\d\d-\d\d\)/);
  }
});
