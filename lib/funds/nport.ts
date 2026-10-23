/**
 * N-PORT (monthly portfolio holdings report) — live from EDGAR.
 *
 *   nport_fund_search : ticker/name -> cik / seriesId / classId (company_tickers_mf.json
 *                       + Investment Company Series & Class CSV for names)
 *   nport_holdings    : latest public NPORT-P for a series -> fund totals + top N holdings
 *
 * Filing discovery for a series: EDGAR's browse-edgar Atom feed accepts a
 * series id as CIK (…?action=getcompany&CIK=S000002839&type=NPORT-P&output=atom)
 * and returns only that series' filings — one request instead of scanning the
 * registrant's (often hundreds of) same-day NPORT-P filings. For registrants
 * without series (UITs like SPY) the submissions API is used.
 *
 * Public NPORT-P: funds file monthly, but only the third month of each fiscal
 * quarter is made public, ~60 days after period end. So "latest" is typically
 * 2-5 months stale.
 */
import {
  SEC,
  archiveUrl,
  asArray,
  cached,
  H6,
  jsonFetch,
  mfTickers,
  num,
  padCik,
  resolveFund,
  seriesClassTable,
  textFetch,
  txt,
  xmlParser,
} from "./sec";

const DS = "SEC EDGAR N-PORT (NPORT-P primary_doc.xml, live)";

const ASSET_CAT: Record<string, string> = {
  EC: "Equity-common", EP: "Equity-preferred", DBT: "Debt", STIV: "Short-term investment vehicle",
  RA: "Repurchase agreement", ABS: "ABS", "ABS-MBS": "ABS-mortgage backed", "ABS-CBDO": "ABS-collateralized bond/debt", "ABS-APCP": "ABS-asset backed CP",
  "ABS-O": "ABS-other", DCO: "Derivative-commodity", DCR: "Derivative-credit", DE: "Derivative-equity", DFE: "Derivative-FX",
  DIR: "Derivative-interest rate", DO: "Derivative-other", LON: "Loan", COMM: "Commodity", RE: "Real estate", SN: "Structured note", OTHER: "Other",
};

// ---------------------------------------------------------------------------
// nport_fund_search
// ---------------------------------------------------------------------------
export async function nportFundSearch(args: { query: string; limit?: number }) {
  const q = String(args?.query ?? "").trim();
  if (!q) throw new Error("nport_fund_search requires a query (ticker, series id, or fund-name text).");
  const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 50);
  const qu = q.toUpperCase();
  const ql = q.toLowerCase();

  // Exact ticker / series id first (cheap 1.2MB map); names need the series-class CSV.
  const mf = await mfTickers();
  const exact = mf.filter((x) => x.symbol.toUpperCase() === qu || x.seriesId === qu || x.classId === qu);
  let sc: Awaited<ReturnType<typeof seriesClassTable>> | null = null;
  try {
    sc = await seriesClassTable();
  } catch {
    sc = null;
  }
  const byClass = new Map(sc?.rows.map((r) => [r.classId, r]) ?? []);
  const fmt = (x: { cik: number | string; seriesId: string; classId: string; symbol: string }) => {
    const r = byClass.get(x.classId);
    return {
      ticker: x.symbol || r?.ticker || null,
      cik: padCik(x.cik),
      seriesId: x.seriesId || null,
      classId: x.classId || null,
      registrant: r?.entityName ?? null,
      seriesName: r?.seriesName ?? null,
      className: r?.className ?? null,
    };
  };

  let matches: any[] = exact.map(fmt);
  if (matches.length < limit && sc && q.length >= 3) {
    const scored: Array<{ s: number; r: (typeof sc.rows)[number] }> = [];
    for (const r of sc.rows) {
      const sn = r.seriesName.toLowerCase();
      const en = r.entityName.toLowerCase();
      let s = 0;
      if (sn === ql) s = 90;
      else if (sn.startsWith(ql)) s = 70;
      else if (sn.includes(ql)) s = 50;
      else if (en.includes(ql)) s = 30;
      if (s) scored.push({ s: s + (r.ticker ? 25 : 0), r });
    }
    scored.sort((a, b) => b.s - a.s || a.r.seriesName.length - b.r.seriesName.length);
    const seen = new Set(matches.map((m) => m.classId));
    for (const { r } of scored) {
      if (matches.length >= limit) break;
      if (seen.has(r.classId)) continue;
      seen.add(r.classId);
      matches.push({ ticker: r.ticker || null, cik: r.cik, seriesId: r.seriesId || null, classId: r.classId || null, registrant: r.entityName, seriesName: r.seriesName, className: r.className });
    }
  }
  matches = matches.slice(0, limit);
  return {
    dataSource: "SEC company_tickers_mf.json + Investment Company Series & Class information (live)",
    query: q,
    matchCount: matches.length,
    matches,
    note: matches.length
      ? "Pass seriesId (preferred) or ticker to nport_holdings; pass cik to ncen_service_providers. One series (fund) has several share classes/tickers that share the same portfolio."
      : "No match. company_tickers_mf.json covers open-end funds/ETFs with tickers; UIT ETFs such as SPY are company tickers (use nport_holdings with ticker directly). Try a shorter name fragment.",
  };
}

