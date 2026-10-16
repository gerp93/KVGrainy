# Web content, SEO and ads (PLAN.md Phase 6)

The site is the tool (`/`) plus 11 real pages. Everything is written to be useful on its own, uses
facts we measured or cite, and ships **closed to search engines** until you launch.

## Pages

Registered once, in `web/src/pages-data.ts` (title, description, kind); navigation, the footer, the
sitemap and the tests all read it.

| Page | What it is |
|---|---|
| `/how-it-works/` | what the search does and why; Quick vs Best; what it will not do |
| `/compress-image-to-100kb/`, `-1mb/`, `-2mb/` | what actually fits, **measured on ten real phone photos** (numbers in the page, with their sample and settings) |
| `/make-gif-smaller/` | the three things that make a GIF big and which to give up first |
| `/jpeg-webp-avif-png/` | when each format wins, with what we saw |
| `/common-size-limits/` | Discord, Gmail, GitHub, YouTube, Slack limits from `presets.ts`, each with its source link and the date it was checked |
| `/faq/` | ten questions; the FAQPage structured data is generated from the same list |
| `/about/`, `/privacy/`, `/contact/` | who, what is stored, how to report things |

There are no mass-generated pages. A third-party limit appears only in `presets.ts`, which requires a source URL and a
verification date, and the Playwright suite checks every row shows both. The size guides link to the tool with
`/?limit=100kb`, which pre-fills the size box.

## Closed until you launch

By default every page says `noindex`, `robots.txt` disallows everything and `sitemap.xml` is empty. To open the site:

```bash
PUBLIC_LAUNCH=1 PUBLIC_SITE_URL=https://your-domain npm run build
```

That switches the robots meta to `index,follow`, makes `robots.txt` allow crawling and point at the sitemap, lists all 12
pages in `sitemap.xml`, and uses your domain in canonical URLs. The 404 page is never indexed.

It also decides the `X-Robots-Tag: noindex` response header. That header is **not** in `public/_headers`: the build adds it to
`dist/_headers` only when `PUBLIC_LAUNCH` is not `1` (`web/scripts/launch-headers.mjs`, wired in `astro.config.mjs`, unit-tested
in `web/tests/inputs.test.ts`). It used to be hard-coded, which would have kept a launch build out of search engines.

**Before launching, confirm:** the domain (PLAN.md D4 is open); and that you are happy with the copy. `/about/` names the
GitHub handle only (`SITE.author` in `web/src/site.ts`), by the owner's choice; the `LICENSE` and `THIRD_PARTY.md` carry
whatever copyright line they carry. The numbers in the size guides come
from my runs on your phone photos and describe the desktop engine; rerun them if you change the search.

## Structured data

`/` carries `WebApplication` (free, AGPL-3.0, with the code repository), and `/faq/` carries `FAQPage`. Nothing else is
marked up: structured data has to be true, and the other pages are articles that do not map to a type we can claim honestly.

## Lighthouse

Run against a launch-mode build with the system Edge browser (Lighthouse 12, desktop defaults): the tool page, `/how-it-works/`,
`/compress-image-to-100kb/`, `/faq/`, `/common-size-limits/` and `/make-gif-smaller/` score 100 in performance, accessibility, best practices
and SEO (largest contentful paint 1.2 to 1.5 s, no layout shift, no blocking time). Two things it caught were fixed: a missing favicon and
footer links too small to tap. Mobile emulation was not run, and these numbers are from my machine over localhost; re-run on the real host.

## Analytics

None. The Privacy page says so, and a test would catch a third-party script. When you want numbers, choose a cookieless service
(Plausible, Fathom, Cloudflare Web Analytics, or counting from server logs), add it, and update `/privacy/` **first**; a
self-hosted or first-party option keeps the CSP's "own origin only" rule intact, a hosted script needs a deliberate, reviewed
exception in `public/_headers` and the page meta.

## Ads

Nothing is live. The rules from the plan are enforced in code, not just written down:

- `AdSlot.astro` renders nothing by default. With `PUBLIC_ADS=placeholder` it draws a labelled, dashed box with reserved
  height (250 px) on **guide and FAQ pages only**. `live` is reserved for the real ad code and currently renders nothing.
- **Never on the tool page, never near a button or the drop zone, none on pages without real content** (about, privacy,
  contact, 404). `npm run check-ads` fails the build if a slot appears on any of them; `npm run test:ads` builds with
  placeholders and proves the slots land where they should and that a deployed build (`KVG_DEPLOY=production`) is refused.
  Both run in Web CI.
- `PUBLIC_ADS=live` fails the check unless `dist/ads.txt` exists (put it in `web/public/` once you have a publisher id).
- **Not done, and it is yours:** an ad network account, the real ad code, the `ads.txt` id, and a certified consent tool
  (a Google-certified CMP for visitors in the EEA, UK and Switzerland). Wiring ads without those would break the privacy
  promise. When ads go live: update `/privacy/` to name the partners and cookies, loosen the CSP deliberately for exactly the
  hosts the network needs, and re-run `e2e/privacy.spec.ts`, which will (rightly) fail until you decide how the privacy claim
  is worded.

## Accounts and money

You create every account (Cloudflare Pages, analytics, an ad network), buy the domain, and enter all identity, bank and tax details.
Nothing in this repo does that for you.
