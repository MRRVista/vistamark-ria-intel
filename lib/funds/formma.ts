/**
 * Municipal advisors — Form MA (firms) / MA-I (natural persons) / MA-W (withdrawal).
 *
 * Two live sources, combined:
 *  1. SEC "Information About Registered Municipal Advisors" — a monthly .xlsx
 *     of CURRENTLY registered MA firms (Registrant Name, File Number 867-,
 *     CIK). ~410 firms. Link scraped from the page (fallback hard-coded).
 *  2. EDGAR full-text search (efts.sec.gov) with forms=MA,MA-A,MA-W[,MA-I] —
 *     filing history, latest filing date, business location, and a
 *     locationCodes=<state> filter. Without a q, EFTS returns up to 100 hits
 *     newest-first, which is enough to roll up distinct firms per state.
 *
 * Modes:
 *   query  -> registry name match, then ONE EFTS call (ciks=...) to enrich
 *             top matches with latest filing date/form + location
 *   state  -> EFTS by business location, rolled up to distinct firms, each
 *             flagged currentlyRegistered against the registry
 *   individuals=true -> MA-I (individual municipal advisor) filings instead
 */
import { bufferFetch, cached, H24, jsonFetch, padCik, pageLinks, readXlsx, SEC, textFetch } from "./sec";

const PAGE = `${SEC}/help/foia-docs-muniadvisorshtm.html`;
const EFTS = "https://efts.sec.gov/LATEST/search-index";
const DS = "SEC registered municipal advisor list (monthly xlsx) + EDGAR full-text search (Form MA/MA-I, live)";

interface MaFirm {
  name: string;
  fileNumber: string;
  cik: string;
}

async function registry(): Promise<{ asOf: string | null; url: string; firms: MaFirm[] }> {
  return cached("ma-registry", H24, async () => {
    let url = `${SEC}/files/data/other/information-about-registered-municipal-advisors/ma100126.xlsx`;
    try {
      const html = await textFetch(PAGE, 15000);
      const first = pageLinks(html, /\.xlsx$/i)[0];
      if (first) url = first.href;
    } catch { /* fallback */ }
    const wb = readXlsx(await bufferFetch(url, 30000));
    const grid = wb.sheet(wb.sheetNames[0]) ?? [];
    let asOf: string | null = null;
    const hIdx = grid.findIndex((r) => /registrant name/i.test(r[0] ?? ""));
    for (const r of grid.slice(0, Math.max(hIdx, 0))) {
      const m = (r[0] ?? "").match(/as (?:of )?(\d{1,2}\/\d{1,2}\/\d{4})/i);
      if (m) asOf = m[1];
    }
    const header = grid[hIdx] ?? [];
    const iName = 0;
    const iFile = header.findIndex((c) => /file number/i.test(c));
    const iCik = header.findIndex((c) => /^cik/i.test(c));
    const firms: MaFirm[] = [];
    for (const r of grid.slice(hIdx + 1)) {
      const name = (r[iName] ?? "").replace(/&amp;/g, "&").trim();
      if (!name) continue;
      firms.push({ name, fileNumber: (r[iFile] ?? "").trim(), cik: padCik(r[iCik] ?? "") });
    }
    return { asOf, url, firms };
  });
}

function parseHit(h: any) {
  const s = h?._source ?? {};
  const cik = Array.isArray(s.ciks) && s.ciks[0] ? padCik(s.ciks[0]) : null;
  const name = Array.isArray(s.display_names) && s.display_names[0] ? String(s.display_names[0]).replace(/\s*\(CIK \d+\)\s*$/, "").trim() : null;
  const adsh = s.adsh ?? String(h?._id ?? "").split(":")[0];
  return {
    cik,
    name,
    form: s.form ?? s.file_type ?? null,
    fileDate: s.file_date ?? null,
    fileNumber: Array.isArray(s.file_num) ? s.file_num[0] ?? null : null,
    location: Array.isArray(s.biz_locations) ? s.biz_locations[0] ?? null : null,
    accession: adsh || null,
    url: cik && adsh ? `${SEC}/Archives/edgar/data/${Number(cik)}/${String(adsh).replace(/-/g, "")}/` : null,
  };
}

async function efts(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  const raw = await jsonFetch<any>(`${EFTS}?${qs}`, { timeoutMs: 20000 });
  const hits: any[] = raw?.hits?.hits ?? [];
  const total = typeof raw?.hits?.total === "number" ? raw.hits.total : raw?.hits?.total?.value ?? null;
  return { total, hits: hits.map(parseHit), sampleRaw: hits.length && !parseHit(hits[0]).cik ? hits[0] : undefined };
}

function rollup(hits: ReturnType<typeof parseHit>[]) {
  const m = new Map<string, any>();
  for (const h of hits) {
    if (!h.cik) continue;
    const e = m.get(h.cik);
    if (!e) m.set(h.cik, { cik: h.cik, name: h.name, fileNumber: h.fileNumber, location: h.location, latestFilingDate: h.fileDate, latestForm: h.form, latestFilingUrl: h.url, filingsInWindow: 1 });
    else {
      e.filingsInWindow++;
      if ((h.fileDate ?? "") > (e.latestFilingDate ?? "")) Object.assign(e, { latestFilingDate: h.fileDate, latestForm: h.form, latestFilingUrl: h.url, name: h.name ?? e.name, location: h.location ?? e.location });
    }
  }
  return [...m.values()].sort((a, b) => String(b.latestFilingDate).localeCompare(String(a.latestFilingDate)));
}

