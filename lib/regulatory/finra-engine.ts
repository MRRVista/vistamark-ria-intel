/**
 * FINRA BrokerCheck + SEC IAPD — the same search engine on two hosts, keyless.
 *
 * Verified live 2026-10-22 from the sandbox:
 *   GET {host}/search/individual?query=<name>&hl=true&nrows=12&start=0&r=25&wt=json
 *   GET {host}/search/individual/<crd>?hl=true&nrows=12&start=0&wt=json
 *   GET {host}/search/firm?query=<name>&hl=true&nrows=12&start=0&wt=json
 *   GET {host}/search/firm/<crd>?hl=true&nrows=12&start=0&wt=json
 *   host = https://api.brokercheck.finra.org (BC) | https://api.adviserinfo.sec.gov (IAPD)
 *
 * Working filters on /search/individual: `firm=<CRD or name>` (query may then be
 * empty), `state=IL`, `city=Hinsdale` (with state). On the BrokerCheck host
 * `state` MUST be accompanied by `r=<n>` or the engine answers
 * {errorMessage:"Exceeded limit"} (that message is NOT a rate limit). `zip`,
 * `radius`, `location` are accepted but ignored (totals don't change), so zip
 * proximity is done client-side on the branch zips of the hits. `filter=`,
 * `includePrevious`, `sort=` trigger "Search unavailable" and are not sent.
 *
 * Hit shape (BC host): _source.ind_source_id (CRD), ind_firstname/middlename/
 * lastname, ind_other_names, ind_bc_scope, ind_ia_scope, ind_bc_disclosure_fl,
 * ind_approved_finra_registration_count, ind_employments_count,
 * ind_industry_cal_date (BC start date) | ind_industry_days,
 * ind_current_employments[{firm_id, firm_name, branch_city, branch_state,
 * branch_zip, ia_only, firm_bd_sec_number, firm_ia_sec_number}].
 * IAPD host swaps in ind_ia_disclosure_fl, ind_industry_cal_date_iapd and
 * ind_ia_current_employments (IA-side firms only; BD-only hits show none).
 *
 * Detail: _source.content (BC) / _source.iacontent (IAPD) is a JSON string with
 * basicInformation, currentEmployments, currentIAEmployments, previousEmployments,
 * previousIAEmployments, disclosures[{eventDate, disclosureType,
 * disclosureResolution, disclosureDetail{...}}], stateExamCategory /
 * principalExamCategory / productExamCategory, registrationCount,
 * registeredStates, registeredSROs.
 *
 * Soft failures: HTTP 200 with {errorCode:-1, errorMessage:"Search unavailable"}
 * for unsupported params; "Exceeded limit" for state-without-r (see above).
 * No true rate limiting was observed in ~60 calls from the sandbox.
 */
import {
  BC_HOST,
  IAPD_HOST,
  cached,
  HOUR,
  clampInt,
  compactAddress,
  engineGet,
  isoDate,
  parseDetail,
  parseMaybeJson,
  qs,
  trunc,
  yearsSince,
  yn,
  type EngineHit,
} from "./common";

export type Engine = "brokercheck" | "iapd";
const hostOf = (e: Engine) => (e === "iapd" ? IAPD_HOST : BC_HOST);
const SRC_LABEL: Record<Engine, string> = {
  brokercheck: "FINRA BrokerCheck (api.brokercheck.finra.org)",
  iapd: "SEC IAPD — Investment Adviser Public Disclosure (api.adviserinfo.sec.gov)",
};
const PUBLIC_URL: Record<Engine, (kind: "individual" | "firm", crd: string | number) => string> = {
  brokercheck: (k, crd) => `https://brokercheck.finra.org/${k}/summary/${crd}`,
  iapd: (k, crd) => `https://adviserinfo.sec.gov/${k}/summary/${crd}`,
};

// ---------------------------------------------------------------- individuals

export interface IndividualSearchArgs {
  query?: string;
  firm?: string | number;
  state?: string;
  city?: string;
  zip?: string;
  activeOnly?: boolean;
  disclosuresOnly?: boolean;
  limit?: number;
  start?: number;
}

