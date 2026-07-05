/**
 * Daily Treasury Statement (DTS) — the U.S. government's daily cash ledger
 * (FiscalData API, live, no key, no ingest). Published each business day
 * for the prior business day, this is the freshest free fiscal/liquidity
 * tape available:
 *
 *   treasury_daily_cash  — the Treasury General Account (TGA) closing
 *     balance, daily. The DAILY counterpart of the weekly WTREGEN series
 *     used in macro_market_signals' net-liquidity calc: TGA drawdowns
 *     inject liquidity into the banking system, rebuilds drain it.
 *
 *   treasury_daily_flows — deposits and withdrawals of operating cash by
 *     category. The headline signal is 'Taxes - Withheld Individual/FICA'
 *     deposits, which track wage payrolls with ~1-day lag — the classic
 *     near-real-time labor-market read. FYTD comparisons are the cleanest
 *     use (payment-calendar effects make day/week deltas noisy).
 *
 * SCHEMA QUIRKS (live-verified 2026-07-05):
 *   • operating_cash_balance publishes TWO account_type rows per date —
 *     'Treasury General Account (TGA) Opening Balance' and '... Closing
 *     Balance' — with the value in open_today_bal on both (there is no
 *     close_today_bal column in the current schema). Per-date selection
 *     prefers the Closing row; balanceBasis reports which row served it.
 *   • deposits_withdrawals rows carry the literal string 'null' as
 *     transaction_catg on Treasury's own sub-total lines — these are
 *     treated as total rows (excluded from category sums and top lists,
 *     reported separately) to avoid double counting.
 *
 * UNIT SAFETY (net-liquidity lesson applied): DTS figures are stated by
 * Treasury in MILLIONS of USD. The cash tool carries a plausibility gate
 * (TGA outside $30B–$2.5T flags a warning instead of silently reporting
 * nonsense), and both tools surface sampleRawRow when parsing yields
 * nothing so schema drift is visible, not silent.
 */
import { jsonFetch } from "../data/http";

