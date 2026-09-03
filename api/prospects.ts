/**
 * /api/prospects — the zip-code prospect database, over HTTP.
 *
 * Auth: requireAccessOrSession (ACCESS_TOKEN header / Bearer, or the Entra
 * session cookie). These rows are PII; there is deliberately no open GET.
 *
 * GET  /api/prospects?zip=60521&limit=50&...        search (all ProspectSearchArgs as query params)
 * GET  /api/prospects?id=123                        one prospect + household + events
 * GET  /api/prospects?view=summary[&zip=60521]      per-zip counts, home-value stats, recent imports
 * GET  /api/prospects?view=zips                     target zip list
 * GET  /api/prospects?view=imports                  import ledger
 * GET  /api/prospects?format=csv&zip=60521          search result as a CSV download
 * GET  /api/prospects?format=crm[&markSynced=1]     VistaCRM-shaped feed (see prospectsExportCrm)
 *
 * POST /api/prospects  (Content-Type: application/json)
 *      { records: [...] | record: {...}, source, sourceDetail, defaultZip, restrictZips, dryRun, tags }
 *      { csv: "<text>", source, columnMap, ... }              inline CSV
 *      { action: "update", id, ...ProspectUpdateArgs }         status / consent / note / enrichment
 *      { action: "zips", action2: "add"|"deactivate"..., zip, city, ... }   manage targets
 *      { action: "crm_ack", vistacrmContactIds: { "<prospectId>": "<crmId>" } }
 * POST /api/prospects?source=...&filename=...&defaultZip=60521&restrictZips=1&dryRun=1&columnMap={...}
 *      Content-Type: text/csv | text/tab-separated-values | text/plain        raw CSV body
 *      Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet | application/octet-stream
 *                                                                              raw .xlsx body
 *      Content-Type: multipart/form-data  (field "file" + optional text fields = the options above)
 *
 * Request bodies are capped by Vercel at ~4.5 MB (≈ 40k CSV rows). Split larger lists.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAccessOrSession } from "../lib/auth";
import { isDbReady } from "../lib/db";
import { importRecords, importTable, type ImportOptions } from "../lib/prospects/store";
import { parseTabular } from "../lib/prospects/tabular";
import {
  prospectImportsList,
  prospectLookup,
  prospectsExportCrm,
  prospectsSearch,
  prospectsZipSummary,
  prospectUpdate,
  prospectZipTargets,
} from "../lib/prospects/queries";

export const config = { api: { bodyParser: false } };

const MAX_BODY = 4_500_000;

function q(req: VercelRequest, k: string): string | undefined {
  const v = req.query[k];
  return Array.isArray(v) ? v[0] : v;
}
function qBool(req: VercelRequest, k: string): boolean | undefined {
  const v = q(req, k);
  if (v == null) return undefined;
  return ["1", "true", "yes", "y"].includes(v.toLowerCase());
}
function qNum(req: VercelRequest, k: string): number | undefined {
  const v = q(req, k);
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function readBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error(`Body exceeds ${MAX_BODY} bytes — split the file`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Minimal multipart/form-data reader: text fields + the first file part. */
function parseMultipart(body: Buffer, contentType: string): { fields: Record<string, string>; file?: { name: string; type: string; data: Buffer } } {
  const m = contentType.match(/boundary="?([^";]+)"?/i);
  if (!m) throw new Error("multipart body without boundary");
  const boundary = Buffer.from(`--${m[1]}`);
  const fields: Record<string, string> = {};
  let file: { name: string; type: string; data: Buffer } | undefined;
  let pos = body.indexOf(boundary);
  while (pos !== -1) {
    pos += boundary.length;
    if (body.slice(pos, pos + 2).toString() === "--") break;
    const headEnd = body.indexOf("\r\n\r\n", pos);
    if (headEnd === -1) break;
    const head = body.slice(pos, headEnd).toString("utf8");
    const next = body.indexOf(boundary, headEnd + 4);
    const dataEnd = next === -1 ? body.length : next - 2; // strip CRLF before boundary
    const data = body.slice(headEnd + 4, dataEnd);
    const nameM = head.match(/name="([^"]*)"/i);
    const fileM = head.match(/filename="([^"]*)"/i);
    const typeM = head.match(/Content-Type:\s*([^\r\n]+)/i);
    if (fileM) {
      if (!file) file = { name: fileM[1], type: typeM?.[1]?.trim() ?? "application/octet-stream", data };
    } else if (nameM) {
      fields[nameM[1]] = data.toString("utf8");
    }
    pos = next;
  }
  return { fields, file };
}

