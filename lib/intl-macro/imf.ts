/**
 * IMF data — two keyless upstreams, both verified live 2026-10-21.
 *
 * 1) DataMapper API (www.imf.org/external/datamapper/api/v1) — WEO / Fiscal
 *    Monitor / Global Debt Database annual series INCLUDING projections
 *    (current WEO vintage: "World Economic Outlook (October 2026)").
 *    NOTE (live quirk): /{indicator}/{ISO3}/{ISO3} path filtering and
 *    ?periods= are IGNORED — every call returns the full indicator for all
 *    ~230 economies/groups (~120KB). We therefore fetch per indicator, cache
 *    12h, and filter client-side. Group codes: WEOWORLD, ADVEC, OEMDC, EURO, EU...
 *    /indicators returns ~130 indicators with label/unit/dataset/source.
 *
 * 2) SDMX 3.0 API (api.imf.org/external/sdmx/3.0) — the IFS successor
 *    dataflows (IMF.STA:CPI, IMF.STA:ER, ...), monthly. No subscription key
 *    needed for data queries (checked). CSV with labels=both via Accept header.
 *    Key order for CPI: COUNTRY.INDEX_TYPE.COICOP_1999.TYPE_OF_TRANSFORMATION.FREQUENCY;
 *    ER: COUNTRY.INDICATOR.TYPE_OF_TRANSFORMATION.FREQUENCY. Euro area = G163.
 *    lastNObservations is honored.
 */
import { jsonFetch } from "../data/http";
import { cached, HOUR, normCountries, toStyle, EURO_CODE, clampInt, round, textFetch, parseSdmxCsv, groupSdmxSeries } from "./common";

const DM = "https://www.imf.org/external/datamapper/api/v1";
const SDMX3 = "https://api.imf.org/external/sdmx/3.0/data/dataflow";

interface DmIndicator { label: string; description?: string; source?: string; unit?: string; dataset?: string }

async function dmIndicators(): Promise<Record<string, DmIndicator>> {
  return cached("imf:dm:indicators", 12 * HOUR, async () => {
    const b = await jsonFetch<any>(`${DM}/indicators`, { timeoutMs: 20000, retries: 2 });
    return (b?.indicators ?? {}) as Record<string, DmIndicator>;
  });
}

async function dmNames(): Promise<Record<string, string>> {
  return cached("imf:dm:names", 24 * HOUR, async () => {
    const out: Record<string, string> = {};
    for (const kind of ["countries", "groups", "regions"]) {
      try {
        const b = await jsonFetch<any>(`${DM}/${kind}`, { timeoutMs: 20000, retries: 1 });
        for (const [k, v] of Object.entries<any>(b?.[kind] ?? {})) out[k] = String(v?.label ?? k).trim();
      } catch { /* names are cosmetic */ }
    }
    return out;
  });
}

async function dmValues(indicator: string): Promise<Record<string, Record<string, number>>> {
  return cached(`imf:dm:values:${indicator}`, 12 * HOUR, async () => {
    const b = await jsonFetch<any>(`${DM}/${encodeURIComponent(indicator)}`, { timeoutMs: 25000, retries: 2 });
    return (b?.values?.[indicator] ?? {}) as Record<string, Record<string, number>>;
  });
}

export async function imfWeo(args: any) {
  const indicator = String(args?.indicator ?? "").trim();
  if (!indicator) throw new Error("indicator is required (e.g. NGDP_RPCH, PCPIPCH, GGXWDG_NGDP). Use imf_indicator_list for codes.");
  const countries = normCountries(args?.countries ?? args?.country ?? "WEOWORLD").map((c) => toStyle(c, "iso3", EURO_CODE.imfDatamapper));
  if (countries.length > 25) throw new Error("max 25 countries per call");
  const thisYear = new Date().getUTCFullYear();
  const startYear = clampInt(args?.startYear, thisYear - 5, 1980, 2100);
  const endYear = clampInt(args?.endYear, thisYear + 5, 1980, 2100);

  const [inds, values, names] = await Promise.all([dmIndicators(), dmValues(indicator), dmNames()]);
  const meta = inds[indicator];
  if (!meta && Object.keys(values).length === 0) {
    throw new Error(`Unknown IMF DataMapper indicator '${indicator}'. Call imf_indicator_list (e.g. NGDP_RPCH real GDP growth, PCPIPCH inflation, LUR unemployment, GGXWDG_NGDP gross debt % GDP, BCA_NGDPD current account % GDP).`);
  }
  const series = countries.map((c) => {
    const v = values[c];
    if (!v) return { country: c, name: names[c] ?? null, error: "no data for this code (DataMapper uses ISO3 and group codes like WEOWORLD, ADVEC, OEMDC, EURO)" };
    const years = Object.keys(v).filter((y) => +y >= startYear && +y <= endYear).sort();
    const obs = years.map((y) => ({ year: y, value: round(Number(v[y]), 3), projection: +y >= thisYear }));
    const actuals = obs.filter((o) => !o.projection);
    return {
      country: c,
      name: names[c] ?? null,
      latestActual: actuals.length ? actuals[actuals.length - 1] : null,
      values: obs,
    };
  });
  return {
    dataSource: `IMF DataMapper API (live) — ${meta?.source ?? meta?.dataset ?? "IMF"}`,
    indicator,
    label: meta?.label?.trim() ?? null,
    unit: meta?.unit?.trim() ?? null,
    dataset: meta?.dataset ?? null,
    window: `${startYear}-${endYear}`,
    series,
    note: `Annual. projection:true marks years >= ${thisYear} — these are IMF staff estimates/forecasts from the named vintage (the current year is usually still an estimate). For monthly prints use imf_sdmx_series, oecd_series or bis_series.`,
  };
}

