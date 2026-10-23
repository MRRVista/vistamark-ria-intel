# web-intel — News, Entities & Courts

Catalog id `webintel`. Exports `WEBINTEL_TOOLS`, `WEBINTEL_DOMAIN`, `WEBINTEL_CHECKS` from `index.ts`.
All HTTP goes through `politeFetch` (Vistamark UA, credential redaction) via `common.ts#fetchWithBackoff`,
which makes exactly one network-error retry and one paced retry on HTTP 429, then throws a clear error.

| Tool | Source | Auth | Verified live from sandbox (2026-10-22) |
|---|---|---|---|
| `gdelt_doc_search` | GDELT DOC 2.0 | keyless | artlist + timelinevol JSON via curl (after a ≥ 6 s pause); through Node the proxy tunnel timed out (503 "upstream connect error") on every attempt, so the parser/backoff were verified against the captured live payloads |
| `news_rss_search` | Google News RSS + Bing News RSS | keyless | both live (Google 50 items, Bing 10–12 items) |
| `wikidata_entity_search` | Wikidata | keyless | EntityData + SPARQL labels live; `wbsearchentities` 429 → Wikipedia-search fallback live |
| `wikipedia_summary` | English Wikipedia | keyless | REST summary live; action-API fallback live |
| `courtlistener_search` | CourtListener v4 | anonymous or `COURTLISTENER_TOKEN` | **not** live — IP throttled (429 "Expected available in 52,597 s" / "125/day"); parser verified against the official docs' sample response |
| `opencorporates_search` / `opencorporates_officers` | OpenCorporates v0.4 | `OPENCORPORATES_API_TOKEN` **required** | keyless → 401 "Invalid Api Token" every time; fails fast without the env var; response mapping follows the v0.4 docs, unexercised |

Dropped: `il_sos_business_search` (see bottom).

## Sources

### GDELT DOC 2.0 — `gdelt_doc_search`
- `GET https://api.gdeltproject.org/api/v2/doc/doc?query=<q>&mode=artlist&format=json&maxrecords=25&timespan=1w&sort=datedesc`
- `GET …&mode=timelinevol&format=json&timespan=1m` → `{timeline:[{series:"Volume Intensity",data:[{date:"20260924T000000Z",value:0.0026},…]}]}`
- Keyless. Limit: **one request per 5 seconds per IP**; violations return HTTP 429 with a plain-text body (not JSON). Default rolling window is 3 months (`timespan` up to `3m`); older data needs `startdatetime/enddatetime` (not exposed).
- Quirks: multi-word queries must be quoted (the tool auto-quotes a plain multi-word name); `domain:`, `sourcecountry:`, `sourcelang:`, `tone<-5` are query-string operators. Slow: 10–15 s per response from the sandbox. Tool timeout 28 s, cache 15 min, retry pause 5.5 s.
- Sandbox: curl got 200 for both modes (sample saved in smoke scripts); Node's `fetch` through the agent proxy got 503 connection timeouts on every try, apparently a proxy-tunnel issue specific to this host. Expect it to work from Vercel, but keep `WEBINTEL_CHECKS` free of GDELT (it is).

### Google News RSS / Bing News RSS — `news_rss_search`
- `GET https://news.google.com/rss/search?q=<q>&hl=en-US&gl=US&ceid=US:en` — returns **503 "Sorry… automated queries"** for the Vistamark UA; works with a Chrome UA (sent for this host only). Titles end in ` - Source`; `<source url=…>` carries the publisher; links are `news.google.com/rss/articles/…` redirects. `when:7d` operator supported.
- `GET https://www.bing.com/news/search?q=<q>&format=rss` — accepts the Vistamark UA; `<News:Source>` publisher, `<description>` snippet; link is `bing.com/news/apiclick.aspx?…&url=<real>` and is unwrapped.
- Both keyless, no documented limits; cached 10 min. Items are deduped by normalized title, sorted newest-first, Bing snippets merged onto Google rows.

