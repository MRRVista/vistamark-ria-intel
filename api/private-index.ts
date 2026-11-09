/**
 * /api/private-index — upload slot and read API for appraisal-based private
 * market indices that have NO public API and arrive as a quarterly
 * subscriber download: NCREIF Timberland Property Index (NTI), NCREIF
 * Farmland Property Index (NFI), and anything else of that shape.
 *
 *   GET  /api/private-index?id=ncreif-timberland
 *        Public read (same CORS posture as /api/cpi): the stored series,
 *        newest-first, with a chained index level and the de-smoothing
 *        parameter VistaBuilder needs. 404 when nothing is loaded yet —
 *        never an empty 200 that a consumer could mistake for "zero".
 *   GET  /api/private-index            -> list of loaded index ids + counts
 *   DELETE /api/private-index?id=X[&period=2026Q3]  (same write auth) -> remove one period or the whole index
 *
 *   POST /api/private-index            (Bearer ACCESS_TOKEN or Bearer CRON_SECRET — Randall, scripts, Matt)
 *        Body (JSON): { "id": "ncreif-timberland", "source": "NCREIF NTI 3Q2026 release",
 *                       "rows": [ { "period": "2026Q3", "total": 0.0123,
 *                                   "income": 0.0061, "appreciation": 0.0062 }, ... ] }
 *        Body (text/csv): header row "period,total,income,appreciation" then rows.
 *        Returns are DECIMALS (1.23% -> 0.0123). Percent inputs are rejected
 *        (|x| > 1) so a pasted "1.23" can never land as 123%. Upsert on
 *        (id, period): re-posting a revised quarter overwrites it.
 *
 * Index ids are free-form slugs; the two VistaBuilder consumes are
 * "ncreif-timberland" and "ncreif-farmland". Licensing: NCREIF data is
 * subscriber-only — this endpoint redistributes a Vistamark-held series to
 * Vistamark's own apps, nothing more; keep the CORS list tight.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { neon } from "@neondatabase/serverless";
import { requireAccess } from "../lib/auth";

/**
 * Write auth: ACCESS_TOKEN (the standing automation credential) OR
 * Authorization: Bearer CRON_SECRET (the admin/migration credential Matt
 * already holds — added 2026-11-09 so the quarterly upload needs no second
 * secret). Deliberately NOT requireCron(): that helper also accepts a bare
 * x-vercel-cron header, which must never unlock a write.
 */
function requireWrite(req: VercelRequest): { ok: true } | { ok: false; reason: string } {
  const a = requireAccess(req);
  if (a.ok) return a;
  const cron = process.env.CRON_SECRET;
  const auth = req.headers.authorization;
  if (cron && auth === `Bearer ${cron}`) return { ok: true };
  return { ok: false, reason: "Missing or invalid credential: send ACCESS_TOKEN header or Authorization: Bearer <ACCESS_TOKEN | CRON_SECRET>" };
}

function allowOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
  const exact = [
    "vistaintel.app",
    "www.vistaintel.app",
    "vistabuilder.app",
    "www.vistabuilder.app",
    "vistabuilder.net",
    "www.vistabuilder.net",
    "vistabalancer.app",
    "www.vistabalancer.app",
    "localhost",
    "127.0.0.1",
  ];
  return exact.includes(host) ? origin : null;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

interface Row {
  period: string;
  total: number | null;
  income: number | null;
  appreciation: number | null;
}

/** "2026Q3" | "2026-Q3" | "3Q2026" | "Q3 2026" | "2026-09-30" -> "2026Q3" */
function normPeriod(s: string): string | null {
  const t = String(s).trim().toUpperCase().replace(/\s+/g, "");
  let m = /^(\d{4})-?Q([1-4])$/.exec(t);
  if (m) return `${m[1]}Q${m[2]}`;
  m = /^Q?([1-4])Q?-?(\d{4})$/.exec(t);
  if (m) return `${m[2]}Q${m[1]}`;
  m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(t);
  if (m) {
    const mo = parseInt(m[2], 10);
    if (mo >= 1 && mo <= 12) return `${m[1]}Q${Math.ceil(mo / 3)}`;
  }
  return null;
}

function num(v: unknown): number | null | "bad" {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[%,\s]/g, ""));
  if (!Number.isFinite(n)) return "bad";
  return n;
}

