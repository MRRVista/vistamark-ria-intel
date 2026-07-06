/**
 * Morning market brief — the pre-market composite. One call assembles the
 * whole early-warning stack:
 *
 *   • macro_market_signals (22 indicators, six pillars, net liquidity)
 *   • treasury_daily_cash   (daily TGA — the daily liquidity read)
 *   • treasury_daily_flows  (withheld-tax payroll signal + fiscal tape)
 *   • fred_yield_curve      (full curve + inversion flags)
 *   • ofr_financial_stress_index (daily systemic gauge)
 *
 * Output: headline bullets, trimmed per-source sections, and briefMarkdown —
 * a compact markdown note ready to drop into Randall's pre-market brief
 * prompt. Every section is independently try/caught: one upstream hiccup
 * degrades that section to an error string instead of killing the brief.
 *
 * Also served unauthenticated at GET /api/market-brief for cron
 * consumption — aggregated public macro data only (FRED/Treasury/OFR), no
 * client or prospecting data. Same exposure posture as /api/selftest; gate
 * or remove alongside it if desired.
 *
 * Indicators with documented historical relationships — not predictions,
 * not investment advice.
 */
import { macroMarketSignals } from "../macro/signals";
import { treasuryDailyCash, treasuryDailyFlows } from "../treasury/dts";
import { fredYieldCurve } from "../fred/tools";
import { ofrFinancialStressIndex } from "../ofr/tools";

const safe = (p: Promise<any>): Promise<any> =>
  p.catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));

const NO_SIGNALS_SENTINEL = "No threshold signals currently firing";

function fmtB(millions: number | null | undefined): string | null {
  if (millions == null || !Number.isFinite(millions)) return null;
  return `$${Math.round(millions / 1000).toLocaleString("en-US")}B`;
}

function signed(x: number | null | undefined, unit = ""): string {
  if (x == null || !Number.isFinite(x)) return "n/a";
  return `${x >= 0 ? "+" : "−"}${Math.abs(x)}${unit}`;
}

export interface MorningMarketBriefArgs {}

