# CutRank Cloudflare migration

The static site is deployed as a Cloudflare Worker with static assets at
`https://cutrank-site.callout-ai.workers.dev/`. This preview sends
`X-Robots-Tag: noindex, nofollow`; its HTML canonicals still point to
`https://cutrank.app/`.

## Current state (2026-09-29)

- The production site `cutrank.app` still uses Namecheap nameservers and points
  to Netlify. The preview is separate from production.
- All 29 sitemap URLs returned HTTP 200 on the preview. The existing `.html`
  paths are served directly. Extensionless versions redirect to `.html`.
- `/t1`–`/t15`, `/i1`–`/i15`, `/10`, and `/100` retain their existing redirects.
- `callout-ai.com` is still served by Netlify and redirects to `cutrank.app`.
  The Worker has equivalent old-domain routing for a later move.
- The existing AI/payment API stays on its separate Worker.

## Production switch

1. Add `cutrank.app` to the same Cloudflare account as `cutrank-site`.
   Review the imported DNS records before changing nameservers. The currently
   observed records include an apex A record (`75.2.60.5`), a `www` CNAME to
   `tiny-stroopwafel-7f56a2.netlify.app`, MX records for
   `mx1.improvmx.com` (priority 10) and `mx2.improvmx.com` (priority 20), and
   apex SPF TXT `v=spf1 include:spf.improvmx.com ~all`. Check the registrar and
   Cloudflare dashboards for any additional records, especially email records.
2. In Namecheap, replace the current registrar nameservers with the two nameservers
   assigned to **this exact Cloudflare zone**. Wait until the zone is Active.
   Keep the imported Netlify DNS records in place until the Worker custom domains
   are ready, so the site can continue to serve during the DNS change.
3. Add `cutrank.app` and `www.cutrank.app` as Custom Domains on `cutrank-site`.
   Cloudflare creates the Worker DNS records and certificates. Remove the old
   Netlify A/CNAME records for these hostnames when the dashboard asks or before
   attaching the matching hostname.
4. Check `/`, every sitemap URL, `/sitemap.xml`, `/robots.txt`, the shortlinks,
   `www` to apex redirect, and one normal AI flow on the production domain.
   Confirm production responses have **no** `X-Robots-Tag: noindex` header.
5. Leave `callout-ai.com` on Netlify until its own Cloudflare zone and verification
   exception are migrated. Its current redirects will continue pointing to the
   new `cutrank.app` host.

Build and deploy updates with `npm ci && npm run deploy`. The build copies only
tracked public file types to `dist/`; it does not upload `_redirects`, Git files,
or local-only development files. The Worker implements the required redirects.

This hosting change preserves the site and URL behavior; it does not by itself
resolve Google's “Crawled, currently not indexed” decisions.