const BASE = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service";

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function daysBeforeIso(fromIso: string, days: number): string {
  const d = new Date(fromIso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function num(v: any): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === "null") return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function dtsFetch(path: string, params: Record<string, string>): Promise<any[]> {
  const qs = new URLSearchParams(params).toString();
  const raw = await jsonFetch<any>(`${BASE}${path}?${qs}`);
  return Array.isArray(raw?.data) ? raw.data : [];
}

const DTS_UNITS_NOTE =
  "Daily Treasury Statement figures are stated by Treasury in MILLIONS of USD. Published each business day for the prior business day (no weekend/holiday rows).";

/* ──────────────────── daily TGA cash balance ──────────────────── */

export interface TreasuryDailyCashArgs {
  lookbackDays?: number;
}

interface CashPoint {
  date: string;
  accountType: string | null;
  closeTodayMillions: number | null;
  openTodayMillions: number | null;
  openMonthMillions: number | null;
}

function balanceOf(p: CashPoint | null): number | null {
  if (!p) return null;
  return p.closeTodayMillions ?? p.openTodayMillions ?? null;
}

function pointAtOrBefore(points: CashPoint[], targetDate: string): CashPoint | null {
  for (const p of points) {
    if (p.date <= targetDate) return p;
  }
  return null;
}

export async function treasuryDailyCash(args: TreasuryDailyCashArgs = {}) {
  const lookback = Math.min(Math.max(args.lookbackDays ?? 30, 5), 400);
  const start = isoDaysAgo(lookback + 6); // pad for publication lag + weekends

  const rows = await dtsFetch("/v1/accounting/dts/operating_cash_balance", {
    filter: `record_date:gte:${start}`,
    sort: "-record_date",
    "page[size]": "600",
  });

  const accountTypesPresent = [...new Set(rows.map((r) => r?.account_type).filter(Boolean))] as string[];
  const isTga = (t: any) => /general account|federal reserve/i.test(String(t ?? ""));

  let scoped = rows.filter((r) => isTga(r?.account_type));
  let scopeNote = "Treasury General Account rows; Closing Balance row preferred per date";
  if (!scoped.length) {
    scoped = rows;
    scopeNote = `no TGA-labeled account_type found — returning all rows (types present: ${accountTypesPresent.join("; ") || "none"})`;
  }

  const mapped: CashPoint[] = scoped
    .map((r) => ({
      date: r?.record_date ?? null,
      accountType: r?.account_type ?? null,
      closeTodayMillions: num(r?.close_today_bal),
      openTodayMillions: num(r?.open_today_bal),
      openMonthMillions: num(r?.open_month_bal),
    }))
    .filter((x): x is CashPoint => Boolean(x.date));

  // One row per date. The current schema carries TWO TGA rows per date
  // (Opening Balance / Closing Balance, value in open_today_bal on both) —
  // prefer the Closing row so the headline is the end-of-day balance.
  const isClosing = (t: string | null) => /closing/i.test(String(t ?? ""));
  const byDateMap = new Map<string, CashPoint>();
  for (const m of mapped) {
    const existing = byDateMap.get(m.date);
    if (!existing || (isClosing(m.accountType) && !isClosing(existing.accountType))) {
      byDateMap.set(m.date, m);
    }
  }
  const series = [...byDateMap.values()].sort((a, b) => (a.date < b.date ? 1 : -1));

  const latest = series[0] ?? null;
  const latestBal = balanceOf(latest);
  const parsedNothing = series.length > 0 && series.every((p) => balanceOf(p) == null);

  let changeWeekMillions: number | null = null;
  let changeMonthMillions: number | null = null;
  if (latest && latestBal != null) {
    const w = balanceOf(pointAtOrBefore(series, daysBeforeIso(latest.date, 7)));
    const m = balanceOf(pointAtOrBefore(series, daysBeforeIso(latest.date, 30)));
    changeWeekMillions = w != null ? +(latestBal - w).toFixed(0) : null;
    changeMonthMillions = m != null ? +(latestBal - m).toFixed(0) : null;
  }

  // Plausibility gate (the WTREGEN unit lesson): TGA lives ~$30B–$2.5T.
  const plausible = latestBal == null || (latestBal > 30000 && latestBal < 2500000);

  const toB = (x: number | null) => (x == null ? null : +(x / 1000).toFixed(1));

  return {
    dataSource: "Daily Treasury Statement — Operating Cash Balance (api.fiscaldata.treasury.gov, live)",
    latestDate: latest?.date ?? null,
    latestClosingBalanceUsdBillions: toB(latestBal),
    balanceBasis: latest?.accountType ?? null,
    changeVs1WeekUsdBillions: toB(changeWeekMillions),
    changeVs1MonthUsdBillions: toB(changeMonthMillions),
    observationCount: series.length,
    observations: series.slice(0, Math.min(lookback, 60)),
    accountTypesPresent,
    scope: scopeNote,
    ...(parsedNothing && rows.length ? { sampleRawRow: rows[0] } : {}),
    ...(plausible ? {} : { plausibilityWarning: "Latest TGA balance is outside the sane $30B–$2.5T band — inspect sampleRawRow/field units before trusting this figure." }),
    note:
      DTS_UNITS_NOTE +
      " This is the DAILY counterpart of the weekly WTREGEN series in macro_market_signals' net-liquidity calc: TGA drawdowns inject liquidity into the banking system; rebuilds (tax season, post-debt-ceiling refills) drain it. balanceBasis reports which account_type row served the headline (Closing Balance preferred; if it reads Opening Balance, Treasury changed the row layout). observations values are in $ millions; headline conversions are in $ billions. For ~1-month changes use lookbackDays >= 40 so the window reaches the comparison point.",
  };
}

/* ────────────────── daily deposits & withdrawals ────────────────── */

export interface TreasuryDailyFlowsArgs {
  lookbackDays?: number;
  focusCategory?: string;
  transactionType?: "deposits" | "withdrawals";
  topN?: number;
}

interface FlowRow {
  date: string;
  accountType: string | null;
  type: string | null;
  category: string;
  todayMillions: number | null;
  mtdMillions: number | null;
  fytdMillions: number | null;
}

export async function treasuryDailyFlows(args: TreasuryDailyFlowsArgs = {}) {
  const lookback = Math.min(Math.max(args.lookbackDays ?? 30, 5), 120);
  const start = isoDaysAgo(lookback + 6);
  const topN = Math.min(Math.max(args.topN ?? 8, 3), 25);

  const rows = await dtsFetch("/v1/accounting/dts/deposits_withdrawals_operating_cash", {
    filter: `record_date:gte:${start}`,
    sort: "-record_date",
    "page[size]": "10000",
  });

  let mapped: FlowRow[] = rows
    .map((r) => ({
      date: r?.record_date ?? null,
      accountType: r?.account_type ?? null,
      type: r?.transaction_type ?? null,
      category: (r?.transaction_catg ?? r?.transaction_catg_desc ?? "") as string,
      todayMillions: num(r?.transaction_today_amt),
      mtdMillions: num(r?.transaction_mtd_amt),
      fytdMillions: num(r?.transaction_fytd_amt),
    }))
    .filter((x): x is FlowRow => Boolean(x.date && x.category));

  const parsedNothing = mapped.length > 0 && mapped.every((m) => m.todayMillions == null && m.mtdMillions == null);

  if (args.transactionType) {
    const want = args.transactionType.toLowerCase().startsWith("dep") ? "dep" : "with";
    mapped = mapped.filter((m) => String(m.type ?? "").toLowerCase().startsWith(want));
  }

  // Treasury's own sub-total lines: 'Total…' categories AND rows whose
  // transaction_catg is the literal string 'null' (live-verified) — both
  // excluded from category sums/top lists to avoid double counting.
  const isTotalRow = (c: string) => /total/i.test(c) || c.trim().toLowerCase() === "null";
  const isDeposit = (t: string | null) => String(t ?? "").toLowerCase().startsWith("dep");
  const isWithdrawal = (t: string | null) => String(t ?? "").toLowerCase().startsWith("with");

  const latestDate = mapped[0]?.date ?? null;
  const latestRows = latestDate ? mapped.filter((m) => m.date === latestDate) : [];

  const sideView = (side: (t: string | null) => boolean) => {
    const sideRows = latestRows.filter((m) => side(m.type));
    const catRows = sideRows.filter((m) => !isTotalRow(m.category));
    const totalRows = sideRows.filter((m) => isTotalRow(m.category));
    const sum = catRows.reduce((acc, m) => acc + (m.todayMillions ?? 0), 0);
    const top = [...catRows]
      .sort((a, b) => (b.todayMillions ?? 0) - (a.todayMillions ?? 0))
      .slice(0, topN)
      .map((m) => ({ category: m.category, todayMillions: m.todayMillions, mtdMillions: m.mtdMillions, fytdMillions: m.fytdMillions }));
    return {
      sumExTotalsTodayMillions: +sum.toFixed(0),
      topCategoriesToday: top,
      reportedTotalRows: totalRows.map((m) => ({ category: m.category, transactionType: m.type, todayMillions: m.todayMillions })),
    };
  };

  const deposits = sideView(isDeposit);
  const withdrawals = sideView(isWithdrawal);
  const netFlowTodayMillions = +(deposits.sumExTotalsTodayMillions - withdrawals.sumExTotalsTodayMillions).toFixed(0);

  // Focus category — default: withheld individual/FICA taxes, the
  // near-real-time payroll signal.
  const focusTerm = (args.focusCategory ?? "withheld").toLowerCase();
  const focusRows = mapped.filter((m) => !isTotalRow(m.category) && m.category.toLowerCase().includes(focusTerm));
  const matchedCategories = [...new Set(focusRows.map((m) => m.category))];
  const byDate = new Map<string, number>();
  for (const m of focusRows) {
    byDate.set(m.date, (byDate.get(m.date) ?? 0) + (m.todayMillions ?? 0));
  }
  const focusSeries = [...byDate.entries()]
    .map(([date, todayMillions]) => ({ date, todayMillions: +todayMillions.toFixed(0) }))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 25);
  const focusLatestRow = focusRows.find((m) => m.date === focusSeries[0]?.date) ?? null;
  const focus = {
    term: args.focusCategory ?? "withheld",
    matchedCategories,
    latestDate: focusSeries[0]?.date ?? null,
    latestTodayMillions: focusSeries[0]?.todayMillions ?? null,
    ...(matchedCategories.length === 1 && focusLatestRow
      ? { latestMtdMillions: focusLatestRow.mtdMillions, latestFytdMillions: focusLatestRow.fytdMillions }
      : {}),
    dailySeries: focusSeries,
    ...(matchedCategories.length > 1
      ? { multiCategoryNote: "Multiple categories matched — dailySeries sums their 'today' amounts; MTD/FYTD omitted to avoid mixing categories." }
      : {}),
  };

  return {
    dataSource: "Daily Treasury Statement — Deposits and Withdrawals of Operating Cash (api.fiscaldata.treasury.gov, live)",
    latestDate,
    deposits,
    withdrawals,
    netFlowTodayMillions,
    focusCategory: focus,
    distinctCategoriesInWindow: [...new Set(mapped.map((m) => m.category))].length,
    rowsInWindow: mapped.length,
    ...(parsedNothing && rows.length ? { sampleRawRow: rows[0] } : {}),
    note:
      DTS_UNITS_NOTE +
      " Side sums exclude Treasury's own sub-total lines — 'Total…' categories and rows whose category is the literal string 'null' — to avoid double counting (those are reported separately under reportedTotalRows). Note that Public Debt Cash Issues/Redemptions appear as ordinary categories, so netFlow includes financing flows, not just fiscal ones. The default focus — withheld individual/FICA tax deposits — tracks wage payrolls with ~1-day lag; FYTD comparisons against the same point last fiscal year are the cleanest signal, since payment-calendar effects make day/week deltas noisy. Category matching is case-insensitive contains — try focusCategory 'corporate' for corporate income taxes or 'interest' for debt service.",
  };
}
