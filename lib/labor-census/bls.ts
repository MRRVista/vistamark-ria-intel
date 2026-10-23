/**
 * BLS Public Data API (timeseries), keyless with optional BLS_API_KEY.
 *
 * Endpoints (verified live 2026-10-22):
 *   POST https://api.bls.gov/publicAPI/v2/timeseries/data/   body {seriesid:[..], startyear, endyear, registrationkey?}
 *   POST https://api.bls.gov/publicAPI/v1/timeseries/data/   same body, no key, no catalog
 *   GET  https://api.bls.gov/publicAPI/v2/timeseries/popular[?survey=XX]
 *
 * Quotas: v2 keyless and v1 are each 25 queries/day PER IP, 10 years, 25
 * series/query. On Vercel (and in the build sandbox) the egress IP is shared,
 * so v2 keyless can report "daily threshold ... reached" even on a first call;
 * we then fall back to v1, which keeps a separate counter. With BLS_API_KEY
 * (free, https://data.bls.gov/registrationEngine/) v2 allows 500 queries/day,
 * 20 years and 50 series.
 */
import { politeFetch, redactUrl } from "../data/http";
import { cached, clampInt, HOUR, pctChange, round } from "./common";

const V2 = "https://api.bls.gov/publicAPI/v2/timeseries/data/";
const V1 = "https://api.bls.gov/publicAPI/v1/timeseries/data/";
const POPULAR = "https://api.bls.gov/publicAPI/v2/timeseries/popular";

/** Friendly names → BLS series ids. All ids verified live 2026-10-22. */
export const BLS_ALIASES: Record<string, { id: string; title: string; units: string }> = {
  unemployment: { id: "LNS14000000", title: "Unemployment rate, 16+, SA (CPS)", units: "percent" },
  unemployment_u6: { id: "LNS13327709", title: "U-6 total unemployed + marginally attached + part-time for economic reasons, SA", units: "percent" },
  participation: { id: "LNS11300000", title: "Labor force participation rate, SA", units: "percent" },
  employment_population: { id: "LNS12300000", title: "Employment-population ratio, SA", units: "percent" },
  payrolls: { id: "CES0000000001", title: "Total nonfarm payroll employment, SA (CES)", units: "thousands of jobs" },
  private_payrolls: { id: "CES0500000001", title: "Total private payroll employment, SA", units: "thousands of jobs" },
  financial_activities_payrolls: { id: "CES5500000001", title: "Financial activities employment, SA", units: "thousands of jobs" },
  ahe: { id: "CES0500000003", title: "Average hourly earnings, total private, SA", units: "USD per hour" },
  awe: { id: "CES0500000011", title: "Average weekly earnings, total private, SA", units: "USD per week" },
  avg_weekly_hours: { id: "CES0500000002", title: "Average weekly hours, total private, SA", units: "hours" },
  cpi: { id: "CUUR0000SA0", title: "CPI-U all items, US city average, NSA (1982-84=100)", units: "index" },
  cpi_sa: { id: "CUSR0000SA0", title: "CPI-U all items, SA", units: "index" },
  core_cpi: { id: "CUUR0000SA0L1E", title: "CPI-U all items less food and energy, NSA", units: "index" },
  core_cpi_sa: { id: "CUSR0000SA0L1E", title: "CPI-U all items less food and energy, SA", units: "index" },
  cpi_energy: { id: "CUUR0000SA0E", title: "CPI-U energy, NSA", units: "index" },
  cpi_rent: { id: "CUUR0000SEHA", title: "CPI-U rent of primary residence, NSA", units: "index" },
  cpi_chicago: { id: "CUURS23ASA0", title: "CPI-U all items, Chicago-Naperville-Elgin, NSA (bi-monthly/monthly)", units: "index" },
  ppi_final_demand: { id: "WPSFD4", title: "PPI final demand, SA", units: "index" },
  ppi_final_demand_nsa: { id: "WPUFD4", title: "PPI final demand, NSA", units: "index" },
  import_prices: { id: "EIUIR", title: "Import price index, all commodities", units: "index" },
  jolts_openings: { id: "JTS000000000000000JOL", title: "JOLTS job openings, total nonfarm, SA (level)", units: "thousands" },
  jolts_quits_rate: { id: "JTS000000000000000QUR", title: "JOLTS quits rate, total nonfarm, SA", units: "percent" },
  jolts_hires_rate: { id: "JTS000000000000000HIR", title: "JOLTS hires rate, total nonfarm, SA", units: "percent" },
  eci: { id: "CIU1010000000000A", title: "Employment Cost Index, total compensation, civilian, 12-month % change (quarterly)", units: "percent y/y" },
  eci_wages: { id: "CIU2010000000000A", title: "ECI wages and salaries, civilian, 12-month % change (quarterly)", units: "percent y/y" },
  productivity: { id: "PRS85006092", title: "Nonfarm business labor productivity, % change q/q annualized", units: "percent" },
  unit_labor_costs: { id: "PRS85006112", title: "Nonfarm business unit labor costs, % change q/q annualized", units: "percent" },
  il_unemployment: { id: "LASST170000000000003", title: "Illinois unemployment rate, SA (LAUS)", units: "percent" },
  chicago_msa_unemployment: { id: "LAUMT171698000000003", title: "Chicago-Naperville-Elgin MSA unemployment rate, NSA (LAUS)", units: "percent" },
  dupage_unemployment: { id: "LAUCN170430000000003", title: "DuPage County, IL unemployment rate, NSA (LAUS)", units: "percent" },
  cook_unemployment: { id: "LAUCN170310000000003", title: "Cook County, IL unemployment rate, NSA (LAUS)", units: "percent" },
};

