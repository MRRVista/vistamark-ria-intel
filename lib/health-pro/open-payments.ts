/**
 * CMS Open Payments (Sunshine Act) — https://openpaymentsdata.cms.gov
 *
 * The site is DKAN 2; the public datastore query API is keyless:
 *   GET /api/1/datastore/query/{datasetId}/0?conditions[0][property]=covered_recipient_npi&...
 * `limit` is capped at 500 by JSON-schema validation; `count=true` triggers a
 * COUNT(*) which is slow on the 14M-row general-payments tables, so we keep it
 * off. GROUP BY aggregates (sum/count) filtered by NPI answer in ~2 s;
 * filtered by zip they take 30–60 s (full scan), so zip ranking is cached 24 h
 * and advertised as slow. The /api/1/datastore/sql endpoint returned 400 for
 * every query form tried from the sandbox and is not used.
 *
 * Dataset ids (metastore, verified 2026-10-22; refreshed each June/Jan):
 *   General Payment Data PY2019..PY2025 and the Covered Recipient Profile
 *   Supplement (one row per physician/NPP with NPI, specialty, business address).
 */
import { assertNpi, assertState, assertZip5, cached, clampInt, dkanFetch, DAY, HOUR, likePattern, num, round, str, titleCase, nz } from "./common";

const HOST = "https://openpaymentsdata.cms.gov/api/1/datastore/query";
const SOURCE = "CMS Open Payments (openpaymentsdata.cms.gov DKAN datastore)";

/** General Payment Data dataset ids by program year (metastore identifiers). */
export const GENERAL_PAYMENTS: Record<number, string> = {
  2019: "4e54dd6c-30f8-4f86-86a7-3c109a89528e",
  2020: "a08c4b30-5cf3-4948-ad40-36f404619019",
  2021: "0380bbeb-aea1-58b6-b708-829f92a48202",
  2022: "df01c2f8-dc1f-4e79-96cb-8208beaf143c",
  2023: "fb3a65aa-c901-4a38-a813-b04b00dfa2a9",
  2024: "e6b17c6a-2534-4207-a4a1-6746a14911ff",
  2025: "fb0b1734-1410-429d-92f6-3f4b35218e5e",
};
export const LATEST_PROGRAM_YEAR = 2025;
export const PROFILE_SUPPLEMENT = "23160558-6742-54ff-8b9f-cac7d514ff4e";

const F = {
  npi: "covered_recipient_npi",
  first: "covered_recipient_first_name",
  last: "covered_recipient_last_name",
  type: "covered_recipient_type",
  spec: "covered_recipient_specialty_1",
  city: "recipient_city",
  state: "recipient_state",
  zip: "recipient_zip_code",
  mfr: "applicable_manufacturer_or_applicable_gpo_making_payment_name",
  amt: "total_amount_of_payment_usdollars",
  date: "date_of_payment",
  nature: "nature_of_payment_or_transfer_of_value",
  form: "form_of_payment_or_transfer_of_value",
  product: "name_of_drug_or_biological_or_device_or_medical_supply_1",
  productType: "indicate_drug_or_biological_or_device_or_medical_supply_1",
  ownership: "physician_ownership_indicator",
  recordId: "record_id",
  n: "number_of_payments_included_in_total_amount",
} as const;

function yearId(year: number): string {
  const id = GENERAL_PAYMENTS[year];
  if (!id) throw new Error(`program_year must be one of ${Object.keys(GENERAL_PAYMENTS).join(", ")} (got ${year})`);
  return id;
}

