/**
 * College Scorecard — GET https://api.data.gov/ed/collegescorecard/v1/schools
 * ?api_key=…&school.name=…&fields=… (verified live with DEMO_KEY; production
 * uses DATA_GOV_API_KEY from https://api.data.gov/signup). Rate limit 1,000/h
 * per key. Annual release (data year shown in `latest`). Dotted field names;
 * `school.name` is a substring match; `school.state`, `school.city` exact.
 */
import { cached, clampInt, HOUR, jsonGet, requireKey, round } from "./common";

const BASE = "https://api.data.gov/ed/collegescorecard/v1/schools";
const FIELDS = [
  "id", "school.name", "school.city", "school.state", "school.zip", "school.school_url", "school.ownership", "school.carnegie_basic",
  "school.endowment.begin", "school.endowment.end",
  "latest.student.size", "latest.admissions.admission_rate.overall", "latest.admissions.sat_scores.average.overall",
  "latest.cost.tuition.in_state", "latest.cost.tuition.out_of_state", "latest.cost.attendance.academic_year", "latest.cost.avg_net_price.overall",
  "latest.aid.median_debt.completers.overall", "latest.aid.pell_grant_rate",
  "latest.completion.rate_suppressed.overall",
  "latest.earnings.6_yrs_after_entry.median", "latest.earnings.10_yrs_after_entry.median",
];
const OWNERSHIP: Record<number, string> = { 1: "public", 2: "private nonprofit", 3: "private for-profit" };

export async function collegeScorecard(args: any) {
  const apiKey = requireKey("DATA_GOV_API_KEY", "free key at https://api.data.gov/signup (shared by College Scorecard and SAM.gov)");
  const q = new URLSearchParams();
  if (args?.name) q.set("school.name", String(args.name));
  if (args?.state) q.set("school.state", String(args.state).toUpperCase());
  if (args?.city) q.set("school.city", String(args.city));
  if (args?.zip) q.set("school.zip", String(args.zip));
  if (args?.unit_id) q.set("id", String(args.unit_id));
  if (args?.min_size) q.set("latest.student.size__range", `${Number(args.min_size)}..`);
  if (args?.degree_granting_only !== false) q.set("school.degrees_awarded.predominant__range", "2..4");
  if (![...q.keys()].some((k) => k !== "school.degrees_awarded.predominant__range")) throw new Error("college_scorecard needs name, unit_id, zip or city/state");
  q.set("fields", FIELDS.join(","));
  q.set("per_page", String(clampInt(args?.limit, 10, 1, 25)));
  q.set("sort", String(args?.sort ?? "latest.student.size:desc"));
  const url = `${BASE}?api_key=${encodeURIComponent(apiKey)}&${q.toString()}`;
  const data = await cached(`scorecard:${q.toString()}`, 24 * HOUR, () => jsonGet<any>(url));
  const rows = (data?.results ?? []).map((r: any) => ({
    unitId: r.id,
    name: r["school.name"],
    city: r["school.city"],
    state: r["school.state"],
    ownership: OWNERSHIP[r["school.ownership"]] ?? r["school.ownership"],
    url: r["school.school_url"],
    students: r["latest.student.size"],
    admissionRate: round(r["latest.admissions.admission_rate.overall"], 3),
    satAverage: r["latest.admissions.sat_scores.average.overall"] ?? null,
    tuitionInState: r["latest.cost.tuition.in_state"],
    tuitionOutOfState: r["latest.cost.tuition.out_of_state"],
    costOfAttendance: r["latest.cost.attendance.academic_year"],
    avgNetPrice: r["latest.cost.avg_net_price.overall"],
    medianDebtCompleters: r["latest.aid.median_debt.completers.overall"],
    pellRate: round(r["latest.aid.pell_grant_rate"], 3),
    completionRate: round(r["latest.completion.rate_suppressed.overall"], 3),
    medianEarnings6y: r["latest.earnings.6_yrs_after_entry.median"],
    medianEarnings10y: r["latest.earnings.10_yrs_after_entry.median"],
    endowmentBegin: r["school.endowment.begin"],
    endowmentEnd: r["school.endowment.end"],
  }));
  return {
    source: "College Scorecard API (api.data.gov/ed/collegescorecard, U.S. Dept. of Education)",
    fetchedAt: new Date().toISOString(),
    total: data?.metadata?.total ?? rows.length,
    returned: rows.length,
    schools: rows,
    note: "USD; rates are decimals. Endowment fields are IPEDS-reported FY begin/end values for the latest Scorecard year — use endowment_lookup (ipeds family) for multi-year endowment history and peer rank.",
  };
}
