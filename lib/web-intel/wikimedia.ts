/**
 * Wikidata + Wikipedia (all keyless).
 *
 *   Search:   https://www.wikidata.org/w/api.php?action=wbsearchentities&search=..&language=en&format=json
 *   Claims:   https://www.wikidata.org/wiki/Special:EntityData/<QID>.json   (linked-data dump of one item)
 *   Labels:   https://query.wikidata.org/sparql  (VALUES + wikibase:label, one round trip for all QIDs)
 *   Summary:  https://en.wikipedia.org/api/rest_v1/page/summary/<title>
 *   Fallback: https://en.wikipedia.org/w/api.php?action=query&prop=extracts|description|pageimages|pageprops
 *
 * Verified 2026-10-22 from the sandbox: api.php on BOTH wikidata.org and
 * en.wikipedia.org (wbsearchentities, wbgetentities) and the REST summary
 * endpoint answer HTTP 429 to the shared proxy IP most of the time, while
 * Special:EntityData, the SPARQL endpoint and the en.wikipedia action API
 * (query/extracts/search) answer 200. So every call has a fallback path:
 *   entity search  -> wbsearchentities, else enwiki list=search + pageprops.wikibase_item
 *   entity claims  -> Special:EntityData (primary), labels via SPARQL
 *   page summary   -> REST summary, else action API extracts (intro, plaintext)
 * Wikimedia asks for a descriptive User-Agent with contact (sent via politeFetch
 * + Api-User-Agent). Cached 6 h (entities) / 12 h (summaries).
 */
import { cached, clampInt, fetchWithBackoff, HOUR, jsonWithBackoff, round, trim, VISTAMARK_UA } from "./common";

const WD_API = "https://www.wikidata.org/w/api.php";
const WD_ENTITY = "https://www.wikidata.org/wiki/Special:EntityData";
const WD_SPARQL = "https://query.wikidata.org/sparql";
const WP_API = "https://en.wikipedia.org/w/api.php";
const WP_REST = "https://en.wikipedia.org/api/rest_v1/page/summary";

const HEADERS = { "Api-User-Agent": VISTAMARK_UA, Accept: "application/json" };

/** Properties surfaced as "key claims" (prospect-research relevant). */
const KEY_PROPS: Record<string, string> = {
  P31: "instanceOf",
  P106: "occupation",
  P108: "employer",
  P69: "educatedAt",
  P2218: "netWorthUSD",
  P112: "foundedBy",
  P856: "officialWebsite",
  P569: "dateOfBirth",
  P19: "placeOfBirth",
  P551: "residence",
  P27: "citizenship",
  P169: "chiefExecutiveOfficer",
  P488: "chairperson",
  P1037: "director",
  P159: "headquartersLocation",
  P571: "inception",
  P452: "industry",
  P749: "parentOrganization",
  P127: "ownedBy",
  P1830: "ownerOf",
  P1128: "employees",
  P2139: "totalRevenueUSD",
  P2403: "totalAssetsUSD",
  P1454: "legalForm",
  P1448: "officialName",
  P2002: "twitter",
  P4264: "linkedinCompanyId",
  P6634: "linkedinPersonalId",
  P463: "memberOf",
  P39: "positionHeld",
  P22: "father",
  P25: "mother",
  P26: "spouse",
  P40: "child",
  P3373: "sibling",
};

interface SearchHit { id: string; label: string | null; description: string | null; aliases?: string[]; via: "wikidata" | "wikipedia" }

async function wdSearch(q: string, limit: number): Promise<SearchHit[]> {
  const url = `${WD_API}?${new URLSearchParams({ action: "wbsearchentities", search: q, language: "en", uselang: "en", type: "item", format: "json", limit: String(limit) })}`;
  const data = await jsonWithBackoff<any>(url, { source: "Wikidata wbsearchentities", headers: HEADERS, retryAfterMs: 2500, hint429: "Wikimedia throttles this IP; the tool falls back to Wikipedia search" });
  return (data?.search ?? []).map((s: any) => ({ id: s.id, label: s.label ?? null, description: s.description ?? null, aliases: s.aliases?.slice(0, 3), via: "wikidata" as const }));
}

