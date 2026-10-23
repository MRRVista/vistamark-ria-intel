/**
 * org_360 — one institution, resolved across IRS, DOL, SEC, GLEIF, federal
 * money, then scored for "is this mandate in play?" and handed an angle.
 *
 * Two waves: wave 1 resolves identity in parallel (990 search, BMF, 5500 by
 * sponsor, ADV, LEI, EDGAR ticker); wave 2 pulls depth against the resolved
 * EIN/name (board, 990 history, Schedule C providers, USAspending, PPP, EDGAR
 * full text). Everything error-isolated; coverage reported.
 */
import { fanOut, type SourceResult, rowsOf, num, usd, sameOrg, isoDaysAgo, coverage } from "./core";
import { buildOrgAngles } from "./angles";

export interface Org360Args {
  name?: string;
  ein?: string | number;
  state?: string;
  city?: string;
  includeEdgar?: boolean;
}

function einStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const digits = String(v).replace(/\D/g, "");
  return digits.length === 9 ? digits : null;
}

export async function org360(args: Org360Args) {
  const name = String(args.name ?? "").trim();
  const einIn = einStr(args.ein);
  if (!name && !einIn) throw new Error("org_360: `name` or `ein` is required");
  const state = args.state?.toUpperCase();

  /* ----------------------------- wave 1: resolve ---------------------------- */
  const w1 = await fanOut([
    einIn
      ? { tool: "irs990_filing_get", args: { ein: einIn, limit: 3, includePeople: false } }
      : { tool: "irs990_filing_search", args: { orgName: name, ...(state ? { state } : {}), ...(args.city ? { city: args.city } : {}), limit: 5 } },
    einIn ? { tool: "irs_eo_lookup", args: { ein: einIn } } : { tool: "irs_eo_search", args: { name, ...(state ? { state } : {}), limit: 5 } },
    { tool: "dol_plan_search", args: einIn ? { sponsorEin: einIn, limit: 10 } : { sponsorName: name, limit: 10 } },
    name ? { tool: "search_rias", args: { nameContains: name, limit: 3 } } : { tool: "search_rias", args: {}, skip: "no name" },
    name ? { tool: "gleif_entity_search", args: { query: name, country: "US", limit: 3 } } : { tool: "gleif_entity_search", args: {}, skip: "no name" },
    name && args.includeEdgar !== false ? { tool: "edgar_company_lookup", args: { query: name, limit: 3 } } : { tool: "edgar_company_lookup", args: {}, skip: "no name" },
  ]);
  const [f990, bmf, plans, rias, lei, tickers] = w1;

  // resolve the 990 filing(s)
  let filings: any[] = rowsOf(f990.data);
  if (name) filings = filings.filter((f) => sameOrg(f.orgName ?? "", name) || !f.orgName);
  // irs990_filing_get returns filings for one EIN already sorted newest first
  filings = filings.sort((a, b) => String(b.taxPeriodEnd ?? "").localeCompare(String(a.taxPeriodEnd ?? "")));
  const newest = filings[0] ?? null;
  const prior = filings.find((f) => f.ein === newest?.ein && f.taxPeriodEnd !== newest?.taxPeriodEnd) ?? null;

  const bmfRows = rowsOf(bmf.data);
  const bmfRow = einIn ? (bmf.data?.org ?? bmf.data?.row ?? bmfRows[0] ?? (bmf.data?.ein ? bmf.data : null)) : bmfRows.find((r) => sameOrg(r.name ?? "", name)) ?? bmfRows[0] ?? null;

  const ein = einIn ?? einStr(newest?.ein) ?? einStr(bmfRow?.ein) ?? einStr(rowsOf(plans.data)[0]?.sponsDfeEin);
  const resolvedName = newest?.orgName ?? bmfRow?.name ?? rowsOf(plans.data)[0]?.sponsDfeName ?? name;

  /* ------------------------------ wave 2: depth ----------------------------- */
  const w2 = await fanOut([
    ein ? { tool: "irs990_board", args: { ein } } : { tool: "irs990_board", args: {}, skip: "no EIN resolved" },
    ein ? { tool: "propublica_org_990", args: { ein } } : { tool: "propublica_org_990", args: {}, skip: "no EIN resolved" },
    ein || name
      ? { tool: "dol_sch_c_providers_by_plan", args: ein ? { sponsorEin: ein, limitPlans: 3 } : { sponsorName: name, limitPlans: 3 } }
      : { tool: "dol_sch_c_providers_by_plan", args: {}, skip: "no key" },
    { tool: "usaspending_awards_search", args: { recipientName: resolvedName, ...(state ? { recipientState: state } : {}), limit: 10 } },
    { tool: "ppp_lookup", args: { borrowerName: resolvedName, ...(state ? { state } : {}), limit: 5 } },
    args.includeEdgar === false
      ? { tool: "edgar_fulltext_search", args: {}, skip: "includeEdgar=false" }
      : { tool: "edgar_fulltext_search", args: { query: `"${resolvedName}"`, startDate: isoDaysAgo(730), limit: 10 } },
  ]);
  const [board, propub, schC, grants, ppp, edgar] = w2;
  const sources: SourceResult[] = [...w1.map((r) => r.src), ...w2.map((r) => r.src)];

  /* ------------------------------- assemble -------------------------------- */
  const fin = newest
    ? {
        taxPeriodEnd: newest.taxPeriodEnd, returnType: newest.returnType,
        totalRevenue: num(newest.totalRevenue), totalExpenses: num(newest.totalExpenses),
        totalAssetsEoy: num(newest.totalAssetsEoy), netAssetsEoy: num(newest.netAssetsEoy),
        contributions: num(newest.contributions), investmentIncome: num(newest.investmentIncome),
        investmentsPublic: num(newest.investmentsPublic), investmentsOther: num(newest.investmentsOther),
        endowmentEoy: num(newest.endowmentEoy), investMgmtFees: num(newest.investMgmtFees),
        votingMembers: newest.votingMembers, independentMembers: newest.independentMembers, employees: newest.employees,
        website: newest.website, mission: typeof newest.mission === "string" ? newest.mission.slice(0, 300) : undefined,
      }
    : null;
  const finPrior = prior ? { taxPeriodEnd: prior.taxPeriodEnd, netAssetsEoy: num(prior.netAssetsEoy), investMgmtFees: num(prior.investMgmtFees), totalRevenue: num(prior.totalRevenue) } : null;

  const people = rowsOf(board.data).map((p: any) => ({ name: p.name, title: p.title, isOfficer: p.isOfficer, isTrustee: p.isIndividualTrustee, hours: p.avgHours, compOrg: p.compOrg }));
  const financeTitles = people.filter((p) => /treasur|finance|investment|cfo|chief financial|audit|endow/i.test(String(p.title ?? "")));

  const ppHistory = rowsOf(propub.data?.filings ?? propub.data?.history ?? propub.data).slice(0, 8).map((f: any) => ({
    year: f.taxYear ?? f.tax_prd_yr ?? f.year, totalRevenue: num(f.totalRevenue ?? f.totrevenue), totalAssets: num(f.totalAssets ?? f.totassetsend), netAssets: num(f.netAssets ?? f.totnetassetend), investmentIncome: num(f.investmentIncome ?? f.invstmntinc),
  }));

  const planRows = rowsOf(plans.data).slice(0, 10).map((p: any) => ({
    planName: p.planName, planYear: p.planYear, assetsEoy: num(p.totAssetsEoyAmt ?? p.netAssetsEoyAmt), participants: p.totActivePartcpCnt, type: p.planTypeLabel, features: p.pensionPlanFeatureCodes, schC: p.schCAttachedInd, schH: p.schHAttachedInd, ackId: p.ackId,
  }));
  const dbPlan = planRows.some((p) => /\b2[A-Z]\b|defined benefit|\bDB\b/i.test(String(p.features ?? "") + " " + String(p.type ?? "")));

  const providerPlans = Array.isArray(schC.data?.plans) ? schC.data.plans : [];
  const incumbents: Array<{ provider: string; relation?: string; services?: unknown; totalComp?: number | null; plan?: string; year?: unknown }> = [];
  for (const pl of providerPlans) for (const p of pl.providers ?? []) incumbents.push({ provider: p.provider, relation: p.relation, services: p.services, totalComp: num(p.totalComp), plan: pl.planName, year: pl.filingYear });
  const adviserLike = incumbents.filter((i) => /advis|invest|consult|manag/i.test(String(i.relation ?? "") + " " + JSON.stringify(i.services ?? "")));

  const awards = rowsOf(grants.data).slice(0, 10).map((a: any) => ({ agency: a.awardingAgency, amountUsd: num(a.amountUsd), start: a.startDate, end: a.endDate, description: typeof a.description === "string" ? a.description.slice(0, 120) : undefined }));
  const grantsUsd = awards.reduce((s, a) => s + (a.amountUsd ?? 0), 0);

  const pppRows = (Array.isArray(ppp.data?.rows) ? ppp.data.rows : ppp.data?.loan ? [ppp.data.loan] : []).filter((r: any) => sameOrg(r.borrowerName ?? "", resolvedName)).slice(0, 3).map((r: any) => ({ amount: num(r.currentApprovalAmount), forgiven: num(r.forgivenessAmount), dateApproved: r.dateApproved, jobs: r.jobsReported, lender: r.originatingLender }));

  const edgarHits = rowsOf(edgar.data).slice(0, 8).map((h: any) => ({ filer: h.filer, form: h.form, fileDate: h.fileDate, url: h.documentUrl }));
  const riaRows = rowsOf(rias.data).filter((r: any) => sameOrg(r.legalName ?? r.primaryBusinessName ?? "", name)).slice(0, 2).map((r: any) => ({ crd: r.crdNumber, legalName: r.legalName, totalAum: num(r.totalAum), city: r.city, state: r.state }));
  const leiRows = rowsOf(lei.data).filter((e: any) => sameOrg(e.legalName ?? "", name)).slice(0, 2).map((e: any) => ({ lei: e.lei, legalName: e.legalName, status: e.entityStatus, hq: e.headquartersAddress }));
  const tickerRows = rowsOf(tickers.data).filter((m: any) => sameOrg(m.name ?? "", name)).slice(0, 2);

  /* ------------------------------- in-play score ---------------------------- */
  const reasons: string[] = [];
  let score = 0;
  const fees = fin?.investMgmtFees ?? null;
  if (fees && fees > 0) { score += 25; reasons.push(`pays investment-management fees (${usd(fees)}) — an incumbent exists`); }
  if (fees && finPrior?.investMgmtFees && fees > finPrior.investMgmtFees) { score += 10; reasons.push("fees rose year over year"); }
  if (fin?.netAssetsEoy !== null && finPrior?.netAssetsEoy && fin && fin.netAssetsEoy !== null && fin.netAssetsEoy < finPrior.netAssetsEoy) { score += 15; reasons.push("net assets fell year over year"); }
  if ((fin?.endowmentEoy ?? 0) > 5e6 || ((fin?.investmentsPublic ?? 0) + (fin?.investmentsOther ?? 0)) > 5e6) { score += 10; reasons.push("invested securities / endowment above $5M"); }
  if (financeTitles.length) { score += 10; reasons.push(`finance/investment-titled decision makers identified (${financeTitles.length})`); }
  if (adviserLike.length) { score += 15; reasons.push(`named adviser/consultant on Schedule C (${adviserLike.length})`); }
  if (dbPlan) { score += 10; reasons.push("sponsors a defined-benefit plan"); }
  if (grantsUsd > 1e6) { score += 5; reasons.push(`federal awards ${usd(grantsUsd)} — reserve-policy conversation`); }
  score = Math.min(100, score);

  const angles = buildOrgAngles({
    orgName: resolvedName, fees, feesPrior: finPrior?.investMgmtFees ?? null,
    netAssets: fin?.netAssetsEoy ?? null, netAssetsPrior: finPrior?.netAssetsEoy ?? null,
    investments: ((fin?.investmentsPublic ?? 0) + (fin?.investmentsOther ?? 0)) || null, endowment: fin?.endowmentEoy ?? null,
    dbPlan, planAssets: planRows[0]?.assetsEoy ?? null, incumbents: adviserLike.map((i) => i.provider).filter(Boolean),
    grantsUsd: grantsUsd || null, decisionMakers: financeTitles.map((p) => `${p.name} (${p.title})`),
  });

  return {
    dataSource: "synthesis:org_360 (IRS 990 e-file · IRS BMF · ProPublica · DOL 5500 + Schedule C · SEC ADV/EDGAR · GLEIF · USAspending · SBA PPP)",
    resolved: { name: resolvedName, ein, bmf: bmfRow ? { subsection: bmfRow.subsectionLabel ?? bmfRow.subsection, foundation: bmfRow.foundationLabel ?? bmfRow.foundation, ntee: bmfRow.nteeCode, city: bmfRow.city, state: bmfRow.state, assetAmt: num(bmfRow.assetAmt), revenueAmt: num(bmfRow.revenueAmt) } : null, isRia: riaRows, lei: leiRows, tickers: tickerRows },
    inPlayScore: score,
    inPlayReasons: reasons,
    financials: fin,
    financialsPrior: finPrior,
    history: ppHistory,
    people: { count: people.length, financeTitles, all: people.slice(0, 40) },
    plans: planRows,
    incumbents: { adviserLike, all: incumbents.slice(0, 25) },
    federalAwards: { count: awards.length, totalUsd: grantsUsd, top: awards.slice(0, 5) },
    ppp: pppRows,
    edgarMentions: edgarHits,
    angles,
    guardrails: [
      "Benchmarks use the org's own 990/5500 figures vs peers; never characterize the incumbent beyond what Schedule C / Part IX states.",
      "Outreach lands as a DRAFT for review; professional email only.",
    ],
    coverage: coverage(sources),
    sources,
    note:
      "in-play score is additive and auditable (see inPlayReasons). 990 figures are the newest e-filed return; ProPublica supplies the multi-year trend. " +
      "dol_plan_search sponsor names are null on 2024 ingests until the SPONSOR_DFE_NAME alias is deployed — EIN-based plan lookups are reliable, name-based may miss.",
  };
}
