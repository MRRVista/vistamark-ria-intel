/**
 * SEC Form 13F ingest pipeline.
 *
 * One quarterly zip (~80-95 MB) from
 *   https://www.sec.gov/files/structureddata/data/form-13f-data-sets/{period}_form13f.zip
 * expands to up to seven tab-delimited TSV tables. We consume four:
 *   SUBMISSION, COVERPAGE, SUMMARYPAGE  -> f13f_filings (one row per accession)
 *   INFOTABLE                            -> f13f_holdings (one row per position)
 *
 * Scale note: SUBMISSION/COVERPAGE/SUMMARYPAGE are small (~10-15K rows each,
 * one per filing) and are loaded fully into memory to assemble the filings
 * map. INFOTABLE is large (hundreds of thousands to >1M rows per quarter) and
 * is streamed line-by-line, upserted in batches.
 *
 * Because a full quarter's INFOTABLE may exceed one Vercel function's time
 * budget, ingest13f accepts:
 *   - managerFilter: only ingest holdings whose filing manager name matches
 *     this case-insensitive substring (e.g. "harvard", "stepstone"). The
 *     filings table is always loaded in full regardless; only holdings are
 *     filtered. This is the recommended mode for targeted prospecting.
 *   - maxHoldings: hard cap on holdings rows ingested this call (safety valve
 *     for the unfiltered case).
 */

import AdmZip from "adm-zip";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { f13fFilings, f13fHoldings, ingestRuns } from "../db/schema";
import type { F13fFilingInsert, F13fHoldingInsert } from "../db/schema";
import { politeFetch } from "../data/http";
import {
  splitTsvLine,
  buildHeaderIndex,
  cell,
  parseSecDate,
  parseIntOrNull,
  parseBigIntOrNull,
  normalizeValueUsd,
} from "./columns";

const SOURCE_PREFIX = "sec-13f";
const HOLDINGS_BATCH = 1000;
const FILINGS_BATCH = 500;

export interface F13fIngestResult {
  source: string;
  url: string;
  filingsUpserted: number;
  holdingsProcessed: number;
  holdingsUpserted: number;
  holdingsTruncated: boolean;
  matchedFilings: number;
  durationMs: number;
}

interface FilingMeta {
  periodIso: string | null;
  managerName: string | null;
}

/** Find a TSV entry by base name (case-insensitive), tolerant of subfolders. */
function findEntry(zip: AdmZip, base: string): AdmZip.IZipEntry | null {
  const want = base.toLowerCase();
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const name = e.entryName.split("/").pop()?.toLowerCase() ?? "";
    if (name === want) return e;
  }
  return null;
}

function readTsv(entry: AdmZip.IZipEntry | null): {
  header: Record<string, number>;
  rows: string[][];
} {
  if (!entry) return { header: {}, rows: [] };
  const text = entry.getData().toString("utf8");
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return { header: {}, rows: [] };
  const header = buildHeaderIndex(splitTsvLine(lines[0]!));
  const rows: string[][] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "") continue;
    rows.push(splitTsvLine(lines[i]!));
  }
  return { header, rows };
}