async function wpSearchForEntities(q: string, limit: number): Promise<SearchHit[]> {
  const url = `${WP_API}?${new URLSearchParams({ action: "query", generator: "search", gsrsearch: q, gsrlimit: String(limit), gsrnamespace: "0", prop: "pageprops|description", ppprop: "wikibase_item", format: "json", redirects: "1" })}`;
  const data = await jsonWithBackoff<any>(url, { source: "Wikipedia search", headers: HEADERS, retryAfterMs: 2500 });
  const pages = Object.values<any>(data?.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return pages
    .filter((p) => p.pageprops?.wikibase_item)
    .map((p) => ({ id: p.pageprops.wikibase_item, label: p.title, description: p.description ?? null, via: "wikipedia" as const }));
}

async function entityData(qid: string): Promise<any> {
  return cached(`wd:entity:${qid}`, 6 * HOUR, async () => {
    const data = await jsonWithBackoff<any>(`${WD_ENTITY}/${qid}.json`, { source: "Wikidata EntityData", headers: HEADERS, retryAfterMs: 2500 });
    const ent = data?.entities?.[qid] ?? Object.values(data?.entities ?? {})[0];
    if (!ent) throw new Error(`Wikidata: no entity returned for ${qid}`);
    return ent;
  });
}

async function labelsFor(qids: string[]): Promise<Record<string, string>> {
  const ids = [...new Set(qids)].filter((q) => /^Q\d+$/.test(q)).slice(0, 60);
  if (!ids.length) return {};
  const key = `wd:labels:${ids.join(",")}`;
  return cached(key, 6 * HOUR, async () => {
    const sparql = `SELECT ?item ?itemLabel WHERE { VALUES ?item { ${ids.map((q) => `wd:${q}`).join(" ")} } SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }`;
    const url = `${WD_SPARQL}?${new URLSearchParams({ format: "json", query: sparql })}`;
    try {
      const data = await jsonWithBackoff<any>(url, { source: "Wikidata SPARQL", headers: { ...HEADERS, Accept: "application/sparql-results+json" }, retryAfterMs: 2000 });
      const out: Record<string, string> = {};
      for (const b of data?.results?.bindings ?? []) {
        const id = String(b.item?.value ?? "").split("/").pop()!;
        out[id] = b.itemLabel?.value ?? id;
      }
      return out;
    } catch {
      // Fallback: resolve a handful individually via EntityData (cheap, cached)
      const out: Record<string, string> = {};
      for (const q of ids.slice(0, 8)) {
        try {
          const e = await entityData(q);
          out[q] = e?.labels?.en?.value ?? q;
        } catch { /* leave unresolved */ }
      }
      return out;
    }
  });
}

function snakValue(snak: any): { kind: string; value: any } | null {
  const dv = snak?.datavalue;
  if (!dv) return null;
  switch (dv.type) {
    case "wikibase-entityid": return { kind: "item", value: dv.value.id };
    case "string": return { kind: "string", value: dv.value };
    case "time": return { kind: "time", value: String(dv.value.time).replace(/^\+/, "").slice(0, 10).replace(/-00/g, "") };
    case "quantity": {
      const amt = Number(dv.value.amount);
      const unit = String(dv.value.unit ?? "").split("/").pop();
      return { kind: "quantity", value: { amount: round(amt, 2), unit: unit === "1" ? null : unit } };
    }
    case "monolingualtext": return { kind: "string", value: dv.value.text };
    default: return { kind: dv.type, value: dv.value };
  }
}

export async function wikidataEntitySearch(args: any) {
  const q = String(args?.query ?? args?.search ?? "").trim();
  const qid = String(args?.id ?? "").trim().toUpperCase();
  if (!q && !/^Q\d+$/.test(qid)) throw new Error("wikidata_entity_search: pass `query` (name of a person/company) or `id` (e.g. Q7936440)");
  const limit = clampInt(args?.limit, 5, 1, 10);
  const includeClaims = args?.claims !== false;
  const fetchedAt = new Date().toISOString();
  const notes: string[] = [];

  let hits: SearchHit[] = [];
  if (/^Q\d+$/.test(qid)) {
    hits = [{ id: qid, label: null, description: null, via: "wikidata" }];
  } else {
    // wbsearchentities is a label-prefix matcher ("Robert F. Smith investor" -> 0 hits);
    // full-text Wikipedia search with pageprops.wikibase_item covers descriptive queries
    // and also serves as the fallback when Wikimedia throttles api.php on wikidata.org.
    try {
      hits = await cached(`wd:search:${q}:${limit}`, 6 * HOUR, () => wdSearch(q, limit));
    } catch (e: any) {
      notes.push(`wbsearchentities unavailable (${String(e?.message).slice(0, 90)}); used Wikipedia search`);
    }
    if (!hits.length) {
      hits = await cached(`wp:esearch:${q}:${limit}`, 6 * HOUR, () => wpSearchForEntities(q, limit));
      if (hits.length && !notes.length) notes.push("No label match in Wikidata search; candidates come from Wikipedia full-text search");
    }
  }
  if (!hits.length) return { source: "Wikidata", fetchedAt, query: q, matches: [], note: "No Wikidata item found; try a fuller name or wikipedia_summary." };

  const matches: any[] = hits.map((h) => ({ id: h.id, label: h.label, description: h.description, aliases: h.aliases, url: `https://www.wikidata.org/wiki/${h.id}` }));
  let entity: any = null;
  if (includeClaims) {
    const top = hits[0]!;
    const ent = await entityData(top.id);
    const claims = ent.claims ?? {};
    const picked: Record<string, Array<{ kind: string; value: any; qualifiers?: any }>> = {};
    const qids: string[] = [];
    for (const [pid, name] of Object.entries(KEY_PROPS)) {
      const stmts = (claims[pid] ?? []).filter((s: any) => s.rank !== "deprecated").slice(0, 6);
      if (!stmts.length) continue;
      picked[name] = stmts
        .map((s: any) => {
          const v = snakValue(s.mainsnak);
          if (!v) return null;
          if (v.kind === "item") qids.push(v.value);
          const quals: any = {};
          const pit = s.qualifiers?.P585?.[0] ?? s.qualifiers?.P580?.[0];
          if (pit) quals.asOf = snakValue(pit)?.value;
          const end = s.qualifiers?.P582?.[0];
          if (end) quals.until = snakValue(end)?.value;
          return Object.keys(quals).length ? { ...v, qualifiers: quals } : v;
        })
        .filter(Boolean);
    }
    const labels = await labelsFor(qids);
    const resolved: Record<string, any> = {};
    for (const [name, arr] of Object.entries(picked)) {
      resolved[name] = arr.map((v) => {
        const base = v.kind === "item" ? { id: v.value, label: labels[v.value] ?? null } : v.value;
        return v.qualifiers ? { ...(typeof base === "object" && base ? base : { value: base }), ...v.qualifiers } : base;
      });
      if (resolved[name].length === 1) resolved[name] = resolved[name][0];
    }
    const sitelink = ent.sitelinks?.enwiki;
    entity = {
      id: ent.id,
      label: ent.labels?.en?.value ?? top.label,
      description: ent.descriptions?.en?.value ?? top.description,
      aliases: (ent.aliases?.en ?? []).slice(0, 5).map((a: any) => a.value),
      modified: ent.modified,
      wikipedia: sitelink?.url ?? (sitelink?.title ? `https://en.wikipedia.org/wiki/${encodeURIComponent(sitelink.title.replace(/ /g, "_"))}` : null),
      claimCount: Object.keys(claims).length,
      keyClaims: resolved,
    };
    matches[0]!.label ??= entity.label;
    matches[0]!.description ??= entity.description;
  }
  return { source: "Wikidata (wbsearchentities / Special:EntityData / SPARQL labels)", fetchedAt, query: q || qid, notes: notes.length ? notes : undefined, matches, entity };
}

export async function wikipediaSummary(args: any) {
  let title = String(args?.title ?? args?.query ?? "").trim();
  if (!title) throw new Error("wikipedia_summary: `title` is required (article title, e.g. 'Vista Equity Partners')");
  const maxChars = clampInt(args?.maxChars, 1200, 200, 1200);
  const fetchedAt = new Date().toISOString();
  const notes: string[] = [];

  const result = await cached(`wp:summary:${title.toLowerCase()}`, 12 * HOUR, async () => {
    const slug = encodeURIComponent(title.replace(/ /g, "_"));
    try {
      const res = await fetchWithBackoff(`${WP_REST}/${slug}?redirect=true`, { source: "Wikipedia REST summary", headers: HEADERS, retryAfterMs: 2500 });
      const d: any = await res.json();
      if (d?.type === "disambiguation") notes.push("Title is a disambiguation page; pick a more specific title");
      return {
        title: d.title ?? title,
        description: d.description ?? null,
        extract: d.extract ?? null,
        thumbnail: d.thumbnail?.source ?? null,
        url: d.content_urls?.desktop?.page ?? null,
        wikidataId: d.wikibase_item ?? null,
        lastModified: d.timestamp ?? null,
        via: "rest",
      };
    } catch (e: any) {
      if (!/429|404/.test(String(e?.message))) throw e;
      if (/404/.test(String(e?.message))) {
        // Try a search for the nearest article title
        const s = await jsonWithBackoff<any>(`${WP_API}?${new URLSearchParams({ action: "query", list: "search", srsearch: title, srlimit: "1", format: "json" })}`, { source: "Wikipedia search", headers: HEADERS });
        const hit = s?.query?.search?.[0]?.title;
        if (!hit) throw new Error(`wikipedia_summary: no article found for '${title}'`);
        notes.push(`No exact article '${title}'; using search match '${hit}'`);
        title = hit;
      } else {
        notes.push("REST summary rate-limited; used action API extract");
      }
      const url = `${WP_API}?${new URLSearchParams({ action: "query", prop: "extracts|description|pageimages|pageprops|info", exintro: "1", explaintext: "1", titles: title, piprop: "thumbnail", pithumbsize: "320", ppprop: "wikibase_item", inprop: "url", redirects: "1", format: "json" })}`;
      const d = await jsonWithBackoff<any>(url, { source: "Wikipedia action API", headers: HEADERS, retryAfterMs: 2500 });
      const page: any = Object.values<any>(d?.query?.pages ?? {})[0];
      if (!page || page.missing !== undefined) throw new Error(`wikipedia_summary: no article found for '${title}'`);
      return {
        title: page.title,
        description: page.description ?? null,
        extract: page.extract ?? null,
        thumbnail: page.thumbnail?.source ?? null,
        url: page.fullurl ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(String(page.title).replace(/ /g, "_"))}`,
        wikidataId: page.pageprops?.wikibase_item ?? null,
        lastModified: page.touched ?? null,
        via: "action-api",
      };
    }
  });
  return {
    source: "English Wikipedia",
    fetchedAt,
    ...result,
    extract: trim(result.extract, maxChars),
    notes: notes.length ? notes : undefined,
  };
}
