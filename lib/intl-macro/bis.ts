/**
 * BIS Data Portal SDMX REST API v1 (stats.bis.org/api/v1) — live, no key.
 *
 * Verified live 2026-10-21 with Accept "application/vnd.sdmx.data+csv;version=1.0.0;labels=both"
 * (cells are "CODE: Label"); lastNObservations honored.
 *   WS_CBPOL      key FREQ.REF_AREA                                  e.g. M.US+GB+XM   (per cent per year)
 *   WS_CREDIT_GAP key FREQ.BORROWERS_CTY.TC_BORROWERS.TC_LENDERS.CG_DTYPE  Q.US.P.A.C
 *                 CG_DTYPE: A = credit-to-GDP ratio (actual), B = HP trend, C = gap (actual−trend), pp of GDP
 *   WS_SPP        key FREQ.REF_AREA.VALUE.UNIT_MEASURE               Q.US.R.628 (real, index 2010=100) / .771 (y/y %)
 *                 VALUE: N nominal, R real
 *   WS_EER        key FREQ.EER_TYPE.EER_BASKET.REF_AREA               M.R.B.US (real, broad 64-economy basket)
 *                 EER_TYPE: N nominal, R real; BASKET: B broad, N narrow
 * BIS uses ISO2 country codes; euro area = XM.
 */
import { cached, HOUR, normCountries, toStyle, EURO_CODE, clampInt, textFetch, parseSdmxCsv, groupSdmxSeries } from "./common";

const BASE = "https://stats.bis.org/api/v1/data";

interface Preset { flow: string; key: (a: string) => string; desc: string; freq: string }

const PRESETS: Record<string, Preset> = {
  policy_rate: { flow: "WS_CBPOL", key: (a) => `M.${a}`, desc: "Central bank policy rate, end of month (per cent per year)", freq: "M" },
  policy_rate_daily: { flow: "WS_CBPOL", key: (a) => `D.${a}`, desc: "Central bank policy rate, daily", freq: "D" },
  credit_gap: { flow: "WS_CREDIT_GAP", key: (a) => `Q.${a}.P.A.C`, desc: "Credit-to-GDP gap (actual minus HP-filter trend), private non-financial sector, percentage points of GDP. Basel III CCyB guide: >2pp starts buffer, >10pp is a historic crisis-warning zone", freq: "Q" },
  credit_to_gdp: { flow: "WS_CREDIT_GAP", key: (a) => `Q.${a}.P.A.A+B+C`, desc: "Credit-to-GDP ratio (A), its HP trend (B) and gap (C), private non-financial sector, % of GDP", freq: "Q" },
  property_prices_real: { flow: "WS_SPP", key: (a) => `Q.${a}.R.628+771`, desc: "Residential property prices, REAL: index 2010=100 (628) and y/y % change (771)", freq: "Q" },
  property_prices_nominal: { flow: "WS_SPP", key: (a) => `Q.${a}.N.628+771`, desc: "Residential property prices, NOMINAL: index 2010=100 (628) and y/y % change (771)", freq: "Q" },
  reer: { flow: "WS_EER", key: (a) => `M.R.B.${a}`, desc: "Real effective exchange rate, broad basket (64 economies), index 2020=100, monthly average; up = appreciation", freq: "M" },
  neer: { flow: "WS_EER", key: (a) => `M.N.B.${a}`, desc: "Nominal effective exchange rate, broad basket, index 2020=100, monthly average; up = appreciation", freq: "M" },
};

export const BIS_PRESET_NAMES = Object.keys(PRESETS);

export async function bisSeries(args: any) {
  const preset = args?.preset ? String(args.preset).toLowerCase() : null;
  const recentN = clampInt(args?.recent, 6, 1, 120);
  let flow: string, key: string;
  if (preset) {
    const p = PRESETS[preset];
    if (!p) throw new Error(`unknown preset '${preset}'. Presets: ${BIS_PRESET_NAMES.join(", ")}`);
    const cs = normCountries(args?.countries ?? "US").map((c) => toStyle(c, "iso2", EURO_CODE.bis));
    if (cs.length > 25) throw new Error("max 25 countries per call");
    flow = p.flow; key = p.key(cs.join("+"));
  } else {
    if (!args?.flow || args?.key === undefined) throw new Error("pass preset (" + BIS_PRESET_NAMES.join("|") + ") + countries, or raw flow ('WS_CBPOL') and key ('M.US+GB')");
    flow = String(args.flow).trim().toUpperCase();
    key = String(args.key).trim() || "all";
  }
  const qs = new URLSearchParams({ lastNObservations: String(recentN) });
  if (args?.startPeriod) qs.set("startPeriod", String(args.startPeriod));
  const url = `${BASE}/${encodeURIComponent(flow)}/${key}/all?${qs.toString()}`;
  let text: string;
  try {
    text = await cached(`bis:${url}`, 6 * HOUR, () => textFetch(url, { Accept: "application/vnd.sdmx.data+csv;version=1.0.0;labels=both" }, 30000));
  } catch (e: any) {
    if (/HTTP 404/.test(String(e?.message))) {
      return { dataSource: "BIS SDMX API (stats.bis.org, live)", flow, key, series: [], note: "No data matched — BIS uses ISO2 country codes (euro area XM); check key positions." };
    }
    throw e;
  }
  const rows = parseSdmxCsv(text);
  const { commonDims, series } = groupSdmxSeries(rows, recentN);
  const maxSeries = clampInt(args?.maxSeries, 30, 1, 100);
  return {
    dataSource: "BIS Data Portal SDMX API v1 (stats.bis.org, live)",
    flow,
    key,
    ...(preset ? { preset, presetDescription: PRESETS[preset].desc } : {}),
    commonDims,
    seriesCount: series.length,
    series: series.slice(0, maxSeries).map((s) => ({ ...s, key: undefined })),
    ...(series.length === 0 ? { sampleRaw: text.slice(0, 400) } : {}),
    note: "Most recent observations per series, newest first. Quarterly BIS series lag ~1-2 quarters.",
  };
}