const NATURE_SHORT: Array<[RegExp, string]> = [
  [/^Compensation for services other than consulting/i, "Speaking/faculty fees (non-CME)"],
  [/^Compensation for serving as faculty or as a speaker for an accredited/i, "Accredited CME speaking"],
  [/^Compensation for serving as faculty or as a speaker for a medical education program/i, "Medical-education speaking"],
  [/^Consulting Fee/i, "Consulting fee"],
  [/^Food and Beverage/i, "Food & beverage"],
  [/^Travel and Lodging/i, "Travel & lodging"],
  [/^Royalty or License/i, "Royalty / license"],
  [/^Honoraria/i, "Honoraria"],
  [/^Education/i, "Education"],
  [/^Grant/i, "Grant"],
  [/^Gift/i, "Gift"],
  [/^Entertainment/i, "Entertainment"],
  [/^Charitable Contribution/i, "Charitable contribution"],
  [/^Current or prospective ownership/i, "Ownership / investment interest"],
  [/^Space rental/i, "Space rental / facility fees"],
  [/^Debt forgiveness/i, "Debt forgiveness"],
  [/^Long term medical supply/i, "Long-term device loan"],
  [/^Acquisitions/i, "Acquisitions"],
];
function natureShort(s: string | null): string {
  if (!s) return "Unknown";
  for (const [re, label] of NATURE_SHORT) if (re.test(s)) return label;
  return s.length > 60 ? s.slice(0, 57) + "..." : s;
}

interface Row { [k: string]: string }

function groupSum(rows: Row[], key: string): Array<{ name: string; total: number; payments: number }> {
  const m = new Map<string, { total: number; payments: number }>();
  for (const r of rows) {
    const k = str(r[key]) ?? "(blank)";
    const g = m.get(k) ?? { total: 0, payments: 0 };
    g.total += num(r[F.amt]) ?? 0;
    g.payments += 1;
    m.set(k, g);
  }
  return [...m.entries()].map(([name, g]) => ({ name, total: round(g.total, 2)!, payments: g.payments })).sort((a, b) => b.total - a.total);
}

/** Per-NPI summary for one program year: total, by manufacturer, by nature, products, largest payments. */
async function npiYearSummary(npi: string, year: number, topN: number) {
  const id = yearId(year);
  const base = `${HOST}/${id}/0`;
  const rows = await cached(`op:rows:${year}:${npi}`, 12 * HOUR, () =>
    dkanFetch<Row>(base, {
      limit: 500,
      properties: [F.first, F.last, F.type, F.spec, F.city, F.state, F.zip, F.mfr, F.amt, F.date, F.nature, F.form, F.product, F.productType, F.ownership, F.n],
      conditions: [{ property: F.npi, value: npi }],
      sorts: [{ property: F.amt, order: "desc" }],
    }, 30000)
  );
  const r = rows.results;
  let total: number;
  let payments: number;
  let byManufacturer: Array<{ name: string; total: number; payments: number }>;
  let byNature: Array<{ name: string; total: number; payments: number }>;
  let complete = true;
  if (r.length < 500) {
    total = r.reduce((s, x) => s + (num(x[F.amt]) ?? 0), 0);
    payments = r.length;
    byManufacturer = groupSum(r, F.mfr);
    byNature = groupSum(r, F.nature);
  } else {
    // > 500 payment lines: let the server aggregate (fast when filtered by NPI).
    complete = false;
    const [mfr, nat] = await Promise.all([
      cached(`op:aggmfr:${year}:${npi}`, 12 * HOUR, () =>
        dkanFetch<Row>(base, {
          limit: 100,
          properties: [F.mfr],
          aggregates: [{ op: "sum", property: F.amt, alias: "total" }, { op: "count", property: F.recordId, alias: "payments" }],
          groupBy: [F.mfr],
          conditions: [{ property: F.npi, value: npi }],
          sorts: [{ property: "total", order: "desc" }],
        }, 40000)
      ),
      cached(`op:aggnat:${year}:${npi}`, 12 * HOUR, () =>
        dkanFetch<Row>(base, {
          limit: 30,
          properties: [F.nature],
          aggregates: [{ op: "sum", property: F.amt, alias: "total" }, { op: "count", property: F.recordId, alias: "payments" }],
          groupBy: [F.nature],
          conditions: [{ property: F.npi, value: npi }],
          sorts: [{ property: "total", order: "desc" }],
        }, 40000)
      ),
    ]);
    byManufacturer = mfr.results.map((x) => ({ name: str(x[F.mfr]) ?? "(blank)", total: round(num(x.total), 2)!, payments: num(x.payments) ?? 0 }));
    byNature = nat.results.map((x) => ({ name: str(x[F.nature]) ?? "(blank)", total: round(num(x.total), 2)!, payments: num(x.payments) ?? 0 }));
    total = byNature.reduce((s, x) => s + x.total, 0);
    payments = byNature.reduce((s, x) => s + x.payments, 0);
  }
  const first = r[0];
  const products = groupSum(r.filter((x) => str(x[F.product])), F.product).slice(0, topN);
  const ownership = r.some((x) => /^Y/i.test(x[F.ownership] ?? ""));
  return {
    programYear: year,
    recipient: first
      ? {
          name: `${titleCase(first[F.first]) ?? ""} ${titleCase(first[F.last]) ?? ""}`.trim(),
          type: nz(first[F.type]),
          specialty: nz(first[F.spec]),
          city: titleCase(first[F.city]),
          state: nz(first[F.state]),
          zip: nz(first[F.zip])?.slice(0, 5),
        }
      : null,
    totalUsd: round(total, 2),
    paymentLines: payments,
    linesFetched: r.length,
    note: complete ? undefined : "More than 500 payment lines — totals/manufacturer/nature come from server-side aggregates; products and largest payments reflect the 500 largest lines only.",
    physicianOwnershipFlag: ownership || undefined,
    byNature: byNature.slice(0, topN).map((x) => ({ nature: natureShort(x.name), total: x.total, payments: x.payments })),
    topManufacturers: byManufacturer.slice(0, topN),
    topProducts: products.length ? products.map((p) => ({ product: p.name, total: p.total, payments: p.payments })) : undefined,
    largestPayments: r.slice(0, Math.min(topN, 5)).map((x) => ({
      date: nz(x[F.date]),
      amount: round(num(x[F.amt]), 2),
      manufacturer: nz(x[F.mfr]),
      nature: natureShort(str(x[F.nature])),
      product: nz(x[F.product]),
    })),
  };
}

