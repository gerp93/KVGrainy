import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test as base } from '@playwright/test';

/** The production response headers from public/_headers (the `/*` block), which `astro preview` does not apply. */
function productionHeaders(): Record<string, string> {
  const text = readFileSync(resolve(import.meta.dirname, '../public/_headers'), 'utf8');
  const headers: Record<string, string> = {};
  let inAll = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) inAll = line.trim() === '/*';
    else if (inAll && line.trim()) {
      const [name, ...value] = line.trim().split(':');
      headers[name!.trim()] = value.join(':').trim();
    }
  }
  return headers;
}

export interface Seen {
  url: string;
  method: string;
  hasBody: boolean;
}

/**
 * Every spec runs under the real Content-Security-Policy, records every request the page makes,
 * and fails if the browser reports a CSP violation or the page throws.
 */
export const test = base.extend<{ seen: Seen[] }>({
  seen: async ({ page }, use) => {
    const headers = productionHeaders();
    const seen: Seen[] = [];
    const problems: string[] = [];
    await page.route('**/*', async (route) => {
      const response = await route.fetch();
      const url = route.request().url();
      // Only the page itself and its scripts carry the policy; blob: and data: URLs never reach here.
      await route.fulfill({ response, headers: { ...response.headers(), ...headers } });
      void url;
    });
    page.on('request', (r) => seen.push({ url: r.url(), method: r.method(), hasBody: r.postData() !== null }));
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    // privacy.spec.ts deliberately probes example.invalid to prove the CSP refuses it; that refusal is not a problem.
    page.on('console', (m) => m.type() === 'error' && !m.text().includes('example.invalid') && problems.push(`console: ${m.text()}`));
    await use(seen);
    expect(problems, `the page reported errors (CSP violations included):\n${problems.join('\n')}`).toEqual([]);
  },
});

export { expect };
