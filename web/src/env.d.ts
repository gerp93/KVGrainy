/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** The site's public origin, once the domain is chosen. */
  readonly PUBLIC_SITE_URL?: string;
  /** "1" opens the site to search engines. */
  readonly PUBLIC_LAUNCH?: string;
  /** "off" (default), "placeholder" or "live". */
  readonly PUBLIC_ADS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