/** Resolve name + state (+ optional first name/city) to NPIs via the Covered Recipient Profile Supplement. */
async function resolveByName(last: string, state: string, first?: string, city?: string, limit = 10) {
  const conditions = [
    { property: "covered_recipient_profile_last_name", value: last.toUpperCase() },
    { property: "covered_recipient_profile_state", value: state },
  ] as Array<{ property: string; value: string; operator?: any }>;
  if (first) conditions.push({ property: "covered_recipient_profile_first_name", value: likePattern(first, "prefix"), operator: "like" });
  if (city) conditions.push({ property: "covered_recipient_profile_city", value: city.toUpperCase() });
  const res = await cached(`op:profile:${last}:${state}:${first ?? ""}:${city ?? ""}`, DAY, () =>
    dkanFetch<Row>(`${HOST}/${PROFILE_SUPPLEMENT}/0`, {
      limit: Math.min(limit, 50),
      properties: [
        "covered_recipient_npi", "covered_recipient_profile_first_name", "covered_recipient_profile_middle_name", "covered_recipient_profile_last_name",
        "covered_recipient_profile_type", "covered_recipient_profile_primary_specialty", "covered_recipient_profile_city", "covered_recipient_profile_state",
        "covered_recipient_profile_zipcode", "covered_recipient_profile_address_line_1",
      ],
      conditions,
    }, 30000)
  );
  return res.results.map((p) => ({
    npi: nz(p.covered_recipient_npi),
    name: [titleCase(p.covered_recipient_profile_first_name), titleCase(p.covered_recipient_profile_middle_name), titleCase(p.covered_recipient_profile_last_name)].filter(Boolean).join(" "),
    type: nz(p.covered_recipient_profile_type),
    specialty: nz(p.covered_recipient_profile_primary_specialty),
    practiceCity: titleCase(p.covered_recipient_profile_city),
    state: nz(p.covered_recipient_profile_state),
    zip: nz(p.covered_recipient_profile_zipcode)?.slice(0, 5),
    practiceAddress: titleCase(p.covered_recipient_profile_address_line_1),
  }));
}

export interface OpenPaymentsArgs {
  npi?: string | number;
  last_name?: string;
  first_name?: string;
  state?: string;
  city?: string;
  zip?: string;
  program_year?: number;
  years?: number;
  top?: number;
  limit?: number;
}

