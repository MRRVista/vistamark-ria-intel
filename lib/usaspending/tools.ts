/**
 * MCP tool handlers for USAspending.gov — federal awards (grants, contracts,
 * loans, direct payments) by recipient. Live API, no key, no local ingest.
 *
 * Why it's here: federal award flows are a prospecting signal. A nonprofit or
 * health system living on large federal grants has budget/reserve dynamics
 * worth a board conversation; a company with big federal contracts has
 * revenue concentration worth knowing in diligence. Pairs with irs_eo_search
 * (find the org) → usaspending tools (see its federal money).
 *
 * Tools:
 *   usaspending_awards_search — award-level detail for a recipient/keyword/state
 *   usaspending_top_recipients — aggregated top recipients by state/type/period
 *
 * API notes (api.usaspending.gov/api/v2): POST JSON endpoints; award type
 * groups cannot be mixed in one request (contracts vs grants vs loans...);
 * amounts are OBLIGATIONS in whole USD (not outlays). Parsed defensively —
 * sampleRawRow surfaces the upstream shape if mapping yields nothing, and
 * jsonFetch errors include the API's own error detail for diagnosis.
 */
import { jsonFetch } from "../data/http";

const BASE = "https://api.usaspending.gov/api/v2";

const AWARD_TYPE_GROUPS: Record<string, string[]> = {
  grants: ["02", "03", "04", "05"],
  contracts: ["A", "B", "C", "D"],
  loans: ["07", "08"],
  direct_payments: ["06", "10"],
  other: ["09", "11"],
  idvs: ["IDV_A", "IDV_B", "IDV_B_A", "IDV_B_B", "IDV_B_C", "IDV_C", "IDV_D", "IDV_E"],
};

const FIELDS = [
  "Award ID",
  "Recipient Name",
  "Start Date",
  "End Date",
  "Award Amount",
  "Awarding Agency",
  "Awarding Sub Agency",
  "Description",
];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function resolvePeriod(startDate?: string, endDate?: string): { start_date: string; end_date: string } {
  const end = endDate ?? isoDate(new Date());
  let start = startDate;
  if (!start) {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 10);
    start = isoDate(d);
  }
  return { start_date: start, end_date: end };
}

function resolveAwardTypes(awardType?: string): { codes: string[]; group: string } {
  const group = (awardType ?? "grants").toLowerCase();
  const codes = AWARD_TYPE_GROUPS[group];
  if (!codes) {
    throw new Error(
      `Unknown awardType '${awardType}'. Use one of: ${Object.keys(AWARD_TYPE_GROUPS).join(", ")}. (The API cannot mix groups in one request.)`
    );
  }
  return { codes, group };
}

