# PHYSIQ history integration — 25 October 2026

Prepared in an isolated worktree from main 58b29ab. Original commits and author metadata are unchanged; every branch head below is an ancestor through regular merge commits. This integration is a source/history reconciliation, not a deployment.

## Source choices

- Preserve the 18 October live-synced affiliate release production UI, animation, referral attribution, pricing ($7.99 audit, $16.99 monthly, $66.99 yearly) and private API boundary. Its corrected SEO pages retain the factual changes from the separate corrections branch, with later branding. The earlier UI and October 4 release remain in ancestry, rather than reverting the live-synced result.
- Retain the older SEO product explainer and supporting visual assets. Remove its retired favicon reference and replace stale GBP/lifetime offers with current USD audit/monthly/yearly plans. Add the explainer to the sitemap and tools hub; preserve the qualified llms summary.
- Keep the complete training/onboarding mockup under prototypes/training. The public build explicitly excludes prototypes; no mock coach, local example history or nutrition demo is promoted into production.
- Retain current Cloudflare cutrank-site worker, production domain routes, asset binding, canonical redirects, 410 retired guide handling and preview noindex. The early bot's callout/root-directory configuration would expose the wrong artifact and is superseded. Retain its local-secret ignore rules.
- Keep the Netlify Pretty URLs setting as a compatibility configuration; Cloudflare remains the documented host.
- Keep payment implementation private: worker/payments-api.mjs is absent in the final tree, as in the affiliate release. Tests consume the sibling private integration worker without copying its source.

## Validation

- npm run build: 62 tracked public assets built.
- node --test scripts/site-affiliate.test.cjs scripts/history-integration.test.cjs: six tests pass. Covers campaign/referral links, resolver failure, preview noindex, canonical redirects, guide retirement, prototype/private-source build exclusion, pricing consistency and local asset references.
- CUTRANK_API_SOURCE pointed at the isolated callout-worker integration; node scripts/check-stripe-pricing.mjs passed mock checkout/renewal, subscription lifecycle, pinned API retrieval, refund and unsigned-webhook cases. No payments or API calls were made by these tests.
- JavaScript syntax checks and git diff --check pass.
- No tracked GitHub workflows. GitHub API reported no workflows, hooks or deployments on 25 October. External hosting Git integrations cannot be proved absent by those results. No deployment command was run; a default-branch merge can still trigger hosting integration outside this repository.
- Not a browser visual acceptance or a real purchase-to-unlock test. Existing source branch release evidence is historical, not a new production verification.

## Preserved heads

| Branch | Original head | Ancestor |
| --- | --- | --- |
| `cloudflare/workers-autoconfig` | `71818b6dc173837a818e627b39edcb91b1791062` | yes |
| `codex/affiliate-dashboard-release` | `b0676d3c8659daf0c2ef5ac259c47ab17059dea7` | yes |
| `codex/fix-netlify-pretty-urls` | `a261bbfa5a7805760faf859bd0813097c10cca41` | yes |
| `codex/latest-ui-release-2026-10-04` | `d89f7fb4514a79629f749004082d2fd5ad993191` | yes |
| `codex/migrate-cutrank-cloudflare` | `cf134a8195371b9909f4318025b19f2f0f0f44f5` | yes |
| `codex/seo-content-corrections-20261005` | `deb291cf7d2355490dff1910054d5807102a08ee` | yes |
| `codex/seo-three-pages-20260924` | `fd079b1d58e2b2c631b61787da327e4b1a0074b5` | yes |
| `codex/training-mockup` | `6b9cc9829de50236094023d0d075d4ead982519f` | yes |
| `codex/ui-refresh-faceiq-inspired` | `aab311d342333856fe094acbddb731f3c7667eea` | yes |
