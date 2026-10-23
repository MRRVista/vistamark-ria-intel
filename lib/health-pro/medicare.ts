/**
 * data.cms.gov — Medicare Physician & Other Practitioners (Part B FFS, annual)
 *
 *   by Provider:             https://data.cms.gov/data-api/v1/dataset/{id}/data
 *   by Provider and Service: https://data.cms.gov/data-api/v1/dataset/{id}/data
 *
 * Keyless JSON. Query params: filter[Col]=v (exact), filter[x][condition][path|operator|value]
 * (operators =, CONTAINS, STARTS_WITH, >, <, IN...), size (≤5000), offset, sort=-Col,
 * column=A,B,C. `/data/stats` with the same filters returns {found_rows,total_rows}.
 * Dataset ids below are the yearly versions from https://data.cms.gov/data.json
 * (verified 2026-10-22; 2024 vintage released 2026-05-21). Amounts are USD.
 */
import { assertNpi, assertState, assertZip5, cached, clampInt, fetchJson, HOUR, num, nz, round, str, DAY } from "./common";

const API = "https://data.cms.gov/data-api/v1/dataset";
const SOURCE = "CMS Medicare Physician & Other Practitioners (data.cms.gov)";

/** "by Provider" (one row per NPI per year). */
export const BY_PROVIDER: Record<number, string> = {
  2024: "8889d81e-2ee7-448f-8713-f071038289b5",
  2023: "8ba584c6-a43a-4b0b-a35a-eb9a59e3a571",
  2022: "21555c17-ec1b-4e74-b2c6-925c6cbb3147",
  2021: "44e0a489-666c-4ea4-a1a2-360b6cdc19db",
  2020: "29d799aa-c660-44fe-a51a-72c4b3e661ac",
  2019: "6a53afe5-1cbc-4b33-9dc8-926ee532dc66",
};
/** "by Provider and Service" (one row per NPI × HCPCS × place of service). */
export const BY_PROVIDER_SERVICE: Record<number, string> = {
  2024: "92396110-2aed-4d63-a6a2-5d6207d46a29",
  2023: "0e9f2f2b-7bf9-451a-912c-e02e654dd725",
  2022: "e650987d-01b7-4f09-b75e-b0b075afbf98",
  2021: "31dc2c47-f297-4948-bfb4-075e1bec3a02",
};
export const LATEST_YEAR = 2024;

type Row = Record<string, string>;

function url(id: string, params: Record<string, string | number | undefined>, stats = false): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, String(v));
  return `${API}/${id}/data${stats ? "/stats" : ""}?${p.toString()}`;
}

const PROVIDER_COLS = [
  "Rndrng_NPI", "Rndrng_Prvdr_Last_Org_Name", "Rndrng_Prvdr_First_Name", "Rndrng_Prvdr_Crdntls", "Rndrng_Prvdr_Ent_Cd",
  "Rndrng_Prvdr_St1", "Rndrng_Prvdr_St2", "Rndrng_Prvdr_City", "Rndrng_Prvdr_State_Abrvtn", "Rndrng_Prvdr_Zip5", "Rndrng_Prvdr_Type", "Rndrng_Prvdr_Mdcr_Prtcptg_Ind",
  "Tot_HCPCS_Cds", "Tot_Benes", "Tot_Srvcs", "Tot_Sbmtd_Chrg", "Tot_Mdcr_Alowd_Amt", "Tot_Mdcr_Pymt_Amt", "Tot_Mdcr_Stdzd_Amt",
  "Drug_Mdcr_Pymt_Amt", "Med_Mdcr_Pymt_Amt", "Bene_Avg_Age", "Bene_Avg_Risk_Scre",
];

function compactProvider(r: Row) {
  const isOrg = r.Rndrng_Prvdr_Ent_Cd === "O";
  const name = isOrg ? r.Rndrng_Prvdr_Last_Org_Name : [r.Rndrng_Prvdr_First_Name, r.Rndrng_Prvdr_Last_Org_Name].filter(Boolean).join(" ");
  return {
    npi: r.Rndrng_NPI,
    name,
    credentials: isOrg ? undefined : nz(r.Rndrng_Prvdr_Crdntls),
    entity: isOrg ? "organization" : "individual",
    providerType: nz(r.Rndrng_Prvdr_Type),
    practiceAddress: {
      line1: nz(r.Rndrng_Prvdr_St1), line2: nz(r.Rndrng_Prvdr_St2), city: nz(r.Rndrng_Prvdr_City), state: nz(r.Rndrng_Prvdr_State_Abrvtn), zip: nz(r.Rndrng_Prvdr_Zip5),
    },
    participating: r.Rndrng_Prvdr_Mdcr_Prtcptg_Ind === "Y",
    beneficiaries: num(r.Tot_Benes),
    services: num(r.Tot_Srvcs),
    distinctHcpcs: num(r.Tot_HCPCS_Cds),
    submittedChargesUsd: round(num(r.Tot_Sbmtd_Chrg), 0),
    medicareAllowedUsd: round(num(r.Tot_Mdcr_Alowd_Amt), 0),
    medicarePaidUsd: round(num(r.Tot_Mdcr_Pymt_Amt), 0),
    medicareStandardizedUsd: round(num(r.Tot_Mdcr_Stdzd_Amt), 0),
    drugPaidUsd: round(num(r.Drug_Mdcr_Pymt_Amt), 0),
    medicalPaidUsd: round(num(r.Med_Mdcr_Pymt_Amt), 0),
    beneAvgAge: num(r.Bene_Avg_Age),
    beneAvgRiskScore: num(r.Bene_Avg_Risk_Scre),
  };
}