export interface FormMaArgs {
  query?: string;
  state?: string;
  individuals?: boolean;
  limit?: number;
}

export async function formMaSearch(args: FormMaArgs) {
  const a = args ?? {};
  const limit = Math.min(Math.max(Number(a.limit) || 15, 1), 50);
  const q = a.query?.trim() ?? "";
  const st = a.state?.trim().toUpperCase() ?? "";
  if (!q && !st) {
    const reg = await registry();
    return {
      dataSource: DS,
      registeredFirmCount: reg.firms.length,
      registryAsOf: reg.asOf,
      registryUrl: reg.url,
      error: "Provide query (firm or person name text) and/or state (2-letter business-location code, e.g. IL).",
    };
  }

  // Individuals (MA-I): EFTS only.
  if (a.individuals) {
    const p: Record<string, string> = { forms: "MA-I,MA-I/A" };
    if (q) p.q = `"${q.replace(/"/g, "")}"`;
    if (st) p.locationCodes = st;
    const r = await efts(p);
    return {
      dataSource: DS,
      mode: "individuals (MA-I)",
      totalFilings: r.total,
      filings: r.hits.slice(0, limit),
      ...(r.sampleRaw ? { sampleRaw: r.sampleRaw } : {}),
      note: "MA-I is filed by the municipal advisor FIRM for each associated natural person; display name/CIK are usually the firm (the person's name is inside the filing — open url). Query text matches anywhere in the filing text.",
    };
  }

  const reg = await registry();
  const regByCik = new Map(reg.firms.map((f) => [f.cik, f]));

  if (q) {
    const ql = q.toLowerCase();
    let matches = reg.firms
      .map((f) => {
        const n = f.name.toLowerCase();
        const s = n === ql ? 100 : n.startsWith(ql) ? 70 : n.includes(ql) ? 50 : f.fileNumber === q || f.cik === padCik(q.replace(/\D/g, "") || "x") ? 95 : 0;
        return { f, s };
      })
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s || x.f.name.localeCompare(y.f.name))
      .map((x) => x.f);

    let firms: any[] = matches.slice(0, limit).map((f) => ({ ...f, currentlyRegistered: true }));
    let source = "registry";
    if (!firms.length) {
      // Not on the current list — maybe withdrawn or a name variant. Fall back to EDGAR full-text.
      const p: Record<string, string> = { q: `"${q.replace(/"/g, "")}"`, forms: "MA,MA-A,MA-W" };
      if (st) p.locationCodes = st;
      const r = await efts(p);
      firms = rollup(r.hits).slice(0, limit).map((f) => ({ ...f, currentlyRegistered: regByCik.has(f.cik) }));
      source = "edgar-fulltext";
    } else {
      // Enrich: one EFTS call over the matched CIKs for latest filing + location.
      try {
        const r = await efts({ forms: "MA,MA-A,MA-W", ciks: firms.slice(0, 20).map((f) => f.cik).join(",") });
        const roll = new Map(rollup(r.hits).map((x) => [x.cik, x]));
        firms = firms.map((f) => {
          const e = roll.get(f.cik);
          return e ? { ...f, location: e.location, latestFilingDate: e.latestFilingDate, latestForm: e.latestForm, latestFilingUrl: e.latestFilingUrl } : f;
        });
      } catch { /* enrichment optional */ }
      if (st) firms = firms.filter((f) => !f.location || f.location.toUpperCase().endsWith(`, ${st}`));
    }
    return {
      dataSource: DS,
      mode: source === "registry" ? "name search (current registry)" : "name search (EDGAR full-text fallback)",
      registryAsOf: reg.asOf,
      registeredFirmCount: reg.firms.length,
      matchCount: source === "registry" ? matches.length : firms.length,
      firms,
      note:
        "currentlyRegistered = on the SEC's latest monthly municipal-advisor list. File numbers 867- are MA firms. latestForm: MA = initial/annual update, MA-A = amendment, MA/A = annual update amendment, MA-W = withdrawal. Use individuals=true for MA-I (associated persons). Many broker-dealers and banks are also registered MAs.",
    };
  }

  // State mode.
  const r = await efts({ forms: "MA,MA-A,MA-W", locationCodes: st });
  const firms = rollup(r.hits).map((f) => ({ ...f, currentlyRegistered: regByCik.has(f.cik) })).slice(0, limit);
  return {
    dataSource: DS,
    mode: `state (${st})`,
    registryAsOf: reg.asOf,
    filingsInState: r.total,
    firmsReturned: firms.length,
    firms,
    ...(r.sampleRaw ? { sampleRaw: r.sampleRaw } : {}),
    note:
      "Distinct firms with Form MA/MA-A/MA-W filings whose EDGAR business address is in the state, ranked by most recent filing (rolled up from the 100 most recent filings, so very inactive firms may be missing). currentlyRegistered=false usually means withdrawn (MA-W). Location = EDGAR business address of the filer.",
  };
}