// ---------------------------------------------------------------------------
// Filing discovery
// ---------------------------------------------------------------------------
interface FilingRef {
  accession: string;
  filingDate: string | null;
  reportDate?: string | null;
  cik: string;
}

async function latestNportForSeries(seriesId: string, cikHint: string): Promise<FilingRef[]> {
  return cached(`nport-series:${seriesId}`, H6, async () => {
    const atom = await textFetch(
      `${SEC}/cgi-bin/browse-edgar?action=getcompany&CIK=${seriesId}&type=NPORT-P&dateb=&owner=include&count=10&output=atom`,
      20000
    );
    const out: FilingRef[] = [];
    const cikM = atom.match(/<cik>(\d+)<\/cik>/);
    const cik = cikHint || (cikM ? padCik(cikM[1]) : "");
    const re = /<entry>([\s\S]*?)<\/entry>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(atom))) {
      const e = m[1];
      const type = e.match(/<filing-type>([^<]+)/)?.[1] ?? e.match(/term="([^"]+)"/)?.[1];
      if (type && type !== "NPORT-P") continue; // skip NPORT-P/A unless nothing else
      const acc = e.match(/<accession-number>([^<]+)/)?.[1];
      if (acc) out.push({ accession: acc, filingDate: e.match(/<filing-date>([^<]+)/)?.[1] ?? null, cik });
    }
    return out;
  });
}

async function nportFilingsForCik(cik: string): Promise<FilingRef[]> {
  const sub = await jsonFetch<any>(`https://data.sec.gov/submissions/CIK${padCik(cik)}.json`);
  const r = sub?.filings?.recent ?? {};
  const out: FilingRef[] = [];
  const forms: string[] = r.form ?? [];
  for (let i = 0; i < forms.length; i++) {
    if (forms[i] !== "NPORT-P") continue;
    out.push({ accession: r.accessionNumber[i], filingDate: r.filingDate?.[i] ?? null, reportDate: r.reportDate?.[i] ?? null, cik: padCik(cik) });
  }
  return out;
}

async function fetchNport(f: FilingRef): Promise<any> {
  return cached(`nport-doc:${f.accession}`, H6, async () => {
    const xml = await textFetch(archiveUrl(f.cik, f.accession, "primary_doc.xml"), 45000);
    return xmlParser.parse(xml)?.edgarSubmission ?? null;
  });
}

// ---------------------------------------------------------------------------
// nport_holdings
// ---------------------------------------------------------------------------
export interface NportHoldingsArgs {
  ticker?: string;
  seriesId?: string;
  cik?: string | number;
  seriesName?: string;
  limit?: number;
  assetCategory?: string;
  accession?: string;
}