export interface MedicareArgs {
  npi?: string | number;
  last_name?: string;
  first_name?: string;
  zip?: string;
  city?: string;
  state?: string;
  provider_type?: string;
  year?: number;
  years?: number;
  limit?: number;
  offset?: number;
  sort?: "medicare_paid" | "services" | "beneficiaries" | "allowed";
  include_services?: boolean;
  services_limit?: number;
  individuals_only?: boolean;
}

const SORT_COL: Record<string, string> = {
  medicare_paid: "Tot_Mdcr_Pymt_Amt",
  services: "Tot_Srvcs",
  beneficiaries: "Tot_Benes",
  allowed: "Tot_Mdcr_Alowd_Amt",
};

function yearId(table: Record<number, string>, year: number, label: string): string {
  const id = table[year];
  if (!id) throw new Error(`${label}: year must be one of ${Object.keys(table).join(", ")} (got ${year})`);
  return id;
}

async function topServices(npi: string, year: number, limit: number) {
  const id = BY_PROVIDER_SERVICE[year] ?? BY_PROVIDER_SERVICE[LATEST_YEAR]!;
  const rows = await cached(`mdcr:svc:${year}:${npi}`, DAY, () =>
    fetchJson<Row[]>(url(id, {
      "filter[Rndrng_NPI]": npi,
      size: limit,
      sort: "-Tot_Srvcs",
      column: "HCPCS_Cd,HCPCS_Desc,HCPCS_Drug_Ind,Place_Of_Srvc,Tot_Benes,Tot_Srvcs,Avg_Sbmtd_Chrg,Avg_Mdcr_Pymt_Amt",
    }), 20000, 1)
  );
  return rows.map((s) => ({
    hcpcs: s.HCPCS_Cd,
    desc: (s.HCPCS_Desc ?? "").slice(0, 80),
    drug: s.HCPCS_Drug_Ind === "Y" || undefined,
    place: s.Place_Of_Srvc === "F" ? "facility" : "office",
    services: num(s.Tot_Srvcs),
    beneficiaries: num(s.Tot_Benes),
    avgSubmittedUsd: round(num(s.Avg_Sbmtd_Chrg), 0),
    avgMedicarePaidUsd: round(num(s.Avg_Mdcr_Pymt_Amt), 2),
    estMedicarePaidUsd: round((num(s.Tot_Srvcs) ?? 0) * (num(s.Avg_Mdcr_Pymt_Amt) ?? 0), 0),
  }));
}

