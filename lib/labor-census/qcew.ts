/**
 * BLS QCEW open-data CSV slices, keyless.
 *
 * Endpoints (verified live 2026-10-22):
 *   https://data.bls.gov/cew/data/api/<year>/<q>/area/<areaFIPS>.csv   q = 1..4 (quarterly) or a (annual averages)
 *   https://data.bls.gov/cew/doc/titles/industry/industry_titles.csv   NAICS code → title (~2,700 rows)
 *   https://data.bls.gov/cew/doc/titles/area/area_titles.csv           area FIPS → title
 * A county slice is ~350 KB / ~2,000 rows covering every ownership × NAICS
 * level. Latest quarter available at build time: 2026 Q1 (2026 Q2 404s);
 * annual 2024 and 2025 Q4 both present. BLS publishes a quarter ~5 months
 * after it ends. own_code: 0 total, 1 federal, 2 state, 3 local, 5 private.
 * Each row already carries over-the-year (oty_*) changes.
 */
import { cached, clampInt, DAY, getText, parseCsv, round, toNum } from "./common";

const BASE = "https://data.bls.gov/cew/data/api";
const OWN: Record<string, string> = { "0": "Total covered", "1": "Federal government", "2": "State government", "3": "Local government", "5": "Private" };

function loadTitles(kind: "industry" | "area"): Promise<Map<string, string>> {
  return cached(`qcew:titles:${kind}`, 7 * DAY, async () => {
    const text = await getText(`https://data.bls.gov/cew/doc/titles/${kind}/${kind}_titles.csv`, 15000, 1);
    const m = new Map<string, string>();
    for (const r of parseCsv(text)) {
      const code = r[`${kind}_code`] ?? r[`${kind}_fips`] ?? "";
      const title = r[`${kind}_title`] ?? "";
      if (code) m.set(code, title.replace(/^NAICS \S+ /, "").replace(/^\d+ /, ""));
    }
    return m;
  });
}

async function loadSlice(year: number, q: string, area: string): Promise<Record<string, string>[] | null> {
  return cached(`qcew:${year}:${q}:${area}`, 1 * DAY, async () => {
    const url = `${BASE}/${year}/${q}/area/${area}.csv`;
    try {
      const text = await getText(url, 25000, 1);
      return parseCsv(text);
    } catch (e: any) {
      if (/HTTP 404/.test(String(e?.message))) return null;
      throw e;
    }
  });
}

/** Find the newest published quarter for an area, probing back from today. */
async function newestSlice(area: string, annual: boolean): Promise<{ year: number; q: string; rows: Record<string, string>[] }> {
  const now = new Date();
  const candidates: Array<{ year: number; q: string }> = [];
  if (annual) {
    for (let y = now.getFullYear() - 1; y >= now.getFullYear() - 3; y--) candidates.push({ year: y, q: "a" });
  } else {
    let y = now.getFullYear();
    let qq = Math.floor(now.getMonth() / 3); // the quarter before the current one
    if (qq === 0) {
      y--;
      qq = 4;
    }
    for (let i = 0; i < 6; i++) {
      candidates.push({ year: y, q: String(qq) });
      qq--;
      if (qq === 0) {
        qq = 4;
        y--;
      }
    }
  }
  for (const c of candidates) {
    const rows = await loadSlice(c.year, c.q, area);
    if (rows && rows.length) return { ...c, rows };
  }
  throw new Error(`QCEW: no published slice found for area ${area} in the last ${annual ? "3 years" : "6 quarters"}; check the area FIPS (county e.g. 17043, state 17000, US 'US000')`);
}

function shapeRow(r: Record<string, string>, annual: boolean, titles: Map<string, string>) {
  const naics = r.industry_code ?? "";
  const disclosed = (r.disclosure_code ?? "") !== "N";
  const base = {
    naics,
    industry: titles.get(naics) ?? naics,
    ownCode: r.own_code,
    ownership: OWN[r.own_code ?? ""] ?? r.own_code,
    aggLevel: Number(r.agglvl_code),
    suppressed: disclosed ? undefined : true,
  };
  if (annual) {
    return {
      ...base,
      establishments: toNum(r.annual_avg_estabs),
      employment: toNum(r.annual_avg_emplvl),
      totalWagesUSD: toNum(r.total_annual_wages),
      avgWeeklyWageUSD: toNum(r.annual_avg_wkly_wage),
      avgAnnualPayUSD: toNum(r.avg_annual_pay),
      lqEmployment: toNum(r.lq_annual_avg_emplvl),
      yoy: {
        establishmentsPct: toNum(r.oty_annual_avg_estabs_pct_chg),
        employmentPct: toNum(r.oty_annual_avg_emplvl_pct_chg),
        totalWagesPct: toNum(r.oty_total_annual_wages_pct_chg),
        avgWeeklyWagePct: toNum(r.oty_annual_avg_wkly_wage_pct_chg),
        avgAnnualPayPct: toNum(r.oty_avg_annual_pay_pct_chg),
      },
    };
  }
  const m1 = toNum(r.month1_emplvl);
  const m2 = toNum(r.month2_emplvl);
  const m3 = toNum(r.month3_emplvl);
  const avgEmp = m1 != null && m2 != null && m3 != null ? Math.round((m1 + m2 + m3) / 3) : null;
  return {
    ...base,
    establishments: toNum(r.qtrly_estabs),
    employment: avgEmp,
    employmentMonth3: m3,
    totalQuarterlyWagesUSD: toNum(r.total_qtrly_wages),
    avgWeeklyWageUSD: toNum(r.avg_wkly_wage),
    lqEmployment: toNum(r.lq_month3_emplvl),
    yoy: {
      establishmentsPct: toNum(r.oty_qtrly_estabs_pct_chg),
      employmentPct: toNum(r.oty_month3_emplvl_pct_chg),
      totalWagesPct: toNum(r.oty_total_qtrly_wages_pct_chg),
      avgWeeklyWagePct: toNum(r.oty_avg_wkly_wage_pct_chg),
    },
  };
}

