/**
 * N-CEN (annual census report for registered investment companies) — live.
 *
 * Latest N-CEN for a registrant -> service-provider roster:
 *   registrant level : principal underwriters, independent public accountants,
 *                      (UITs) sponsors, trustees, depositors, UIT administrators
 *   per series       : investment advisers, sub-advisers, transfer agents,
 *                      custodians (incl. sub-custodians), administrators,
 *                      shareholder servicing agents, pricing services,
 *                      securities-lending agents, liquidity classification services
 *
 * Filing discovery: data.sec.gov submissions (form N-CEN, newest first).
 * One N-CEN covers every series of the trust, so a multi-series registrant's
 * file can be ~1MB; parsed once and cached 6h.
 */
import { archiveUrl, asArray, cached, clean, H6, jsonFetch, padCik, resolveFund, textFetch, txt, num, xmlParser } from "./sec";

const DS = "SEC EDGAR N-CEN (primary_doc.xml, live)";

/** <xStateCountry xState="US-PA" xCountry="US"/> — attribute names vary in case (principalUnderWriter…), so match by suffix. */
function stateCountry(node: any, _prefix?: string): string | null {
  if (!node || typeof node !== "object") return null;
  let st: string | undefined;
  let ct: string | undefined;
  for (const [k, v] of Object.entries(node)) {
    if (!k.startsWith("@_")) continue;
    if (/State$/i.test(k)) st = String(v);
    else if (/Country$/i.test(k)) ct = String(v);
  }
  return [st, ct].filter(Boolean).join(" / ") || null;
}

/** Case-insensitive child lookup. */
function pick(x: any, key: string): any {
  if (!x || typeof x !== "object") return undefined;
  if (key in x) return x[key];
  const lk = key.toLowerCase();
  for (const k of Object.keys(x)) if (k.toLowerCase() === lk) return x[k];
  return undefined;
}

function provider(x: any, p: string, extra: Record<string, string> = {}) {
  const o: Record<string, any> = {
    name: txt(x[`${p}Name`]),
    lei: txt(x[`${p}Lei`]),
    fileNo: txt(x[`${p}FileNo`]) ?? txt(x[`${p}FileNumber`]),
    crd: txt(x[`${p}CrdNo`]) ?? txt(x[`${p}CrdNumber`]),
    location: stateCountry(pick(x, `${p}StateCountry`)) ?? txt(pick(x, `${p}Country`)),
  };
  for (const [k, tag] of Object.entries(extra)) o[k] = txt(x[tag]);
  return clean(o);
}

function list(node: any, child: string, p: string, extra: Record<string, string> = {}) {
  return asArray(node?.[child]).map((x) => provider(x, p, extra)).filter((x) => x.name);
}

