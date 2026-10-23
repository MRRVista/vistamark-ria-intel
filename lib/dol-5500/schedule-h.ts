/**
 * DOL Form 5500 Schedule H (large plans) + Schedule I (small plans) — ingest
 * into dol_sch_h_i (migrations/0010) and shared asset lookup helpers.
 *
 * WHY: since the 2024 FOIA files DOL no longer populates TOT_ASSETS_*_AMT /
 * NET_ASSETS_*_AMT in F_5500 (so plans.tot_assets_eoy_amt is NULL for 2024+).
 * Plan totals now live only on Schedule H / I. This loader restores them and
 * adds the Sch H asset-class breakdown an adviser cares about.
 *
 * Files (verified live 2026-10-22, published 2026-09-25):
 *   F_SCH_H_2024_Latest.zip → F_SCH_H_2024_latest.csv  166 cols, 87,983 rows
 *   F_SCH_I_2024_Latest.zip → F_SCH_I_2024_latest.csv   77 cols, 59,666 rows
 * One row per ACK_ID in each file (no duplicates). Sch I columns carry a
 * SMALL_ prefix; both are mapped onto one unprefixed column set.
 *
 * Pattern copied from lib/filings-people/schedule-c.ts: zip via adm-zip,
 * CSV stream-parsed in 4 MB chunks (irs-bmf primitives), batched upserts with
 * drizzle `sql` (no schema.ts changes), one ingest_runs row per schedule.
 */
import AdmZip from "adm-zip";
import { sql } from "drizzle-orm";
import { db, isDbReady } from "../db";
import { politeFetch } from "../data/http";
import { consumeCsvChunk, finishCsvStream, newStreamState } from "../irs-bmf/parser";

const SOURCE_PREFIX = "dol-sch-h";
const BATCH_SIZE = 500; // 51 params × 500 = 25.5k binds (< 65,535)
// askebsa.dol.gov 301-redirects to www.askebsa.dol.gov; use the final host.
const DOL_BASE_URL = process.env.DOL_5500_SCH_H_BASE_URL ?? "https://www.askebsa.dol.gov/FOIA%20Files";

export type Schedule = "H" | "I";

export function defaultSchHYear(): number {
  const envYear = process.env.DOL_5500_YEAR;
  if (envYear && /^\d{4}$/.test(envYear)) return Number(envYear);
  return new Date().getUTCFullYear() - 2;
}

export function schHUrl(year: number, schedule: Schedule): string {
  return `${DOL_BASE_URL}/${year}/Latest/F_SCH_${schedule}_${year}_Latest.zip`;
}

// ---------------------------------------------------------------------------
// Column mapping: table column → [Sch H FOIA field, Sch I FOIA field | null]
// ---------------------------------------------------------------------------

