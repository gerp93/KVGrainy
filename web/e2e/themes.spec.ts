import data from '../src/ui/visual-assault-themes.json' with { type: 'json' };
import { expect, test } from './fixtures';

// Every VisualAssault theme has to apply on the tool page. This broke once when a stray unclosed rule in
// global.css swallowed the vendored theme rules into a nested selector, so no theme class matched and the
// page silently stayed on Dark. Runs under the production CSP (fixtures.ts), which also fails on console errors.

test('every VisualAssault theme applies', async ({ page }) => {
  await page.goto('/');
  for (const theme of data.themes) {
    await page.locator('#theme-more').selectOption(theme.id);
    await expect(page.locator('html'), theme.id).toHaveAttribute('data-theme', 'va');
    await expect(page.locator('body'), theme.id).toHaveClass(new RegExp(`${theme.id}-theme`));
  }
});

test('a chosen VisualAssault theme is still applied after a reload', async ({ page }) => {
  await page.goto('/');
  await page.locator('#theme-more').selectOption(data.themes[1]!.id);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'va');
});

test('the footer links are laid out by their own rule, not nested inside another', async ({ page }) => {
  await page.goto('/');
  const nested = await page.evaluate(() => {
    const bad: string[] = [];
    const walk = (rules: CSSRuleList) => {
      for (const rule of rules) {
        const text = (rule as CSSStyleRule).selectorText;
        if (text && /\.toast span\s+(\.|body)/.test(text)) bad.push(text);
        if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) walk((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of document.styleSheets) walk(sheet.cssRules);
    return bad;
  });
  expect(nested).toEqual([]);
});
