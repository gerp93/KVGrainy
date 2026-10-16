# Deploying the website (Cloudflare Pages)

The site is static files (`web/dist`). `.github/workflows/deploy-web.yml` builds it in GitHub Actions and uploads it to
**Cloudflare Pages**, which applies `web/public/_headers` (the Content-Security-Policy and friends) as-is. Nothing here is
done for you: the workflow is **inert until you add two secrets**, and every step below is a click only the account
owner can make.

## Why secrets

The deploy job runs on GitHub's servers and has to log in to Cloudflare to upload the site. Cloudflare gives you an API
token (a password for that one job). The repository is public, so the token cannot live in the code; GitHub's encrypted
**secrets** hold it, readable only by workflows. Without them the job prints "Deploy skipped" and does nothing.

## One-time setup (about 15 minutes)

1. **Cloudflare account.** Sign up at cloudflare.com (free plan).
2. **Put your domain on Cloudflare.** Add the site in the dashboard and change the domain's nameservers at the registrar to
   the two Cloudflare gives you (or register/transfer the domain to Cloudflare). A bare domain such as `example.com`
   needs this; check Cloudflare's current Pages custom-domain docs if you would rather keep DNS elsewhere.
3. **Create the Pages project** (Workers & Pages > Create > Pages > Upload assets), named `kvgrainy` (or set the
   repository variable `CLOUDFLARE_PAGES_PROJECT` to another name), production branch `main`. Upload anything to create it;
   the workflow replaces it. Or from a terminal: `npx wrangler pages project create kvgrainy --production-branch main`.
4. **Create an API token** (My Profile > API Tokens > Create Token > Create Custom Token). Permission: **Account >
   Cloudflare Pages > Edit**, scoped to your account. Copy it once; Cloudflare will not show it again.
5. **Find your Account ID** (the Workers & Pages overview page, right-hand side).
6. **Add the GitHub secrets** (repository Settings > Secrets and variables > Actions > *Secrets*):
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
7. **Add the GitHub variables** (same page, *Variables* tab): `PUBLIC_SITE_URL` = `https://your-domain` now; leave
   `PUBLIC_LAUNCH` unset until launch day.
8. **Attach the domain** to the Pages project (Custom domains > Set up a custom domain).
9. **Run it.** Actions > "Deploy web" > Run workflow on `main`. The log ends with the deployment URL. Check:
   - `curl -sI https://your-domain/` shows `content-security-policy` and `x-robots-tag: noindex` (still closed).
   - Open the site and reduce an image.

The first real run is also the first test of the upload command (`wrangler pages deploy`), which could not be run from the
development environment; if it fails, the log says why and the fix is usually the project name or the token's scope.

## What happens on its own after that

- **Push to `main`** touching `web/**`, `crates/**` or the lock files: waits for that commit's Web CI to pass, then
  builds and deploys production. A commit whose tests fail is never deployed.
- **Pull request** from this repository: a preview deployment, always built closed to search engines.
- Every build runs the bundle budgets and the ad rules (`KVG_DEPLOY=production` refuses an ad placeholder) and checks that
  the search-engine header matches the launch setting.

## Launch day

1. Set the repository variable `PUBLIC_LAUNCH` = `1` (and confirm `PUBLIC_SITE_URL`).
2. Re-run "Deploy web" on `main`. The build step fails if a launch build still sends `X-Robots-Tag`.
3. Verify: `curl -sI https://your-domain/` has **no** `x-robots-tag`; `https://your-domain/robots.txt` allows crawling;
   `/sitemap.xml` lists 12 pages.
4. Submit the sitemap in Google Search Console and Bing Webmaster Tools.
5. Posts and the checklist: `docs/launch.md`.

## Keep these Cloudflare features OFF

Several Cloudflare dashboard features inject their own script or rewrite pages. They would be blocked by the site's
Content-Security-Policy, and they contradict the privacy page ("no analytics or tracking script"). Leave them off:
Web Analytics (and Browser Insights), Rocket Loader, Auto Minify, Email Address Obfuscation, Zaraz, and any "Speed"
setting that rewrites HTML. If you later want analytics, update `/privacy/` first (`docs/web-content.md`).

## After deploying

- `/privacy/` names Cloudflare as the host. If you ever change host, change that sentence.
- HTTPS is automatic. Consider turning on "Always Use HTTPS" and HSTS (SSL/TLS > Edge Certificates) once everything works;
  do not enable HSTS preload until you are sure.
- Desktop installers are not hosted here; they stay on GitHub Releases (`docs/release.md`).
