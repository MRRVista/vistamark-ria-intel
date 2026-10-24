# legal-pros family — builder spec (shared by all builders)

Repo: /home/claude/vistamark-ria-intel (branch `legal-pros`, main is v0.34.0). Family dir: `lib/legal-pros/`.
Catalog id: `legalpros`. Purpose: find Chicago-area attorneys by practice area (ERISA/employee benefits,
family/matrimonial, trusts & estates, other) for Vistamark's referral-partner network and prospecting
(see playbook §4.7). Attorneys are NOT in IDFPR (`idfpr_licensee_search`); they are licensed by the ARDC.

## Conventions (copy existing families — read `lib/web-intel/*.ts` and `lib/local-wealth/*.ts` first)
- `import type { ToolDef } from "../mcp/tools"; import type { CatalogDomain } from "../mcp/catalog";`
- HTTP via `fetchWithBackoff` / `textWithBackoff` / `jsonWithBackoff` from `../web-intel/common` (wraps
  `politeFetch` with Vistamark UA; `BROWSER_UA` is available for hosts that block non-browser UAs). Timeouts ≤ 25 s.
- Cache with `cached(key, ttlMs, fn)` from `../web-intel/common` (re-export of research/common). Directory pages
  change rarely: cache 6–24 h.
- Output must be COMPACT (Ask Randall caps each tool result at 6K chars): `limit` default 25, max 100;
  return `{ dataSource, asOf, returned, total?, rows: [...], note? }`. Each row ≤ ~12 short fields:
  name, firm, city, state, zip, practiceAreas[], phone?, email? (professional/firm only), website?, profileUrl, source, extras.
- Every tool takes a geography or name filter; refuse unbounded dumps with a clear error message.
- No new npm deps. Parse HTML with regex/`stripTags`/`decodeEntities` from common.ts (no cheerio).
- No `console.log` noise; throw `Error` with actionable text on upstream failure (status + hint).
- Do NOT edit anything outside `lib/legal-pros/`. Do NOT edit `index.ts` (integrator writes it). Do NOT commit.
- `npx tsc --noEmit` must stay clean for your files (run it; `node_modules` is installed).
- Each module exports:
    export const <MOD>_TOOLS: ToolDef[]
    export const <MOD>_CATALOG: CatalogDomain["tools"]   // {name, backing:"live-api"|"postgres", probe:"unprobed", note}
    export const <MOD>_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }>  // only keyless probes that run cold < 10 s; omit throttled hosts
- Write `lib/legal-pros/README-<mod>.md`: per tool — endpoint(s) used, auth, what was verified live from the
  sandbox (date 2026-10-24), quirks (UA, throttles, 403s), what could NOT be verified and what to check from Vercel.
- Verify live from the sandbox with a small `.mts` smoke script in /tmp/claude-0/-home-claude/3c573a14-33bc-5f23-ae4b-d8bfe97400bd/scratchpad/ (run with `npx tsx`), not committed.
  Sandbox network quirks: outbound goes through a proxy; some hosts 403 Akamai / throttle the shared IP (CourtListener 429s anonymous; set `COURTLISTENER_TOKEN` path but it is unset here). If a host is blocked, build from the page structure you can observe (view-source via curl with BROWSER_UA) and document "unverified".
- Guardrails to bake into descriptions: results are public directory/registry records, not consent to contact;
  professional/firm contact info only; cite dataset + as-of date; "serves alongside / listed in" language only.

## Modules & owners
- **directories-estate-family.ts** (builder A): `actec_fellow_search`, `aaml_il_fellow_search`, `collaborative_divorce_il_search`, plus (if public) `cepc_member_search` (Chicago Estate Planning Council) and `naela_il_search`.
  Leads: ACTEC WordPress REST `https://www.actec.org/wp-json/mg/v1/directory` and `/mg/v1/directory-facets` (discover params from facets; filter state=IL, city). AAML Illinois: https://aaml-illinois.org/find-a-lawyer/. Collaborative Divorce Illinois: https://collaborativedivorceillinois.org/find-a-professional/ (Gravity Forms site; look for a JSON/AJAX endpoint or parse the listing). CEPC https://www.cepcweb.org/ and NAELA — include only if a public listing exists; otherwise document as dropped.
- **directories-erisa-general.ts** (builder B): `acebc_fellow_search` (https://www.acebc.com/fellows — "Find a Fellow"), `leading_lawyers_search` (https://www.leadinglawyers.com/search/ — practice area × geography; Illinois-only, peer-recommended; find the search POST/GET and the result page structure; categories to map: Trust, Will & Estate Planning; Tax: Individual; Employee Benefits; Family; Adoption; Elder), `ardc_lawyer_lookup` (https://www.iardc.org/Lawyer/Search — verification lookup by last name (+first, city); return status, admission date, firm, city, discipline flag; it is a form POST — inspect the page for the request shape; expect possible blocking, document).
- **derived.ts** (builder C): `dol_sch_c_legal_counsel` (DB, `postgres` backing): rollup of Schedule C providers with service code 29 (Legal) — group by `provider_name_norm` (+ein), count plans, sum comp, sum plan assets, list top sponsors; filters state (default IL), city, filingYear, minPlans, name contains; reuse patterns from `lib/filings-people/schedule-c.ts` (`assetsJoin`, `roleCondition`, `normalizeProviderName`, `missingTable`, `emptyResponse` — import what is exported, copy small private helpers if needed). Returns empty-with-note when table missing/empty. `courtlistener_counsel` (live): RECAP docket search on CourtListener v4 for a practice area → court default `ilnd`; presets `erisa` (nature of suit 791 / q "ERISA"), `probate_trust`, `family` (federal is thin — note that state courts are not on CourtListener), free `q`; extract counsel/party names from `party`/`attorney` fields when present in the v4 `type=r` response (document actual field names; anonymous is throttled so document and use `COURTLISTENER_TOKEN` if set). `legal_pros_playbook` (no network): returns the routing doctrine for this family — which tool per practice area, the IDFPR-is-not-attorneys note, ARDC-as-verification, Sch C for ERISA, and the contact/compliance guardrails.

Integrator (not you) writes `index.ts` (LEGALPROS_TOOLS / LEGALPROS_DOMAIN / LEGALPROS_CHECKS) and README.md, wires lib/mcp/tools.ts, catalog.ts, api/selftest.ts, bumps version.
