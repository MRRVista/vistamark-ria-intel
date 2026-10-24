# legal-pros / derived.ts

Three tools: a Postgres rollup of Schedule C legal providers, a CourtListener RECAP
counsel search, and the family's static routing doctrine. Exports
`DERIVED_TOOLS`, `DERIVED_CATALOG`, `DERIVED_CHECKS`; handlers `dolSchCLegalCounsel`,
`courtlistenerCounsel`, `legalProsPlaybook` are also exported for direct use.

Verified from the sandbox on 2026-10-24 (see per-tool notes; `npx tsc --noEmit` clean).

---

## dol_sch_c_legal_counsel  (backing: postgres)

**What it is.** Firms coded **29 = Legal** on Form 5500 Schedule C Part I Item 2
(providers paid $5,000+ by a plan), grouped by `provider_name_norm` + `provider_ein`,
with distinct-plan count, distinct-sponsor count, total comp, total plan assets, filing
year span and the top 3 sponsors (by plan assets) per firm.

**Tables / joins.** `dol_sch_c_providers p` (migration 0009) `LEFT JOIN plans pl`
(0002; `JOIN` when `sponsorState` is given) `LEFT JOIN dol_sch_h_i shi` (0010, only
when `schHTableExists()`), i.e. the same `assetsJoin` shape as
`lib/filings-people/schedule-c.ts`. Assets = `COALESCE(pl.tot_assets_eoy_amt,
shi.tot_assets_eoy_amt)` because DOL dropped the F_5500 total in the 2024 files.
`normalizeProviderName` and `SCH_C_ROLE_CODES.legal` are imported from
`schedule-c-parse.ts`; `assetsJoin` / `missingTable` / `emptyResponse` are private in
schedule-c.ts so small copies live in derived.ts.

**SQL shape.** A `per_plan` CTE collapses to one row per (norm, ein, ack_id) first (a
firm listed twice on one Schedule C — direct + indirect lines — would otherwise
double-count plan assets), then the outer query aggregates per firm with
`mode() WITHIN GROUP` for the display name/city/state, `COUNT(*) OVER ()` for `total`,
`HAVING COUNT(*) >= minPlans`, `LIMIT/OFFSET`. A second query ranks sponsors with
`ROW_NUMBER() OVER (PARTITION BY norm, ein ORDER BY assets DESC NULLS LAST ...)` and
keeps `rn <= 3`. Code match is the same whole-token regex as `roleCondition`:
`p.service_codes ~ '(^|,)(29)(,|$)'`.