const ID_TO_ALIAS: Record<string, string> = Object.fromEntries(Object.entries(BLS_ALIASES).map(([k, v]) => [v.id, k]));

export function resolveSeriesId(s: string): string {
  const t = String(s).trim();
  const key = t.toLowerCase().replace(/[\s-]+/g, "_");
  if (BLS_ALIASES[key]) return BLS_ALIASES[key]!.id;
  return t.toUpperCase();
}

interface BlsPoint {
  year: string;
  period: string;
  periodName: string;
  value: string;
  latest?: string;
  footnotes?: Array<{ code?: string; text?: string }>;
}
interface BlsSeries {
  seriesID: string;
  catalog?: Record<string, string>;
  data: BlsPoint[];
}
interface BlsResponse {
  status: string;
  message?: string[];
  Results?: { series?: BlsSeries[] };
}

async function post(url: string, body: Record<string, unknown>): Promise<BlsResponse> {
  const res = await politeFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 20000,
    retries: 1,
  });
  if (!res.ok) throw new Error(`BLS HTTP ${res.status} from ${redactUrl(url)}`);
  return (await res.json()) as BlsResponse;
}

function isQuota(r: BlsResponse): boolean {
  return r.status !== "REQUEST_SUCCEEDED" && (r.message ?? []).some((m) => /threshold|limit|quota/i.test(m));
}

/** Fetch raw series (cached 1h). Keyed v2 → keyless v2 → v1 fallback on quota. */
export function fetchBlsSeries(ids: string[], startyear: number, endyear: number): Promise<{ series: BlsSeries[]; messages: string[]; api: string }> {
  const key = process.env.BLS_API_KEY?.trim();
  const ck = `bls:${ids.join(",")}:${startyear}:${endyear}:${key ? "k" : "n"}`;
  return cached(ck, 1 * HOUR, async () => {
    const body: Record<string, unknown> = { seriesid: ids, startyear: String(startyear), endyear: String(endyear) };
    const messages: string[] = [];
    if (key) {
      const r = await post(V2, { ...body, registrationkey: key, catalog: true });
      if (r.status === "REQUEST_SUCCEEDED") return { series: r.Results?.series ?? [], messages: r.message ?? [], api: "v2-keyed" };
      messages.push(...(r.message ?? []));
      if (!isQuota(r)) throw new Error(`BLS v2: ${messages.join("; ") || r.status}`);
    } else {
      const r = await post(V2, body);
      if (r.status === "REQUEST_SUCCEEDED") return { series: r.Results?.series ?? [], messages: r.message ?? [], api: "v2-keyless" };
      messages.push(...(r.message ?? []));
      if (!isQuota(r)) throw new Error(`BLS v2: ${messages.join("; ") || r.status}`);
    }
    const r1 = await post(V1, body);
    if (r1.status === "REQUEST_SUCCEEDED") {
      return { series: r1.Results?.series ?? [], messages: [...messages, ...(r1.message ?? [])], api: "v1-fallback" };
    }
    messages.push(...(r1.message ?? []));
    // Last resort: single-series GETs keep answering after the POST counters trip (observed 2026-10-22).
    const singles = await Promise.all(
      ids.map(async (id) => {
        try {
          const res = await politeFetch(`${V2}${encodeURIComponent(id)}?startyear=${startyear}&endyear=${endyear}`, { timeoutMs: 15000, retries: 0 });
          if (!res.ok) return null;
          const j = (await res.json()) as BlsResponse;
          return j.status === "REQUEST_SUCCEEDED" ? j.Results?.series?.[0] ?? null : null;
        } catch {
          return null;
        }
      })
    );
    const got = singles.filter((s): s is BlsSeries => !!s);
    if (got.length) return { series: got, messages: [...messages, `POST quota tripped; served ${got.length}/${ids.length} series via per-series GET`], api: "v2-get-fallback" };
    throw new Error(
      `BLS quota exhausted on this egress IP (${messages.join("; ")}). Set BLS_API_KEY (free at https://data.bls.gov/registrationEngine/) for 500 queries/day.`
    );
  });
}

function periodKey(p: BlsPoint): string {
  return `${p.year}-${p.period}`;
}

function periodsPerYear(period: string): number {
  if (/^M/.test(period)) return 12;
  if (/^Q/.test(period)) return 4;
  if (/^S/.test(period)) return 2;
  return 1;
}