export async function cmsOpenPayments(args: OpenPaymentsArgs) {
  const a = args ?? {};
  const year = clampInt(a.program_year, LATEST_PROGRAM_YEAR, 2019, LATEST_PROGRAM_YEAR);
  const nYears = clampInt(a.years, 1, 1, 5);
  const topN = clampInt(a.top, 8, 1, 25);
  const fetchedAt = new Date().toISOString();

  // Mode 3: zip ranking (slow full-scan aggregate; cached 24h).
  if (a.zip && !a.npi && !a.last_name) {
    const zip = assertZip5(a.zip);
    const limit = clampInt(a.limit, 15, 1, 25);
    const id = yearId(year);
    const started = Date.now();
    const res = await cached(`op:zip:${year}:${zip}`, DAY, () =>
      dkanFetch<Row>(`${HOST}/${id}/0`, {
        limit: 25,
        properties: [F.npi, F.first, F.last, F.spec],
        aggregates: [{ op: "sum", property: F.amt, alias: "total" }, { op: "count", property: F.recordId, alias: "payments" }],
        groupBy: [F.npi, F.first, F.last, F.spec],
        conditions: [{ property: F.zip, value: zip }],
        sorts: [{ property: "total", order: "desc" }],
      }, 58000)
    );
    return {
      source: SOURCE,
      fetchedAt,
      mode: "zip_ranking",
      programYear: year,
      zip,
      elapsedMs: Date.now() - started,
      note: "Ranks covered recipients whose Open Payments business address is in this ZIP by total general payments (USD). Teaching hospitals are excluded (blank NPI rows dropped). Full-table aggregate upstream: 20–60 s cold, cached 24 h.",
      results: res.results
        .filter((r) => str(r[F.npi]))
        .slice(0, limit)
        .map((r) => ({
          npi: r[F.npi],
          name: `${titleCase(r[F.first]) ?? ""} ${titleCase(r[F.last]) ?? ""}`.trim(),
          specialty: nz(r[F.spec]),
          totalUsd: round(num(r.total), 2),
          paymentLines: num(r.payments),
        })),
    };
  }

  // Resolve NPI from name if needed.
  let npi: string | null = a.npi != null && String(a.npi).trim() ? assertNpi(a.npi) : null;
  let candidates: Awaited<ReturnType<typeof resolveByName>> | undefined;
  if (!npi) {
    const last = str(a.last_name);
    if (!last) throw new Error("cms_open_payments needs `npi`, or `last_name` + `state` (optionally first_name/city), or `zip` for a ZIP ranking");
    const state = assertState(a.state ?? "");
    candidates = await resolveByName(last, state, str(a.first_name) ?? undefined, str(a.city) ?? undefined, 10);
    if (!candidates.length) {
      return { source: SOURCE, fetchedAt, mode: "name_lookup", found: false, note: `No covered recipient named ${last} in ${state} in the Open Payments profile supplement — the person may never have received a reportable payment. Try nppes_search for the NPI.` };
    }
    if (candidates.length > 1) {
      return {
        source: SOURCE,
        fetchedAt,
        mode: "name_lookup",
        found: true,
        ambiguous: true,
        note: "Several covered recipients match — call again with `npi` (or add first_name / city).",
        candidates,
      };
    }
    npi = candidates[0]!.npi!;
  }

  const yearsList: number[] = [];
  for (let y = year; y > year - nYears && GENERAL_PAYMENTS[y]; y--) yearsList.push(y);
  const summaries = await Promise.all(yearsList.map((y) => npiYearSummary(npi!, y, topN)));
  const any = summaries.find((s) => s.recipient);
  const multi = summaries.length > 1
    ? {
        totalUsd: round(summaries.reduce((s, x) => s + (x.totalUsd ?? 0), 0), 2),
        byYear: summaries.map((s) => ({ year: s.programYear, totalUsd: s.totalUsd, paymentLines: s.paymentLines })),
      }
    : undefined;
  return {
    source: SOURCE,
    fetchedAt,
    mode: "npi",
    npi,
    found: !!any,
    recipient: any?.recipient ?? candidates?.[0] ?? null,
    note: any ? undefined : `No general payments recorded for NPI ${npi} in program year${yearsList.length > 1 ? "s" : ""} ${yearsList.join(", ")}.`,
    multiYear: multi,
    years: summaries.map(({ recipient: _r, ...rest }) => rest),
  };
}
