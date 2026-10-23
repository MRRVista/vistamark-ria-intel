/**
 * Generic Socrata tools: Discovery-API catalog search, SoQL query against any
 * allowlisted government domain, and dataset column metadata.
 *
 * Verified live 2026-10-22 (keyless):
 *   GET https://api.us.socrata.com/api/catalog/v1?q=...&domains=a,b&only=datasets&limit=N[&order=relevance|page_views_total|updatedAt]
 *   GET https://<domain>/resource/<4x4>.json?$select&$where&$order&$group&$limit&$q
 *   GET https://<domain>/api/views/<4x4>.json
 */
import {
  DISCOVERY_URL, DEFAULT_DOMAINS, DOMAIN_ALIASES, HOUR, cached, getJson, normalizeDomain, validDatasetId,
  sodaQuery, viewMeta, trimText, pickColumns, compactRow, clampLimit, strList,
} from "./common";

const ORDERS: Record<string, string> = {
  relevance: "relevance",
  popularity: "page_views_total",
  updated: "updatedAt",
};

export async function socrataCatalogSearch(args: any) {
  const q = String(args?.q ?? "").trim();
  const limit = clampLimit(args?.limit, 15, 25);
  let domains = strList(args?.domains).map(normalizeDomain).map((d) => DOMAIN_ALIASES[d] ?? d);
  const allDomains = args?.allDomains === true;
  if (!domains.length && !allDomains) domains = DEFAULT_DOMAINS;
  if (!q && allDomains) throw new Error("q is required when searching all Socrata domains");
  const order = ORDERS[String(args?.order ?? "relevance")] ?? "relevance";

  const qs = new URLSearchParams({ only: "datasets", limit: String(limit), order });
  if (q) qs.set("q", q);
  if (domains.length) qs.set("domains", domains.join(","));
  if (args?.category) qs.set("categories", String(args.category));
  const url = `${DISCOVERY_URL}?${qs}`;

  const data = await cached(`opendata:catalog:${url}`, 2 * HOUR, () => getJson<any>(url, 20000));
  const results: any[] = data?.results ?? [];
  return {
    source: "Socrata Discovery API (api.us.socrata.com/api/catalog/v1)",
    fetchedAt: new Date().toISOString(),
    q: q || null,
    domains: domains.length ? domains : "all",
    totalMatches: data?.resultSetSize ?? results.length,
    returned: results.length,
    note: "Pass domain + id to socrata_dataset_columns (field names) then socrata_query (rows). data.illinois.gov is indexed as illinois-edp.data.socrata.com — either host works for queries.",
    datasets: results.map((r) => {
      const res = r.resource ?? {};
      const meta = r.metadata ?? {};
      const cls = r.classification ?? {};
      const dm: Array<{ key: string; value: string }> = cls.domain_metadata ?? [];
      const freq = dm.find((m) => /frequency/i.test(m.key))?.value ?? null;
      return {
        id: res.id,
        domain: meta.domain,
        name: res.name,
        description: trimText(res.description, 220),
        attribution: res.attribution ?? null,
        category: cls.domain_category ?? null,
        columns: Array.isArray(res.columns_field_name) ? res.columns_field_name.length : null,
        columnNames: Array.isArray(res.columns_field_name) ? res.columns_field_name.slice(0, 12) : undefined,
        updateFrequency: freq,
        dataUpdated: res.data_updated_at ? String(res.data_updated_at).slice(0, 10) : null,
        downloads: res.download_count ?? null,
        url: r.permalink ?? null,
      };
    }),
  };
}

export async function socrataQuery(args: any) {
  const domain = normalizeDomain(args?.domain);
  const datasetId = validDatasetId(args?.datasetId);
  const limit = clampLimit(args?.limit, 25, 100);
  const offset = Math.max(0, Math.floor(Number(args?.offset) || 0));
  const columns = strList(args?.columns);
  const select = args?.select ? String(args.select) : columns.length ? columns.join(",") : undefined;
  const t0 = Date.now();
  const raw = await sodaQuery(domain, datasetId, {
    select,
    where: args?.where ? String(args.where) : undefined,
    order: args?.order ? String(args.order) : undefined,
    group: args?.group ? String(args.group) : undefined,
    q: args?.q ? String(args.q) : undefined,
    limit,
    offset,
  });
  const rows = raw.map((r) => compactRow(r as Record<string, unknown>));
  const colSet = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) colSet.add(k);
  return {
    source: `Socrata SODA ${domain}/resource/${datasetId}.json`,
    fetchedAt: new Date().toISOString(),
    domain,
    datasetId,
    query: { select: select ?? null, where: args?.where ?? null, order: args?.order ?? null, group: args?.group ?? null, q: args?.q ?? null, limit, offset },
    returned: rows.length,
    hasMore: rows.length === limit,
    elapsedMs: Date.now() - t0,
    columns: Array.from(colSet),
    rows,
  };
}

export async function socrataDatasetColumns(args: any) {
  const domain = normalizeDomain(args?.domain);
  const datasetId = validDatasetId(args?.datasetId);
  const meta = await viewMeta(domain, datasetId);
  const filter = strList(args?.search).map((s) => s.toLowerCase());
  let cols = meta.columns;
  if (filter.length) {
    cols = cols.filter((c) => filter.every((f) => `${c.fieldName} ${c.name} ${c.description ?? ""}`.toLowerCase().includes(f)));
  }
  const limit = clampLimit(args?.limit, 60, 150);
  const includeStats = args?.stats === true;
  return {
    source: `Socrata metadata ${domain}/api/views/${datasetId}.json`,
    fetchedAt: new Date().toISOString(),
    dataset: {
      id: meta.id, domain, name: meta.name, description: meta.description, category: meta.category,
      attribution: meta.attribution, rowsUpdatedAt: meta.rowsUpdatedAt, createdAt: meta.createdAt,
      updateFrequency: meta.frequency, timePeriod: meta.timePeriod, downloads: meta.downloads,
      totalColumns: meta.columns.length,
    },
    returnedColumns: Math.min(cols.length, limit),
    columns: cols.slice(0, limit).map((c) => {
      const o: Record<string, unknown> = { field: c.fieldName, type: c.dataType };
      if (c.name && c.name.toLowerCase().replace(/[^a-z0-9]/g, "") !== c.fieldName.toLowerCase().replace(/[^a-z0-9]/g, "")) o.label = c.name;
      if (c.description) o.description = c.description;
      if (includeStats) {
        if (c.cardinality != null) o.distinct = c.cardinality;
        if (c.nonNull != null) o.nonNull = c.nonNull;
        if (c.top) o.topValues = c.top;
      }
      return o;
    }),
    soqlHints: "Text match: upper(field) like '%X%'. Dates: field > '2026-01-01'. Numbers: reported_cost > 1000000. Aggregates: select='field,count(*)' + group='field'. Full text: q='term'.",
  };
}

export { pickColumns };