function parseHolding(h: any) {
  const ids = h.identifiers ?? {};
  const isin = ids.isin?.["@_value"] ?? null;
  const ticker = ids.ticker?.["@_value"] ?? null;
  const other = asArray(ids.other).map((o: any) => o?.["@_value"]).filter(Boolean);
  const assetCat = txt(h.assetCat) ?? (h.assetConditional?.["@_assetCat"] ?? null);
  const issuerCat = txt(h.issuerCat) ?? (h.issuerConditional?.["@_issuerCat"] ?? null);
  const pct = num(h.pctVal);
  const debt = h.debtSec
    ? { maturity: txt(h.debtSec.maturityDt), coupon: num(h.debtSec.annualizedRt), couponKind: txt(h.debtSec.couponKind), inDefault: txt(h.debtSec.isDefault) === "Y" || undefined }
    : undefined;
  const cusip = txt(h.cusip);
  const lei = txt(h.lei);
  const cur = txt(h.curCd) ?? h.currencyConditional?.["@_curCd"] ?? null;
  return {
    name: txt(h.name) ?? txt(h.title),
    cusip: cusip && cusip !== "N/A" && !/^0+$/.test(cusip) ? cusip : null,
    isin,
    ...(ticker ? { ticker } : {}),
    ...(other.length && !isin ? { otherId: other[0] } : {}),
    balance: num(h.balance),
    units: txt(h.units), // NS = shares, PA = principal amount, NC = contracts, OU = other
    ...(cur && cur !== "USD" ? { currency: cur } : {}),
    valueUSD: num(h.valUSD),
    pctVal: pct == null ? null : Math.round(pct * 10000) / 10000, // percent of NET assets (7.51 = 7.51%)
    ...(txt(h.payoffProfile) === "Short" ? { payoff: "Short" } : {}),
    assetCat,
    issuerCat,
    country: txt(h.invCountry),
    ...(debt ? { debt } : {}),
  };
}