function mapIndividualHit(h: EngineHit, engine: Engine) {
  const s = h._source ?? {};
  const emps: any[] = s.ind_current_employments ?? s.ind_ia_current_employments ?? [];
  const bcStart = isoDate(s.ind_industry_cal_date ?? s.ind_industry_cal_date_iapd);
  const days = Number(s.ind_industry_days ?? s.ind_industry_days_iapd);
  const years = bcStart ? yearsSince(bcStart) : Number.isFinite(days) && days > 0 ? Math.round((days / 365.25) * 10) / 10 : null;
  const name = [s.ind_firstname, s.ind_middlename, s.ind_lastname].filter(Boolean).join(" ");
  const first = emps[0];
  return {
    crd: s.ind_source_id,
    name,
    otherNames: Array.isArray(s.ind_other_names) ? s.ind_other_names.filter((n: string) => n && n.replace(/\s+/g, " ").toUpperCase() !== name.toUpperCase()).slice(0, 3) : [],
    brokerStatus: s.ind_bc_scope ?? null,
    advisorStatus: s.ind_ia_scope ?? null,
    hasDisclosures: yn(s.ind_bc_disclosure_fl ?? s.ind_ia_disclosure_fl),
    finraRegistrations: s.ind_approved_finra_registration_count ?? null,
    yearsInIndustry: years,
    location: first ? [first.branch_city, first.branch_state].filter(Boolean).join(", ") || null : null,
    currentFirms: emps.map((e) => ({
      crd: e.firm_id,
      name: e.firm_name,
      city: e.branch_city ?? null,
      state: e.branch_state ?? null,
      zip: e.branch_zip ?? null,
      role: e.ia_only === "Y" ? "IA" : e.firm_bd_sec_number ? "BD" : "BD/IA",
    })),
    profileUrl: PUBLIC_URL[engine]("individual", s.ind_source_id),
  };
}

export async function searchIndividuals(engine: Engine, args: IndividualSearchArgs) {
  const query = String(args.query ?? "").trim();
  const firm = args.firm != null ? String(args.firm).trim() : "";
  const state = args.state ? String(args.state).trim().toUpperCase() : "";
  const city = args.city ? String(args.city).trim() : "";
  const zip = args.zip ? String(args.zip).trim().slice(0, 5) : "";
  if (!query && !firm && !(city && state)) {
    throw new Error("Pass `query` (a person's name), `firm` (firm CRD or name), or `city` + `state`");
  }
  if (city && !state) throw new Error("`city` requires `state` (two-letter code)");
  const limit = clampInt(args.limit, 12, 1, 25);
  const start = clampInt(args.start, 0, 0, 500);
  // When we filter client-side (zip / active / disclosures) over-fetch a page.
  const clientFilter = Boolean(zip || args.activeOnly || args.disclosuresOnly);
  const nrows = clientFilter ? 50 : limit;
  // BrokerCheck answers {errorMessage:"Exceeded limit"} whenever `state` is sent
  // without a radius param, so `r` is always included (its value is otherwise ignored).
  const url = `${hostOf(engine)}/search/individual?${qs({ query, firm, state, city, hl: false, nrows, start, r: 25, wt: "json" })}`;
  const data = await cached(`reg:${engine}:ind:${url}`, HOUR, () => engineGet(url, `${engine} individual search`));
  let rows = (data.hits?.hits ?? []).map((h) => mapIndividualHit(h, engine));
  if (zip) {
    const z3 = zip.slice(0, 3);
    rows = rows.filter((r) => r.currentFirms.some((f) => f.zip === zip)).concat(
      rows.filter((r) => !r.currentFirms.some((f) => f.zip === zip) && r.currentFirms.some((f) => (f.zip ?? "").startsWith(z3)))
    );
  }
  if (args.activeOnly) rows = rows.filter((r) => /^active$/i.test(String(r.brokerStatus)) || /^active$/i.test(String(r.advisorStatus)));
  if (args.disclosuresOnly) rows = rows.filter((r) => r.hasDisclosures === true);
  return {
    source: SRC_LABEL[engine],
    fetchedAt: new Date().toISOString(),
    query: { query: query || null, firm: firm || null, state: state || null, city: city || null, zip: zip || null },
    totalMatches: data.hits?.total ?? 0,
    returned: Math.min(rows.length, limit),
    note: clientFilter ? "zip/activeOnly/disclosuresOnly are applied client-side to the first 50 engine hits (the engine ignores zip)" : undefined,
    results: rows.slice(0, limit),
  };
}

