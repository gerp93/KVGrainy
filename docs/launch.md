# Launch plan (PLAN.md Phase 7)

Nothing here has been posted, and none of it can be by me: it is drafts, a checklist, and the numbers you
need to decide. Do the checklist first; the posts are only worth sending once the claims in them are
true on the live site.

## Before anything is posted

1. **Open the site.** Buy the domain, put the site on Cloudflare Pages, and build with
   `PUBLIC_LAUNCH=1 PUBLIC_SITE_URL=https://your-domain` (docs/web-content.md). Confirm the name on `/about/`.
2. **Ship the desktop build people will actually download.** Add the signing secrets (docs/release.md);
   an unsigned installer makes the first impression "Windows protected your PC".
3. **Have the benchmark table.** The plan says to lead with it. `docs/benchmark-baseline.md` and
   `docs/benchmark-vs-manual.md` are the honest first results (read their limits). A claim like "beats
   Squoosh/TinyPNG" needs those tools run on 20 real images, which has not been done; do not make it until it is.
4. **Record the 10-second demo.** `cd web && npm run build && npm run demo` records a scripted run in the real
   page (drop a photo, set 100 KB, the result with its before/after) to `web/demo/demo.webm`. Convert it to a
   GIF with KVGrainy itself if you like (the desktop app turns a clip into a GIF).
5. **Read each community's rules** before posting. Several forbid or restrict self-promotion; I have not checked
   any of them, and rules change.

## Where, and the angle for each

| Where | Angle |
|---|---|
| **Show HN** | The technical story: one Rust search shared by a WebAssembly web tool and a native desktop app; the privacy claim enforced by a test; honest limits. Lead with the table and the demo. |
| **Discord, streaming and emote communities** | Practical: "fit your emote under the limit", linking `/common-size-limits/` (every number cited). |
| **Docs and README authors** | GIFs: `/make-gif-smaller/`, with the Fine-Tune tab. |
| **r/DataHoarder and similar** | The local-first, no-upload, open-source angle, and the desktop app for batches. Check whether it fits the subreddit at all. |

## Drafts

### Show HN

**Title:** Show HN: KVGrainy – pick a size, get the best-looking image that fits (local, open source)

> Most image compressors give you a quality slider. What I usually have is a limit: an upload cap, an email size,
> "under 100 KB". KVGrainy takes the limit and searches for the best-looking result that fits, across scales and
> JPEG/WebP/AVIF/PNG, scoring candidates with SSIMULACRA2.
>
> It runs entirely in your browser (nothing is uploaded; a test asserts no request carries image data), or as a desktop
> app. The search is written once in Rust: it runs as WebAssembly in the page and natively in the desktop app, which is
> faster and can also make palette PNGs.
>
> Things I measured and things I haven't: on ten phone photos at 100 KB, [table]. I have not yet compared it against
> Squoosh or TinyPNG on a proper image set, and I've only tested Chromium. Feedback on pictures it handles badly is the most
> useful thing you can send.
>
> Code (AGPL-3.0): https://github.com/gerp93/KVGrainy · Try it: [url]

(Fill the bracketed parts from the real benchmark. Do not post it with the placeholder left in.)

### Short version for chat communities

> Made a free tool that fits an image or GIF under a size limit (like Discord's 256 KB emoji cap) with the best quality it
> can. Runs in your browser, nothing uploaded. [url]/common-size-limits/ lists the limits with sources.

Only post the Discord line if the limit on that page is still what Discord says; re-check the source first (the page shows the date).

## After launch

- **Feedback goes to GitHub issues** (`/contact/` says so); real findings go into `TODO.md`.
- Add **cookieless analytics** only after updating `/privacy/` (docs/web-content.md), so you can tell whether the numbers below are being met.
- Answer every early issue yourself; the first 20 users decide whether it is a product.

## When to stop or change course

The plan asks for a trigger, defined with you. **These are proposals, not decisions:**

- **Stop or rethink if**, about **3 months after launch**, there are **fewer than ~500 unique visitors a month** *and* **no
  external mention** (no post, article or link you did not write), *and* **fewer than ~5 people who used it more than
  once** (needs analytics or a feedback form to know).
- **Keep going if** any of the three is clearly beating that, or the desktop installs (release download counts) are
  growing even while the website is quiet.

Pick the real numbers before launch. Revisit the goal (free open source, or a paid "pro" with batch and video) only after
there is real usage to look at.
