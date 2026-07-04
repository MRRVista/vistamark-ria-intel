/**
 * MCP tool handlers for the GLEIF LEI API — global legal-entity resolution
 * and corporate family trees. Live API (api.gleif.org), no key, no ingest.
 *
 * Why it's here: the LEI (Legal Entity Identifier) is the ISO 17442 global
 * entity ID mandated for financial-market participants — funds, GPs, banks,
 * insurers, issuers, and many private companies carry one. GLEIF's free API
 * resolves any name to its LEI record (legal/HQ address, jurisdiction,
 * status) and exposes ACCOUNTING-CONSOLIDATION relationships: direct parent,
 * ultimate parent, and direct children. That's entity mapping for manager
 * diligence (which umbrella does this fund sit under?) and M&A buyer
 * research (a PE firm's entity structure).
 *
 * Tools:
 *   gleif_entity_search  — fulltext name search → LEI records
 *   gleif_entity_profile — one entity's record + parents + children
 *
 * API notes: JSON:API envelope ({ data: [{ id, attributes: { lei, entity,
 * registration } }], meta.pagination }). Relationship endpoints return 404
 * when no parent is reported — many entities file "reporting exceptions"
 * (e.g. no consolidating parent), so null parents are a valid answer, not
 * an error. Parsed defensively with sampleRawRecord surfacing.
 */
import { jsonFetch } from "../data/http";

const BASE = "https://api.gleif.org/api/v1";