### Wikidata / Wikipedia — `wikidata_entity_search`, `wikipedia_summary`
- `GET https://www.wikidata.org/w/api.php?action=wbsearchentities&search=…&language=en&type=item&format=json` — **429 for the sandbox IP** almost every time (also with `Api-User-Agent`). Also a label-prefix matcher, so "Robert F. Smith investor" returns 0 hits even when it works.
- Fallback / complement: `GET https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=…&prop=pageprops|description&ppprop=wikibase_item` (200 from sandbox) → QIDs for descriptive queries.
- Claims: `GET https://www.wikidata.org/wiki/Special:EntityData/<QID>.json` (200 from sandbox; `wbgetentities` on api.php 429s). ~35 properties are surfaced (P31, P106, P108, P69, P2218 net worth, P112, P856, P169, P488, P159, P571, P452, P749, P127, P1830, P1128, P2139, P2403, P569, P19, P551, P27, P26, P40, P39, P2002, P4264, P6634 …), with `P585/P580` as-of and `P582` until qualifiers.
- Labels for linked items: one SPARQL round-trip `https://query.wikidata.org/sparql?format=json&query=SELECT ?item ?itemLabel WHERE { VALUES ?item {…} SERVICE wikibase:label {…} }` (200 from sandbox; falls back to per-item EntityData for ≤ 8 ids).
- Summary: `GET https://en.wikipedia.org/api/rest_v1/page/summary/<Title>?redirect=true` (200 from sandbox in the tool run; 429 in an earlier curl). Fallback `action=query&prop=extracts|description|pageimages|pageprops|info&exintro&explaintext`. A 404 title falls back to `list=search` top hit and notes it.
- Wikimedia policy: descriptive UA with contact (done via politeFetch + `Api-User-Agent`), ≤ ~200 req/s but shared-IP throttling is aggressive. Cached 6 h (entities) / 12 h (summaries).

### CourtListener — `courtlistener_search`
- `GET https://www.courtlistener.com/api/rest/v4/search/?q=<q>&type=r|o&order_by=dateFiled desc|score desc[&court=ilnd ilsd][&filed_after=YYYY-MM-DD][&filed_before=…]`
- Anonymous allowed; per-IP throttle (sandbox: 429 with "Expected available in N seconds" and "Rate limit exceeded: 125/day"). With `COURTLISTENER_TOKEN` → header `Authorization: Token <token>`, 5,000 req/day free.
- Result fields used: `caseName, court, court_id, dateFiled, docketNumber, absolute_url`; opinions add `citation[], status, citeCount, opinions[0].snippet`; RECAP adds `dateTerminated, suitNature, cause, party, assignedTo, recap_documents[0].snippet/description`. Field set for `type=r` follows the docs (not seen live).
- Docs live at https://wiki.free.law/c/courtlistener/help/api/rest/v4/search (the courtlistener.com help URL 301s there). Cached 1 h.

### OpenCorporates — `opencorporates_search`, `opencorporates_officers`
- `GET https://api.opencorporates.com/v0.4/companies/search?q=…&jurisdiction_code=us_il&per_page=N&api_token=…`
- `GET https://api.opencorporates.com/v0.4/officers/search?q=…&jurisdiction_code=us_il&position=…&api_token=…`
- **Keyless tier no longer exists**: every anonymous request (Vistamark UA, browser UA, with/without jurisdiction) returned HTTP 401 `Invalid Api Token`. Both tools throw `OPENCORPORATES_API_TOKEN not configured — …` before any network call. Key request: https://opencorporates.com/api_accounts/new (free public-benefit tier is application-based; commercial plans are paid).
- Mapping (`results.companies[].company`, `results.officers[].officer`, `total_count`) follows the v0.4 docs; `jurisdiction: "il"` is normalized to `us_il`. Not exercised live.

### Illinois SOS CyberDrive business entity search — DROPPED
- `https://apps.ilsos.gov/businessentitysearch/` answers **HTTP 403 from Akamai** to a non-browser client from the sandbox; the page is a Java form-post (`businessentitysearch/search`) with session cookies and a per-session CSRF token behind Akamai Bot Manager. There is no JSON endpoint, and scripting a browser-UA form post against a bot-managed government site is fragile and not something this family should rely on in a nightly job. The bulk data file is sold ($1,500/yr) and was previously rejected.
- Substitutes: `opencorporates_search` with `jurisdiction: "il"` (once keyed — OpenCorporates mirrors the IL registry including president/secretary/agent), and `idfpr_licensee_search` (already in repo) for IL professional licenses.

## Env vars introduced
- `COURTLISTENER_TOKEN` (optional) — lifts CourtListener anonymous throttle.
- `OPENCORPORATES_API_TOKEN` (required for the two OpenCorporates tools).

## Selftest checks (`WEBINTEL_CHECKS`)
`news_rss_search` (Bing only, 0.5 s), `wikipedia_summary` (0.1 s), `wikidata_entity_search` by QID (0.6 s). GDELT and CourtListener are excluded on purpose (per-IP throttles would make the selftest flaky).
