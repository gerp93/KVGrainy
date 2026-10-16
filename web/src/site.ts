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
  /** Named on the About page: the GitHub handle only, by the owner's choice (no legal name on a public page). */
  author: { name: 'gerp93', url: 'https://github.com/gerp93' },
  /** The link-preview card (1200x630, in public/). Absolute, because crawlers need a full URL. */
  ogImage: { path: '/og-image.png', width: 1200, height: 630, alt: 'KVGrainy: pick a size limit, get the best-looking image that fits under it.' },
} as const;

export * from './pages-data';
