/**
 * NY Fed Markets Data API (markets.newyorkfed.org/api — public JSON, no key).
 *
 * Verified live 2026-10-21:
 *   /api/rates/all/latest.json                          latest SOFR/EFFR/OBFR/TGCR/BGCR + SOFRAI
 *   /api/rates/{secured|unsecured}/{rate}/last/{n}.json  newest-first
 *   /api/rates/{secured|unsecured}/{rate}/search.json?startDate&endDate
 *   /api/pd/list/timeseries.json                         ~1,540 keyids (seriesbreak SBN2024)
 *   /api/pd/latest/SBN2024.json                          every keyid's latest weekly value
 *   /api/pd/get/{keyid}.json                             full history of one keyid (oldest first)
 *   /api/rp/{reverserepo|repo}/all/results/last/{n}.json
 *   /api/soma/summary.json                               weekly SOMA holdings since 2003 (~320KB)
 */
import { jsonFetch } from "../data/http";
import { HOUR, cached, clampInt, num, round } from "./common";

const BASE = "https://markets.newyorkfed.org/api";

const RATE_PATH: Record<string, string> = {
  sofr: "secured/sofr",
  tgcr: "secured/tgcr",
  bgcr: "secured/bgcr",
  effr: "unsecured/effr",
  obfr: "unsecured/obfr",
};
const ALL_RATES = Object.keys(RATE_PATH);

function compactRate(r: any) {
  return {
    date: r.effectiveDate,
    rate: num(r.percentRate),
    p1: num(r.percentPercentile1),
    p25: num(r.percentPercentile25),
    p75: num(r.percentPercentile75),
    p99: num(r.percentPercentile99),
    volumeBn: num(r.volumeInBillions),
    ...(r.targetRateFrom != null ? { targetLow: num(r.targetRateFrom), targetHigh: num(r.targetRateTo) } : {}),
    ...(r.revisionIndicator ? { revised: r.revisionIndicator } : {}),
  };
}

export async function nyfedReferenceRates(args: { rates?: string[]; recent?: number; startDate?: string; endDate?: string }) {
  const wanted = (args.rates?.length ? args.rates : ALL_RATES).map((r) => String(r).toLowerCase());
  const bad = wanted.filter((r) => !RATE_PATH[r]);
  if (bad.length) throw new Error(`Unknown rate(s): ${bad.join(", ")}. Valid: ${ALL_RATES.join(", ")}`);
  const recent = clampInt(args.recent, 5, 1, 250);
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (args.startDate && !dateRe.test(args.startDate)) throw new Error("startDate must be YYYY-MM-DD");
  if (args.endDate && !dateRe.test(args.endDate)) throw new Error("endDate must be YYYY-MM-DD");

  const [perRate, all] = await Promise.all([
    Promise.all(
      wanted.map(async (r) => {
        const url = args.startDate
          ? `${BASE}/rates/${RATE_PATH[r]}/search.json?startDate=${args.startDate}&endDate=${args.endDate ?? new Date().toISOString().slice(0, 10)}`
          : `${BASE}/rates/${RATE_PATH[r]}/last/${recent}.json`;
        try {
          const j: any = await cached(`nyfed:rate:${url}`, 1 * HOUR, () => jsonFetch(url, { timeoutMs: 15000 }));
          const rows = (j?.refRates ?? []).map(compactRate);
          const capped = rows.slice(0, 250);
          return { rate: r.toUpperCase(), latest: capped[0] ?? null, series: capped, truncated: rows.length > capped.length || undefined, sampleRaw: rows.length ? undefined : j };
        } catch (e: any) {
          return { rate: r.toUpperCase(), error: String(e?.message ?? e) };
        }
      })
    ),
    cached("nyfed:rates:all:latest", 1 * HOUR, () => jsonFetch<any>(`${BASE}/rates/all/latest.json`, { timeoutMs: 15000 })).catch(() => null),
  ]);

  const sofrai = (all?.refRates ?? []).find((r: any) => r.type === "SOFRAI");
  const latest = perRate.map((p: any) => (p.latest ? { rate: p.rate, date: p.latest.date, rate_pct: p.latest.rate, volumeBn: p.latest.volumeBn } : { rate: p.rate, error: p.error }));
  const sofr = perRate.find((p: any) => p.rate === "SOFR" && p.latest)?.latest;
  const effr = perRate.find((p: any) => p.rate === "EFFR" && p.latest)?.latest;
  return {
    dataSource: "Federal Reserve Bank of New York — Markets Data API (reference rates)",
    latest,
    fedFundsTargetRange: effr?.targetLow != null ? `${effr.targetLow.toFixed(2)}–${effr.targetHigh.toFixed(2)}%` : undefined,
    sofrMinusEffrBp: sofr && effr && sofr.date === effr.date ? round((sofr.rate! - effr.rate!) * 100, 1) : undefined,
    sofrAverages: sofrai
      ? { date: sofrai.effectiveDate, avg30d: num(sofrai.average30day), avg90d: num(sofrai.average90day), avg180d: num(sofrai.average180day), sofrIndex: num(sofrai.index) }
      : undefined,
    rates: perRate,
    note: "Rates in percent; percentiles (p1/p25/p75/p99) are the transaction-weighted distribution; volume in $ billions. Series newest-first. Published ~8am ET for the prior business day (SOFR averages/index dated today). SOFR/TGCR/BGCR = secured overnight Treasury repo (SOFR broadest; TGCR tri-party GC; BGCR = TGCR + GCF); EFFR/OBFR = unsecured fed funds / overnight bank funding. SOFR trading above EFFR or a widening p99 tail signals repo/reserve tightness. FRED carries the headline rates only; use this tool for percentiles, volumes and same-day data.",
  };
}

