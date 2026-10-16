/** Site-wide facts and the list of pages. One place, so navigation, the sitemap and the tests agree. */

export const SITE = {
  name: 'KVGrainy',
  /** Where the site will live. The domain is not chosen yet (PLAN.md D4); set PUBLIC_SITE_URL when it is. */
  url: (import.meta.env.PUBLIC_SITE_URL ?? 'https://kvgrainy.example').replace(/\/$/, ''),
  /** Search engines are kept out (noindex, robots Disallow) until the owner launches: PUBLIC_LAUNCH=1. */
  launched: import.meta.env.PUBLIC_LAUNCH === '1',
  /** 'off' (default), 'placeholder' (labelled boxes, never deployable) or 'live' (needs ads.txt and a consent tool). */
  ads: (import.meta.env.PUBLIC_ADS ?? 'off') as 'off' | 'placeholder' | 'live',
  repo: 'https://github.com/gerp93/KVGrainy',
  issues: 'https://github.com/gerp93/KVGrainy/issues',
  /** Named on the About page. Confirm before launch; it is a real person's name on a public page. */
  author: { name: 'Kaleb Van Gerpen', url: 'https://github.com/gerp93' },
} as const;

export * from './pages-data';
