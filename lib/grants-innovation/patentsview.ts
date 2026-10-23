/**
 * PatentsView PatentSearch API — POST https://search.patentsview.org/api/v1/patent/
 * Header X-Api-Key (free key: https://patentsview-support.atlassian.net/servicedesk/customer/portals).
 * 45 req/min per key. Body: {q, f, s, o}. Built from the published docs
 * (https://search.patentsview.org/docs/); the sandbox could not reach the host
 * (proxy CONNECT 502) and has no PATENTSVIEW_API_KEY, so the query/field
 * contract is UNVERIFIED live — see README. Env: PATENTSVIEW_API_KEY.
 */
import { cached, clampInt, HOUR, postJson, requireKey, sumBy, trunc } from "./common";

const URL = "https://search.patentsview.org/api/v1/patent/";
const FIELDS = [
  "patent_id", "patent_title", "patent_date", "patent_type", "patent_num_times_cited_by_us_patents",
  "inventors.inventor_name_first", "inventors.inventor_name_last", "inventors.inventor_city", "inventors.inventor_state",
  "assignees.assignee_organization", "assignees.assignee_individual_name_first", "assignees.assignee_individual_name_last",
  "assignees.assignee_city", "assignees.assignee_state",
];

export async function patentsviewSearch(args: any) {
  const apiKey = requireKey("PATENTSVIEW_API_KEY", "request a free key at https://patentsview-support.atlassian.net/servicedesk/customer/portals and set PATENTSVIEW_API_KEY");
  const size = clampInt(args?.limit, 15, 1, 50);
  const and: any[] = [];
  if (args?.inventor_last_name) and.push({ "inventors.inventor_name_last": String(args.inventor_last_name) });
  if (args?.inventor_first_name) and.push({ "inventors.inventor_name_first": { _begins: String(args.inventor_first_name) } });
  if (args?.inventor_city) and.push({ "inventors.inventor_city": String(args.inventor_city) });
  if (args?.inventor_state) and.push({ "inventors.inventor_state": String(args.inventor_state).toUpperCase() });
  if (args?.assignee) and.push({ "assignees.assignee_organization": { _contains: String(args.assignee) } });
  if (args?.keyword) and.push({ _or: [{ patent_title: { _text_any: String(args.keyword) } }, { patent_abstract: { _text_any: String(args.keyword) } }] });
  if (args?.date_from) and.push({ patent_date: { _gte: String(args.date_from) } });
  if (args?.date_to) and.push({ patent_date: { _lte: String(args.date_to) } });
  if (!and.length) throw new Error("patentsview_search needs inventor_last_name, inventor_city+inventor_state, assignee or keyword");

  const body = { q: and.length === 1 ? and[0] : { _and: and }, f: FIELDS, s: [{ patent_date: "desc" }], o: { size } };
  const data = await cached(`pv:${JSON.stringify(body)}`, 24 * HOUR, () =>
    postJson<any>(URL, body, { headers: { "X-Api-Key": apiKey }, retries: 1 })
  );
  if (data?.error) throw new Error(`PatentsView: ${JSON.stringify(data.error).slice(0, 200)}`);
  const rows = (data?.patents ?? []).map((p: any) => ({
    patentNumber: p.patent_id,
    title: trunc(p.patent_title, 140),
    date: p.patent_date,
    type: p.patent_type ?? null,
    citedBy: p.patent_num_times_cited_by_us_patents ?? null,
    inventors: (p.inventors ?? []).map((i: any) => [`${i.inventor_name_first ?? ""} ${i.inventor_name_last ?? ""}`.trim(), [i.inventor_city, i.inventor_state].filter(Boolean).join(", ")].filter(Boolean).join(" — ")),
    assignees: (p.assignees ?? []).map((a: any) => a.assignee_organization || `${a.assignee_individual_name_first ?? ""} ${a.assignee_individual_name_last ?? ""}`.trim()).filter(Boolean),
    url: `https://patents.google.com/patent/US${p.patent_id}`,
  }));
  return {
    source: "PatentsView PatentSearch API (search.patentsview.org)",
    fetchedAt: new Date().toISOString(),
    query: body.q,
    total: data?.total_hits ?? rows.length,
    returned: rows.length,
    topAssignees: sumBy(rows.flatMap((r: any) => r.assignees.map((a: string) => ({ a }))), (r: any) => r.a, () => 1, 8).map((x) => ({ assignee: x.name, patents: x.count })),
    patents: rows,
    note: "Granted US patents (weekly refresh). Inventor city/state is the address on the patent at grant. Unassigned patents (no assignee) usually mean an individual inventor-owner.",
  };
}