export async function cmsMedicareProviderUtilization(args: MedicareArgs) {
  const a = args ?? {};
  const year = clampInt(a.year, LATEST_YEAR, 2019, LATEST_YEAR);
  const fetchedAt = new Date().toISOString();
  const limit = clampInt(a.limit, 15, 1, 25);
  const offset = clampInt(a.offset, 0, 0, 100000);
  const sortCol = SORT_COL[a.sort ?? "medicare_paid"] ?? SORT_COL.medicare_paid!;

  // Mode 1: single NPI (optionally multi-year + top HCPCS).
  if (a.npi != null && String(a.npi).trim()) {
    const npi = assertNpi(a.npi);
    const nYears = clampInt(a.years, 1, 1, 6);
    const yrs: number[] = [];
    for (let y = year; y > year - nYears && BY_PROVIDER[y]; y--) yrs.push(y);
    const perYear = await Promise.all(
      yrs.map((y) =>
        cached(`mdcr:npi:${y}:${npi}`, DAY, () =>
          fetchJson<Row[]>(url(BY_PROVIDER[y]!, { "filter[Rndrng_NPI]": npi, size: 1, column: PROVIDER_COLS.join(",") }), 20000, 1)
        ).then((rows) => ({ year: y, row: rows[0] }))
      )
    );
    const latest = perYear.find((p) => p.row);
    if (!latest) {
      return { source: SOURCE, fetchedAt, npi, found: false, note: `NPI ${npi} has no Medicare Part B FFS billing row for ${yrs.join(", ")} (providers with ≤10 beneficiaries are suppressed; hospital-employed physicians often bill under the facility).` };
    }
    const services = a.include_services !== false ? await topServices(npi, latest.year, clampInt(a.services_limit, 8, 1, 25)).catch(() => undefined) : undefined;
    const trend = perYear.filter((p) => p.row).map((p) => ({
      year: p.year,
      beneficiaries: num(p.row!.Tot_Benes),
      services: num(p.row!.Tot_Srvcs),
      medicarePaidUsd: round(num(p.row!.Tot_Mdcr_Pymt_Amt), 0),
      submittedChargesUsd: round(num(p.row!.Tot_Sbmtd_Chrg), 0),
    }));
    return {
      source: SOURCE,
      fetchedAt,
      dataYear: latest.year,
      found: true,
      ...compactProvider(latest.row!),
      trend: trend.length > 1 ? trend : undefined,
      topServices: services,
      note: "Medicare Part B fee-for-service only (no Medicare Advantage, commercial or facility revenue) — a lower bound on practice billing; useful as a relative prominence signal within a specialty.",
    };
  }

  // Mode 2: ranking by geography / name / specialty.
  const id = yearId(BY_PROVIDER, year, "cms_medicare_provider_utilization");
  const params: Record<string, string | number | undefined> = { size: limit, offset, sort: `-${sortCol}`, column: PROVIDER_COLS.join(",") };
  const where: string[] = [];
  if (a.zip) { params["filter[Rndrng_Prvdr_Zip5]"] = assertZip5(a.zip); where.push(`zip=${params["filter[Rndrng_Prvdr_Zip5]"]}`); }
  if (a.city) { params["filter[Rndrng_Prvdr_City]"] = str(a.city)!; where.push(`city=${a.city}`); }
  if (a.state) { params["filter[Rndrng_Prvdr_State_Abrvtn]"] = assertState(a.state); where.push(`state=${params["filter[Rndrng_Prvdr_State_Abrvtn]"]}`); }
  if (a.provider_type) {
    params["filter[pt][condition][path]"] = "Rndrng_Prvdr_Type";
    params["filter[pt][condition][operator]"] = "CONTAINS";
    params["filter[pt][condition][value]"] = str(a.provider_type)!;
    where.push(`provider_type~${a.provider_type}`);
  }
  if (a.last_name) {
    params["filter[ln][condition][path]"] = "Rndrng_Prvdr_Last_Org_Name";
    params["filter[ln][condition][operator]"] = "STARTS_WITH";
    params["filter[ln][condition][value]"] = str(a.last_name)!;
    where.push(`last_name^${a.last_name}`);
  }
  if (a.first_name) {
    params["filter[fn][condition][path]"] = "Rndrng_Prvdr_First_Name";
    params["filter[fn][condition][operator]"] = "STARTS_WITH";
    params["filter[fn][condition][value]"] = str(a.first_name)!;
    where.push(`first_name^${a.first_name}`);
  }
  if (a.individuals_only) { params["filter[Rndrng_Prvdr_Ent_Cd]"] = "I"; where.push("individuals only"); }
  if (!where.length) throw new Error("cms_medicare_provider_utilization needs `npi`, or at least one of zip / city+state / state+provider_type / last_name");
  if (a.city && !a.state) throw new Error("city filter requires state");
  if (a.state && !a.zip && !a.city && !a.provider_type && !a.last_name) throw new Error("state alone is too broad — add zip, city, provider_type or last_name");

  const key = `mdcr:list:${year}:${JSON.stringify(params)}`;
  const rows = await cached(key, 6 * HOUR, () => fetchJson<Row[]>(url(id, params), 25000, 1));
  const statsParams = Object.fromEntries(Object.entries(params).filter(([k]) => k.startsWith("filter[")));
  const stats = await cached(`${key}:stats`, 6 * HOUR, () => fetchJson<{ found_rows?: number }>(url(id, statsParams, true), 15000, 1)).catch(() => undefined);
  const list = rows.map(compactProvider);
  return {
    source: SOURCE,
    fetchedAt,
    dataYear: year,
    filters: where,
    sortedBy: a.sort ?? "medicare_paid",
    matched: stats?.found_rows ?? undefined,
    returned: list.length,
    nextOffset: stats?.found_rows != null && offset + list.length < stats.found_rows ? offset + list.length : null,
    aggregates: list.length
      ? {
          medicarePaidUsd: round(list.reduce((s, r) => s + (r.medicarePaidUsd ?? 0), 0), 0),
          beneficiaries: list.reduce((s, r) => s + (r.beneficiaries ?? 0), 0),
          note: "sums cover the returned page only",
        }
      : undefined,
    results: list,
  };
}