function parseSeries(s: any) {
  const advisers = list(s.investmentAdvisers, "investmentAdviser", "investmentAdviser", { hired: "isInvestmentAdviserHired" });
  const sub = list(s.subAdvisers, "subAdviser", "subAdviser", { affiliated: "isSubAdviserAffiliated", hired: "isSubAdviserHired" });
  const custodians = asArray(s.custodians?.custodian)
    .map((c: any) =>
      clean({
        name: txt(c.custodianName),
        lei: txt(c.custodianLei),
        location: stateCountry(c.custodianStateCountry, "custodian") ?? txt(c.custodianCountry),
        subCustodian: txt(c.isSubCustodian) === "Y" ? true : undefined,
        custodyType: txt(c.custodyType),
        affiliated: txt(c.isCustodianAffiliated),
      })
    )
    .filter((c: any) => c.name);
  const primaryCustodians = custodians.filter((c: any) => !c.subCustodian);
  return {
    seriesName: txt(s.mgmtInvFundName),
    seriesId: txt(s.mgmtInvSeriesId),
    seriesLei: txt(s.mgmtInvLei),
    fundTypes: [
      ...asArray(s.fundTypes?.fundType).map(txt),
      ...asArray(s.fundTypes?.indexFundInfo).map((x: any) => x?.["@_fundType"] ?? null),
    ].filter(Boolean),
    classes: asArray(s.sharesOutstandings?.sharesOutstanding)
      .map((c: any) => clean({ classId: c["@_sharesOutstandingClassId"], className: c["@_sharesOutstandingClassName"], ticker: c["@_sharesOutstandingTickerSymbol"] }))
      .slice(0, 10),
    monthlyAvgNetAssetsUSD: num(s.mnthlyAvgNetAssets),
    investmentAdvisers: advisers,
    subAdvisers: sub,
    transferAgents: list(s.transferAgents, "transferAgent", "transferAgent"),
    administrators: list(s.admins, "admin", "admin", { subAdmin: "isAdminSubAdmin", affiliated: "isAdminAffiliated" }),
    custodians: primaryCustodians.length ? primaryCustodians : custodians.slice(0, 5),
    subCustodianCount: custodians.filter((c: any) => c.subCustodian).length,
    shareholderServicingAgents: list(s.shareholderServicingAgents, "shareholderServicingAgent", "shareholderServiceAgent"),
    pricingServices: list(s.pricingServices, "pricingService", "pricingService"),
    securitiesLendingAgents: list(s.securityLendings, "securityLending", "securitiesAgent"),
    liquidityServices: list(s.liquidityClassifications, "liquidityClassificationService", "liquidity"),
  };
}

/** UIT providers sit either directly under unitInvestmentTrust or under notRegistrantSeparateInsuranceAccount (SPY). */
function uitProviders(uit: any) {
  const nodes = [uit, uit?.notRegistrantSeparateInsuranceAccount].filter(Boolean);
  const grab = (wrap: string, child: string, p: string) => nodes.flatMap((n) => list(n?.[wrap], child, p));
  return {
    sponsors: grab("sponsors", "sponsor", "sponsor"),
    trustees: grab("trustees", "trustee", "trustee"),
    depositors: grab("depositors", "depositor", "depositor"),
    uitAdministrators: grab("uitAdmins", "uitAdmin", "uitAdmin"),
  };
}

export interface NcenArgs {
  cik?: string | number;
  ticker?: string;
  seriesId?: string;
  seriesName?: string;
  limitSeries?: number;
}

