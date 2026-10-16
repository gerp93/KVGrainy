/** The list of pages, as plain data with no build-time environment, so tests and scripts can import it. */

export interface PageInfo {
  /** Always starts and ends with "/". */
  path: string;
  /** The <title>; also the link text in lists. Unique per page. */
  title: string;
  /** The meta description. Unique per page. */
  description: string;
  /** A short label for the navigation, where the title is too long. */
  nav?: string;
  /** "tool" has no ads, ever. Guides and info pages are the only places an ad may go. */
  kind: 'tool' | 'guide' | 'info';
}

export const PAGES: PageInfo[] = [
  {
    path: '/',
    title: 'KVGrainy: make your images more grainy',
    description: 'Get the best-looking version of an image that fits under the size you choose. It all runs in your browser; your image is never uploaded.',
    kind: 'tool',
  },
  {
    path: '/how-it-works/',
    nav: 'How it works',
    title: 'How KVGrainy fits an image under a size limit',
    description: 'What the search does: it tries scales and qualities in JPEG, WebP, AVIF and PNG and keeps the version that looks closest to the original while staying under your limit.',
    kind: 'guide',
  },
  {
    path: '/compress-image-to-100kb/',
    title: 'Compress an image to under 100 KB',
    description: 'What an image under 100 KB looks like, how many pixels fit, and how to get a photo under 100 KB without a blocky mess. Measured on real phone photos.',
    kind: 'guide',
  },
  {
    path: '/compress-image-to-1mb/',
    title: 'Compress an image to under 1 MB',
    description: 'Most photos fit under 1 MB with little visible loss. What to expect, which format wins, and when a very large photo has to shrink.',
    kind: 'guide',
  },
  {
    path: '/compress-image-to-2mb/',
    title: 'Compress an image to under 2 MB',
    description: 'Fitting a photo under 2 MB: how much of the original survives, why the format matters more than the quality slider, and what to do when it will not fit.',
    kind: 'guide',
  },
  {
    path: '/make-gif-smaller/',
    title: 'Make a GIF smaller without ruining it',
    description: 'What makes a GIF big, which of its three knobs (size, colours, frames) to turn first, and how the Fine-Tune GIF tab lets you choose.',
    kind: 'guide',
  },
  {
    path: '/jpeg-webp-avif-png/',
    title: 'JPEG, WebP, AVIF or PNG: which format for a small file',
    description: 'When each image format gives the smallest file at the same look, and why KVGrainy tries all of them instead of guessing.',
    kind: 'guide',
  },
  {
    path: '/common-size-limits/',
    nav: 'Size limits',
    title: 'Common upload size limits, with sources',
    description: 'File size limits for Discord, Gmail, GitHub, YouTube and Slack, each with the page it came from and the date we checked it.',
    kind: 'guide',
  },
  {
    path: '/faq/',
    nav: 'FAQ',
    title: 'Frequently asked questions',
    description: 'Is my image uploaded, why does the result look slightly smaller, what do Quick and Best mean, and other things people ask about KVGrainy.',
    kind: 'info',
  },
  {
    path: '/about/',
    nav: 'About',
    title: 'About KVGrainy',
    description: 'Who makes KVGrainy, why it exists, and what it will and will not do. Free, open source and local-first.',
    kind: 'info',
  },
  {
    path: '/privacy/',
    title: 'Privacy',
    description: 'KVGrainy never uploads your images, has no accounts and sets no cookies today. What is stored, what the host can see, and what changes if ads are added.',
    kind: 'info',
  },
  {
    path: '/contact/',
    title: 'Contact and bug reports',
    description: 'How to report a bug, ask for a feature or report a security problem in KVGrainy.',
    kind: 'info',
  },
];

export function pageInfo(path: string): PageInfo {
  const page = PAGES.find((p) => p.path === path);
  if (!page) throw new Error(`no page registered for ${path}`);
  return page;
}

/** The pages in the top navigation. */
export const NAV: string[] = ['/how-it-works/', '/common-size-limits/', '/faq/', '/about/'];
