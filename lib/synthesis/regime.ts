/**
 * market_regime_brief — eight sources, one regime call, three client
 * sentences and one prospect sentence.
 *
 * Fan-out (parallel): morning_market_brief (22 FRED indicators + TGA + flows +
 * curve + OFR FSI) · NY Fed recession probability · Atlanta Fed GDPNow ·
 * Shiller CAPE · Cboe vol term structure · Damodaran implied ERP · ACM term
 * premia · Philly Fed SPF. Pillar reads are rule-based and documented; the
 * regime label needs ≥3 pillars agreeing or it says "mixed" — indicators, not
 * predictions, and never a probability the tools did not report.
 */
import { fanOut, type SourceResult, num, coverage } from "./core";

type Lean = "risk-on" | "risk-off" | "neutral";

interface PillarRead {
  pillar: string;
  lean: Lean;
  read: string;
  evidence: string[];
  source: string;
}

function sentence(parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export async function marketRegimeBrief(args: { includeSpf?: boolean; includeTermPremia?: boolean } = {}) {
  const w = await fanOut([
    { tool: "morning_market_brief", args: {}, timeoutMs: 18000 },
    { tool: "nyfed_recession_probability", args: { recent: 3 }, timeoutMs: 12000 },
    { tool: "atlfed_gdpnow", args: { recent: 3, includeComponents: false }, timeoutMs: 15000 },
    { tool: "shiller_cape", args: { months: 3 }, timeoutMs: 15000 },
    { tool: "cboe_vol_history", args: { days: 5 }, timeoutMs: 12000 },
    { tool: "damodaran_erp", args: { years: 3, months: 3 }, timeoutMs: 15000 },
    args.includeTermPremia === false ? { tool: "nyfed_term_premia", args: {}, skip: "includeTermPremia=false" } : { tool: "nyfed_term_premia", args: { frequency: "daily", recent: 3, maturities: [2, 10] }, timeoutMs: 15000 },
    args.includeSpf === false ? { tool: "philfed_spf", args: {}, skip: "includeSpf=false" } : { tool: "philfed_spf", args: { variables: ["RGDP", "UNEMP", "CPI", "TBOND"], compareToPrevious: true }, timeoutMs: 15000 },
  ]);
  const [brief, rec, gdp, cape, vol, erp, tp, spf] = w;
  const sources: SourceResult[] = w.map((r) => r.src);
  const pillars: PillarRead[] = [];

  /* ---------------------------------- curve --------------------------------- */
  const sig = brief.data?.sections?.macroSignals;
  const curve = brief.data?.sections?.yieldCurve;
  const spread10_3 = num(curve?.spreads?.["10Y-3M"]);
  const spread10_2 = num(curve?.spreads?.["10Y-2Y"]);
  const recPct = num(rec.data?.headline?.probabilityPct);
  {
    const ev = [
      spread10_3 !== null ? `10Y-3M ${spread10_3.toFixed(2)}%` : null,
      spread10_2 !== null ? `10Y-2Y ${spread10_2.toFixed(2)}%` : null,
      recPct !== null ? `NY Fed 12-mo recession probability ${recPct}% (for ${rec.data?.headline?.forMonth ?? "?"})` : null,
    ].filter(Boolean) as string[];
    const lean: Lean = (spread10_3 !== null && spread10_3 < 0) || (recPct !== null && recPct >= 30) ? "risk-off" : spread10_3 !== null && spread10_3 > 0.5 ? "risk-on" : "neutral";
    pillars.push({ pillar: "curve", lean, read: lean === "risk-off" ? "Curve inverted and/or model recession odds elevated" : lean === "risk-on" ? "Curve positively sloped, recession odds contained" : "Curve flat-ish; no clear read", evidence: ev, source: "fred_yield_curve · nyfed_recession_probability" });
  }

  /* --------------------------------- credit --------------------------------- */
  const readings = (p: string): any[] => (Array.isArray(sig?.pillars?.[p]) ? sig.pillars[p] : []);
  {
    const credit = readings("credit");
    const hy = credit.find((r) => /high yield|HY/i.test(r.name) && /OAS/i.test(r.name));
    const fsi = num(brief.data?.sections?.ofrFsi?.latest?.value ?? brief.data?.sections?.ofrFsi?.latest);
    const ev = [hy?.latest !== null && hy?.latest !== undefined ? `HY OAS ${hy.latest}% (${hy.signal ?? ""})` : null, fsi !== null ? `OFR FSI ${fsi.toFixed(2)}` : null].filter(Boolean) as string[];
    const lean: Lean = (hy?.latest ?? 0) >= 5 || (fsi ?? 0) > 1.5 ? "risk-off" : (hy?.latest ?? 99) < 3.5 && (fsi ?? 0) < 0 ? "risk-on" : "neutral";
    pillars.push({ pillar: "credit", lean, read: lean === "risk-off" ? "Credit repricing / stress above average" : lean === "risk-on" ? "Spreads tight, stress below average" : "Credit in normal range", evidence: ev, source: "macro_market_signals · ofr_financial_stress_index" });
  }

  /* -------------------------------- liquidity ------------------------------- */
  {
    const nl = sig?.netLiquidity;
    const ch3 = num(nl?.change3mUsdTrillions);
    const ev = [nl?.latestUsdTrillions !== undefined ? `Net liquidity $${nl.latestUsdTrillions}T (${ch3 !== null ? (ch3 >= 0 ? "+" : "") + ch3 + "T / 3m" : "3m n/a"})` : null, brief.data?.sections?.tgaDailyCash?.latestClosingBalanceUsdBillions !== undefined ? `TGA $${brief.data.sections.tgaDailyCash.latestClosingBalanceUsdBillions}B` : null].filter(Boolean) as string[];
    const lean: Lean = ch3 !== null && ch3 <= -0.2 ? "risk-off" : ch3 !== null && ch3 >= 0.2 ? "risk-on" : "neutral";
    pillars.push({ pillar: "liquidity", lean, read: lean === "risk-off" ? "Net liquidity draining" : lean === "risk-on" ? "Net liquidity expanding" : "Net liquidity roughly flat", evidence: ev, source: "macro_market_signals · treasury_daily_cash" });
  }

  /* --------------------------------- growth --------------------------------- */
  {
    const now = num(gdp.data?.latest?.nowcastPct);
    const prev = num(gdp.data?.previous?.nowcastPct);
    const growthReads = readings("growth");
    const sahm = growthReads.find((r) => /sahm/i.test(r.name));
    const claims = growthReads.find((r) => /claims/i.test(r.name));
    const spfRgdp = Array.isArray(spf.data?.forecasts) ? spf.data.forecasts.find((f: any) => f.variable === "RGDP") : null;
    const spfNext = spfRgdp?.horizons?.[1]?.median ?? null;
    const ev = [now !== null ? `GDPNow ${gdp.data?.quarter ?? ""} ${now.toFixed(1)}%${prev !== null ? ` (prev ${prev.toFixed(1)}%)` : ""}` : null, sahm?.signal ? `Sahm: ${sahm.signal}` : null, claims?.signal ? `Claims: ${claims.signal}` : null, spfNext !== null ? `SPF next-qtr RGDP ${spfNext}%` : null].filter(Boolean) as string[];
    const sahmFiring = /trigger|firing|recession/i.test(String(sahm?.signal ?? "")) && !/not|no /i.test(String(sahm?.signal ?? ""));
    const lean: Lean = (now !== null && now < 0.5) || sahmFiring ? "risk-off" : now !== null && now > 2.5 ? "risk-on" : "neutral";
    pillars.push({ pillar: "growth", lean, read: lean === "risk-off" ? "Growth stalling / labor turning" : lean === "risk-on" ? "Growth above trend" : "Growth near trend", evidence: ev, source: "atlfed_gdpnow · macro_market_signals · philfed_spf" });
  }

  /* -------------------------------- valuation ------------------------------- */
  {
    const c = num(cape.data?.latest?.cape);
    const pct = num(cape.data?.history?.percentile);
    const ecy = num(cape.data?.latest?.excessCapeYieldPct);
    const erpM = erp.data?.monthly?.latest;
    const erpV = num(erpM?.impliedErpT12m ?? erpM?.impliedErpSmoothed ?? erp.data?.annual?.latest?.impliedErpFcfe);
    const ev = [c !== null ? `CAPE ${c.toFixed(1)} (${pct !== null ? pct.toFixed(0) + "th pct since " + (cape.data?.history?.since ?? "1881") : "pct n/a"})` : null, ecy !== null ? `Excess CAPE yield ${ecy.toFixed(2)}%` : null, erpV !== null ? `Implied ERP ${(erpV * (erpV < 1 ? 100 : 1)).toFixed(2)}%` : null].filter(Boolean) as string[];
    const lean: Lean = (pct !== null && pct >= 90) || (ecy !== null && ecy < 1) ? "risk-off" : pct !== null && pct <= 50 ? "risk-on" : "neutral";
    pillars.push({ pillar: "valuation", lean, read: lean === "risk-off" ? "Valuations in the top decile; forward returns historically thin" : lean === "risk-on" ? "Valuations at or below median" : "Valuations elevated but not extreme", evidence: ev, source: "shiller_cape · damodaran_erp" });
  }

  /* ------------------------------- volatility ------------------------------- */
  {
    const vix = num(vol.data?.summary?.VIX?.close);
    const vixPct = num(vol.data?.summary?.VIX?.percentile);
    const state = vol.data?.termStructure?.state;
    const skew = num(vol.data?.summary?.SKEW?.close);
    const ev = [vix !== null ? `VIX ${vix.toFixed(1)} (${vixPct !== null ? vixPct.toFixed(0) + "th pct" : ""})` : null, state ? `term structure ${state}` : null, skew !== null ? `SKEW ${skew.toFixed(0)}` : null].filter(Boolean) as string[];
    const lean: Lean = (vix !== null && vix >= 25) || state === "backwardation" ? "risk-off" : vix !== null && vix < 15 ? "risk-on" : "neutral";
    pillars.push({ pillar: "volatility", lean, read: lean === "risk-off" ? "Vol elevated / curve inverted — stress pricing" : lean === "risk-on" ? "Vol suppressed — hedges are cheap" : "Vol in normal range", evidence: ev, source: "cboe_vol_history" });
  }

  /* -------------------------------- rates/TP -------------------------------- */
  {
    const ten = tp.data?.tenYear;
    const tp10 = num(ten?.termPremium ?? tp.data?.latest?.tp10);
    const ch1y = num(ten?.change1y);
    const inflReads = readings("inflation");
    const be10 = inflReads.find((r) => /breakeven|10/i.test(r.name));
    const ev = [tp10 !== null ? `ACM 10y term premium ${tp10.toFixed(2)}%${ch1y !== null ? ` (${ch1y >= 0 ? "+" : ""}${ch1y.toFixed(2)} / 1y)` : ""}${ten?.percentileSince1961 !== undefined ? `, ${ten.percentileSince1961}th pct since 1961` : ""}` : null, be10?.latest !== undefined && be10?.latest !== null ? `10y breakeven ${be10.latest}%` : null].filter(Boolean) as string[];
    const lean: Lean = tp10 !== null && ch1y !== null && ch1y > 0.4 ? "risk-off" : "neutral";
    pillars.push({ pillar: "rates", lean, read: lean === "risk-off" ? "Long end repricing on term premium (supply / fiscal / inflation uncertainty), not just Fed path" : "Long-end move explained mostly by expected policy path", evidence: ev, source: "nyfed_term_premia · macro_market_signals" });
  }

  /* --------------------------------- regime --------------------------------- */
  const counts = { on: pillars.filter((p) => p.lean === "risk-on").length, off: pillars.filter((p) => p.lean === "risk-off").length, neutral: pillars.filter((p) => p.lean === "neutral").length };
  const regime = counts.off >= 3 && counts.off > counts.on ? "defensive" : counts.on >= 3 && counts.on > counts.off ? "constructive" : "mixed / late-cycle, data-dependent";
  const confidence = Math.max(counts.on, counts.off) >= 4 ? "high" : Math.max(counts.on, counts.off) >= 3 ? "moderate" : "low";

  const firing: string[] = Array.isArray(sig?.highlights) ? sig.highlights.filter((h: string) => !/^No threshold/i.test(h)) : [];
  const val = pillars.find((p) => p.pillar === "valuation");
  const capeV = num(cape.data?.latest?.cape);
  const impliedRealReturn = capeV ? Math.round((100 / capeV) * 10) / 10 : null; // 1/CAPE as a crude 10-yr real-return proxy

  const talkingPoints = {
    whatChanged: sentence([
      sig?.error || !sig?.pillars
        ? "The 22-indicator FRED board was unavailable for this read (see coverage) — curve/credit/liquidity pillars are thin."
        : firing.length
        ? `Signals firing: ${firing.slice(0, 3).join("; ")}.`
        : "No threshold signals are firing across the 22-indicator board.",
      recPct !== null ? `The NY Fed curve model puts 12-month recession odds at ${recPct}%.` : null,
    ]),
    whatWeDid: regime === "defensive"
      ? "We are keeping duration moderate, quality high and dry powder ready; rebalancing bands are tightened so the next drawdown funds the next purchase."
      : regime === "constructive"
      ? "We are letting winners run inside rebalancing bands and using cheap volatility to fund protection rather than selling risk."
      : "We are holding targets, rebalancing on bands rather than headlines, and letting the data — not the narrative — move allocations.",
    whatWeAreWatching: sentence([
      pillars.filter((p) => p.lean !== "neutral").slice(0, 3).map((p) => `${p.pillar} (${p.read.toLowerCase()})`).join(", ") || "the curve, credit spreads and the claims trend",
      "— the three that historically turn first.",
    ]),
    prospectHook: capeV
      ? `A CAPE of ${capeV.toFixed(0)} implies roughly ${impliedRealReturn}% real from US large caps over a decade; most plans assume 7% nominal. If your current advisor hasn't shown you that arithmetic, that's the conversation.`
      : "Most plans still assume last decade's returns; the question for any prospect is whether their plan has been re-underwritten for today's starting valuations and rates.",
  };

  return {
    dataSource: "synthesis:market_regime_brief (FRED composite · Treasury DTS · OFR · NY Fed · Atlanta Fed · Philly Fed · Shiller · Cboe · Damodaran)",
    asOf: new Date().toISOString().slice(0, 10),
    regime,
    confidence,
    pillarCounts: counts,
    pillars,
    talkingPoints,
    headline: Array.isArray(brief.data?.headline) ? brief.data.headline.slice(0, 6) : [],
    consensus: Array.isArray(spf.data?.forecasts) ? spf.data.forecasts.filter((f: any) => !f.error).map((f: any) => ({ variable: f.variable, label: f.label, next4: (f.horizons ?? []).slice(0, 5).map((h: any) => ({ period: h.period, median: h.median, prev: h.prevSurvey })) })) : [],
    valuationDetail: val ? { cape: capeV, capePercentile: num(cape.data?.history?.percentile), impliedRealReturnProxyPct: impliedRealReturn, erpLatest: erp.data?.monthly?.latest ?? erp.data?.annual?.latest ?? null } : null,
    briefMarkdown: typeof brief.data?.briefMarkdown === "string" ? brief.data.briefMarkdown.slice(0, 2500) : null,
    guardrails: ["Indicators, not predictions. Never attach a probability the tools did not report. Never time the market in writing.", "1/CAPE is a crude real-return proxy — label it as such in client-facing text."],
    coverage: coverage(sources),
    sources,
    note: "Regime needs ≥3 pillars agreeing; otherwise 'mixed'. Pillar rules are thresholds on documented historical relationships (inversion, HY OAS ≥5%, Sahm trigger, CAPE top decile, VIX ≥25 / backwardation, term-premium +40bp/yr). Each source is error-isolated — check coverage.failed before quoting a pillar that depends on it.",
  };
}
