
## Live release — 4 October 2026

- Rebuilt UI and USD pricing deployed to https://cutrank.app/.
- Site version: `96fbe950-a488-4e9c-82a2-8a7d9861db81`.
- The separate `calloutapp` API source is maintained in the private `qhak/callout-worker` repository; the site deploy command deploys `worker/site.js` only.
- New and legacy Stripe prices are recognized. The restricted Stripe API key and webhook signing secret are Cloudflare secrets, never source files.
- Set `CUTRANK_API_SOURCE` to that private checkout's `worker.js`, then run `node scripts/check-stripe-pricing.mjs` for isolated payment lifecycle tests. These use mock Stripe responses and do not charge anyone.
- Verified live asset contents, SEO pages/sitemap, retired page 410, signed no-op webhook acceptance, unsigned webhook rejection, and backend CORS.
- A real purchase-to-unlock test has not been performed for this release.

## Affiliate workspace — 18 October 2026

Manually approved emails receive Pro, private studio access, and a dashboard of
referred sales, renewals and estimated USD commission. The private API repository
contains the approval command and `AFFILIATES.md` operator guide. Codes give 20%
off; commission is 35% of the listed price before discounts, adjusted for refunds.
New affiliate accounts are activated only through that private command/config.