**Args.** `state` (firm's state as filed; default `IL`; `ANY`/`ALL` to drop), `city`
(ILIKE exact), `sponsorState` (plan sponsor mail state; forces inner join to plans),
`filingYear`, `minPlans` (default 1), `nameContains` (normalized LIKE on
`provider_name_norm`), `providerEin`, `sortBy` plans|comp|assets, `limit` ≤100
(default 25), `offset`. An unbounded call (`state:'ANY'` with no other filter) returns
`{error}`.

**Empty / missing handling.** `DATABASE_URL` unset → `{empty:true, note}` with the
ingest hint. Relation missing (42P01) → same shape. Table present but no rows → same
shape ("ingest has not run"). Rows present but no match → `returned:0, total:0, note`.

**Verified 2026-10-24.** `DATABASE_URL` is NOT set in the sandbox, so the SQL was run
against a throwaway local **Postgres 16** (`/usr/lib/postgresql/16/bin`, port 54329)
with `pg_trgm`, migrations 0002 + 0009 + 0010 applied verbatim, and 8 synthetic
Schedule C rows across 4 plans (`DATABASE_DRIVER=pg`). Confirmed: grouping merges
"Seyfarth Shaw LLP" / "SEYFARTH SHAW, LLP" under one (norm, ein) while the EIN-less
"Seyfarth Shaw" stays a separate row (by design — EIN is part of the key); the two
Seyfarth lines on plan A1 count as 1 plan with comp summed (45,000) and assets counted
once; non-legal providers (Fidelity, codes 15,64) are excluded; a provider coded `29,16`
matches; `sponsorState:'WI'` returns only the WI-sponsored plan; `nameContains` with
suffixes ("Seyfarth Shaw LLP") normalizes to `SEYFARTH SHAW`; a plan with no Schedule H
row yields `totalPlanAssetsUsd:null, plansWithAssets:0`; the `plans.spons_dfe_name IS
NULL` fallback to `plan_name` works; no-match returns `returned:0`; `DATABASE_URL`
unset returns `empty:true`.

**Not verified.** Neon HTTP driver behaviour for the CTE + `mode()` + window query
(drizzle `sql` raw, single statement, no transaction — same pattern as schedule-c.ts, so
expected fine). Real-data performance: the per_plan CTE scans all code-29 rows for the
state; `dol_sch_c_name_norm_idx` / `dol_sch_c_year_idx` help, `service_codes ~` does not
use an index. ~265k Schedule C rows/year of which Legal is a small slice, so should be
sub-second; check from Vercel once refresh-dol-sch-c has run (`/api/selftest` check
"legalpros: Sch C legal counsel IL"). Note `plans.spons_dfe_name` is null in current
ingests (DOL renamed the column) — the tool falls back to `plan_name`, which usually
embeds the sponsor.

---

## courtlistener_counsel  (backing: live-api)

**Endpoint.** `GET https://www.courtlistener.com/api/rest/v4/search/` with
`type=r` (RECAP federal dockets), `order_by=dateFiled desc`, `court` (default `ilnd`),
`q`, optional `filed_after` / `filed_before`, and the front-end sidebar filters
`atty_name` / `party_name` (the operators page says `party:` / `attorney:` inside `q`
must not be mixed with document fields, and that the sidebar filters are the supported
route; the API "uses the same GET parameters as the front end"). Auth: anonymous or
`Authorization: Token $COURTLISTENER_TOKEN`. Cached 1 h (`cached()`), one paced 429
retry via `jsonWithBackoff`.

**Presets.** `erisa` → `q=(suitNature:791 OR "ERISA")` (PACER nature-of-suit 791 =
Labor: E.R.I.S.A.); `probate_trust` → trustee / breach of trust / probate AND estate|trust;
`family` → divorce / dissolution / custody / marital settlement / domestic relations;
`custom` → `q` only. A free `q` is ANDed with the preset. At least one of preset / q /
attorney / party is required.

**Response mapping (field names as documented on
courtlistener.com/help/api/rest/search and help/search-operators).** Per result:
`caseName`, `court_id` (fallback `court`), `dateFiled`, `dateTerminated`,
`docketNumber`, `suitNature`, `cause`, `assignedTo`, `party[]`, `attorney[]`, `firm[]`,
`docket_absolute_url` (fallback `absolute_url`), `recap_documents[0].description|snippet`.
`party`/`attorney`/`firm` are docket-level multi-value fields; the handler accepts either
arrays or `;`-joined strings and tallies them into `topAttorneys` / `topFirms` across the
returned dockets. `count` → `totalMatches` (±6 % above 2,000 per docs).

**Verified 2026-10-24.** Two anonymous calls succeeded between throttle windows
(`preset:'erisa', court:'ilnd'`): HTTP 200, `count` 32,132, 20 results/page, newest
dockets 2026-10-20 / 2026-10-19 (Fox Valley Laborers H&W Fund v. Seyller's; Chicago &
Vicinity Laborers' Pension Fund v. Paving Zone). Actual `type=r` result keys observed:
`assignedTo, assigned_to_id, attorney, attorney_id, caseName, case_name_full, cause,
chapter, court, court_citation_string, court_id, dateArgued, dateFiled, dateTerminated,
docketNumber, docket_absolute_url, docket_id, firm, firm_id, jurisdictionType,
juryDemand, meta, pacer_case_id, party, party_id, recap_documents, referredTo,
referred_to_id, suitNature, trustee_str`; `recap_documents[]` carries `description,
short_description, snippet, entry_date_filed, document_number, absolute_url, ...`.
`party`, `attorney`, `firm` are **arrays of plain strings** (e.g. Rusbuldt v. Mondelez
Global LLC → `attorney: ["Mason A Barney"]`, `firm: ["Siri & Glimstad LLP"]`), with
parallel `*_id` arrays. On a fresh 20-docket page only 1 docket had attorney/firm and 3
had `suitNature` (RECAP often has only the case header for new filings), so
`topAttorneys` / `topFirms` are sparse unless `filedBefore` pushes to older dockets.
Most other attempts in the session answered **HTTP 429 "Request was throttled. Rate
limit exceeded: 125/day. Expected available in N seconds"** — the sandbox shares an IP.
The error surfaces as `CourtListener rate-limited (HTTP 429) after retry — anonymous
access is throttled per IP ...; set COURTLISTENER_TOKEN`.

**Not verified.** (1) That `atty_name` / `party_name` are honoured by the API endpoint
(they are the front-end form names; the search-API doc says to copy front-end GET
params; the operators page says sidebar filters, not `attorney:` in `q`, are the
supported route). From Vercel: set `COURTLISTENER_TOKEN`, call `{attorney:'Seyfarth'}`
and confirm results narrow. (2) `probate_trust` / `family` presets were not exercised
live (quota) — same endpoint, only `q` differs. (3) The wiki page https://wiki.free.law/c/courtlistener/help/api/rest/v4/search
could not be fetched from the sandbox (fetch permission not granted); the equivalent
pages on courtlistener.com/help/ were used instead.

**Coverage caveat baked into descriptions/notes.** Illinois circuit courts (Cook County
Probate, Domestic Relations, Chancery) are not on CourtListener, so `probate_trust` and
`family` return federal spill-over only; the directory tools are the discovery path for
those practice areas.

---

## legal_pros_playbook  (no network)

Static object: purpose, licensing note (attorneys are not in IDFPR; ARDC licenses them;
`ardc_lawyer_lookup` is verification, run last), routing per practice area (ERISA →
`dol_sch_c_legal_counsel` + `acebc_fellow_search` + `leading_lawyers_search` +
`courtlistener_counsel erisa`; T&E → `actec_fellow_search` + Leading Lawyers + CEPC/NAELA
if present; family → `aaml_il_fellow_search` + `collaborative_divorce_il_search`; other →
`courtlistener_counsel` custom), data notes (Schedule C $5k threshold and free-text names,
CourtListener state-court gap, anonymous throttle), six guardrails (public records ≠
consent; professional contact only; cite dataset + as-of; ARDC before outreach; referral
marketing not advice, routed through outreach guardrails; respect directory terms / no bulk
dumps), and a 5-step workflow. Optional `practiceArea` narrows `routing` by keyword
(erisa|benefit|401|pension → ERISA; estate|trust|probate|elder → T&E; family|divorce|
matrimon|custod → family; else other). Verified: `{practiceArea:'divorce'}` returns the
single family route and 6 guardrails.

---

## Checks (`DERIVED_CHECKS`)

- `legalpros: playbook (static)` — no network.
- `legalpros: Sch C legal counsel IL (tolerates empty/missing table)` — `{state:'IL',
  limit:3}`; `empty:true` until the ingest runs.

`courtlistener_counsel` is deliberately **not** in the checks: the host throttles the
shared IP and the check would burn the 125/day anonymous budget.

## Catalog notes

`DERIVED_CATALOG` marks `dol_sch_c_legal_counsel` as `postgres`, the other two as
`live-api` (the playbook has no backing; `live-api` is the closest allowed `ToolBacking`
and the note says "static doctrine, no network").