export async function nportHoldings(args: NportHoldingsArgs) {
  const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 200);
  const resolved = await resolveFund(args ?? {});
  if (!resolved) {
    return {
      dataSource: DS,
      error: "Could not resolve the fund. Provide ticker (e.g. VFIAX, SPY), seriesId (S000xxxxxx), or cik (+ optional seriesName). Try nport_fund_search first.",
    };
  }

  // Candidate filings, newest first.
  let filings: FilingRef[] = [];
  if (args.accession) {
    filings = [{ accession: args.accession, filingDate: null, cik: resolved.cik }];
  } else if (resolved.seriesId) {
    filings = await latestNportForSeries(resolved.seriesId, resolved.cik);
  } else if (resolved.cik) {
    filings = await nportFilingsForCik(resolved.cik);
    if (filings.length) {
      // Multi-series registrant with no series filter: same-date filings belong to different funds.
      const latestDate = filings[0].filingDate;
      const sameDay = filings.filter((f) => f.filingDate === latestDate).length;
      if (sameDay > 1) {
        let series: Array<{ seriesId: string; seriesName: string; tickers: string[] }> = [];
        try {
          const { rows } = await seriesClassTable();
          const m = new Map<string, { seriesId: string; seriesName: string; tickers: string[] }>();
          for (const r of rows) {
            if (r.cik !== resolved.cik || !r.seriesId) continue;
            const e = m.get(r.seriesId) ?? { seriesId: r.seriesId, seriesName: r.seriesName, tickers: [] };
            if (r.ticker) e.tickers.push(r.ticker);
            m.set(r.seriesId, e);
          }
          series = [...m.values()].slice(0, 40);
        } catch { /* names optional */ }
        return {
          dataSource: DS,
          registrantCik: resolved.cik,
          error: `This registrant filed ${sameDay} NPORT-P reports on ${latestDate} (one per series/fund). Specify seriesId, seriesName, or a ticker.`,
          series,
        };
      }
    }
  }
  if (!filings.length) {
    return { dataSource: DS, resolved, error: "No NPORT-P filings found for this fund/registrant (money market funds file N-MFP instead; closed-end interval funds and BDCs may not file N-PORT)." };
  }

  const filing = filings[0];
  const doc = await fetchNport(filing);
  const form = doc?.formData;
  if (!form) {
    return { dataSource: DS, resolved, filing, error: "NPORT-P primary_doc.xml parsed to nothing", sampleRaw: doc ? JSON.stringify(doc).slice(0, 600) : null };
  }
  const gen = form.genInfo ?? {};
  const fi = form.fundInfo ?? {};
  const all = asArray(form.invstOrSecs?.invstOrSec).map(parseHolding);
  const wantCat = args.assetCategory?.trim().toUpperCase();
  const filtered = wantCat ? all.filter((h) => (h.assetCat ?? "").toUpperCase() === wantCat) : all;
  filtered.sort((a, b) => Math.abs(b.pctVal ?? 0) - Math.abs(a.pctVal ?? 0));
  const top = filtered.slice(0, limit);

  // Composition summary by asset category (pct of net assets).
  const byCat = new Map<string, { pct: number; n: number }>();
  for (const h of all) {
    const k = h.assetCat ? ASSET_CAT[h.assetCat] ?? h.assetCat : "Unspecified";
    const e = byCat.get(k) ?? { pct: 0, n: 0 };
    e.pct += h.pctVal ?? 0; e.n++;
    byCat.set(k, e);
  }
  const composition = [...byCat.entries()]
    .map(([assetCategory, v]) => ({ assetCategory, pctOfNetAssets: Math.round(v.pct * 100) / 100, holdings: v.n }))
    .sort((a, b) => b.pctOfNetAssets - a.pctOfNetAssets)
    .slice(0, 8);

  const classReturns = asArray(fi.returnInfo?.monthlyTotReturns?.monthlyTotReturn).map((r: any) => ({
    classId: r["@_classId"] ?? null,
    rtn1: num(r["@_rtn1"]), rtn2: num(r["@_rtn2"]), rtn3: num(r["@_rtn3"]),
  }));
  const myReturn = resolved.classId ? classReturns.find((r) => r.classId === resolved.classId) : classReturns[0];

  const top10Pct = filtered.slice(0, 10).reduce((s, h) => s + (h.pctVal ?? 0), 0);
  return {
    dataSource: DS,
    fund: {
      registrant: txt(gen.regName),
      registrantCik: txt(gen.regCik) ?? resolved.cik,
      seriesName: txt(gen.seriesName),
      seriesId: txt(gen.seriesId) ?? resolved.seriesId,
      seriesLei: txt(gen.seriesLei),
      ticker: resolved.ticker,
      classId: resolved.classId,
    },
    filing: {
      accession: filing.accession,
      filingDate: filing.filingDate,
      reportPeriodEnd: txt(gen.repPdDate),
      fiscalYearEnd: txt(gen.repPdEnd),
      url: archiveUrl(filing.cik, filing.accession, "primary_doc.xml"),
      indexUrl: archiveUrl(filing.cik, filing.accession),
    },
    totals: {
      totalAssetsUSD: num(fi.totAssets),
      totalLiabilitiesUSD: num(fi.totLiabs),
      netAssetsUSD: num(fi.netAssets),
      holdingsCount: all.length,
      top10PctOfNetAssets: Math.round(top10Pct * 100) / 100,
    },
    ...(myReturn ? { monthlyTotalReturnsPct: { ...myReturn, note: "rtn1..rtn3 = the three months of the reported quarter, %" } } : {}),
    composition,
    holdings: top,
    returned: top.length,
    ...(wantCat ? { assetCategoryFilter: wantCat, matchingHoldings: filtered.length } : {}),
    note:
      "pctVal is % of NET assets (already in percent: 7.1 = 7.1%). units: NS=shares, PA=principal, NC=contracts. assetCat: EC equity, EP preferred, DBT debt, STIV cash/MMF vehicle, RA repo, ABS-MBS mortgage, LON loan, DE/DIR/DFE/DCR derivatives. issuerCat: CORP, UST, USGA, USGSE, MUN, NUSS (non-US sovereign), RF (registered fund), PF (private fund). Public NPORT-P = quarter-end month only, released ~60 days after period end, so holdings are as of reportPeriodEnd, not today. Derivatives can carry negative values. " +
      (resolved.candidates ? `seriesName matched ${resolved.candidates.length} series; used the closest — see candidates. ` : "") +
      "Use limit (max 200) and assetCategory (EC, DBT, STIV, RA, ABS-MBS, DE, DIR, LON, ...) to widen/filter.",
    ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
  };
}