// ---------------------------------------------------------------------------
// Primary dealer statistics
// ---------------------------------------------------------------------------

interface PdSeries { keyid: string; description: string; seriesbreak: string }

async function pdCatalog(): Promise<PdSeries[]> {
  return cached("nyfed:pd:catalog", 24 * HOUR, async () => {
    const j: any = await jsonFetch(`${BASE}/pd/list/timeseries.json`, { timeoutMs: 20000 });
    return (j?.pd?.timeseries ?? []).map((x: any) => ({ keyid: String(x.keyid), description: String(x.description ?? "").replace(/\s+/g, " ").trim(), seriesbreak: String(x.seriesbreak ?? "") }));
  });
}

async function pdLatestAll(seriesbreak: string): Promise<Map<string, { date: string; value: string }>> {
  return cached(`nyfed:pd:latest:${seriesbreak}`, 6 * HOUR, async () => {
    const j: any = await jsonFetch(`${BASE}/pd/latest/${encodeURIComponent(seriesbreak)}.json`, { timeoutMs: 20000 });
    const m = new Map<string, { date: string; value: string }>();
    for (const x of j?.pd?.timeseries ?? []) m.set(String(x.keyid), { date: String(x.asofdate), value: String(x.value) });
    return m;
  });
}

const PD_HEADLINE: Array<{ keyid: string; label: string }> = [
  { keyid: "PDPOSGST-TOT", label: "Net Treasury positions (ex-TIPS), total" },
  { keyid: "PDPOSGS-B", label: "Net Treasury bills position" },
  { keyid: "PDPOSGSC-G7L11", label: "Net Treasury coupons 7–11y" },
  { keyid: "PDPOSGSC-G21", label: "Net Treasury coupons >21y" },
  { keyid: "PDPOSMBS-TOT", label: "Net agency MBS positions" },
  { keyid: "PDPOSCS-TOT", label: "Net corporate securities positions" },
  { keyid: "PDSORA-UTSETTOT", label: "Repo (financing out) — Treasuries ex-TIPS" },
  { keyid: "PDSIRRA-UTSETTOT", label: "Reverse repo (financing in) — Treasuries ex-TIPS" },
];

const pdVal = (v: string) => (v === "*" ? null : num(v));