function mapEmployment(e: any) {
  const loc = Array.isArray(e.branchOfficeLocations) ? e.branchOfficeLocations[0] : null;
  return {
    firmCrd: e.firmId,
    firm: e.firmName,
    type: e.iaOnly === "Y" ? "IA" : e.bdSECNumber ? "BD" : "BD/IA",
    city: e.city ?? loc?.city ?? null,
    state: e.state ?? loc?.state ?? null,
    from: isoDate(e.registrationBeginDate),
    to: isoDate(e.registrationEndDate),
  };
}

function mapDisclosure(d: any) {
  const det = d.disclosureDetail ?? {};
  const pick = (...keys: string[]) => {
    for (const k of keys) if (det[k] != null && det[k] !== "") return det[k];
    return null;
  };
  return {
    date: isoDate(d.eventDate),
    type: d.disclosureType ?? null,
    resolution: d.disclosureResolution ?? null,
    subtype: pick("Type", "Allegations Type") ?? null,
    initiatedBy: pick("Initiated By", "Regulator Name", "Court Name") ?? null,
    allegations: trunc(pick("Allegations", "Allegation"), 240),
    disposition: pick("Disposition", "Resolution", "Status") ?? null,
    sanctions: trunc(pick("Sanctions", "Sanction Details", "Damage Amount Requested", "Settlement Amount"), 160),
    comment: trunc(pick("Broker Comment", "Firm Statement"), 160),
  };
}

export async function individualDetail(engine: Engine, args: { crd: string | number; maxDisclosures?: number; maxEmployments?: number }) {
  const crd = String(args.crd ?? "").replace(/\D/g, "");
  if (!crd) throw new Error("`crd` (numeric individual CRD) is required — find it with the matching *_individual_search tool");
  const maxD = clampInt(args.maxDisclosures, 10, 0, 40);
  const maxE = clampInt(args.maxEmployments, 12, 1, 40);
  const url = `${hostOf(engine)}/search/individual/${crd}?${qs({ hl: true, nrows: 12, start: 0, wt: "json" })}`;
  const data = await cached(`reg:${engine}:indd:${crd}`, 6 * HOUR, () => engineGet(url, `${engine} individual detail`));
  const c = parseDetail(data.hits?.hits?.[0], `${engine} individual ${crd}`);
  const b = c.basicInformation ?? {};
  const exams = [
    ...(c.stateExamCategory ?? []),
    ...(c.principalExamCategory ?? []),
    ...(c.productExamCategory ?? []),
  ].map((x: any) => ({ exam: x.examCategory, name: trunc(x.examName, 70), date: isoDate(x.examTakenDate) }));
  const current = [...(c.currentEmployments ?? []), ...(c.currentIAEmployments ?? [])].map(mapEmployment);
  const previous = [...(c.previousEmployments ?? []), ...(c.previousIAEmployments ?? [])]
    .map(mapEmployment)
    .sort((a, b2) => String(b2.to ?? "").localeCompare(String(a.to ?? "")));
  const disclosures: any[] = [...(c.disclosures ?? [])];
  const disclosuresSorted = disclosures.map(mapDisclosure).sort((a, b2) => String(b2.date ?? "").localeCompare(String(a.date ?? "")));
  const byType: Record<string, number> = {};
  for (const d of disclosuresSorted) byType[d.type ?? "Unknown"] = (byType[d.type ?? "Unknown"] ?? 0) + 1;
  const regStates = (c.registeredStates ?? []) as any[];
  const earliest = [...current, ...previous].map((e) => e.from).filter(Boolean).sort()[0] ?? null;
  return {
    source: SRC_LABEL[engine],
    fetchedAt: new Date().toISOString(),
    crd: b.individualId ?? Number(crd),
    name: [b.firstName, b.middleName, b.lastName].filter(Boolean).join(" "),
    otherNames: (b.otherNames ?? []).slice(0, 4),
    brokerStatus: b.bcScope ?? null,
    advisorStatus: b.iaScope ?? null,
    firstRegistered: earliest,
    yearsInIndustry: yearsSince(earliest),
    currentEmployments: current.slice(0, maxE),
    previousEmployments: previous.slice(0, maxE),
    previousEmploymentsTotal: previous.length,
    registrations: {
      finra: c.registrationCount?.approvedFinraRegistrationCount ?? null,
      sro: c.registrationCount?.approvedSRORegistrationCount ?? null,
      bdStates: c.registrationCount?.approvedStateRegistrationCount ?? null,
      iaStates: c.registrationCount?.approvedIAStateRegistrationCount ?? null,
      sros: (c.registeredSROs ?? []).map((s: any) => ({ sro: s.sro, status: s.status, categories: (s.CategoriesList ?? []).slice(0, 4) })),
      states: regStates.map((s: any) => `${s.state} (${s.regScope}${s.status && s.status !== "APPROVED" ? ": " + s.status : ""})`).slice(0, 55),
    },
    exams,
    disclosures: {
      flag: yn(c.disclosureFlag) || yn(c.iaDisclosureFlag) || disclosuresSorted.length > 0,
      total: disclosuresSorted.length,
      byType,
      items: disclosuresSorted.slice(0, maxD),
    },
    profileUrl: PUBLIC_URL[engine]("individual", crd),
  };
}