const MONEY_COLS: Array<[string, string, string | null]> = [
  ["tot_assets_boy_amt", "TOT_ASSETS_BOY_AMT", "SMALL_TOT_ASSETS_BOY_AMT"],
  ["tot_liabilities_boy_amt", "TOT_LIABILITIES_BOY_AMT", "SMALL_TOT_LIABILITIES_BOY_AMT"],
  ["net_assets_boy_amt", "NET_ASSETS_BOY_AMT", "SMALL_NET_ASSETS_BOY_AMT"],
  ["tot_assets_eoy_amt", "TOT_ASSETS_EOY_AMT", "SMALL_TOT_ASSETS_EOY_AMT"],
  ["tot_liabilities_eoy_amt", "TOT_LIABILITIES_EOY_AMT", "SMALL_TOT_LIABILITIES_EOY_AMT"],
  ["net_assets_eoy_amt", "NET_ASSETS_EOY_AMT", "SMALL_NET_ASSETS_EOY_AMT"],
  ["emplr_contrib_income_amt", "EMPLR_CONTRIB_INCOME_AMT", "SMALL_EMPLR_CONTRIB_INCOME_AMT"],
  ["participant_contrib_amt", "PARTICIPANT_CONTRIB_AMT", "SMALL_PARTICIPANT_CONTRIB_AMT"],
  ["oth_contrib_rcvd_amt", "OTH_CONTRIB_RCVD_AMT", "SMALL_OTH_CONTRIB_RCVD_AMT"],
  ["tot_contrib_amt", "TOT_CONTRIB_AMT", null], // derived for I
  ["tot_income_amt", "TOT_INCOME_AMT", "SMALL_TOT_INCOME_AMT"],
  ["net_invst_gain_amt", "", null], // derived for both
  ["tot_distrib_bnft_amt", "TOT_DISTRIB_BNFT_AMT", "SMALL_TOT_DISTRIB_BNFT_AMT"],
  ["tot_admin_expenses_amt", "TOT_ADMIN_EXPENSES_AMT", "SMALL_ADMIN_SRVC_PROVIDERS_AMT"],
  ["invst_mgmt_fees_amt", "INVST_MGMT_FEES_AMT", null],
  ["tot_expenses_amt", "TOT_EXPENSES_AMT", "SMALL_TOT_EXPENSES_AMT"],
  ["net_income_amt", "NET_INCOME_AMT", "SMALL_NET_INCOME_AMT"],
  ["non_int_bear_cash_eoy_amt", "NON_INT_BEAR_CASH_EOY_AMT", null],
  ["int_bear_cash_eoy_amt", "INT_BEAR_CASH_EOY_AMT", null],
  ["govt_sec_eoy_amt", "GOVT_SEC_EOY_AMT", null],
  ["corp_debt_preferred_eoy_amt", "CORP_DEBT_PREFERRED_EOY_AMT", null],
  ["corp_debt_other_eoy_amt", "CORP_DEBT_OTHER_EOY_AMT", null],
  ["pref_stock_eoy_amt", "PREF_STOCK_EOY_AMT", null],
  ["common_stock_eoy_amt", "COMMON_STOCK_EOY_AMT", null],
  ["joint_venture_eoy_amt", "JOINT_VENTURE_EOY_AMT", "SMALL_JOINT_VENTURE_EOY_AMT"],
  ["real_estate_eoy_amt", "REAL_ESTATE_EOY_AMT", "SMALL_INV_REAL_ESTATE_EOY_AMT"],
  ["other_loans_eoy_amt", "OTHER_LOANS_EOY_AMT", "SMALL_OTH_LNS_PARTCP_EOY_AMT"],
  ["partcp_loans_eoy_amt", "PARTCP_LOANS_EOY_AMT", "SMALL_MORTG_PARTCP_EOY_AMT"],
  ["int_common_tr_eoy_amt", "INT_COMMON_TR_EOY_AMT", null],
  ["int_pool_sep_acct_eoy_amt", "INT_POOL_SEP_ACCT_EOY_AMT", null],
  ["int_master_tr_eoy_amt", "INT_MASTER_TR_EOY_AMT", null],
  ["int_103_12_invst_eoy_amt", "INT_103_12_INVST_EOY_AMT", null],
  ["int_reg_invst_co_eoy_amt", "INT_REG_INVST_CO_EOY_AMT", null],
  ["ins_co_gen_acct_eoy_amt", "INS_CO_GEN_ACCT_EOY_AMT", null],
  ["oth_invst_eoy_amt", "OTH_INVST_EOY_AMT", null],
  ["emplr_sec_eoy_amt", "EMPLR_SEC_EOY_AMT", "SMALL_EMPLR_SEC_EOY_AMT"],
  ["emplr_prop_eoy_amt", "EMPLR_PROP_EOY_AMT", "SMALL_EMPLR_PROP_EOY_AMT"],
  ["bldgs_used_eoy_amt", "BLDGS_USED_EOY_AMT", null],
];

const TEXT_COLS: Array<[string, string, string | null, number]> = [
  ["accountant_firm_name", "ACCOUNTANT_FIRM_NAME", null, 200],
  ["accountant_firm_ein", "ACCOUNTANT_FIRM_EIN", null, 12],
  ["acctnt_opinion_type_cd", "ACCTNT_OPINION_TYPE_CD", null, 2],
  ["fdcry_trust_name", "FDCRY_TRUST_NAME", "FDCRY_TRUST_NAME", 200],
  ["fdcry_trustee_cust_name", "FDCRY_TRUSTEE_CUST_NAME", "FDCRY_TRUSTEE_CUST_NAME", 200],
];

const HEAD_COLS = ["ack_id", "filing_year", "schedule", "plan_year_begin_date", "tax_prd", "pn", "ein"];
const ALL_COLS = [...HEAD_COLS, ...MONEY_COLS.map((c) => c[0]), ...TEXT_COLS.map((c) => c[0])];

export type SchHRow = Array<string | number | null>;

