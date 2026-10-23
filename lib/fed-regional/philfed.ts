/**
 * Philadelphia Fed Survey of Professional Forecasters (public xlsx, no key).
 *
 * Verified live 2026-10-21:
 *   .../survey-of-professional-forecasters/historical-data/medianLevel.xlsx   (~550KB; one sheet per variable)
 *   .../survey-of-professional-forecasters/historical-data/medianGrowth.xlsx  (~145KB; q/q annualized growth)
 * Each sheet: YEAR, QUARTER (survey date), then horizon columns <VAR>1..6, <VAR>A..D:
 *   1 = quarter before the survey quarter (usually already known), 2 = survey (current) quarter,
 *   3..6 = next four quarters; A = current calendar year, B = next year, C/D = following years.
 * Rates (UNEMP, TBILL, TBOND) are levels in %; CPI/CORECPI/PCE/COREPCE quarterly columns are
 * annualized q/q %, annual columns are Q4/Q4 %. RGDP levels are chained $bn — growth comes
 * from medianGrowth (drgdp2..6) and annual-average growth is derived from RGDPA..D.
 */
import { HOUR, cached, fetchBuffer, num, round } from "./common";
import { openXlsx, type Grid, type XlsxBook } from "./xlsx";

const SPF = "https://www.philadelphiafed.org/-/media/FRBP/Assets/Surveys-And-Data/survey-of-professional-forecasters/historical-data";

async function book(name: "medianLevel" | "medianGrowth"): Promise<XlsxBook> {
  return cached(`phil:spf:${name}`, 24 * HOUR, async () => openXlsx(await fetchBuffer(`${SPF}/${name}.xlsx`, 45000)));
}

interface SheetRows { headers: string[]; rows: (string | number | null)[][] }

function sheetRows(g: Grid): SheetRows {
  const headers = (g[0] ?? []).map((h) => String(h ?? "").trim());
  const rows = g.slice(1).filter((r) => typeof r?.[0] === "number" && typeof r?.[1] === "number");
  return { headers, rows };
}

function quarterLabel(year: number, q: number, offset: number): string {
  const idx = year * 4 + (q - 1) + offset;
  return `${Math.floor(idx / 4)}Q${(idx % 4) + 1}`;
}

/** Pull horizon columns for a level sheet. */
function horizons(sr: SheetRows, row: (string | number | null)[], prefix: string, year: number, q: number) {
  const out: { period: string; value: number | null }[] = [];
  sr.headers.forEach((h, i) => {
    const m = h.toUpperCase().match(new RegExp(`^${prefix.toUpperCase()}([1-6A-D])$`));
    if (!m) return;
    const k = m[1];
    let period: string;
    if (/\d/.test(k)) period = quarterLabel(year, q, Number(k) - 2);
    else period = String(year + "ABCD".indexOf(k));
    if (k === "1") return; // quarter before the survey — usually already reported
    out.push({ period: /\d/.test(k) ? period : `${period} (annual)`, value: round(num(row[i]), 2) });
  });
  return out;
}

const VARS: Record<string, { sheet: string; label: string; units: string; kind: "rate" | "inflation" | "rgdp" | "growthOnly" | "longrun" }> = {
  RGDP: { sheet: "RGDP", label: "Real GDP", units: "growth % (quarterly: q/q SAAR; annual: annual-average)", kind: "rgdp" },
  UNEMP: { sheet: "UNEMP", label: "Unemployment rate", units: "% (quarterly avg; annual = annual avg)", kind: "rate" },
  CPI: { sheet: "CPI", label: "Headline CPI inflation", units: "% (quarterly: q/q SAAR; annual: Q4/Q4)", kind: "inflation" },
  CORECPI: { sheet: "CORECPI", label: "Core CPI inflation", units: "% (quarterly: q/q SAAR; annual: Q4/Q4)", kind: "inflation" },
  PCE: { sheet: "PCE", label: "Headline PCE inflation", units: "% (quarterly: q/q SAAR; annual: Q4/Q4)", kind: "inflation" },
  COREPCE: { sheet: "COREPCE", label: "Core PCE inflation", units: "% (quarterly: q/q SAAR; annual: Q4/Q4)", kind: "inflation" },
  TBILL: { sheet: "TBILL", label: "3-month Treasury bill rate", units: "% (quarterly avg; annual = annual avg)", kind: "rate" },
  TBOND: { sheet: "TBOND", label: "10-year Treasury bond yield", units: "% (quarterly avg; annual = annual avg)", kind: "rate" },
  NGDP: { sheet: "NGDP", label: "Nominal GDP", units: "growth % q/q SAAR", kind: "growthOnly" },
  PGDP: { sheet: "PGDP", label: "GDP price index", units: "growth % q/q SAAR", kind: "growthOnly" },
  EMP: { sheet: "EMP_AVG", label: "Nonfarm payrolls", units: "avg monthly change, thousands", kind: "growthOnly" },
  HOUSING: { sheet: "HOUSING", label: "Housing starts", units: "growth % q/q SAAR", kind: "growthOnly" },
};

const LONGRUN: Record<string, string> = {
  CPI5YR: "CPI, next 5y avg %",
  PCE5YR: "PCE, next 5y avg %",
  CPI10: "CPI, next 10y avg %",
  PCE10: "PCE, next 10y avg %",
  CPI05YF05: "CPI 5y5y-forward %",
  RGDP10: "Real GDP growth, next 10y (Q1 survey)",
  PROD10: "Productivity growth, next 10y (Q1)",
  BOND10: "10y Treasury return, next 10y (Q1)",
  BILL10: "T-bill return, next 10y (Q1)",
  STOCK10: "S&P 500 return, next 10y (Q1)",
  UBAR: "Natural unemployment rate (Q3 survey)",
};