export async function ingest13f(
  url: string,
  opts: { managerFilter?: string; maxHoldings?: number } = {}
): Promise<F13fIngestResult> {
  if (!db) throw new Error("Database not configured");
  const start = Date.now();
  const fileLabel = url.split("/").pop()?.split("?")[0] ?? "file";
  const source = `${SOURCE_PREFIX}/${fileLabel}`.slice(0, 64);

  const runInsert = await db
    .insert(ingestRuns)
    .values({ source, status: "running" })
    .returning({ id: ingestRuns.id });
  const runId = runInsert[0]!.id;

  let filingsUpserted = 0;
  let holdingsProcessed = 0;
  let holdingsUpserted = 0;
  let holdingsTruncated = false;
  let matchedFilings = 0;

  try {
    const res = await politeFetch(url, { timeoutMs: 280_000 });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const zip = new AdmZip(buffer);

    // --- Pass 1: small filing-level tables fully into memory ---
    const submission = readTsv(findEntry(zip, "SUBMISSION.tsv"));
    const coverpage = readTsv(findEntry(zip, "COVERPAGE.tsv"));
    const summary = readTsv(findEntry(zip, "SUMMARYPAGE.tsv"));

    // accession -> partial filing record
    const filings = new Map<string, F13fFilingInsert>();
    const meta = new Map<string, FilingMeta>();

    for (const r of submission.rows) {
      const acc = cell(r, submission.header, "ACCESSION_NUMBER");
      if (!acc) continue;
      const periodIso = parseSecDate(cell(r, submission.header, "PERIODOFREPORT"));
      filings.set(acc, {
        accessionNumber: acc,
        cik: cell(r, submission.header, "CIK"),
        filingDate: parseSecDate(cell(r, submission.header, "FILING_DATE")),
        submissionType: cell(r, submission.header, "SUBMISSIONTYPE"),
        periodOfReport: periodIso,
      });
      meta.set(acc, { periodIso, managerName: null });
    }

    for (const r of coverpage.rows) {
      const acc = cell(r, coverpage.header, "ACCESSION_NUMBER");
      if (!acc) continue;
      const f = filings.get(acc) ?? { accessionNumber: acc };
      const managerName = cell(r, coverpage.header, "FILINGMANAGER_NAME");
      f.filingManagerName = managerName;
      f.filingManagerCity = cell(r, coverpage.header, "FILINGMANAGER_CITY");
      f.filingManagerState = cell(r, coverpage.header, "FILINGMANAGER_STATEORCOUNTRY");
      f.reportType = cell(r, coverpage.header, "REPORTTYPE");
      f.crdNumber = cell(r, coverpage.header, "CRDNUMBER");
      f.secFileNumber = cell(r, coverpage.header, "SECFILENUMBER");
      const isAmd = cell(r, coverpage.header, "ISAMENDMENT");
      f.isAmendment = isAmd != null ? /^y/i.test(isAmd) : null;
      filings.set(acc, f);
      const m = meta.get(acc) ?? { periodIso: null, managerName: null };
      m.managerName = managerName;
      meta.set(acc, m);
    }

    for (const r of summary.rows) {
      const acc = cell(r, summary.header, "ACCESSION_NUMBER");
      if (!acc) continue;
      const f = filings.get(acc) ?? { accessionNumber: acc };
      const entryTotal = parseIntOrNull(cell(r, summary.header, "TABLEENTRYTOTAL"));
      const valueTotal = parseBigIntOrNull(cell(r, summary.header, "TABLEVALUETOTAL"));
      f.tableEntryTotal = entryTotal;
      f.tableValueTotal = valueTotal;
      f.tableValueTotalUsd = normalizeValueUsd(valueTotal, meta.get(acc)?.periodIso ?? null);
      f.otherManagersCount = parseIntOrNull(
        cell(r, summary.header, "OTHERINCLUDEDMANAGERSCOUNT")
      );
      filings.set(acc, f);
    }

    // Upsert filings in batches.
    const filingRows = [...filings.values()];
    for (let i = 0; i < filingRows.length; i += FILINGS_BATCH) {
      const chunk = filingRows.slice(i, i + FILINGS_BATCH);
      await upsertFilings(chunk);
      filingsUpserted += chunk.length;
    }

    // Determine which accessions' holdings we will ingest.
    const filterLc = opts.managerFilter?.trim().toLowerCase() ?? null;
    let wantedAccessions: Set<string> | null = null;
    if (filterLc) {
      wantedAccessions = new Set<string>();
      for (const [acc, m] of meta) {
        if (m.managerName && m.managerName.toLowerCase().includes(filterLc)) {
          wantedAccessions.add(acc);
        }
      }
      matchedFilings = wantedAccessions.size;
      if (wantedAccessions.size === 0) {
        // Nothing matched; finish early with filings-only result.
        await markOk(runId, filingsUpserted);
        return {
          source, url, filingsUpserted,
          holdingsProcessed: 0, holdingsUpserted: 0,
          holdingsTruncated: false, matchedFilings: 0,
          durationMs: Date.now() - start,
        };
      }
    } else {
      matchedFilings = filings.size;
    }

    // --- Pass 2: stream INFOTABLE, filter by wanted accessions, upsert ---
    const infoEntry = findEntry(zip, "INFOTABLE.tsv");
    if (infoEntry) {
      const text = infoEntry.getData().toString("utf8");
      const cap = opts.maxHoldings ?? Number.POSITIVE_INFINITY;
      let header: Record<string, number> | null = null;
      let batch: F13fHoldingInsert[] = [];

      // Iterate line-by-line without splitting the whole file into an array
      // up front (keeps peak memory lower on the big table).
      let lineStart = 0;
      for (let i = 0; i <= text.length; i++) {
        if (i !== text.length && text[i] !== "\n") continue;
        let line = text.slice(lineStart, i);
        lineStart = i + 1;
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") continue;

        const r = splitTsvLine(line);
        if (!header) {
          header = buildHeaderIndex(r);
          continue;
        }
        const acc = cell(r, header, "ACCESSION_NUMBER");
        if (!acc) continue;
        if (wantedAccessions && !wantedAccessions.has(acc)) continue;

        holdingsProcessed++;
        const periodIso = meta.get(acc)?.periodIso ?? null;
        const valueRaw = parseBigIntOrNull(cell(r, header, "VALUE"));
        batch.push({
          accessionNumber: acc,
          infotableSk: parseBigIntOrNull(cell(r, header, "INFOTABLE_SK")) ?? 0,
          nameOfIssuer: cell(r, header, "NAMEOFISSUER"),
          titleOfClass: cell(r, header, "TITLEOFCLASS"),
          cusip: cell(r, header, "CUSIP"),
          figi: cell(r, header, "FIGI"),
          valueRaw,
          valueUsd: normalizeValueUsd(valueRaw, periodIso),
          sshPrnamt: parseBigIntOrNull(cell(r, header, "SSHPRNAMT")),
          sshPrnamtType: cell(r, header, "SSHPRNAMTTYPE"),
          putCall: cell(r, header, "PUTCALL"),
          investmentDiscretion: cell(r, header, "INVESTMENTDISCRETION"),
          votingAuthSole: parseBigIntOrNull(cell(r, header, "VOTING_AUTH_SOLE")),
          votingAuthShared: parseBigIntOrNull(cell(r, header, "VOTING_AUTH_SHARED")),
          votingAuthNone: parseBigIntOrNull(cell(r, header, "VOTING_AUTH_NONE")),
          periodOfReport: periodIso,
        });

        if (batch.length >= HOLDINGS_BATCH) {
          await upsertHoldings(batch);
          holdingsUpserted += batch.length;
          batch = [];
        }
        if (holdingsProcessed >= cap) {
          holdingsTruncated = true;
          break;
        }
      }
      if (batch.length > 0) {
        await upsertHoldings(batch);
        holdingsUpserted += batch.length;
      }
    }

    await markOk(runId, filingsUpserted + holdingsUpserted);
    return {
      source, url, filingsUpserted,
      holdingsProcessed, holdingsUpserted, holdingsTruncated,
      matchedFilings, durationMs: Date.now() - start,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(ingestRuns)
      .set({
        status: "error",
        finishedAt: new Date(),
        errorMessage: message,
        firmsProcessed: holdingsProcessed,
        firmsInserted: filingsUpserted + holdingsUpserted,
      })
      .where(sql`${ingestRuns.id} = ${runId}`);
    throw err;
  }
}

async function markOk(runId: number, inserted: number): Promise<void> {
  if (!db) return;
  await db
    .update(ingestRuns)
    .set({
      status: "ok",
      finishedAt: new Date(),
      firmsInserted: inserted,
      firmsUpdated: 0,
    })
    .where(sql`${ingestRuns.id} = ${runId}`);
}

async function upsertFilings(rows: F13fFilingInsert[]): Promise<void> {
  if (!db || rows.length === 0) return;
  await db
    .insert(f13fFilings)
    .values(rows)
    .onConflictDoUpdate({
      target: f13fFilings.accessionNumber,
      set: {
        cik: sql`excluded.cik`,
        filingDate: sql`excluded.filing_date`,
        submissionType: sql`excluded.submission_type`,
        periodOfReport: sql`excluded.period_of_report`,
        filingManagerName: sql`excluded.filing_manager_name`,
        filingManagerCity: sql`excluded.filing_manager_city`,
        filingManagerState: sql`excluded.filing_manager_state`,
        reportType: sql`excluded.report_type`,
        crdNumber: sql`excluded.crd_number`,
        secFileNumber: sql`excluded.sec_file_number`,
        tableEntryTotal: sql`excluded.table_entry_total`,
        tableValueTotal: sql`excluded.table_value_total`,
        tableValueTotalUsd: sql`excluded.table_value_total_usd`,
        otherManagersCount: sql`excluded.other_managers_count`,
        isAmendment: sql`excluded.is_amendment`,
        lastUpdatedAt: sql`NOW()`,
      },
    });
}

async function upsertHoldings(rows: F13fHoldingInsert[]): Promise<void> {
  if (!db || rows.length === 0) return;
  await db
    .insert(f13fHoldings)
    .values(rows)
    .onConflictDoUpdate({
      target: [f13fHoldings.accessionNumber, f13fHoldings.infotableSk],
      set: {
        nameOfIssuer: sql`excluded.name_of_issuer`,
        titleOfClass: sql`excluded.title_of_class`,
        cusip: sql`excluded.cusip`,
        figi: sql`excluded.figi`,
        valueRaw: sql`excluded.value_raw`,
        valueUsd: sql`excluded.value_usd`,
        sshPrnamt: sql`excluded.ssh_prnamt`,
        sshPrnamtType: sql`excluded.ssh_prnamt_type`,
        putCall: sql`excluded.put_call`,
        investmentDiscretion: sql`excluded.investment_discretion`,
        votingAuthSole: sql`excluded.voting_auth_sole`,
        votingAuthShared: sql`excluded.voting_auth_shared`,
        votingAuthNone: sql`excluded.voting_auth_none`,
        periodOfReport: sql`excluded.period_of_report`,
        lastUpdatedAt: sql`NOW()`,
      },
    });
}