export async function blsSeries(args: any): Promise<any> {
  const raw: unknown[] = Array.isArray(args?.series) ? args.series : args?.series ? [args.series] : args?.seriesId ? [args.seriesId] : [];
  if (!raw.length) throw new Error("series is required: an array of BLS series ids or alias names (see bls_popular)");
  if (raw.length > 10) throw new Error("series: at most 10 per call");
  const ids = raw.map((s) => resolveSeriesId(String(s)));
  const recent = clampInt(args?.recent, 13, 1, 60);
  const years = clampInt(args?.years, 3, 1, 10);
  const now = new Date();
  const endyear = clampInt(args?.endYear, now.getFullYear(), 1950, now.getFullYear() + 1);
  const startyear = clampInt(args?.startYear, endyear - years + 1, 1950, endyear);

  const { series, messages, api } = await fetchBlsSeries(ids, startyear, endyear);
  const byId = new Map(series.map((s) => [s.seriesID, s]));
  const out = ids.map((id) => {
    const s = byId.get(id);
    const alias = ID_TO_ALIAS[id];
    const meta = alias ? BLS_ALIASES[alias] : undefined;
    if (!s || !s.data?.length) {
      return { seriesId: id, alias, title: meta?.title ?? s?.catalog?.series_title, error: "no data returned (check id, or series may not cover the requested years)" };
    }
    // BLS returns newest first; drop annual-average rows (M13/Q05) for change math.
    const pts = s.data.filter((p) => p.period !== "M13" && p.period !== "Q05" && p.period !== "S03");
    const sorted = [...pts].sort((a, b) => (periodKey(a) < periodKey(b) ? 1 : -1));
    const latest = sorted[0]!;
    const ppy = periodsPerYear(latest.period);
    const val = (p?: BlsPoint) => (p ? Number(p.value) : null);
    const latestV = val(latest);
    const prev = sorted[1];
    const yearAgo = sorted.find((p) => p.year === String(Number(latest.year) - 1) && p.period === latest.period);
    const prelim = (latest.footnotes ?? []).some((f) => f.code === "P");
    return {
      seriesId: id,
      alias,
      title: meta?.title ?? s.catalog?.series_title,
      units: meta?.units ?? s.catalog?.units,
      latest: { period: `${latest.year}-${latest.period}`, periodName: `${latest.periodName} ${latest.year}`, value: latestV, preliminary: prelim || undefined },
      changeVsPrior: prev ? { period: `${prev.year}-${prev.period}`, diff: round(latestV! - val(prev)!, 3), pct: pctChange(latestV, val(prev)) } : null,
      changeVsYearAgo: yearAgo ? { period: `${yearAgo.year}-${yearAgo.period}`, diff: round(latestV! - val(yearAgo)!, 3), pct: pctChange(latestV, val(yearAgo)) } : null,
      frequency: ppy === 12 ? "monthly" : ppy === 4 ? "quarterly" : ppy === 2 ? "semiannual" : "annual",
      recent: sorted.slice(0, recent).map((p) => ({ period: `${p.year}-${p.period}`, value: Number(p.value) })),
    };
  });
  return {
    source: "BLS Public Data API " + api,
    fetchedAt: new Date().toISOString(),
    window: { startyear, endyear },
    notes: [
      "Index series (CPI, PPI): use changeVsYearAgo.pct for the inflation rate. Rate series (unemployment, ECI, productivity): use diff in percentage points.",
      ...(messages.length ? messages : []),
    ],
    series: out,
  };
}

export async function blsPopular(args: any): Promise<any> {
  const survey = args?.survey ? String(args.survey).trim().toUpperCase() : undefined;
  const live = await cached(`bls:popular:${survey ?? "all"}`, 24 * HOUR, async () => {
    try {
      const url = survey ? `${POPULAR}?survey=${encodeURIComponent(survey)}` : POPULAR;
      const res = await politeFetch(url, { timeoutMs: 10000, retries: 0 });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const j = (await res.json()) as BlsResponse;
      return { status: j.status, ids: (j.Results?.series ?? []).map((s) => s.seriesID) };
    } catch (e: any) {
      return { error: String(e?.message ?? e) };
    }
  });
  return {
    source: "BLS Public Data API (aliases built in; popular list live)",
    fetchedAt: new Date().toISOString(),
    keyed: !!process.env.BLS_API_KEY,
    aliases: Object.entries(BLS_ALIASES).map(([alias, v]) => ({ alias, seriesId: v.id, title: v.title, units: v.units })),
    popularLive: live,
    idPatterns: {
      LAUS_county: "LAUCN<state2><county3>0000000003 = unemployment rate (…04 unemployed, …05 employed, …06 labor force)",
      LAUS_state: "LASST<state2>0000000000003",
      LAUS_msa: "LAUMT<state2><cbsa5>00000003 (e.g. LAUMT171698000000003 Chicago MSA)",
      CPI_area: "CUUR<area>SA0 (S23A Chicago, S24A Detroit, 0100 Northeast…)",
      CES_industry: "CES<supersector2><industry6>01 employment, …03 hourly earnings (55 = financial activities)",
    },
  };
}