async function post<T = any>(path: string, body: any): Promise<T> {
  return jsonFetch<T>(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function num(v: any): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const OBLIGATION_NOTE =
  "Amounts are federal OBLIGATIONS in whole USD (funds committed, not necessarily outlaid). Award type groups cannot be mixed per API rules — run grants and contracts as separate queries. recipient name matching is fuzzy/full-text on the government's side.";

export interface UsaspendingAwardsSearchArgs {
  recipientName?: string;
  keywords?: string;
  awardType?: string;
  recipientState?: string;
  startDate?: string;
  endDate?: string;
  sortBy?: "amount" | "end_date";
  limit?: number;
  page?: number;
}

export async function usaspendingAwardsSearch(args: UsaspendingAwardsSearchArgs) {
  const { codes, group } = resolveAwardTypes(args.awardType);
  const time_period = [resolvePeriod(args.startDate, args.endDate)];
  const filters: any = { award_type_codes: codes, time_period };
  if (args.recipientName && args.recipientName.trim()) {
    filters.recipient_search_text = [args.recipientName.trim()];
  }
  if (args.keywords && args.keywords.trim()) {
    filters.keywords = [args.keywords.trim()];
  }
  if (args.recipientState && args.recipientState.trim()) {
    filters.recipient_locations = [{ country: "USA", state: args.recipientState.trim().toUpperCase() }];
  }

  const limit = Math.min(args.limit ?? 25, 100);
  const raw = await post<any>("/search/spending_by_award/", {
    filters,
    fields: FIELDS,
    page: args.page ?? 1,
    limit,
    sort: args.sortBy === "end_date" ? "End Date" : "Award Amount",
    order: "desc",
    subawards: false,
  });

  const results: any[] = Array.isArray(raw?.results) ? raw.results : [];
  const awards = results.map((r) => ({
    awardId: r["Award ID"] ?? null,
    recipientName: r["Recipient Name"] ?? null,
    startDate: r["Start Date"] ?? null,
    endDate: r["End Date"] ?? null,
    amountUsd: num(r["Award Amount"]),
    awardingAgency: r["Awarding Agency"] ?? null,
    awardingSubAgency: r["Awarding Sub Agency"] ?? null,
    description: r["Description"] ?? null,
    usaspendingUrl: r.generated_internal_id
      ? `https://www.usaspending.gov/award/${r.generated_internal_id}`
      : null,
  }));
  const parsedNothing = awards.length > 0 && awards.every((a) => a.recipientName == null && a.amountUsd == null);

  return {
    returned: awards.length,
    awards,
    ...(parsedNothing && results.length ? { sampleRawRow: results[0] } : {}),
    pageMetadata: raw?.page_metadata ?? null,
    dataSource: "USAspending.gov (api.usaspending.gov, live)",
    request: {
      awardTypeGroup: group,
      awardTypeCodes: codes,
      recipientName: args.recipientName ?? null,
      keywords: args.keywords ?? null,
      recipientState: args.recipientState ?? null,
      period: time_period[0],
      sort: args.sortBy === "end_date" ? "End Date" : "Award Amount",
      page: args.page ?? 1,
    },
    note:
      OBLIGATION_NOTE +
      " Default period is the last 10 years; pass startDate/endDate (YYYY-MM-DD) to change. The endpoint paginates without a total count — pageMetadata.hasNext signals more pages. Each award links to its USAspending page.",
  };
}

export interface UsaspendingTopRecipientsArgs {
  awardType?: string;
  recipientState?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  page?: number;
}

export async function usaspendingTopRecipients(args: UsaspendingTopRecipientsArgs) {
  const { codes, group } = resolveAwardTypes(args.awardType);
  const time_period = [resolvePeriod(args.startDate, args.endDate)];
  const filters: any = { award_type_codes: codes, time_period };
  if (args.recipientState && args.recipientState.trim()) {
    filters.recipient_locations = [{ country: "USA", state: args.recipientState.trim().toUpperCase() }];
  }

  const limit = Math.min(args.limit ?? 10, 100);
  const raw = await post<any>("/search/spending_by_category/recipient/", {
    filters,
    limit,
    page: args.page ?? 1,
  });

  const results: any[] = Array.isArray(raw?.results) ? raw.results : [];
  const recipients = results.map((r) => ({
    name: r.name ?? null,
    amountUsd: num(r.amount),
    recipientId: r.recipient_id ?? null,
    uei: r.uei ?? r.code ?? null,
  }));
  const parsedNothing = recipients.length > 0 && recipients.every((x) => x.name == null && x.amountUsd == null);

  return {
    returned: recipients.length,
    recipients,
    ...(parsedNothing && results.length ? { sampleRawRow: results[0] } : {}),
    pageMetadata: raw?.page_metadata ?? null,
    dataSource: "USAspending.gov (api.usaspending.gov, live)",
    request: {
      awardTypeGroup: group,
      awardTypeCodes: codes,
      recipientState: args.recipientState ?? null,
      period: time_period[0],
      page: args.page ?? 1,
    },
    note:
      OBLIGATION_NOTE +
      " Aggregated by recipient over the requested period and award-type group only — not a lifetime total. Default period is the last 10 years. Use usaspending_awards_search to drill into a recipient's individual awards.",
  };
}
