
## Live release — 4 October 2026

- Rebuilt UI and USD pricing deployed to https://cutrank.app/.
- Site version: `96fbe950-a488-4e9c-82a2-8a7d9861db81`.
- The separate `calloutapp` API source is recorded in `worker/payments-api.mjs`; the site deploy command deploys `worker/site.js` only.
- New and legacy Stripe prices are recognized. The restricted Stripe API key and webhook signing secret are Cloudflare secrets, never source files.
- Run `node scripts/check-stripe-pricing.mjs` for isolated payment lifecycle tests. These use mock Stripe responses and do not charge anyone.
- Verified live asset contents, SEO pages/sitemap, retired page 410, signed no-op webhook acceptance, unsigned webhook rejection, and backend CORS.
- A real purchase-to-unlock test has not been performed for this release.