export async function blsQcewCounty(args: any): Promise<any> {
  const areaRaw = String(args?.area ?? args?.county ?? args?.areaFips ?? "17043").trim().toUpperCase();
  const area = /^\d{5}$/.test(areaRaw) || /^(US000|C\d{4}|CS\d{3})$/.test(areaRaw) ? areaRaw : /^\d{2}$/.test(areaRaw) ? `${areaRaw}000` : areaRaw;
  const annual = args?.period === "annual" || String(args?.quarter ?? "").toLowerCase() === "a";
  const limit = clampInt(args?.limit, 25, 1, 100);
  const ownArg = args?.ownership == null ? "5" : String(args.ownership);
  const ownCodes: Set<string> | null = ownArg === "all" ? null : new Set(ownArg.split(",").map((s: string) => s.trim()));
  const naicsList: string[] = Array.isArray(args?.naics) ? args.naics.map(String) : args?.naics != null ? String(args.naics).split(",").map((s: string) => s.trim()) : [];
  const level = args?.level != null ? clampInt(args.level, 2, 2, 6) : null;

  let year: number;
  let q: string;
  let rows: Record<string, string>[];
  if (args?.year) {
    year = clampInt(args.year, 2024, 1990, 2100);
    q = annual ? "a" : String(clampInt(args?.quarter, 4, 1, 4));
    const got = await loadSlice(year, q, area);
    if (!got) throw new Error(`QCEW: ${year} ${annual ? "annual" : "Q" + q} not published for area ${area} (404). Omit year to get the newest slice.`);
    rows = got;
  } else {
    ({ year, q, rows } = await newestSlice(area, annual));
  }
  const [titles, areas] = await Promise.all([loadTitles("industry"), loadTitles("area")]);

  // Only size_code 0 (all sizes) rows carry the standard series.
  let sel = rows.filter((r) => (r.size_code ?? "0") === "0");
  if (ownCodes) sel = sel.filter((r) => ownCodes.has(r.own_code ?? ""));
  const naicsNorm = naicsList.map((n) => n.toUpperCase());
  if (naicsNorm.length) {
    sel = sel.filter((r) => naicsNorm.includes((r.industry_code ?? "").toUpperCase()));
  } else if (level != null) {
    const want = level === 2 ? 2 : level;
    sel = sel.filter((r) => {
      const c = r.industry_code ?? "";
      // 2-digit sectors include ranges like "31-33", "44-45", "48-49".
      if (want === 2) return /^\d{2}(-\d{2})?$/.test(c);
      return /^\d+$/.test(c) && c.length === want;
    });
  } else {
    // Default: total + 2-digit sectors.
    sel = sel.filter((r) => {
      const c = r.industry_code ?? "";
      return c === "10" || /^\d{2}(-\d{2})?$/.test(c);
    });
  }
  const total = rows.find((r) => r.own_code === "0" && r.industry_code === "10" && (r.size_code ?? "0") === "0");
  const shaped = sel.map((r) => shapeRow(r, annual, titles));
  const sortKey = String(args?.sortBy ?? "employment");
  shaped.sort((a: any, b: any) => (Number(b[sortKey] ?? b.employment ?? 0) || 0) - (Number(a[sortKey] ?? a.employment ?? 0) || 0));
  const hasIndustryHits = naicsNorm.length ? shaped.length > 0 : true;

  return {
    source: "BLS QCEW open data (data.bls.gov/cew)",
    fetchedAt: new Date().toISOString(),
    area: { fips: area, name: areas.get(area) ?? area },
    period: annual ? `${year} annual average` : `${year} Q${q}`,
    ownershipFilter: ownCodes ? [...ownCodes].map((c) => OWN[c] ?? c) : "all",
    areaTotalAllOwnerships: total ? shapeRow(total, annual, titles) : null,
    rows: shaped.slice(0, limit),
    rowCount: shaped.length,
    notes: [
      "Wages in USD; employment = quarterly 3-month average (or annual average). yoy = over-the-year % change published by BLS. suppressed=true rows are non-disclosable (small cell).",
      "lqEmployment = location quotient vs US (1.0 = national share; 2.5 = 2.5x concentration).",
      ...(hasIndustryHits ? [] : [`No rows for naics ${naicsNorm.join(",")} with ownership ${ownArg}; try ownership 'all' or a parent code (52, 523, 5239).`]),
    ],
  };
}
