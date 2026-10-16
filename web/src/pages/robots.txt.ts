import type { APIRoute } from 'astro';
import { SITE } from '../site';

// Until the owner launches (PUBLIC_LAUNCH=1), keep every crawler out. After, allow all and point at the sitemap.
export const GET: APIRoute = () => {
  const lines = SITE.launched
    ? ['User-agent: *', 'Allow: /', '', `Sitemap: ${SITE.url}/sitemap.xml`]
    : ['# Not launched yet: keep search engines out until the owner says go.', 'User-agent: *', 'Disallow: /'];
  return new Response(lines.join('\n') + '\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
