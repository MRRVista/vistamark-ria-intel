/**
 * CourtListener (Free Law Project) REST v4 search.
 *   https://www.courtlistener.com/api/rest/v4/search/?q=...&type=o|r&order_by=dateFiled%20desc
 *   type=o  case-law opinions (clusters; fields caseName, court, dateFiled, docketNumber,
 *           citation[], status, opinions[].snippet, absolute_url)
 *   type=r  RECAP/PACER federal dockets (caseName, court, dateFiled, docketNumber,
 *           party, attorney, suitNature, cause, recap_documents[].snippet)
 *   Optional filters: court (slug list, e.g. "ilnd ilsd ill"), filed_after/filed_before (YYYY-MM-DD).
 * Auth: anonymous allowed but throttled per IP (the sandbox's shared IP answered
 * 429 "Request was throttled. Expected available in N seconds" / "Rate limit
 * exceeded: 125/day" on 2026-10-22, so the live response shape above comes from
 * the official docs, not a sandbox call). With COURTLISTENER_TOKEN
 * ("Authorization: Token ...") the limit is 5,000/day. Cached 1 h.
 */
import { cached, clampInt, HOUR, jsonWithBackoff, stripTags, trim } from "./common";

const BASE = "https://www.courtlistener.com/api/rest/v4/search/";

export async function courtlistenerSearch(args: any) {
  const q = String(args?.query ?? "").trim();
  if (!q) throw new Error("courtlistener_search: `query` is required (party/firm name; quote exact phrases, e.g. \"Vista Equity Partners\")");
  const type = args?.type === "o" || args?.type === "opinions" ? "o" : "r";
  const limit = clampInt(args?.limit, 10, 1, 20);
  const order = args?.sort === "relevance" ? "score desc" : "dateFiled desc";
  const params = new URLSearchParams({ q, type, order_by: order });
  if (args?.court) params.set("court", String(args.court).trim());
  if (args?.filedAfter) params.set("filed_after", String(args.filedAfter));
  if (args?.filedBefore) params.set("filed_before", String(args.filedBefore));
  const url = `${BASE}?${params.toString()}`;

  const token = process.env.COURTLISTENER_TOKEN?.trim();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = `Token ${token}`;

  const data = await cached(`cl:${token ? "k" : "a"}:${url}`, HOUR, () =>
    jsonWithBackoff<any>(url, {
      source: "CourtListener",
      headers,
      retryAfterMs: 2500,
      hint429: token ? "daily quota exhausted for this token" : "anonymous access is throttled per IP; set COURTLISTENER_TOKEN (free account at courtlistener.com/sign-in) for 5,000 req/day",
    })
  );

  const results = (Array.isArray(data?.results) ? data.results : []).slice(0, limit).map((r: any) => {
    const base = {
      caseName: trim(r.caseName, 160),
      court: r.court ?? null,
      courtId: r.court_id ?? null,
      dateFiled: r.dateFiled ?? null,
      docketNumber: r.docketNumber ?? null,
      url: r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : null,
    };
    if (type === "o") {
      return {
        ...base,
        citation: Array.isArray(r.citation) ? r.citation.slice(0, 3) : undefined,
        status: r.status ?? null,
        citeCount: r.citeCount ?? null,
        snippet: trim(stripTags(r.opinions?.[0]?.snippet ?? ""), 240),
      };
    }
    return {
      ...base,
      dateTerminated: r.dateTerminated ?? null,
      suitNature: trim(r.suitNature, 80),
      cause: trim(r.cause, 100),
      party: Array.isArray(r.party) ? r.party.slice(0, 6).map((p: any) => trim(p, 80)) : trim(r.party, 200),
      assignedTo: trim(r.assignedTo, 60),
      snippet: trim(stripTags(r.recap_documents?.[0]?.snippet ?? r.recap_documents?.[0]?.description ?? ""), 240),
    };
  });

  return {
    source: `CourtListener REST v4 search (${type === "o" ? "case-law opinions" : "RECAP federal dockets"})`,
    fetchedAt: new Date().toISOString(),
    authenticated: Boolean(token),
    query: q,
    totalMatches: data?.count ?? null,
    returned: results.length,
    results,
  };
}