function parseCsv(text: string): Row[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idx = (names: string[]) => header.findIndex((h) => names.includes(h));
  const iP = idx(["period", "quarter", "date"]);
  const iT = idx(["total", "total_return", "totalreturn", "tr"]);
  const iI = idx(["income", "income_return", "incomereturn"]);
  const iA = idx(["appreciation", "appreciation_return", "capital", "capital_return"]);
  if (iP < 0) throw new Error("CSV needs a 'period' column");
  return lines.slice(1).map((l) => {
    const c = l.split(",");
    const pick = (i: number) => (i >= 0 ? c[i] : undefined);
    return {
      period: pick(iP) ?? "",
      total: num(pick(iT)) as number | null,
      income: num(pick(iI)) as number | null,
      appreciation: num(pick(iA)) as number | null,
    };
  });
}

function lag1Autocorr(x: number[]): number | null {
  if (x.length < 8) return null;
  const n = x.length;
  const mean = x.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    den += (x[i] - mean) ** 2;
    if (i > 0) num += (x[i] - mean) * (x[i - 1] - mean);
  }
  return den > 0 ? Math.round((num / den) * 1e6) / 1e6 : null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cors = allowOrigin(req.headers.origin as string | undefined);
  if (cors) {
    res.setHeader("Access-Control-Allow-Origin", cors);
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, ACCESS_TOKEN, access_token");
    res.setHeader("Access-Control-Max-Age", "86400");
    res.status(204).end();
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    res.status(503).json({ error: "DATABASE_URL not configured" });
    return;
  }
  const sql = neon(url);

  try {
    if (req.method === "GET") {
      const idRaw = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
      if (!idRaw) {
        const rows = (await sql`
          SELECT index_id, count(*)::int AS n, min(period) AS first, max(period) AS last, max(uploaded_at) AS uploaded_at
          FROM private_index_obs GROUP BY index_id ORDER BY index_id`) as any[];
        res.setHeader("Cache-Control", "public, s-maxage=300");
        res.status(200).json({ indices: rows });
        return;
      }
      const id = String(idRaw).toLowerCase();
      if (!ID_RE.test(id)) {
        res.status(400).json({ error: "bad id" });
        return;
      }
      const rows = (await sql`
        SELECT period, total_return, income_return, appreciation_return, index_level, source, note, uploaded_at
        FROM private_index_obs WHERE index_id = ${id} ORDER BY period ASC`) as any[];
      if (!rows.length) {
        res.status(404).json({
          error: `No observations loaded for index '${id}'`,
          hint: "POST rows to /api/private-index with ACCESS_TOKEN. See the file header for the body shape.",
        });
        return;
      }
      // Chain a level from total returns when the upload did not carry one (base 100 at first period).
      let level = 100;
      const periods: string[] = [];
      const total: (number | null)[] = [];
      const income: (number | null)[] = [];
      const appreciation: (number | null)[] = [];
      const index: (number | null)[] = [];
      for (const r of rows) {
        const tr = r.total_return == null ? null : Number(r.total_return);
        periods.push(r.period);
        total.push(tr);
        income.push(r.income_return == null ? null : Number(r.income_return));
        appreciation.push(r.appreciation_return == null ? null : Number(r.appreciation_return));
        if (r.index_level != null) level = Number(r.index_level);
        else if (tr != null) level = level * (1 + tr);
        index.push(Math.round(level * 1e4) / 1e4);
      }
      const trClean = total.filter((v): v is number => v != null);
      const rho = lag1Autocorr(trClean);
      // Newest-first on output, matching /api/cpi and /api/farmland.
      const rev = <T>(a: T[]) => a.slice().reverse();
      res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
      res.status(200).json({
        indexId: id,
        source: rows[rows.length - 1].source ?? null,
        frequency: "Quarterly",
        periodKey: "YYYYQn",
        order: "newest-first",
        units: "decimal returns; index base 100 at observationStart unless levels were uploaded",
        observationStart: periods[0],
        asof: periods[periods.length - 1],
        count: periods.length,
        lastUploaded: rows.reduce((m: string, r: any) => (r.uploaded_at > m ? r.uploaded_at : m), ""),
        periods: rev(periods),
        total: rev(total),
        income: rev(income),
        appreciation: rev(appreciation),
        index: rev(index),
        unsmoothing: {
          rho,
          method: "Geltner (1993) first-order: r_true[t] = (r_obs[t] - rho*r_obs[t-1]) / (1 - rho)",
          note: "rho is the lag-1 autocorrelation of the stored total returns. Appraisal-based indices understate volatility and overstate diversification; de-smooth before this series touches an optimizer.",
        },
      });
      return;
    }

    if (req.method === "DELETE") {
      const auth = requireWrite(req);
      if (!auth.ok) {
        res.status(401).json({ error: auth.reason });
        return;
      }
      const id = String(Array.isArray(req.query.id) ? req.query.id[0] : req.query.id ?? "").toLowerCase();
      if (!ID_RE.test(id)) {
        res.status(400).json({ error: "DELETE requires ?id=<slug>" });
        return;
      }
      const periodRaw = Array.isArray(req.query.period) ? req.query.period[0] : req.query.period;
      if (periodRaw) {
        const p = normPeriod(String(periodRaw));
        if (!p) {
          res.status(400).json({ error: `bad period '${periodRaw}'` });
          return;
        }
        const r = (await sql`DELETE FROM private_index_obs WHERE index_id = ${id} AND period = ${p} RETURNING period`) as any[];
        res.status(200).json({ ok: true, indexId: id, deleted: r.length, period: p });
        return;
      }
      const r = (await sql`DELETE FROM private_index_obs WHERE index_id = ${id} RETURNING period`) as any[];
      res.status(200).json({ ok: true, indexId: id, deleted: r.length });
      return;
    }

    if (req.method === "POST") {
      const auth = requireWrite(req);
      if (!auth.ok) {
        res.status(401).json({ error: auth.reason });
        return;
      }
      const ct = String(req.headers["content-type"] ?? "");
      let id: string | undefined;
      let source: string | undefined;
      let note: string | undefined;
      let rows: Row[];
      if (ct.includes("text/csv") || ct.includes("text/plain")) {
        id = String(Array.isArray(req.query.id) ? req.query.id[0] : req.query.id ?? "");
        source = String(Array.isArray(req.query.source) ? req.query.source[0] : req.query.source ?? "");
        const text = typeof req.body === "string" ? req.body : String(req.body ?? "");
        rows = parseCsv(text);
      } else {
        const body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) ?? {};
        id = body.id;
        source = body.source;
        note = body.note;
        rows = Array.isArray(body.rows) ? body.rows : [];
      }
      id = String(id ?? "").toLowerCase();
      if (!ID_RE.test(id)) {
        res.status(400).json({ error: "id must be a slug like 'ncreif-timberland'" });
        return;
      }
      if (!rows.length) {
        res.status(400).json({ error: "no rows" });
        return;
      }
      const clean: Row[] = [];
      const problems: string[] = [];
      for (const r of rows) {
        const p = normPeriod(r.period);
        if (!p) {
          problems.push(`bad period '${r.period}'`);
          continue;
        }
        const vals = { total: num(r.total), income: num(r.income), appreciation: num(r.appreciation) };
        let ok = true;
        for (const [k, v] of Object.entries(vals)) {
          if (v === "bad") {
            problems.push(`${p}: ${k} not numeric`);
            ok = false;
          } else if (v != null && Math.abs(v) > 1) {
            problems.push(`${p}: ${k}=${v} looks like a percent; send decimals (1.23% -> 0.0123)`);
            ok = false;
          }
        }
        if (!ok) continue;
        if (vals.total == null && vals.income == null && vals.appreciation == null) {
          problems.push(`${p}: no values`);
          continue;
        }
        clean.push({
          period: p,
          total: vals.total as number | null,
          income: vals.income as number | null,
          appreciation: vals.appreciation as number | null,
        });
      }
      if (problems.length) {
        res.status(400).json({ error: "validation failed; nothing written", problems });
        return;
      }
      const by = (req.headers["x-uploaded-by"] as string | undefined) ?? "access_token";
      let written = 0;
      for (const r of clean) {
        await sql`
          INSERT INTO private_index_obs (index_id, period, total_return, income_return, appreciation_return, source, note, uploaded_by, uploaded_at)
          VALUES (${id}, ${r.period}, ${r.total}, ${r.income}, ${r.appreciation}, ${source ?? null}, ${note ?? null}, ${by}, now())
          ON CONFLICT (index_id, period) DO UPDATE SET
            total_return = EXCLUDED.total_return,
            income_return = EXCLUDED.income_return,
            appreciation_return = EXCLUDED.appreciation_return,
            source = COALESCE(EXCLUDED.source, private_index_obs.source),
            note = COALESCE(EXCLUDED.note, private_index_obs.note),
            uploaded_by = EXCLUDED.uploaded_by,
            uploaded_at = now()`;
        written++;
      }
      const count = (await sql`SELECT count(*)::int AS n, min(period) AS first, max(period) AS last FROM private_index_obs WHERE index_id = ${id}`) as any[];
      res.status(200).json({ ok: true, indexId: id, written, stored: count[0] });
      return;
    }

    res.status(405).json({ error: "GET, POST or DELETE" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Table missing -> migration 0013 not applied yet. Say so plainly.
    if (/private_index_obs.*does not exist/i.test(msg)) {
      res.status(503).json({ error: "private_index_obs table missing — run /api/admin/migrate (Bearer CRON_SECRET) to apply migration 0013" });
      return;
    }
    res.status(500).json({ error: msg });
  }
}
