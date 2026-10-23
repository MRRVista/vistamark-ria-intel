/**
 * OECD Data Explorer SDMX REST API (sdmx.oecd.org/public/rest) — live, no key.
 * (The legacy stats.oecd.org / OECD.Stat API was retired in 2024.)
 *
 * Verified live 2026-10-21, format=csvfilewithlabels (code column + label column),
 * lastNObservations honored:
 *   CLI:   OECD.SDD.STES,DSD_STES@DF_CLI,  /{AREA}.M.LI...AA...H        (index, long-term avg = 100)
 *   BCI/CCI same flow, MEASURE BCICP / CCICP
 *   Rates: OECD.SDD.STES,DSD_STES@DF_FINMARK, /{AREA}.M.IR3TIB.......    (IRLT = 10y govt)
 *   Unemp: OECD.SDD.TPS,DSD_LFS@DF_IALFS_UNE_M, /{AREA}..._Z.Y._T.Y_GE15..M
 *   CPI:   OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL, /{AREA}.M.N.CPI.PA._T.N.GY  (core: _TXCP01_NRG)
 * Area codes are ISO3 plus aggregates (OECD, G7, G20, EA20, A5M, G4E, NAFTA).
 * LIVE GOTCHA: Node/undici fetch sends "Accept-Language: *" by default and the OECD
 * NSI web service answers HTTP 500 "Internal server error" to it (curl works). We
 * always send Accept-Language: en.
 * Rate limiting: OECD throttles bursts (~20 req/min per IP) — results cached 6h.
 */
import { cached, HOUR, normCountries, toStyle, EURO_CODE, clampInt, textFetch, parseSdmxCsv, groupSdmxSeries } from "./common";

const BASE = "https://sdmx.oecd.org/public/rest/data";

interface Preset { flow: string; key: (areas: string) => string; desc: string; unit: string }

const PRESETS: Record<string, Preset> = {
  cli: { flow: "OECD.SDD.STES,DSD_STES@DF_CLI,", key: (a) => `${a}.M.LI...AA...H`, desc: "Composite Leading Indicator, amplitude-adjusted (100 = long-term trend; >100 and rising = expansion ahead, turning points lead the cycle ~6-9 months)", unit: "Index" },
  bci: { flow: "OECD.SDD.STES,DSD_STES@DF_CLI,", key: (a) => `${a}.M.BCICP...AA...H`, desc: "Composite business confidence, OECD-harmonised (100 = long-term average)", unit: "Index" },
  cci: { flow: "OECD.SDD.STES,DSD_STES@DF_CLI,", key: (a) => `${a}.M.CCICP...AA...H`, desc: "Composite consumer confidence, OECD-harmonised (100 = long-term average)", unit: "Index" },
  short_rate: { flow: "OECD.SDD.STES,DSD_STES@DF_FINMARK,", key: (a) => `${a}.M.IR3TIB.......`, desc: "Short-term (3-month interbank/T-bill) interest rate, monthly average", unit: "Percent per annum" },
  long_rate: { flow: "OECD.SDD.STES,DSD_STES@DF_FINMARK,", key: (a) => `${a}.M.IRLT.......`, desc: "Long-term (10-year government bond) interest rate, monthly average", unit: "Percent per annum" },
  unemployment: { flow: "OECD.SDD.TPS,DSD_LFS@DF_IALFS_UNE_M,", key: (a) => `${a}..._Z.Y._T.Y_GE15..M`, desc: "Harmonised monthly unemployment rate, 15+, seasonally adjusted", unit: "% of labour force" },
  cpi: { flow: "OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL,", key: (a) => `${a}.M.N.CPI.PA._T.N.GY`, desc: "Headline CPI (national definition), % change over 1 year", unit: "% y/y" },
  core_cpi: { flow: "OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL,", key: (a) => `${a}.M.N.CPI.PA._TXCP01_NRG.N.GY`, desc: "Core CPI (all items ex food & energy), % change over 1 year", unit: "% y/y" },
};

export const OECD_PRESET_NAMES = Object.keys(PRESETS);

export async function oecdSeries(args: any) {
  const preset = args?.preset ? String(args.preset).toLowerCase() : null;
  const recentN = clampInt(args?.recent, 6, 1, 120);
  let flow: string, key: string;
  if (preset) {
    const p = PRESETS[preset];
    if (!p) throw new Error(`unknown preset '${preset}'. Presets: ${OECD_PRESET_NAMES.join(", ")}`);
    const areas = normCountries(args?.countries ?? "USA").map((c) => toStyle(c, "iso3", EURO_CODE.oecd));
    if (areas.length > 25) throw new Error("max 25 areas per call");
    flow = p.flow; key = p.key(areas.join("+"));
  } else {
    if (!args?.dataflow || args?.key === undefined) {
      throw new Error("pass preset (" + OECD_PRESET_NAMES.join("|") + ") + countries, or raw dataflow ('OECD.SDD.STES,DSD_STES@DF_CLI,' — agency,id,version) and key ('USA.M.LI...AA...H'; empty position = wildcard)");
    }
    flow = String(args.dataflow).trim();
    if (flow.split(",").length === 2) flow += ",";
    key = String(args.key).trim() || "all";
  }
  const qs = new URLSearchParams({ format: "csvfilewithlabels", lastNObservations: String(recentN) });
  if (args?.startPeriod) qs.set("startPeriod", String(args.startPeriod));
  const url = `${BASE}/${flow}/${key}?${qs.toString()}`;
  let text: string;
  try {
    // retries=1: OECD throttles per IP, and retry storms extend the lockout.
    text = await cached(`oecd:${url}`, 6 * HOUR, () => textFetch(url, { Accept: "text/csv", "Accept-Language": "en" }, 30000, 1));
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/HTTP (429|500|503)/.test(msg)) {
      throw new Error(
        `OECD API refused the request (${/HTTP (\d+)/.exec(msg)?.[1]}). sdmx.oecd.org rate-limits bursts per IP (~20 calls/min) and can answer 500 when overloaded. Retry in 1-2 minutes; meanwhile bis_series (policy rates), imf_sdmx_series (CPI) or imf_weo cover similar ground.`,
      );
    }
    if (/HTTP 404/.test(msg)) {
      return { dataSource: "OECD SDMX API (sdmx.oecd.org, live)", dataflow: flow, key, series: [], note: "No data matched (OECD returns 404 'NoResultsFound' for empty selections) — check area codes (ISO3 or OECD/G7/G20/EA20) and key positions." };
    }
    throw e;
  }
  const rows = parseSdmxCsv(text);
  const { commonDims, series } = groupSdmxSeries(rows, recentN);
  const maxSeries = clampInt(args?.maxSeries, 30, 1, 100);
  return {
    dataSource: "OECD Data Explorer SDMX API (sdmx.oecd.org, live)",
    dataflow: flow,
    key,
    ...(preset ? { preset, presetDescription: PRESETS[preset].desc, unit: PRESETS[preset].unit } : {}),
    commonDims,
    seriesCount: series.length,
    series: series.slice(0, maxSeries).map((s) => ({ ...s, key: undefined })),
    ...(series.length === 0 ? { sampleRaw: text.slice(0, 400) } : {}),
    note: "Most recent observations per series, newest first. Series with different release lags will show different latest periods.",
  };
}