export async function philfedSpf(args: { variables?: string[]; compareToPrevious?: boolean }) {
  const want = (args.variables?.length ? args.variables : ["RGDP", "UNEMP", "CPI", "CORECPI", "PCE", "COREPCE", "TBILL", "TBOND"]).map((v) => String(v).toUpperCase());
  const bad = want.filter((v) => !VARS[v]);
  if (bad.length) throw new Error(`Unknown SPF variable(s): ${bad.join(", ")}. Valid: ${Object.keys(VARS).join(", ")}`);
  const compare = args.compareToPrevious !== false;
  const [lvl, gro] = await Promise.all([book("medianLevel"), book("medianGrowth")]);

  const ref = sheetRows(lvl.sheet("UNEMP"));
  const lastRef = ref.rows[ref.rows.length - 1];
  const year = Number(lastRef[0]), q = Number(lastRef[1]);

  const forecasts: any[] = [];
  for (const v of want) {
    const spec = VARS[v];
    try {
      let current: any[] = [];
      let previous: any[] | undefined;
      if (spec.kind === "rate" || spec.kind === "inflation") {
        const sr = sheetRows(lvl.sheet(spec.sheet));
        const row = sr.rows.find((r) => r[0] === year && r[1] === q);
        const prow = sr.rows.find((r) => (q === 1 ? r[0] === year - 1 && r[1] === 4 : r[0] === year && r[1] === q - 1));
        if (row) current = horizons(sr, row, spec.sheet, year, q);
        if (compare && prow) previous = horizons(sr, prow, spec.sheet, Number(prow[0]), Number(prow[1]));
      } else {
        // Growth sheets: d<var>2..6 = quarterly growth; for RGDP also derive annual-average growth from levels.
        const gs = gro.sheetNames.includes(spec.sheet) ? sheetRows(gro.sheet(spec.sheet)) : null;
        const pick = (sr: SheetRows, row: any[], y: number, qq: number) => {
          const out: any[] = [];
          sr.headers.forEach((h, i) => {
            const m = h.match(/(\d)$/);
            if (i < 2 || !m) return;
            out.push({ period: quarterLabel(y, qq, Number(m[1]) - 2), value: round(num(row[i]), 2) });
          });
          return out;
        };
        const prevOf = (sr: SheetRows) => sr.rows.find((r) => (q === 1 ? r[0] === year - 1 && r[1] === 4 : r[0] === year && r[1] === q - 1));
        if (gs) {
          const row = gs.rows.find((r) => r[0] === year && r[1] === q);
          if (row) current = pick(gs, row, year, q);
          const prow = prevOf(gs);
          if (compare && prow) previous = pick(gs, prow, Number(prow[0]), Number(prow[1]));
        }
        if (spec.kind === "rgdp") {
          const ls = sheetRows(lvl.sheet("RGDP"));
          const annual = (row: any[] | undefined, y: number) => {
            if (!row) return [];
            const val = (k: string) => num(row[ls.headers.findIndex((h) => h.toUpperCase() === `RGDP${k}`)]);
            const out: any[] = [];
            const pairs: [string, string, number][] = [["A", "B", y + 1], ["B", "C", y + 2], ["C", "D", y + 3]];
            for (const [a, b, py] of pairs) {
              const va = val(a), vb = val(b);
              if (va != null && vb != null && va > 0) out.push({ period: `${py} (annual)`, value: round((vb / va - 1) * 100, 2) });
            }
            return out;
          };
          const row = ls.rows.find((r) => r[0] === year && r[1] === q);
          current = current.concat(annual(row, year));
          const prow = prevOf(ls);
          if (compare && prow) previous = (previous ?? []).concat(annual(prow, Number(prow[0])));
        }
      }
      const prevMap = new Map((previous ?? []).map((p: any) => [p.period, p.value]));
      forecasts.push({
        variable: v,
        label: spec.label,
        units: spec.units,
        horizons: current.map((c) => ({ period: c.period, median: c.value, ...(compare ? { prevSurvey: prevMap.get(c.period) ?? null } : {}) })),
      });
    } catch (e: any) {
      forecasts.push({ variable: v, error: String(e?.message ?? e) });
    }
  }

  const longRun: Record<string, { label: string; value: number | null; surveyed: string }> = {};
  for (const [k, label] of Object.entries(LONGRUN)) {
    if (!lvl.sheetNames.includes(k)) continue;
    const sr = sheetRows(lvl.sheet(k));
    // Some are asked only once a year — take the most recent non-null value.
    for (let i = sr.rows.length - 1; i >= 0; i--) {
      const v = num(sr.rows[i][2]);
      if (v != null) { longRun[k] = { label, value: round(v, 2), surveyed: `${sr.rows[i][0]}Q${sr.rows[i][1]}` }; break; }
    }
  }

  return {
    dataSource: "Federal Reserve Bank of Philadelphia — Survey of Professional Forecasters (median forecasts)",
    survey: `${year}Q${q}`,
    forecasts,
    longRun,
    note: "Median of ~35-40 forecasters; released mid-Feb/May/Aug/Nov. Quarterly periods start at the survey quarter (nowcast) + 4 quarters ahead; '(annual)' = calendar years (inflation Q4/Q4; RGDP annual-average growth derived from median levels, so the survey year itself is omitted). prevSurvey = prior survey's median for the same period (revision). longRun items carry their survey date (some asked only in Q1/Q3). Cached 24h.",
  };
}
