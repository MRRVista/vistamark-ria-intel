/**
 * data.gov catalog search.
 *
 * The CKAN API (catalog.data.gov/api/3/action/package_search) is GONE — it
 * returns 404 as of 2026-10-22. catalog.data.gov now runs a custom
 * OpenSearch-backed service documented at https://catalog.data.gov/openapi.json:
 *
 *   GET https://catalog.data.gov/search?q=...&per_page=N&sort=relevance|popularity|last_harvested_date
 *       &org_type=Federal Government|State Government|City Government|County Government|University|...
 *       &org_slug=<slug>&keyword=<kw>&theme=<t>&has_download=true&after=<cursor>
 *       → { after, results: [{ slug, title, description, organization{name,organization_type,slug}, publisher,
 *            keyword[], theme[], last_harvested_date, popularity, dcat{ modified, distribution[], landingPage, ... } }] }
 *   GET https://catalog.data.gov/api/dataset/<slug_or_id>  → same shape, one result
 *
 * Requires an Accept: application/json header (HTML otherwise). Keyless.
 */
import { politeFetch, redactUrl } from "../data/http";
import { HOUR, cached, trimText, clampLimit, strList } from "./common";

const BASE = "https://catalog.data.gov";

const ORG_TYPES = ["Federal Government", "State Government", "City Government", "County Government", "University", "Tribal", "Non-Profit"];

async function dgJson<T = any>(url: string): Promise<T> {
  const res = await politeFetch(url, { headers: { Accept: "application/json" }, timeoutMs: 20000, retries: 2 });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`data.gov HTTP ${res.status} from ${redactUrl(url)}: ${trimText(body, 160) ?? ""}`);
  }
  return (await res.json()) as T;
}

function shapeDataset(r: any, maxResources: number) {
  const dcat = r.dcat ?? {};
  const dist: any[] = Array.isArray(dcat.distribution) ? dcat.distribution : [];
  const resources = dist
    .map((d) => {
      const url = d.downloadURL ?? d.accessURL ?? null;
      if (!url) return null;
      const fmt = d.format ?? (d.mediaType ? String(d.mediaType).split("/").pop() : null) ?? (url.match(/\.(csv|json|xlsx?|zip|xml|geojson|pdf|parquet)(\?|$)/i)?.[1] ?? null);
      return { title: trimText(d.title, 80), format: fmt ? String(fmt).toUpperCase().replace(/^VND\..*SPREADSHEETML.*$/, "XLSX") : null, url };
    })
    .filter(Boolean) as Array<{ title: string | null; format: string | null; url: string }>;
  return {
    slug: r.slug ?? null,
    title: r.title ?? dcat.title ?? null,
    organization: r.organization?.name ?? null,
    orgType: r.organization?.organization_type ?? null,
    publisher: r.publisher ?? dcat.publisher?.name ?? null,
    description: trimText(r.description ?? dcat.description, 240),
    modified: dcat.modified ? String(dcat.modified).slice(0, 10) : null,
    harvested: r.last_harvested_date ? String(r.last_harvested_date).slice(0, 10) : null,
    keywords: Array.isArray(r.keyword) ? r.keyword.slice(0, 8) : undefined,
    landingPage: dcat.landingPage ?? (r.slug ? `${BASE}/dataset/${r.slug}` : null),
    resourceCount: resources.length,
    resources: resources.slice(0, maxResources),
  };
}

export async function datagovSearch(args: any) {
  const slug = args?.slug ? String(args.slug).trim() : "";
  const maxResources = clampLimit(args?.maxResources, 4, 12);
  if (slug) {
    const url = `${BASE}/api/dataset/${encodeURIComponent(slug)}`;
    const data = await cached(`opendata:datagov:ds:${slug}`, 6 * HOUR, () => dgJson<any>(url));
    const r = data?.results?.[0];
    if (!r) throw new Error(`data.gov dataset '${slug}' not found`);
    return { source: "data.gov catalog (catalog.data.gov/api/dataset)", fetchedAt: new Date().toISOString(), dataset: shapeDataset(r, maxResources) };
  }
  const q = String(args?.q ?? "").trim();
  if (!q) throw new Error("q (search terms) or slug is required");
  const limit = clampLimit(args?.limit, 10, 25);
  const qs = new URLSearchParams({ q, per_page: String(limit) });
  const sort = String(args?.sort ?? "relevance");
  if (["relevance", "popularity", "last_harvested_date"].includes(sort)) qs.set("sort", sort);
  for (const t of strList(args?.orgType)) {
    const hit = ORG_TYPES.find((o) => o.toLowerCase().startsWith(t.toLowerCase()));
    if (!hit) throw new Error(`orgType must be one of: ${ORG_TYPES.join(", ")}`);
    qs.append("org_type", hit);
  }
  if (args?.orgSlug) qs.set("org_slug", String(args.orgSlug));
  if (args?.publisher) qs.set("publisher", String(args.publisher));
  for (const k of strList(args?.keyword)) qs.append("keyword", k);
  if (args?.hasDownload === true) qs.set("has_download", "true");
  if (args?.after) qs.set("after", String(args.after));
  const url = `${BASE}/search?${qs}`;
  const data = await cached(`opendata:datagov:${url}`, 2 * HOUR, () => dgJson<any>(url));
  const results: any[] = data?.results ?? [];
  return {
    source: "data.gov catalog (catalog.data.gov/search, OpenSearch API; CKAN package_search retired)",
    fetchedAt: new Date().toISOString(),
    q,
    sort,
    returned: results.length,
    nextCursor: results.length === limit ? data?.after ?? null : null,
    note: "Resources are raw download URLs (CSV/JSON/ZIP/API). Socrata-hosted resources (…/api/views/<4x4>…) can be queried with socrata_query using that host + 4x4 id. Pass slug=<slug> for the full distribution list.",
    datasets: results.map((r) => shapeDataset(r, maxResources)),
  };
}