function nz(v: string | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}
function money(v: string | undefined): number | null {
  const t = nz(v);
  if (t == null) return null;
  const n = Number(t.replace(/[,$]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : null;
}
function isoDate(v: string | undefined): string | null {
  const t = nz(v);
  return t && /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}
function clamp(s: string | null, max: number): string | null {
  return s != null && s.length > max ? s.slice(0, max) : s;
}

export function headerIndex(row: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  row.forEach((h, i) => {
    idx[h.replace(/^﻿/, "").trim().toUpperCase()] = i;
  });
  return idx;
}

/** Map one CSV row (H or I) to an ordered value array matching ALL_COLS. */
export function schRowToRecord(row: string[], idx: Record<string, number>, year: number, schedule: Schedule): SchHRow | null {
  const g = (k: string | null) => (k && idx[k] != null ? row[idx[k]!] : undefined);
  const ackId = clamp(nz(g("ACK_ID")), 40);
  if (!ackId) return null;
  const h = schedule === "H";
  const out: SchHRow = [
    ackId,
    year,
    schedule,
    isoDate(g(h ? "SCH_H_PLAN_YEAR_BEGIN_DATE" : "SCH_I_PLAN_YEAR_BEGIN_DATE")),
    isoDate(g(h ? "SCH_H_TAX_PRD" : "SCH_I_TAX_PRD")),
    clamp(nz(g(h ? "SCH_H_PN" : "SCH_I_PLAN_NUM")), 3),
    clamp((nz(g(h ? "SCH_H_EIN" : "SCH_I_EIN")) ?? "").replace(/\D/g, "") || null, 9),
  ];
  const vals: Record<string, number | null> = {};
  for (const [col, hKey, iKey] of MONEY_COLS) {
    const key = h ? hKey : iKey;
    vals[col] = key ? money(g(key)) : null;
  }
  if (!h) {
    const parts = [
      money(g("SMALL_EMPLR_CONTRIB_INCOME_AMT")),
      money(g("SMALL_PARTICIPANT_CONTRIB_AMT")),
      money(g("SMALL_OTH_CONTRIB_RCVD_AMT")),
      money(g("SMALL_NON_CASH_CONTRIB_BS_AMT")),
    ];
    vals.tot_contrib_amt = parts.every((p) => p == null) ? null : parts.reduce<number>((a, p) => a + (p ?? 0), 0);
  }
  vals.net_invst_gain_amt =
    vals.tot_income_amt != null && vals.tot_contrib_amt != null ? vals.tot_income_amt - vals.tot_contrib_amt : null;
  for (const [col] of MONEY_COLS) out.push(vals[col] ?? null);
  for (const [, hKey, iKey, max] of TEXT_COLS) {
    const key = h ? hKey : iKey;
    out.push(key ? clamp(nz(g(key)), max) : null);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

function rowsOf(r: any): any[] {
  return (r?.rows ?? r) as any[];
}

async function downloadCsvFromZip(url: string): Promise<{ name: string; data: Buffer }> {
  const res = await politeFetch(url, { timeoutMs: 180_000, redirect: "follow", headers: { Accept: "*/*" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
  const entry = zip.getEntries().find((e) => !e.isDirectory && /\.csv$/i.test(e.entryName));
  if (!entry) throw new Error(`No CSV entry in ${url}`);
  return { name: entry.entryName, data: entry.getData() };
}

const UPDATE_SET = sql.raw(
  ALL_COLS.filter((c) => c !== "ack_id")
    .map((c) => `${c} = excluded.${c}`)
    .concat("last_updated_at = NOW()")
    .join(", ")
);
const INSERT_COLS = sql.raw(ALL_COLS.join(", "));

async function upsertBatch(rows: SchHRow[]) {
  if (!rows.length) return;
  const values = sql.join(
    rows.map((r) => sql`(${sql.join(r.map((v) => sql`${v}`), sql`, `)})`),
    sql`, `
  );
  await db.execute(sql`
    INSERT INTO dol_sch_h_i (${INSERT_COLS}) VALUES ${values}
    ON CONFLICT (ack_id) DO UPDATE SET ${UPDATE_SET}`);
}

export interface SchHIngestResult {
  year: number;
  schedule: Schedule;
  rowsProcessed: number;
  rowsUpserted: number;
  durationMs: number;
  csvFile: string;
}

export async function ingestSchedule(year: number, schedule: Schedule): Promise<SchHIngestResult> {
  if (!db) throw new Error("Database not configured");
  const start = Date.now();
  const url = schHUrl(year, schedule);
  const run = rowsOf(
    await db.execute(
      sql`INSERT INTO ingest_runs (source, status) VALUES (${`${SOURCE_PREFIX}/${schedule}/${year}`}, 'running') RETURNING id`
    )
  );
  const runId = run[0]?.id;
  let rowsProcessed = 0;
  let rowsUpserted = 0;
  let csvFile = "";
  try {
    const { name, data } = await downloadCsvFromZip(url);
    csvFile = name;
    const state = newStreamState();
    const decoder = new TextDecoder("utf-8");
    let idx: Record<string, number> | null = null;
    let batch: SchHRow[] = [];
    const seen = new Set<string>(); // guard: duplicate ack_id in one INSERT would fail
    const onRow = (row: string[]) => {
      if (!idx) {
        idx = headerIndex(row);
        const need = schedule === "H" ? "TOT_ASSETS_EOY_AMT" : "SMALL_TOT_ASSETS_EOY_AMT";
        if (idx["ACK_ID"] == null || idx[need] == null) {
          throw new Error(`Unexpected Schedule ${schedule} header: ${row.slice(0, 8).join(",")}`);
        }
        return;
      }
      rowsProcessed++;
      const rec = schRowToRecord(row, idx, year, schedule);
      if (rec && !seen.has(rec[0] as string)) {
        seen.add(rec[0] as string);
        batch.push(rec);
      }
    };
    const CHUNK = 4 * 1024 * 1024;
    for (let off = 0; off < data.length; off += CHUNK) {
      consumeCsvChunk(state, decoder.decode(data.subarray(off, Math.min(off + CHUNK, data.length)), { stream: true }), onRow);
      while (batch.length >= BATCH_SIZE) {
        const chunk = batch.splice(0, BATCH_SIZE);
        await upsertBatch(chunk);
        rowsUpserted += chunk.length;
      }
    }
    const tail = decoder.decode();
    if (tail) consumeCsvChunk(state, tail, onRow);
    finishCsvStream(state, onRow);
    for (let i = 0; i < batch.length; i += BATCH_SIZE) {
      const chunk = batch.slice(i, i + BATCH_SIZE);
      await upsertBatch(chunk);
      rowsUpserted += chunk.length;
    }
    batch = [];
    await db.execute(sql`
      UPDATE ingest_runs SET status = 'ok', finished_at = NOW(),
        firms_processed = ${rowsProcessed}, firms_inserted = ${rowsUpserted}, firms_updated = 0
      WHERE id = ${runId}`);
    return { year, schedule, rowsProcessed, rowsUpserted, durationMs: Date.now() - start, csvFile };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .execute(sql`
        UPDATE ingest_runs SET status = 'error', finished_at = NOW(), error_message = ${message},
          firms_processed = ${rowsProcessed}, firms_inserted = ${rowsUpserted}
        WHERE id = ${runId}`)
      .catch(() => undefined);
    throw err;
  }
}

/** Load Schedule H then Schedule I for a year (sequential: each is ~50 MB of CSV). */
export async function ingestScheduleHI(year: number, schedules: Schedule[] = ["H", "I"]) {
  const results: SchHIngestResult[] = [];
  for (const s of schedules) results.push(await ingestSchedule(year, s));
  return { year, results, durationMs: results.reduce((a, r) => a + r.durationMs, 0) };
}

// ---------------------------------------------------------------------------
// Shared guard: does dol_sch_h_i exist? Cached so queries pay one round trip.
// Used by lib/dol-5500/queries.ts, lib/filings-people/schedule-c.ts, lib/dol-sch-h.
// ---------------------------------------------------------------------------

let tableExists: boolean | null = null;
let tableCheckedAt = 0;
const RECHECK_MS = 5 * 60 * 1000; // re-probe a missing table every 5 min (migration may land)

export async function schHTableExists(): Promise<boolean> {
  if (!isDbReady()) return false;
  if (tableExists === true) return true;
  if (tableExists === false && Date.now() - tableCheckedAt < RECHECK_MS) return false;
  try {
    const r = rowsOf(await db.execute(sql`SELECT to_regclass('public.dol_sch_h_i') AS r`));
    tableExists = r[0]?.r != null;
  } catch {
    tableExists = false;
  }
  tableCheckedAt = Date.now();
  return tableExists;
}

/** For tests / after running migrations in-process. */
export function resetSchHTableCache() {
  tableExists = null;
  tableCheckedAt = 0;
}
