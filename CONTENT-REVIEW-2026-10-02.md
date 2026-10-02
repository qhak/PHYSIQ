# CutRank content revision — 2 October 2026

Committed and pushed as 4aeb4b6 on codex/migrate-cutrank-cloudflare, then deployed to Cloudflare on 2 October 2026. Production version: a1ad6347-940f-4acc-881a-1248b1cabd50. No Search Console indexing requests submitted for this release yet.

Production verification: all six revised guides return 200 and match the release, with self-referencing canonicals. Retired peptides URL variants return 410. The sitemap contains 28 URLs and excludes peptides. The live FFMI calculator returns 22.2 raw and 22.5 normalized for 175 cm, 80 kg and 15% body fat. Evidence: ../outputs/cutrank-release-verification-2026-10-02.json and ../outputs/cutrank-live-content-2026-10-02.png.

## Changes

- FFMI calculator: distinguishes fat-free mass from skeletal muscle, retains and labels the existing 6.1 normalization convention, links the original study (whose abstract reports 6.3), removes unsupported population/training grades and diet advice from results, and shows input sensitivity with a worked example. Positive height/weight validation added.
- Bulk/cut: replaces automatic body-fat cutoffs with a decision checklist, removes exact body-fat/AI accuracy claims, explains the free first-angle offer versus body-fat estimates in paid reports, and sources relevant health context.
- Body-fat-for-abs: replaces prescriptive percentage tables with an explanation of uncertainty and fair photo comparisons. Includes a scoped abdominal-exercise study reference and keeps links to distinct abs questions.
- S-tier, A-tier and tier overview: identify the rubric as CutRank's own; bands checked against app.js scoreToGrade and homepage. Remove unsupported population prevalence, training timelines and substance-use implications. Clarify hidden regions and the separate displayed 1–10 scale.
- Homepage: labels the rubric as CutRank's own visual convention.
- Peptides: local source archived outside the public build at ../outputs/cutrank-retired-content-2026-10-02/what-are-peptides.html. Public source removed; Worker responds 410 for .html, extensionless and trailing-slash variants. Sitemap/footer references removed and build excludes retired file even while Git deletion is unstaged.
- Metadata and FAQ structured data match revised content. Sitemap lastmod changed only for substantively revised pages.

Distinct abs/theory pages and the already improved muscle-loss page remain available. No blanket consolidation or homepage redirects.

## Local review

Run npm run dev to start the local Worker. The reviewed preview used port 8003; that session was stopped before the production build:

- http://127.0.0.1:8003/ffmi-calculator.html
- http://127.0.0.1:8003/should-i-bulk-or-cut.html
- http://127.0.0.1:8003/body-fat-percentage-for-abs.html
- http://127.0.0.1:8003/s-tier-physique.html
- http://127.0.0.1:8003/a-tier-physique.html
- http://127.0.0.1:8003/what-tier-is-my-physique.html

## Verification

- npm run build succeeds; git diff --check clean.
- ../outputs/check-cutrank-content.mjs verifies retired GET/HEAD variants, canonical redirect, six guides' canonicals/FAQ correspondence/local links, metric/imperial calculation, body-fat sensitivity examples, invalid inputs, and archive exclusion.
- Browser calculation: 175 cm, 80 kg, 15% => raw 22.2, normalized 22.5.
- Phone-width visual checks: bulk/cut and S-tier readable without horizontal overflow. Retained original page styling.
- Actual local Worker /what-are-peptides.html response checked as 410.

## Release and observation

Review the local pages, then commit/push/deploy as one batch when approved. After deployment, verify production HTTP responses, canonical URLs and sitemap. Request indexing once for materially revised priority pages if appropriate; avoid repeated requests.

8 October is an observation checkpoint, not a recovery deadline. Compare crawl dates against deployment, Google-selected canonical, index status and impressions. No ranking recovery or removal of a proven spam penalty is claimed. Neither successful live tests nor agreement between AI assistants establishes Google's internal reason for exclusion.