export async function ncenServiceProviders(args: NcenArgs) {
  const a = args ?? {};
  const resolved = await resolveFund({ ticker: a.ticker, seriesId: a.seriesId, cik: a.cik });
  if (!resolved || !resolved.cik) {
    return { dataSource: DS, error: "Could not resolve a registrant. Provide cik, a fund ticker, or seriesId (try nport_fund_search)." };
  }
  const cik = resolved.cik;
  const sub = await jsonFetch<any>(`https://data.sec.gov/submissions/CIK${padCik(cik)}.json`);
  const r = sub?.filings?.recent ?? {};
  const forms: string[] = r.form ?? [];
  let i = forms.findIndex((f) => f === "N-CEN");
  if (i < 0) i = forms.findIndex((f) => f === "N-CEN/A");
  if (i < 0) {
    return { dataSource: DS, registrantCik: cik, registrant: sub?.name ?? null, error: "No N-CEN in this registrant's recent filings (only registered investment companies — mutual funds, ETFs, closed-end funds, UITs, BDCs — file N-CEN)." };
  }
  const accession: string = r.accessionNumber[i];
  const filingDate: string = r.filingDate[i];
  const url = archiveUrl(cik, accession, "primary_doc.xml");
  const doc = await cached(`ncen:${accession}`, H6, async () => xmlParser.parse(await textFetch(url, 45000))?.edgarSubmission ?? null);
  const fd = doc?.formData;
  if (!fd) return { dataSource: DS, registrantCik: cik, filing: { accession, filingDate, url }, error: "N-CEN parsed to nothing", sampleRaw: doc ? JSON.stringify(doc).slice(0, 600) : null };

  const reg = fd.registrantInfo ?? {};
  const registrantLevel = clean({
    principalUnderwriters: list(reg.principalUnderwriters, "principalUnderwriter", "principalUnderwriter", { affiliated: "isPrincipalUnderwriterAffiliatedWithRegistrant" }),
    publicAccountants: list(reg.publicAccountants, "publicAccountant", "publicAccountant", { pcaobNumber: "pcaobNumber" }),
    ...(fd.unitInvestmentTrust ? uitProviders(fd.unitInvestmentTrust) : {}),
  } as any);

  let series = asArray(fd.managementInvestmentQuestionSeriesInfo?.managementInvestmentQuestion).map(parseSeries);
  const totalSeries = series.length;
  const wantSeries = resolved.seriesId ?? (a.seriesId ? a.seriesId.toUpperCase() : null);
  const wantName = a.seriesName?.trim().toLowerCase();
  if (wantSeries) series = series.filter((s) => s.seriesId === wantSeries);
  else if (wantName) series = series.filter((s) => (s.seriesName ?? "").toLowerCase().includes(wantName));
  const limitSeries = Math.min(Math.max(Number(a.limitSeries) || 2, 1), 50);
  const shown = series.slice(0, limitSeries);

  // Roll-up across ALL series of the trust: who are the distinct advisers/custodians/etc.
  const allSeries = asArray(fd.managementInvestmentQuestionSeriesInfo?.managementInvestmentQuestion).map(parseSeries);
  const distinct = (k: keyof ReturnType<typeof parseSeries>) => {
    const m = new Map<string, number>();
    for (const s of allSeries) for (const p of (s[k] as any[]) ?? []) if (p?.name) m.set(p.name, (m.get(p.name) ?? 0) + 1);
    return [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([name, seriesCount]) => ({ name, seriesCount }));
  };

  return {
    dataSource: DS,
    registrant: {
      name: txt(reg.registrantFullName) ?? sub?.name ?? null,
      cik,
      fileNumber: txt(reg.investmentCompFileNo),
      lei: txt(reg.registrantLei),
      classification: txt(reg.registrantClassificationType), // N-1A open-end, N-2 closed-end, S-6 UIT, N-3/N-4 insurance separate accts
      city: txt(reg.registrantcity),
      state: txt(reg.registrantstate),
      familyInvestmentCompany: txt(reg.registrantFamilyInvComp?.familyInvCompFullName) ?? undefined,
    },
    filing: {
      accession,
      filingDate,
      reportPeriodEnd: fd.generalInfo?.["@_reportEndingPeriod"] ?? txt(fd.generalInfo?.reportEndingPeriod) ?? null,
      url,
    },
    registrantLevel,
    seriesTotal: totalSeries,
    seriesMatched: series.length,
    series: shown,
    ...(totalSeries > 1 && !wantSeries && !wantName
      ? {
          rollupAcrossAllSeries: {
            investmentAdvisers: distinct("investmentAdvisers"),
            subAdvisers: distinct("subAdvisers"),
            administrators: distinct("administrators"),
            custodians: distinct("custodians"),
            transferAgents: distinct("transferAgents"),
          },
        }
      : {}),
    note:
      "N-CEN is filed annually (within 75 days of fiscal year end), so providers are as of reportPeriodEnd. Custodians list primary custodians; sub-custodians (foreign 17f-5 banks) are counted, not listed. 'hired'=Y means hired/terminated during the period. " +
      (resolved.seriesId ? "Filtered to the resolved series. " : "") +
      (series.length > shown.length ? `Showing ${shown.length} of ${series.length} series — raise limitSeries or filter by seriesName/seriesId. ` : "") +
      "Advisers' file numbers (801-) and CRD numbers join to Form ADV (get_ria_profile).",
  };
}
