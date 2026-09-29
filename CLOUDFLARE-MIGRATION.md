# CutRank Cloudflare migration

The static site is deployed as a Cloudflare Worker with static assets at
`https://cutrank-site.callout-ai.workers.dev/`. This preview sends
`X-Robots-Tag: noindex, nofollow`; its HTML canonicals still point to
`https://cutrank.app/`.

## Current state (2026-09-29, 21:45 BST)

- The Cloudflare zone is Active. Namecheap uses
  `hunts.ns.cloudflare.com` and `liberty.ns.cloudflare.com`.
- `cutrank.app` and `www.cutrank.app` are Worker custom domains. The old Netlify
  A/CNAME records were replaced. The preview remains separate.
- All 29 sitemap URLs returned HTTP 200 on the preview. The existing `.html`
  paths are served directly. Extensionless versions redirect to `.html`.
- All 29 sitemap URLs also returned HTTP 200 on the production Worker when
  pinned to a Cloudflare edge IP. No production response had a noindex header.
  Extensionless pages, campaign shortlinks, `www` to apex, and 404s passed.
- Cloudflare authoritative DNS retained the two Improvmx MX records with
  priorities 10/20 and the SPF TXT record. The existing AI API's CORS preflight
  still allows `https://cutrank.app`.
- Public DNS caches may temporarily disagree during nameserver propagation.
  At this check, 1.1.1.1 returned Cloudflare nameservers while 8.8.8.8 and the
  local resolver still cached the old Netlify path.
- `/t1`–`/t15`, `/i1`–`/i15`, `/10`, and `/100` retain their existing redirects.
- `callout-ai.com` is still served by Netlify and redirects to `cutrank.app`.
  The Worker has equivalent old-domain routing for a later move.
- The existing AI/payment API stays on its separate Worker.

## Changes made

1. Added `cutrank.app` to the Cloudflare account on the Free plan; reviewed
   its imported DNS records and MX priorities.
2. Updated the domain's nameservers at Namecheap and activated the zone.
3. Attached both production hostnames to the Worker through Wrangler custom
   domain routes, replacing the old Netlify web DNS records.
4. Checked the 29 SEO pages, redirects, sitemap, email DNS, and API CORS.

A complete paid scan or checkout flow was not exercised during the migration.
Those still call the existing backend and Stripe endpoints without code changes.
The old `callout-ai.com` domain remains on Netlify so its redirect and Search
Console verification exception continue working.

Build and deploy updates with `npm ci && npm run deploy`. The build copies only
tracked public file types to `dist/`; it does not upload `_redirects`, Git files,
or local-only development files. The Worker implements the required redirects.

This hosting change preserves the site and URL behavior; it does not by itself
resolve Google's “Crawled, currently not indexed” decisions.
