/**
 * Grants.gov Search2 — POST https://api.grants.gov/v1/api/search2 (keyless,
 * verified live). Body: {keyword, oppStatuses:"forecasted|posted", agencies:"NEH|IMLS",
 * rows, startRecordNum, sortBy:"openDate|desc", fundingCategories, eligibilities}.
 * Detail: POST /v1/api/fetchOpportunity {opportunityId} → synopsis with award
 * ceiling/floor, estimated funding, number of awards, close date, eligibility.
 */
import { cached, clampInt, HOUR, iso, postJson, toNum, trunc } from "./common";

const BASE = "https://api.grants.gov/v1/api";

export async function grantsGovSearch(args: any) {
  const oppId = args?.opportunity_id != null ? String(args.opportunity_id).trim() : "";
  if (oppId) return fetchOpportunity(oppId);

  const rows = clampInt(args?.limit, 15, 1, 25);
  const body: Record<string, unknown> = {
    keyword: String(args?.keyword ?? "").trim(),
    oppStatuses: String(args?.statuses ?? "forecasted|posted"),
    rows,
    startRecordNum: clampInt(args?.offset, 0, 0, 10000),
    sortBy: String(args?.sort ?? "openDate|desc"),
  };
  if (args?.agencies) body.agencies = String(args.agencies).replace(/,/g, "|");
  if (args?.funding_categories) body.fundingCategories = String(args.funding_categories).replace(/,/g, "|");
  if (args?.eligibilities) body.eligibilities = String(args.eligibilities).replace(/,/g, "|");
  if (args?.cfda) body.cfda = String(args.cfda);
  if (!body.keyword && !body.agencies && !body.fundingCategories && !body.cfda) {
    throw new Error("grants_gov_search needs keyword, agencies, funding_categories, cfda or opportunity_id");
  }
  const data = await cached(`gg:${JSON.stringify(body)}`, 6 * HOUR, () => postJson<any>(`${BASE}/search2`, body));
  if (data?.errorcode) throw new Error(`Grants.gov: ${data.msg ?? "error " + data.errorcode}`);
  const d = data?.data ?? {};
  const hits = (d.oppHits ?? []).map((h: any) => ({
    opportunityId: h.id,
    number: h.number,
    title: trunc(h.title, 140),
    agency: h.agency,
    agencyCode: h.agencyCode,
    status: h.oppStatus,
    openDate: iso(h.openDate),
    closeDate: iso(h.closeDate),
    cfda: h.cfdaList ?? [],
    url: `https://www.grants.gov/search-results-detail/${h.id}`,
  }));
  return {
    source: "Grants.gov Search2 API (api.grants.gov)",
    fetchedAt: new Date().toISOString(),
    query: body,
    total: d.hitCount ?? hits.length,
    returned: hits.length,
    statusCounts: (d.oppStatusOptions ?? []).map((o: any) => ({ status: o.value, count: o.count })),
    topAgencies: (d.agencies ?? []).slice(0, 10).map((a: any) => ({ code: a.value, agency: a.label, count: a.count })),
    fundingCategories: (d.fundingCategories ?? []).slice(0, 10).map((a: any) => ({ code: a.value, label: a.label, count: a.count })),
    opportunities: hits,
    note: "Pass opportunity_id for award ceiling/floor, estimated funding, number of awards and eligibility. Agency codes in topAgencies are valid `agencies` filters.",
  };
}

async function fetchOpportunity(oppId: string) {
  const data = await cached(`ggopp:${oppId}`, 6 * HOUR, () => postJson<any>(`${BASE}/fetchOpportunity`, { opportunityId: Number(oppId) }));
  const d = data?.data ?? {};
  const s = d.synopsis ?? d.forecast ?? {};
  const list = (v: any) => (Array.isArray(v) ? v.map((x: any) => x?.description ?? x).filter(Boolean) : []);
  return {
    source: "Grants.gov fetchOpportunity (api.grants.gov)",
    fetchedAt: new Date().toISOString(),
    opportunityId: d.id ?? Number(oppId),
    number: d.opportunityNumber,
    title: d.opportunityTitle,
    agency: s.agencyName ?? d.agencyDetails?.agencyName ?? null,
    agencyCode: d.owningAgencyCode,
    docType: d.docType,
    category: d.opportunityCategory?.description ?? null,
    cfda: (d.cfdas ?? []).map((c: any) => `${c.cfdaNumber} ${c.programTitle ?? ""}`.trim()),
    postingDate: iso(s.postingDate ?? s.postingDateStr),
    closeDate: iso(s.responseDate ?? s.responseDateStr ?? s.estApplicationResponseDate),
    estimatedFunding: toNum(s.estimatedFunding),
    awardCeiling: toNum(s.awardCeiling),
    awardFloor: toNum(s.awardFloor),
    expectedAwards: toNum(s.numberOfAwards),
    costSharing: s.costSharing === "True" || s.costSharing === true,
    fundingInstruments: list(s.fundingInstruments),
    fundingCategories: list(s.fundingActivityCategories),
    applicantTypes: list(s.applicantTypes),
    contact: [s.agencyContactName, s.agencyContactEmail].filter(Boolean).join(" · ") || null,
    description: trunc(s.synopsisDesc ?? s.forecastDesc, 900),
    moreInfo: s.fundingDescLinkUrl ?? null,
    url: `https://www.grants.gov/search-results-detail/${oppId}`,
  };
}