export async function nyfedPrimaryDealer(args: { query?: string; keyids?: string[]; recent?: number; limit?: number }) {
  const catalog = await pdCatalog();
  const desc = new Map(catalog.map((c) => [c.keyid, c.description]));
  const seriesbreak = catalog[0]?.seriesbreak || "SBN2024";

  if (args.query && !args.keyids?.length) {
    const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);
    const limit = clampInt(args.limit, 25, 1, 100);
    const hits = catalog.filter((c) => {
      const hay = `${c.keyid} ${c.description}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    const latest = await pdLatestAll(seriesbreak).catch(() => null);
    return {
      dataSource: "NY Fed Markets API — Primary Dealer Statistics (FR 2004), series catalog",
      query: args.query,
      matchCount: hits.length,
      results: hits.slice(0, limit).map((c) => {
        const l = latest?.get(c.keyid);
        return { keyid: c.keyid, description: c.description.slice(0, 220), latestDate: l?.date, latestValueMn: l ? pdVal(l.value) : undefined };
      }),
      note: "All terms must match keyid or description (AND). Keyid conventions: PDPOS* = net outright positions; PDTR* = weekly transaction volumes; PDSORA* = repo (securities out / cash in); PDSIRRA* = reverse repo; PDSIOSB*/PDSOOS* = securities borrowed/lent; PDFT*/PDCA* = fails; suffix C = week-over-week change. Fetch history with keyids=[...].",
    };
  }

  const recent = clampInt(args.recent, 8, 1, 260);
  if (args.keyids?.length) {
    const ids = args.keyids.slice(0, 8).map((k) => String(k).trim().toUpperCase());
    const series = await Promise.all(
      ids.map(async (id) => {
        try {
          const j: any = await cached(`nyfed:pd:get:${id}`, 6 * HOUR, () => jsonFetch(`${BASE}/pd/get/${encodeURIComponent(id)}.json`, { timeoutMs: 20000 }));
          const rows = (j?.pd?.timeseries ?? []).map((x: any) => ({ date: String(x.asofdate), valueMn: pdVal(String(x.value)) }));
          rows.sort((a: any, b: any) => (a.date < b.date ? 1 : -1));
          const latest = rows[0] ?? null;
          const ago = (n: number) => rows[n]?.valueMn ?? null;
          return {
            keyid: id,
            description: desc.get(id) ?? "(not in catalog — check keyid)",
            latest,
            change1w: latest?.valueMn != null && ago(1) != null ? latest.valueMn - ago(1)! : null,
            change4w: latest?.valueMn != null && ago(4) != null ? latest.valueMn - ago(4)! : null,
            change52w: latest?.valueMn != null && ago(52) != null ? latest.valueMn - ago(52)! : null,
            observations: rows.length,
            series: rows.slice(0, recent),
            sampleRaw: rows.length ? undefined : j,
          };
        } catch (e: any) {
          return { keyid: id, error: String(e?.message ?? e) };
        }
      })
    );
    return {
      dataSource: "NY Fed Markets API — Primary Dealer Statistics (FR 2004)",
      series,
      note: "Values in $ millions, weekly as-of Wednesday (published Thursday with ~1-week lag); series newest-first; null = suppressed ('*'). Positions are net (long minus short). Changes compare against 1/4/52 observations back.",
    };
  }

  // Default: headline snapshot from the single 'latest' call.
  const latest = await pdLatestAll(seriesbreak);
  const headline: any[] = await Promise.all(
    PD_HEADLINE.map(async (h) => {
      const l = latest.get(h.keyid);
      const ch = latest.get(`${h.keyid}C`);
      const out: any = { keyid: h.keyid, label: h.label, date: l?.date ?? null, valueMn: l ? pdVal(l.value) : null, changeFromPrevWeekMn: ch ? pdVal(ch.value) : null };
      if (l && out.valueMn == null) {
        // Suppressed ('*') this week — surface the most recent published value from history.
        try {
          const j: any = await cached(`nyfed:pd:get:${h.keyid}`, 6 * HOUR, () => jsonFetch(`${BASE}/pd/get/${encodeURIComponent(h.keyid)}.json`, { timeoutMs: 15000 }));
          const rows = (j?.pd?.timeseries ?? []).filter((x: any) => pdVal(String(x.value)) != null);
          const last = rows[rows.length - 1];
          if (last) out.lastReported = { date: String(last.asofdate), valueMn: pdVal(String(last.value)) };
        } catch { /* best effort */ }
        out.suppressed = true;
      }
      return out;
    })
  );
  return {
    dataSource: "NY Fed Markets API — Primary Dealer Statistics (FR 2004), latest week",
    asOf: headline.find((h) => h.date)?.date ?? null,
    headline,
    seriesCount: catalog.length,
    note: "Snapshot of key dealer balance-sheet lines in $ millions (net positions; repo/reverse repo = financing). suppressed=true means the NY Fed withheld that week's value ('*', confidentiality) — lastReported gives the latest published figure; the week-over-week change may still be published. Large net-long Treasury coupon positions = dealer balance-sheet strain/absorbing supply. Pass query='treasury coupons' to search ~1,540 keyids, or keyids=[...] for history.",
  };
}

// ---------------------------------------------------------------------------
// Operations: ON RRP, standing repo, SOMA holdings
// ---------------------------------------------------------------------------

function compactOp(o: any) {
  const d0 = (o.details ?? [])[0] ?? {};
  return {
    date: o.operationDate,
    operationId: o.operationId,
    type: o.operationType,
    term: o.term,
    method: o.operationMethod,
    window: o.releaseTime && o.closeTime ? `${o.releaseTime}–${o.closeTime} ET` : undefined,
    acceptedBn: o.totalAmtAccepted != null ? round(Number(o.totalAmtAccepted) / 1e9, 3) : null,
    submittedBn: o.totalAmtSubmitted != null ? round(Number(o.totalAmtSubmitted) / 1e9, 3) : null,
    counterparties: o.acceptedCpty ?? o.participatingCpty,
    rate: num(d0.percentAwardRate ?? d0.percentOfferingRate),
    bySecurity: (o.details ?? []).length > 1 ? (o.details ?? []).map((d: any) => ({ type: d.securityType, acceptedBn: round(Number(d.amtAccepted ?? 0) / 1e9, 3) })) : undefined,
  };
}

export async function nyfedOperations(args: { kind?: string; recent?: number }) {
  const kind = (args.kind ?? "rrp").toLowerCase();
  if (kind === "rrp" || kind === "repo") {
    const recent = clampInt(args.recent, 10, 1, 100);
    const path = kind === "rrp" ? "reverserepo" : "repo";
    const url = `${BASE}/rp/${path}/all/results/last/${recent}.json`;
    const j: any = await cached(`nyfed:op:${url}`, 1 * HOUR, () => jsonFetch(url, { timeoutMs: 15000 }));
    const ops = (j?.repo?.operations ?? []).map(compactOp);
    return {
      dataSource: `NY Fed Markets API — ${kind === "rrp" ? "Overnight Reverse Repo (ON RRP) facility" : "Standing Repo (SRF) operations"}`,
      latest: ops[0] ?? null,
      operations: ops,
      sampleRaw: ops.length ? undefined : j,
      note:
        kind === "rrp"
          ? "ON RRP take-up in $ billions; rate = award rate (sets the floor of the fed funds range). Falling RRP balances = money-fund cash leaving the Fed (liquidity released to markets); near-zero means the buffer is exhausted and QT drains reserves directly. Same series as FRED RRPONTSYD but same-day and with counterparties."
          : "Standing repo facility take-up in $ billions (Treasury/Agency/MBS collateral), twice daily. Non-zero take-up = private repo trading above the SRF minimum bid (top of the fed funds range) — a reserve-scarcity signal.",
    };
  }
  if (kind === "soma") {
    const recent = clampInt(args.recent, 8, 1, 260);
    const j: any = await cached("nyfed:soma:summary", 6 * HOUR, () => jsonFetch(`${BASE}/soma/summary.json`, { timeoutMs: 30000 }));
    const rows = (j?.soma?.summary ?? []).map((r: any) => {
      const bn = (k: string) => (num(r[k]) == null ? null : round(num(r[k])! / 1e9, 1));
      return { date: r.asOfDate, totalBn: bn("total"), billsBn: bn("bills"), notesBondsBn: bn("notesbonds"), tipsBn: bn("tips"), frnBn: bn("frn"), mbsBn: bn("mbs"), cmbsBn: bn("cmbs"), agenciesBn: bn("agencies") };
    });
    rows.sort((a: any, b: any) => (a.date < b.date ? 1 : -1));
    const latest = rows[0];
    const diff = (n: number) => (latest && rows[n]?.totalBn != null ? round(latest.totalBn - rows[n].totalBn, 1) : null);
    return {
      dataSource: "NY Fed Markets API — SOMA holdings summary (weekly, par value)",
      latest,
      changeTotalBn: { w4: diff(4), w13: diff(13), w52: diff(52) },
      series: rows.slice(0, recent),
      sampleRaw: rows.length ? undefined : j,
      note: "System Open Market Account holdings at par in $ billions, weekly (Wednesday as-of). Declines = QT runoff; bills share rising = reserve-management purchases. TIPS excludes inflation compensation.",
    };
  }
  throw new Error("kind must be 'rrp', 'repo', or 'soma'");
}