export async function imfIndicatorList(args: any) {
  const q = String(args?.query ?? "").trim().toLowerCase();
  const dataset = args?.dataset ? String(args.dataset).toUpperCase() : null;
  const inds = await dmIndicators();
  let rows = Object.entries(inds).map(([id, m]) => ({
    id,
    label: (m.label ?? "").replace(/\s+/g, " ").trim(),
    unit: (m.unit ?? "").trim() || null,
    dataset: m.dataset ?? null,
    source: m.source ?? null,
  }));
  if (dataset) rows = rows.filter((r) => (r.dataset ?? "").toUpperCase() === dataset);
  if (q) {
    const toks = q.split(/\s+/);
    rows = rows.filter((r) => toks.every((t) => `${r.id} ${r.label} ${r.unit} ${r.dataset}`.toLowerCase().includes(t)));
  } else if (!dataset) {
    rows = rows.filter((r) => ["WEO", "FM", "GDD", "DEBT"].includes(r.dataset ?? ""));
  }
  const limit = clampInt(args?.limit, 60, 1, 200);
  return {
    dataSource: "IMF DataMapper API /indicators (live, cached 12h)",
    totalIndicators: Object.keys(inds).length,
    returned: Math.min(rows.length, limit),
    indicators: rows.slice(0, limit),
    note: q || dataset
      ? "Pass an id to imf_weo."
      : "Default view = macro datasets (WEO World Economic Outlook, FM Fiscal Monitor, GDD Global Debt Database). Filter with query or dataset (e.g. AFRREO, CF, CL, SPRLU, FPP, AIPI). Pass an id to imf_weo.",
  };
}

// ---------------------------------------------------------------- SDMX 3.0 (monthly, IFS successor)

const IMF_SDMX_PRESETS: Record<string, { flow: string; build: (cs: string) => string; desc: string }> = {
  cpi_yoy: { flow: "IMF.STA/CPI/+", build: (cs) => `${cs}.CPI._T.YOY_PCH_PA_PT.M`, desc: "Headline CPI, % y/y, monthly (IMF CPI dataflow; euro area G163 uses HICP — pass flow/key raw for that)" },
  cpi_index: { flow: "IMF.STA/CPI/+", build: (cs) => `${cs}.CPI._T.IX.M`, desc: "Headline CPI index level, monthly" },
  fx_usd: { flow: "IMF.STA/ER/+", build: (cs) => `${cs}.XDC_USD.PA_RT.M`, desc: "Exchange rate, domestic currency per USD, period average, monthly" },
  fx_usd_eop: { flow: "IMF.STA/ER/+", build: (cs) => `${cs}.XDC_USD.EOP_RT.M`, desc: "Exchange rate, domestic currency per USD, end of period, monthly" },
};

export async function imfSdmxSeries(args: any) {
  const preset = args?.preset ? String(args.preset).toLowerCase() : null;
  const recentN = clampInt(args?.recent, 6, 1, 60);
  let flow: string, key: string;
  if (preset) {
    const p = IMF_SDMX_PRESETS[preset];
    if (!p) throw new Error(`unknown preset '${preset}'. Presets: ${Object.keys(IMF_SDMX_PRESETS).join(", ")}`);
    const cs = normCountries(args?.countries ?? "USA").map((c) => toStyle(c, "iso3", EURO_CODE.imfSdmx));
    if (cs.length > 20) throw new Error("max 20 countries per call");
    flow = p.flow; key = p.build(cs.join("+"));
  } else {
    if (!args?.flow || !args?.key) throw new Error("pass preset (cpi_yoy|cpi_index|fx_usd|fx_usd_eop) + countries, or raw flow ('IMF.STA/CPI/+') and key ('USA.CPI._T.IX.M')");
    flow = String(args.flow).replace(/^\/+|\/+$/g, "");
    if (flow.split("/").length === 2) flow += "/+";
    key = String(args.key);
  }
  const url = `${SDMX3}/${flow}/${key}?lastNObservations=${recentN}`;
  const text = await cached(`imf:sdmx:${url}`, 6 * HOUR, () =>
    textFetch(url, { Accept: "application/vnd.sdmx.data+csv;version=2.0.0;labels=both" }, 25000));
  const rows = parseSdmxCsv(text);
  const { commonDims, series } = groupSdmxSeries(rows, recentN);
  return {
    dataSource: "IMF SDMX 3.0 API (api.imf.org, live, keyless)",
    flow, key,
    ...(preset ? { preset, presetDescription: IMF_SDMX_PRESETS[preset].desc } : {}),
    commonDims,
    series: series.slice(0, 25),
    ...(series.length === 0 ? { sampleRaw: text.slice(0, 400) } : {}),
    note: "Most recent observations, newest first. Periods use IMF format (2026-M09).",
  };
}

export const IMF_SDMX_PRESET_NAMES = Object.keys(IMF_SDMX_PRESETS);
