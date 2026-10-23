/**
 * World Bank Indicators API v2 (api.worldbank.org/v2) — live, no key.
 *
 * Verified live 2026-10-21:
 *   /v2/country/US;DE/indicator/NY.GDP.MKTP.KD.ZG?format=json&date=2020:2025&per_page=100
 *     → [ {page,pages,total,lastupdated}, [ {indicator,country,countryiso3code,date,value,unit,...} ] ]
 *   Invalid country or indicator → [ { message: [ { id:"120", key:"Invalid value" } ] } ] (HTTP 200).
 *   /v2/indicator?format=json&per_page=2000&source=2 → WDI catalog (~1.5k indicators, ~1.5MB, <1s).
 *   The full all-sources catalog is ~15MB / ~29k indicators; we cache WDI plus the
 *   full catalog lazily (only when the caller asks for allSources).
 * Countries accept ISO2 or ISO3 and WB aggregate codes (WLD, EMU, EUU, OED, HIC, LMY...).
 */
import { jsonFetch } from "../data/http";
import { cached, HOUR, normCountries, toStyle, EURO_CODE, clampInt, round } from "./common";

const BASE = "https://api.worldbank.org/v2";

function wbError(body: any): string | null {
  if (Array.isArray(body) && body[0]?.message) {
    const m = body[0].message[0];
    return `${m?.key ?? "error"}: ${m?.value ?? JSON.stringify(m)}`;
  }
  return null;
}

export async function worldbankIndicator(args: any) {
  const indicator = String(args?.indicator ?? "").trim();
  if (!indicator) throw new Error("indicator is required (e.g. NY.GDP.MKTP.KD.ZG). Use worldbank_indicator_search to find codes.");
  const countries = normCountries(args?.countries ?? args?.country ?? "WLD").map((c) => toStyle(c, "iso3", EURO_CODE.worldbank));
  if (countries.length > 20) throw new Error("max 20 countries per call");
  const recentN = clampInt(args?.recent, 10, 1, 60);
  const thisYear = new Date().getUTCFullYear();
  const start = args?.startYear ? clampInt(args.startYear, thisYear - 15, 1960, thisYear) : null;
  const end = args?.endYear ? clampInt(args.endYear, thisYear, 1960, thisYear + 5) : null;
  const dateParam = start || end ? `&date=${start ?? 1960}:${end ?? thisYear}` : `&date=${thisYear - Math.max(recentN + 5, 15)}:${thisYear}`;
  const url = `${BASE}/country/${countries.join(";")}/indicator/${encodeURIComponent(indicator)}?format=json&per_page=5000${dateParam}`;
  const body = await cached(`wb:${url}`, 6 * HOUR, () => jsonFetch<any>(url, { timeoutMs: 10000, retries: 2, retryDelayMs: 300, headers: { "Accept-Language": "en" } }));
  const err = wbError(body);
  if (err) throw new Error(`World Bank rejected the request (${err}) — check the indicator code and ISO country codes [${countries.join(",")}].`);
  const meta = Array.isArray(body) ? body[0] : null;
  const rows: any[] = Array.isArray(body) && Array.isArray(body[1]) ? body[1] : [];

  const byCountry = new Map<string, { name: string; obs: Array<{ year: string; value: number }> }>();
  let indicatorName: string | null = null;
  let unit: string | null = null;
  for (const r of rows) {
    indicatorName = indicatorName ?? r?.indicator?.value ?? null;
    if (r?.unit) unit = unit ?? r.unit;
    const code = r?.countryiso3code || r?.country?.id;
    if (!code) continue;
    let g = byCountry.get(code);
    if (!g) { g = { name: r?.country?.value ?? code, obs: [] }; byCountry.set(code, g); }
    if (r?.value === null || r?.value === undefined) continue;
    g.obs.push({ year: String(r.date), value: round(Number(r.value), 4) });
  }
  const series = [...byCountry.entries()].map(([code, g]) => {
    g.obs.sort((a, b) => b.year.localeCompare(a.year));
    return {
      country: code,
      name: g.name,
      latest: g.obs[0] ?? null,
      recent: g.obs.slice(0, recentN),
      nonNullObservations: g.obs.length,
    };
  });
  return {
    dataSource: "World Bank Indicators API v2 (api.worldbank.org, live)",
    indicator,
    indicatorName,
    unit: unit || "see indicatorName (WB encodes units in the name, e.g. '(annual %)', '(current US$)')",
    lastUpdated: meta?.lastupdated ?? null,
    countriesRequested: countries,
    series,
    ...(series.length === 0 && rows.length === 0 ? { sampleRaw: JSON.stringify(body).slice(0, 400) } : {}),
    note: "Annual values, newest first; nulls (not yet reported) dropped. WB data typically lags 1-2 years — for forecasts/current-year estimates use imf_weo.",
  };
}

interface WbIndicatorMeta { id: string; name: string; source: string; sourceNote: string; topics: string[]; sourceOrganization?: string }

async function loadCatalog(all: boolean): Promise<WbIndicatorMeta[]> {
  return cached(`wb:catalog:${all ? "all" : "wdi"}`, 24 * HOUR, async () => {
    const url = all ? `${BASE}/indicator?format=json&per_page=40000` : `${BASE}/indicator?format=json&per_page=5000&source=2`;
    const body = await jsonFetch<any>(url, { timeoutMs: 45000, retries: 2 });
    const rows: any[] = Array.isArray(body) && Array.isArray(body[1]) ? body[1] : [];
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name ?? ""),
      source: String(r.source?.value ?? ""),
      sourceNote: String(r.sourceNote ?? ""),
      topics: Array.isArray(r.topics) ? r.topics.map((t: any) => t?.value).filter(Boolean) : [],
      sourceOrganization: r.sourceOrganization || undefined,
    }));
  });
}

export async function worldbankIndicatorSearch(args: any) {
  const q = String(args?.query ?? "").trim().toLowerCase();
  if (!q) throw new Error("query is required (e.g. 'government debt', 'inflation', 'current account')");
  const all = !!args?.allSources;
  const limit = clampInt(args?.limit, 15, 1, 50);
  const cat = await loadCatalog(all);
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored = cat
    .map((m) => {
      const name = m.name.toLowerCase();
      const id = m.id.toLowerCase();
      const note = m.sourceNote.toLowerCase();
      let s = 0;
      if (id === q) s += 100;
      if (name.includes(q)) s += 20;
      for (const t of tokens) {
        if (name.includes(t)) s += 5;
        else if (id.includes(t)) s += 3;
        else if (note.includes(t)) s += 1;
        else return { m, s: -1 };
      }
      s -= name.length / 100; // prefer shorter/headline names
      return { m, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  return {
    dataSource: `World Bank Indicators API v2 catalog (${all ? "all sources" : "World Development Indicators"}, cached 24h)`,
    query: q,
    totalMatches: scored.length,
    results: scored.slice(0, limit).map(({ m }) => ({
      id: m.id,
      name: m.name,
      source: m.source,
      topics: m.topics.slice(0, 3),
      description: m.sourceNote.slice(0, 220) + (m.sourceNote.length > 220 ? "…" : ""),
    })),
    note: all
      ? "Searched all ~29k WB indicators across sources."
      : "Searched the ~1.5k WDI indicators. Set allSources:true to search all WB databases (IDS debt, Doing Business, Gender, etc.). Pass a returned id to worldbank_indicator.",
  };
}