function searchArgsFromQuery(req: VercelRequest) {
  return {
    zip: q(req, "zip"),
    zips: q(req, "zips")?.split(","),
    q: q(req, "q"),
    lastName: q(req, "lastName"),
    email: q(req, "email"),
    street: q(req, "street"),
    city: q(req, "city"),
    leadStatus: q(req, "leadStatus"),
    source: q(req, "source"),
    tag: q(req, "tag"),
    hasEmail: qBool(req, "hasEmail"),
    emailOptIn: qBool(req, "emailOptIn"),
    excludeDoNotContact: qBool(req, "excludeDoNotContact"),
    contactableByEmail: qBool(req, "contactableByEmail"),
    minHomeValue: qNum(req, "minHomeValue"),
    maxHomeValue: qNum(req, "maxHomeValue"),
    minLeadScore: qNum(req, "minLeadScore"),
    minInvestableAssets: qNum(req, "minInvestableAssets"),
    isBusinessOwner: qBool(req, "isBusinessOwner"),
    isExecutive: qBool(req, "isExecutive"),
    householdId: qNum(req, "householdId"),
    importId: qNum(req, "importId"),
    updatedSince: q(req, "updatedSince"),
    notSyncedToCrm: qBool(req, "notSyncedToCrm"),
    sortBy: q(req, "sortBy") as any,
    sortDir: q(req, "sortDir") as any,
    limit: qNum(req, "limit"),
    offset: qNum(req, "offset"),
  };
}

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.join(";") : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowsToCsv(rows: ReturnType<typeof import("../lib/prospects/queries").shapeRow>[]): string {
  const cols: Array<[string, (r: any) => unknown]> = [
    ["id", (r) => r.id], ["first_name", (r) => r.name.first], ["last_name", (r) => r.name.last], ["full_name", (r) => r.name.full],
    ["email", (r) => r.email], ["email_status", (r) => r.emailStatus], ["email_opt_in", (r) => r.emailOptIn],
    ["contactable_by_email", (r) => r.consent.contactableByEmail], ["do_not_contact", (r) => r.consent.doNotContact],
    ["phone", (r) => r.phone], ["mobile", (r) => r.phoneMobile],
    ["address1", (r) => r.address.line1], ["address2", (r) => r.address.line2], ["city", (r) => r.address.city],
    ["state", (r) => r.address.state], ["zip5", (r) => r.address.zip5],
    ["home_value", (r) => r.wealth.homeValue], ["purchase_price", (r) => r.wealth.purchasePrice], ["purchase_date", (r) => r.wealth.purchaseDate],
    ["est_net_worth_band", (r) => r.wealth.estNetWorthBand], ["est_investable_assets", (r) => r.wealth.estInvestableAssets],
    ["is_business_owner", (r) => r.wealth.isBusinessOwner], ["is_executive", (r) => r.wealth.isExecutive],
    ["occupation", (r) => r.profile.occupation], ["employer", (r) => r.profile.employer], ["title", (r) => r.profile.title], ["linkedin", (r) => r.profile.linkedinUrl],
    ["lead_status", (r) => r.lead.status], ["lead_score", (r) => r.lead.score],
    ["source", (r) => r.provenance.source], ["source_detail", (r) => r.provenance.sourceDetail], ["acquired_at", (r) => r.provenance.acquiredAt],
    ["vistacrm_contact_id", (r) => r.crm.vistacrmContactId], ["tags", (r) => r.tags], ["notes", (r) => r.notes], ["updated_at", (r) => r.updatedAt],
  ];
  const lines = [cols.map(([c]) => c).join(",")];
  for (const r of rows) lines.push(cols.map(([, f]) => csvEscape(f(r))).join(","));
  return lines.join("\r\n") + "\r\n";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, ACCESS_TOKEN, access_token");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();

  const auth = await requireAccessOrSession(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: auth.reason, auth: "vistamark-sso-or-token" });
  if (!isDbReady()) return res.status(503).json({ ok: false, error: "DATABASE_URL not configured" });
  const actor = auth.via === "session" ? auth.email ?? "session" : "token";

  try {
    if (req.method === "GET") {
      const view = q(req, "view");
      const format = q(req, "format");
      const id = qNum(req, "id");
      if (id != null) return res.status(200).json({ ok: true, ...(await prospectLookup({ id })) });
      if (view === "summary") return res.status(200).json({ ok: true, ...(await prospectsZipSummary({ zip: q(req, "zip"), includeInactive: qBool(req, "includeInactive") })) });
      if (view === "zips") return res.status(200).json({ ok: true, ...(await prospectZipTargets({ action: "list" })) });
      if (view === "imports") return res.status(200).json({ ok: true, ...(await prospectImportsList({ limit: qNum(req, "limit") })) });

      const args = searchArgsFromQuery(req);
      if (format === "crm") {
        const out = await prospectsExportCrm({ ...args, markSynced: qBool(req, "markSynced"), actor });
        return res.status(200).json({ ok: true, ...out });
      }
      if (format === "csv") {
        const out = await prospectsSearch({ ...args, limit: args.limit ?? 1000 });
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="prospects${args.zip ? "-" + args.zip.replace(/[^\d,]/g, "") : ""}.csv"`);
        return res.status(200).send(rowsToCsv(out.rows));
      }
      return res.status(200).json({ ok: true, ...(await prospectsSearch(args)) });
    }

    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "GET or POST only" });

    const contentTypeRaw = String(req.headers["content-type"] ?? "");
    const contentType = contentTypeRaw.toLowerCase(); // boundary tokens are case-sensitive — use contentTypeRaw for multipart
    const body = await readBody(req);

    // Options shared by every upload path, from the query string.
    let columnMap: Record<string, string> | undefined;
    const cmRaw = q(req, "columnMap");
    if (cmRaw) {
      try { columnMap = JSON.parse(cmRaw); } catch { return res.status(400).json({ ok: false, error: "columnMap must be a JSON object" }); }
    }
    const baseOpts = {
      source: q(req, "source"),
      sourceDetail: q(req, "sourceDetail") ?? null,
      filename: q(req, "filename") ?? null,
      defaultZip: q(req, "defaultZip") ?? null,
      restrictZips: qBool(req, "restrictZips") ?? false,
      dryRun: qBool(req, "dryRun") ?? false,
      tags: q(req, "tags")?.split(",").map((t) => t.trim()).filter(Boolean),
      nameOrder: (q(req, "nameOrder") as any) ?? "auto",
      submittedBy: actor,
      columnMap,
    };

    // --- JSON -----------------------------------------------------------------
    if (contentType.includes("application/json")) {
      let json: any;
      try { json = body.length ? JSON.parse(body.toString("utf8")) : {}; } catch { return res.status(400).json({ ok: false, error: "Invalid JSON" }); }

      const action = json.action;
      if (action === "update") {
        return res.status(200).json({ ok: true, ...(await prospectUpdate({ ...json, actor: json.actor ?? actor })) });
      }
      if (action === "zips") {
        return res.status(200).json({ ok: true, ...(await prospectZipTargets({ ...json, action: json.action2 ?? json.zipAction ?? "list" })) });
      }
      if (action === "crm_ack") {
        return res.status(200).json({ ok: true, ...(await prospectsExportCrm({ limit: 1, vistacrmContactIds: json.vistacrmContactIds, actor })) });
      }
      if (typeof json.csv === "string") {
        const table = parseTabular(json.csv, { delimiter: json.delimiter });
        const out = await importTable(table, {
          via: "csv",
          source: json.source ?? baseOpts.source ?? "api",
          sourceDetail: json.sourceDetail ?? baseOpts.sourceDetail,
          filename: json.filename ?? baseOpts.filename,
          defaultZip: json.defaultZip ?? baseOpts.defaultZip,
          restrictZips: json.restrictZips ?? baseOpts.restrictZips,
          dryRun: json.dryRun ?? baseOpts.dryRun,
          tags: json.tags ?? baseOpts.tags,
          nameOrder: json.nameOrder ?? baseOpts.nameOrder,
          columnMap: json.columnMap ?? columnMap,
          submittedBy: actor,
        });
        return res.status(200).json({ ...out, ok: out.ok });
      }
      const records = Array.isArray(json.records) ? json.records : json.record ? [json.record] : Array.isArray(json) ? json : null;
      if (!records || !records.length) {
        return res.status(400).json({ ok: false, error: "Expected { records: [...] }, { record: {...} }, { csv: '...' }, or an action" });
      }
      const opts: ImportOptions = {
        via: json.via === "form" ? "form" : "json",
        source: json.source ?? baseOpts.source ?? (json.via === "form" ? "website-form" : "api"),
        sourceDetail: json.sourceDetail ?? baseOpts.sourceDetail,
        defaultZip: json.defaultZip ?? baseOpts.defaultZip,
        restrictZips: json.restrictZips ?? baseOpts.restrictZips,
        dryRun: json.dryRun ?? baseOpts.dryRun,
        tags: json.tags ?? baseOpts.tags,
        nameOrder: json.nameOrder ?? baseOpts.nameOrder,
        submittedBy: actor,
      };
      return res.status(200).json(await importRecords(records, opts));
    }

    // --- multipart/form-data ----------------------------------------------------
    if (contentType.includes("multipart/form-data")) {
      const { fields, file } = parseMultipart(body, contentTypeRaw);
      if (!file) return res.status(400).json({ ok: false, error: "multipart upload needs a file part" });
      let cm = columnMap;
      if (fields.columnMap) { try { cm = JSON.parse(fields.columnMap); } catch { return res.status(400).json({ ok: false, error: "columnMap field must be JSON" }); } }
      const table = parseTabular(file.data, { filename: file.name, contentType: file.type, sheet: fields.sheet });
      const out = await importTable(table, {
        via: file.name.toLowerCase().endsWith(".xlsx") ? "xlsx" : "csv",
        source: fields.source ?? baseOpts.source ?? "upload",
        sourceDetail: fields.sourceDetail ?? baseOpts.sourceDetail,
        filename: file.name,
        defaultZip: fields.defaultZip ?? baseOpts.defaultZip,
        restrictZips: fields.restrictZips != null ? ["1", "true", "on", "yes"].includes(fields.restrictZips.toLowerCase()) : baseOpts.restrictZips,
        dryRun: fields.dryRun != null ? ["1", "true", "on", "yes"].includes(fields.dryRun.toLowerCase()) : baseOpts.dryRun,
        tags: fields.tags ? fields.tags.split(",").map((t) => t.trim()).filter(Boolean) : baseOpts.tags,
        nameOrder: (fields.nameOrder as any) ?? baseOpts.nameOrder,
        columnMap: cm,
        submittedBy: actor,
      });
      return res.status(200).json({ ...out, sheet: table.sheet });
    }

    // --- raw CSV / TSV / XLSX body ------------------------------------------------
    if (!body.length) return res.status(400).json({ ok: false, error: "Empty body" });
    const isXlsx = contentType.includes("spreadsheetml") || contentType.includes("octet-stream") || (baseOpts.filename ?? "").toLowerCase().endsWith(".xlsx");
    const table = parseTabular(body, { filename: baseOpts.filename ?? undefined, contentType, sheet: q(req, "sheet") });
    const out = await importTable(table, {
      ...baseOpts,
      via: isXlsx ? "xlsx" : "csv",
      source: baseOpts.source ?? "upload",
    });
    return res.status(200).json({ ...out, sheet: table.sheet });
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const status = /requires|Invalid|not a valid|Could not find|No zip|Expected|exceeds|zero data rows|unknown target field/i.test(msg) ? 400 : 500;
    return res.status(status).json({ ok: false, error: msg });
  }
}