// ---------------------------------------------------------------------- firms

export async function searchFirms(engine: Engine, args: { query: string; limit?: number; start?: number; state?: string }) {
  const query = String(args.query ?? "").trim();
  if (!query) throw new Error("`query` (firm name or CRD) is required");
  const limit = clampInt(args.limit, 10, 1, 25);
  const start = clampInt(args.start, 0, 0, 500);
  const state = args.state ? String(args.state).trim().toUpperCase() : "";
  const nrows = state ? 50 : limit;
  const url = `${hostOf(engine)}/search/firm?${qs({ query, hl: false, nrows, start, wt: "json" })}`;
  const data = await cached(`reg:${engine}:firm:${url}`, HOUR, () => engineGet(url, `${engine} firm search`));
  let rows = (data.hits?.hits ?? []).map((h) => {
    const s = h._source ?? {};
    const bdAddr = parseMaybeJson(s.firm_address_details);
    const iaAddr = parseMaybeJson(s.firm_ia_address_details);
    const office = bdAddr?.officeAddress ?? iaAddr?.officeAddress ?? null;
    return {
      crd: s.firm_source_id,
      name: s.firm_name,
      iaName: s.ia_firm_name && s.ia_firm_name !== s.firm_name ? s.ia_firm_name : undefined,
      formerNames: (s.firm_other_names ?? []).filter((n: string) => n !== s.firm_name && n !== s.ia_firm_name).slice(0, 4),
      bdSecNumber: s.firm_bd_full_sec_number ?? null,
      iaSecNumber: s.firm_ia_full_sec_number ?? null,
      brokerDealerStatus: s.firm_scope ?? null,
      advisorStatus: s.firm_ia_scope ?? null,
      hasDisclosures: yn(s.firm_disclosure_fl) || yn(s.firm_ia_disclosure_fl) || false,
      branches: s.firm_branches_count ?? null,
      mainOffice: compactAddress(office),
      state: office?.state ?? null,
      phone: bdAddr?.businessPhoneNumber ?? null,
      profileUrl: PUBLIC_URL[engine]("firm", s.firm_source_id),
    };
  });
  if (state) rows = rows.filter((r) => r.state === state);
  return {
    source: SRC_LABEL[engine],
    fetchedAt: new Date().toISOString(),
    query,
    totalMatches: data.hits?.total ?? 0,
    returned: Math.min(rows.length, limit),
    results: rows.slice(0, limit),
  };
}

