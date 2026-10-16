import type { APIRoute } from 'astro';
import { PAGES, SITE } from '../site';

// Lists every real page, once launched. Before that it is a valid, empty sitemap, so nothing points a
// crawler at pages that say noindex.
export const GET: APIRoute = () => {
  const today = new Date().toISOString().slice(0, 10);
  const urls = SITE.launched
    ? PAGES.map((p) => `  <url><loc>${SITE.url}${p.path}</loc><lastmod>${today}</lastmod></url>`).join('\n')
    : '';
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}${urls ? '\n' : ''}</urlset>\n`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