export async function morningMarketBrief(_args: MorningMarketBriefArgs = {}) {
  const [signals, cash, flows, curve, fsi] = await Promise.all([
    safe(macroMarketSignals()),
    safe(treasuryDailyCash({ lookbackDays: 45 })), // >=40 so the ~1-month change populates
    safe(treasuryDailyFlows({ lookbackDays: 30 })),
    safe(fredYieldCurve({})),
    safe(ofrFinancialStressIndex({ lookback: 10 })),
  ]);

  /* ── headline bullets ── */
  const headline: string[] = [];

  if (Array.isArray(signals?.highlights) && signals.highlights.length) {
    const firing = signals.highlights.filter((h: string) => !h.startsWith(NO_SIGNALS_SENTINEL));
    if (firing.length) headline.push(...firing);
    else headline.push("No macro threshold signals firing (curve, credit, growth, inflation, sentiment all inside normal bands).");
  } else if (signals?.error) {
    headline.push(`Macro signals unavailable: ${signals.error}`);
  }

  const nl = signals?.netLiquidity;
  if (nl?.latestUsdTrillions != null && !nl.plausibilityWarning) {
    headline.push(
      `Net liquidity $${nl.latestUsdTrillions}T (3m change ${signed(nl.change3mUsdTrillions, "T")}).`
    );
  }

  if (cash?.latestClosingBalanceUsdBillions != null && !cash.plausibilityWarning) {
    headline.push(
      `TGA close $${cash.latestClosingBalanceUsdBillions}B on ${cash.latestDate} (1w ${signed(cash.changeVs1WeekUsdBillions, "B")}, 1m ${signed(cash.changeVs1MonthUsdBillions, "B")}) — drawdowns inject liquidity, rebuilds drain it.`
    );
  } else if (cash?.error) {
    headline.push(`Daily TGA unavailable: ${cash.error}`);
  }

  const focus = flows?.focusCategory;
  if (focus?.latestTodayMillions != null) {
    const fytd = fmtB(focus.latestMtdMillions != null ? focus.latestFytdMillions : null);
    headline.push(
      `Withheld Ind/FICA taxes (payroll proxy): ${fmtB(focus.latestTodayMillions) ?? "n/a"} day / ${fmtB(focus.latestMtdMillions) ?? "n/a"} MTD${fytd ? ` / ${fytd} FYTD` : ""} as of ${focus.latestDate}.`
    );
  } else if (flows?.error) {
    headline.push(`Daily fiscal flows unavailable: ${flows.error}`);
  }

  if (curve?.spreads) {
    const s3m = curve.spreads["10Y-3M"];
    const s2y = curve.spreads["10Y-2Y"];
    headline.push(
      `Curve: 10Y–3M ${signed(s3m)} / 10Y–2Y ${signed(s2y)}${curve.inverted3m10y || curve.inverted2y10y ? " — INVERTED" : " — positively sloped"}.`
    );
  } else if (curve?.error) {
    headline.push(`Yield curve unavailable: ${curve.error}`);
  }

  if (fsi?.latest?.headline != null) {
    headline.push(
      `OFR Financial Stress Index ${fsi.latest.headline} on ${fsi.latest.date} (${fsi.latest.headline > 0 ? "ABOVE" : "below"}-average stress).`
    );
  } else if (fsi?.error) {
    headline.push(`OFR FSI unavailable: ${fsi.error}`);
  }

  /* ── trimmed sections ── */
  const cashLite = cash?.error
    ? cash
    : {
        latestDate: cash?.latestDate ?? null,
        latestClosingBalanceUsdBillions: cash?.latestClosingBalanceUsdBillions ?? null,
        balanceBasis: cash?.balanceBasis ?? null,
        changeVs1WeekUsdBillions: cash?.changeVs1WeekUsdBillions ?? null,
        changeVs1MonthUsdBillions: cash?.changeVs1MonthUsdBillions ?? null,
        recentObservations: Array.isArray(cash?.observations) ? cash.observations.slice(0, 10) : [],
        ...(cash?.plausibilityWarning ? { plausibilityWarning: cash.plausibilityWarning } : {}),
      };

  const flowsLite = flows?.error
    ? flows
    : {
        latestDate: flows?.latestDate ?? null,
        netFlowTodayMillions: flows?.netFlowTodayMillions ?? null,
        focusCategory: flows?.focusCategory ?? null,
        topDepositsToday: flows?.deposits?.topCategoriesToday?.slice(0, 3) ?? [],
        topWithdrawalsToday: flows?.withdrawals?.topCategoriesToday?.slice(0, 3) ?? [],
      };

  const fsiLite = fsi?.error
    ? fsi
    : {
        latest: fsi?.latest ?? null,
      };

  /* ── markdown ── */
  const today = new Date().toISOString().slice(0, 10);
  const md: string[] = [];
  md.push(`# Pre-Market Intel Brief — ${today}`);
  md.push("");
  md.push("_Source: vistamark-ria-intel (FRED, Treasury DTS, OFR — live public data). Indicators with documented historical relationships — not predictions or advice._");
  md.push("");
  md.push("## Headline");
  for (const h of headline) md.push(`- ${h}`);
  if (Array.isArray(curve?.curve) && curve.curve.length) {
    md.push("");
    md.push(`## Yield curve (${curve.asOfDate ?? "latest"})`);
    md.push(
      curve.curve
        .filter((p: any) => p?.yield != null)
        .map((p: any) => `${p.maturity} ${p.yield}`)
        .join(" | ")
    );
  }
  if (!flows?.error && flowsLite?.topDepositsToday?.length) {
    md.push("");
    md.push(`## Fiscal tape (DTS ${flowsLite.latestDate ?? ""})`);
    md.push(`Net flow today: ${fmtB(flowsLite.netFlowTodayMillions) ?? "n/a"} (includes debt issuance/redemption financing flows)`);
    md.push(`Top deposits: ${flowsLite.topDepositsToday.map((c: any) => `${c.category} ${fmtB(c.todayMillions) ?? "?"}`).join("; ")}`);
    if (flowsLite.topWithdrawalsToday?.length) {
      md.push(`Top withdrawals: ${flowsLite.topWithdrawalsToday.map((c: any) => `${c.category} ${fmtB(c.todayMillions) ?? "?"}`).join("; ")}`);
    }
  }
  if (!signals?.error && signals?.pillars) {
    md.push("");
    md.push("## Signal board");
    md.push("Full 22-indicator board in sections.macroSignals (curve / credit / liquidity / growth / inflation / sentiment).");
  }
  const briefMarkdown = md.join("\n");

  return {
    dataSource: "vistamark-ria-intel morning composite — FRED + Treasury DTS + OFR, all live",
    generatedAt: new Date().toISOString(),
    headline,
    sections: {
      macroSignals: signals,
      tgaDailyCash: cashLite,
      dailyFlows: flowsLite,
      yieldCurve: curve,
      ofrFsi: fsiLite,
    },
    briefMarkdown,
    note:
      "Composite of macro_market_signals + treasury_daily_cash + treasury_daily_flows + fred_yield_curve + ofr_financial_stress_index. Each section is independently error-isolated — an upstream failure degrades that section, not the brief. briefMarkdown is sized for direct insertion into a morning-brief prompt. Indicators, not predictions.",
  };
}