export async function firmDetail(engine: Engine, args: { crd: string | number; owners?: number; countIndividuals?: boolean }) {
  const crd = String(args.crd ?? "").replace(/\D/g, "");
  if (!crd) throw new Error("`crd` (numeric firm CRD) is required — find it with *_firm_search or search_rias");
  const maxOwners = clampInt(args.owners, 8, 0, 30);
  const url = `${hostOf(engine)}/search/firm/${crd}?${qs({ hl: true, nrows: 12, start: 0, wt: "json" })}`;
  const data = await cached(`reg:${engine}:firmd:${crd}`, 6 * HOUR, () => engineGet(url, `${engine} firm detail`));
  const c = parseDetail(data.hits?.hits?.[0], `${engine} firm ${crd}`);
  const b = c.basicInformation ?? {};
  const bdAddr = c.firmAddressDetails ?? null;
  const iaAddr = c.iaFirmAddressDetails ?? null;

  // Headcount is not in the firm document; the individual index exposes it as hits.total.
  let registeredIndividuals: number | null = null;
  if (args.countIndividuals !== false) {
    try {
      const u = `${hostOf(engine)}/search/individual?${qs({ query: "", firm: crd, hl: false, nrows: 1, start: 0, wt: "json" })}`;
      const r = await cached(`reg:${engine}:count:${crd}`, 6 * HOUR, () => engineGet(u, `${engine} firm headcount`));
      registeredIndividuals = r.hits?.total ?? null;
    } catch {
      registeredIndividuals = null;
    }
  }

  const disclosures = (c.disclosures ?? []).map((d: any) => ({ type: d.disclosureType, count: d.disclosureCount }));
  const out: Record<string, any> = {
    source: SRC_LABEL[engine],
    fetchedAt: new Date().toISOString(),
    crd: b.firmId ?? Number(crd),
    name: b.firmName,
    iaName: b.iaFirmName && b.iaFirmName !== b.firmName ? b.iaFirmName : undefined,
    formerNames: (b.otherNames ?? []).filter((n: string) => n !== b.firmName && n !== b.iaFirmName).slice(0, 5),
    bdSecNumber: b.bdSECNumber ? `8-${b.bdSECNumber}` : null,
    iaSecNumber: b.iaSECNumber ? `${b.iaSECNumberType ?? "801"}-${b.iaSECNumber}` : null,
    brokerDealerStatus: b.bcScope ?? null,
    advisorStatus: b.iaScope ?? null,
    firmType: b.firmType ?? null,
    formedState: b.formedState ?? null,
    formedDate: isoDate(b.formedDate),
    firmSize: b.firmSize ?? null,
    regulator: b.regulator ?? null,
    finraDistrict: b.districtName ?? null,
    finraApproved: isoDate(b.finraLastApprovalDate),
    mainOffice: compactAddress(bdAddr?.officeAddress ?? iaAddr?.officeAddress),
    mailingAddress: compactAddress(bdAddr?.mailingAddress),
    phone: bdAddr?.businessPhoneNumber ?? null,
    registeredIndividuals,
    disclosures: { flag: yn(c.bdDisclosureFlag) || yn(c.iaDisclosureFlag) || disclosures.length > 0, byType: disclosures, total: disclosures.reduce((a: number, d: any) => a + (Number(d.count) || 0), 0) },
    profileUrl: PUBLIC_URL[engine]("firm", crd),
  };
  if (c.registrations) {
    out.registrations = {
      finra: c.registrations.approvedFinraRegistrationCount ?? null,
      sec: c.registrations.approvedSECRegistrationCount ?? null,
      sro: c.registrations.approvedSRORegistrationCount ?? null,
      stateCount: c.registrations.approvedStateRegistrationCount ?? null,
    };
  }
  if (Array.isArray(c.directOwners) && maxOwners > 0) {
    out.directOwners = c.directOwners.slice(0, maxOwners).map((o: any) => ({ name: o.legalName, position: o.position, crd: o.crdNumber || null }));
    out.directOwnersTotal = c.directOwners.length;
  }
  // IAPD-only sections
  if (b.advFilingDate) out.lastAdvFiling = isoDate(b.advFilingDate);
  if (Array.isArray(c.registrationStatus)) {
    out.iaRegistration = c.registrationStatus.map((r: any) => ({ jurisdiction: r.secJurisdiction, status: r.status, effective: isoDate(r.effectiveDate) }));
  }
  if (Array.isArray(c.noticeFilings)) {
    out.noticeFilingStates = c.noticeFilings.filter((n: any) => /notice filed/i.test(String(n.status))).map((n: any) => n.jurisdiction).slice(0, 55);
  }
  if (c.orgScopeStatusFlags) {
    const f = c.orgScopeStatusFlags;
    out.scope = { secRegistered: yn(f.isSECRegistered), stateRegistered: yn(f.isStateRegistered), exemptReportingAdviser: yn(f.isERARegistered) || yn(f.isSECERARegistered) || yn(f.isStateERARegistered) };
  }
  if (c.brochures?.brochuredetails) {
    out.brochures = c.brochures.brochuredetails.slice(0, 5).map((x: any) => ({ name: x.brochureName, submitted: isoDate(x.dateSubmitted), url: `https://adviserinfo.sec.gov/firm/brochure/${crd}` }));
  }
  if (b.crs?.fileId) out.formCrsUrl = `https://reports.adviserinfo.sec.gov/crs/crs_${crd}.pdf`;
  return out;
}
