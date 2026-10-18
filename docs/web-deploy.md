# Deploying the web tool to kvgrainy.com

The site is static (`web/dist`), hosted on Cloudflare Pages (PLAN.md D5).
`.github/workflows/web-deploy.yml` builds it on every web change merged to `main` and uploads it
once the two secrets below exist. Until then it builds and skips the upload.

The accounts, API token and DNS belong to the owner; nothing here can be done by the build.

## One-time setup

1. **Cloudflare account** (free): https://dash.cloudflare.com/sign-up
2. **Pages project:** Workers & Pages > Create > Pages > *Direct Upload*, name it exactly
   `kvgrainy` (the workflow uses that name). Upload any placeholder folder to finish creating it.
3. **API token:** My Profile > API Tokens > Create Token > custom, permission
   *Account > Cloudflare Pages > Edit*. Copy the token, and your Account ID (Workers & Pages overview).
4. **GitHub secrets** (repo Settings > Secrets and variables > Actions):
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
5. **Custom domain:** in the Pages project, Custom domains > add `kvgrainy.com` (and `www.kvgrainy.com`).
   The domain is registered at Namecheap, so either:
   - *Recommended:* add the domain to Cloudflare (Add a site) and switch the nameservers at Namecheap
     to the two Cloudflare gives you; Pages then creates the DNS records itself. Or
   - keep Namecheap DNS and add a `CNAME` for `www` to `kvgrainy.pages.dev`. The bare domain
     (`kvgrainy.com`) cannot be a CNAME at Namecheap, so redirect it to `www` there, or use the option above.
6. Run the workflow once from the Actions tab (*Web deploy > Run workflow*), or merge any web change.

## Launching to search engines

The site ships `noindex` and `robots.txt Disallow: /`. When you are ready (the About page names a real
person, so confirm that first), set the repository variable `WEB_LAUNCH` to `1` and re-run the workflow.
Ads stay off; turning them on is a separate step with its own checks (`npm run check-ads`).