function fmtAddress(a: any): string | null {
  if (!a || typeof a !== "object") return null;
  const lines: string[] = Array.isArray(a.addressLines) ? a.addressLines.filter(Boolean) : [];
  const parts = [...lines, a.city, a.region, a.postalCode, a.country].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function parseRecord(d: any) {
  const a = d?.attributes ?? {};
  const e = a.entity ?? {};
  const r = a.registration ?? {};
  return {
    lei: a.lei ?? d?.id ?? null,
    legalName: e.legalName?.name ?? null,
    entityStatus: e.status ?? null,
    jurisdiction: e.jurisdiction ?? null,
    category: e.category ?? null,
    legalFormCode: e.legalForm?.id ?? null,
    legalAddress: fmtAddress(e.legalAddress),
    headquartersAddress: fmtAddress(e.headquartersAddress),
    registrationStatus: r.status ?? null,
    initialRegistrationDate: r.initialRegistrationDate ?? null,
    lastUpdateDate: r.lastUpdateDate ?? null,
    nextRenewalDate: r.nextRenewalDate ?? null,
  };
}

type ParsedRecord = ReturnType<typeof parseRecord>;

function isEmptyRecord(x: ParsedRecord): boolean {
  return x.lei == null && x.legalName == null;
}

async function fetchOptionalRecord(url: string): Promise<ParsedRecord | null> {
  try {
    const raw = await jsonFetch<any>(url);
    const d = raw?.data;
    if (!d) return null;
    const rec = parseRecord(Array.isArray(d) ? d[0] : d);
    return isEmptyRecord(rec) ? null : rec;
  } catch {
    // 404 = no relationship reported (or a reporting exception) — a valid answer.
    return null;
  }
}

const LEI_NOTE =
  "LEI = ISO 17442 Legal Entity Identifier (GLEIF, live). Coverage skews to financial-market participants — funds, GPs, banks, insurers, issuers — plus many operating companies. Parent/child links are ACCOUNTING-CONSOLIDATION relationships; a null parent is common and valid (many entities file reporting exceptions such as 'no consolidating parent' or non-consolidating ownership).";

export interface GleifEntitySearchArgs {
  query: string;
  country?: string;
  limit?: number;
  page?: number;
}

export async function gleifEntitySearch(args: GleifEntitySearchArgs) {
  if (!args.query || !String(args.query).trim()) {
    return {
      dataSource: "GLEIF LEI API (api.gleif.org, live)",
      error: "query is required — provide an entity name or name fragment.",
      entities: [],
    };
  }
  const params = new URLSearchParams();
  params.set("filter[fulltext]", String(args.query).trim());
  if (args.country && args.country.trim()) {
    params.set("filter[entity.legalAddress.country]", args.country.trim().toUpperCase());
  }
  const limit = Math.min(args.limit ?? 10, 50);
  params.set("page[size]", String(limit));
  params.set("page[number]", String(args.page ?? 1));

  const raw = await jsonFetch<any>(`${BASE}/lei-records?${params.toString()}`);
  const data: any[] = Array.isArray(raw?.data) ? raw.data : [];
  const entities = data.map(parseRecord);
  const parsedNothing = entities.length > 0 && entities.every(isEmptyRecord);

  return {
    totalMatches: raw?.meta?.pagination?.total ?? null,
    returned: entities.length,
    entities,
    ...(parsedNothing && data.length ? { sampleRawRecord: data[0] } : {}),
    dataSource: "GLEIF LEI API (api.gleif.org, live)",
    request: {
      query: String(args.query).trim(),
      country: args.country ?? null,
      page: args.page ?? 1,
    },
    note:
      LEI_NOTE +
      " Fulltext matching covers legal names, other/former names, and addresses. Optional country filter is the 2-letter ISO code of the LEGAL address. Use a returned lei with gleif_entity_profile for parents and children.",
  };
}

export interface GleifEntityProfileArgs {
  lei?: string;
  name?: string;
  childrenLimit?: number;
}

export async function gleifEntityProfile(args: GleifEntityProfileArgs) {
  let lei = args.lei?.trim() || null;
  let resolvedVia = "lei";

  if (!lei) {
    if (!args.name || !String(args.name).trim()) {
      return {
        dataSource: "GLEIF LEI API (api.gleif.org, live)",
        error: "Provide lei (20-char identifier) or name (resolved via fulltext search, best match wins).",
      };
    }
    const search = await gleifEntitySearch({ query: String(args.name).trim(), limit: 1 });
    const top = (search as any).entities?.[0];
    if (!top || !top.lei) {
      return {
        dataSource: "GLEIF LEI API (api.gleif.org, live)",
        error: `No LEI record matched name '${args.name}'. Try gleif_entity_search directly to inspect candidates.`,
      };
    }
    lei = top.lei;
    resolvedVia = `name search ('${String(args.name).trim()}' → top match)`;
  }

  const raw = await jsonFetch<any>(`${BASE}/lei-records/${encodeURIComponent(lei!)}`);
  const entity = parseRecord(raw?.data);

  const childrenLimit = Math.min(args.childrenLimit ?? 10, 50);
  const [directParent, ultimateParent, childrenRaw] = await Promise.all([
    fetchOptionalRecord(`${BASE}/lei-records/${encodeURIComponent(lei!)}/direct-parent`),
    fetchOptionalRecord(`${BASE}/lei-records/${encodeURIComponent(lei!)}/ultimate-parent`),
    (async () => {
      try {
        return await jsonFetch<any>(
          `${BASE}/lei-records/${encodeURIComponent(lei!)}/direct-children?page[size]=${childrenLimit}`
        );
      } catch {
        return null;
      }
    })(),
  ]);

  const childData: any[] = Array.isArray(childrenRaw?.data) ? childrenRaw.data : [];
  const children = childData.map(parseRecord).filter((c) => !isEmptyRecord(c));

  return {
    entity,
    resolvedVia,
    directParent,
    ultimateParent,
    children,
    childCountReturned: children.length,
    childTotal: childrenRaw?.meta?.pagination?.total ?? null,
    dataSource: "GLEIF LEI API (api.gleif.org, live)",
    note:
      LEI_NOTE +
      " directParent/ultimateParent null means no consolidating parent is reported for this entity. children lists direct accounting-consolidation subsidiaries (childTotal is the full count; childrenLimit caps what's returned).",
  };
}
