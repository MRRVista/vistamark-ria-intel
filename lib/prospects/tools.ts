/**
 * MCP tool handlers for the prospects domain. Thin: argument coercion here,
 * logic in store.ts / queries.ts so /api/prospects can share it.
 */
import { importRecords, importTable, type ImportOptions } from "./store";
import { parseCsv } from "./tabular";
import {
  prospectImportsList,
  prospectLookup,
  prospectsExportCrm,
  prospectsSearch,
  prospectsZipSummary,
  prospectUpdate,
  prospectZipTargets,
} from "./queries";
import type { ProspectInput } from "./normalize";

export { prospectsSearch, prospectLookup, prospectUpdate, prospectsZipSummary, prospectZipTargets, prospectsExportCrm, prospectImportsList };

export interface ProspectsUpsertArgs {
  records?: ProspectInput[];
  record?: ProspectInput;
  source?: string;
  sourceDetail?: string;
  defaultZip?: string;
  restrictZips?: boolean;
  dryRun?: boolean;
  tags?: string[];
  nameOrder?: "auto" | "first-last" | "last-first";
  actor?: string;
}

/** One record or a batch of JSON records (Randall's path). */
export async function prospectsUpsert(args: ProspectsUpsertArgs) {
  const records = args.records ?? (args.record ? [args.record] : []);
  if (!records.length) throw new Error("prospects_upsert requires `record` or a non-empty `records` array");
  if (records.length > 5000) throw new Error("prospects_upsert accepts at most 5,000 records per call — split the batch");
  const opts: ImportOptions = {
    via: "mcp",
    source: args.source ?? "randall",
    sourceDetail: args.sourceDetail ?? null,
    submittedBy: args.actor ?? "mcp",
    defaultZip: args.defaultZip ?? null,
    restrictZips: !!args.restrictZips,
    dryRun: !!args.dryRun,
    tags: args.tags,
    nameOrder: args.nameOrder ?? "auto",
  };
  return importRecords(records, opts);
}

export interface ProspectsImportCsvArgs {
  csv: string;
  source: string;
  sourceDetail?: string;
  filename?: string;
  columnMap?: Record<string, string>;
  defaultZip?: string;
  restrictZips?: boolean;
  dryRun?: boolean;
  delimiter?: string;
  tags?: string[];
  nameOrder?: "auto" | "first-last" | "last-first";
  actor?: string;
}

/** CSV text pasted or read by Randall. Files go to POST /api/prospects instead. */
export async function prospectsImportCsv(args: ProspectsImportCsvArgs) {
  if (!args.csv || typeof args.csv !== "string") throw new Error("prospects_import_csv requires `csv` text");
  if (!args.source) throw new Error("prospects_import_csv requires `source` (e.g. 'dupage-assessor', 'list-broker:Acme', 'event:hinsdale-gala')");
  if (args.csv.length > 4_000_000) throw new Error("CSV over 4 MB — upload the file to POST /api/prospects instead");
  const table = parseCsv(args.csv, args.delimiter);
  if (!table.rows.length) throw new Error("CSV parsed to zero data rows (is the header the only line?)");
  return importTable(table, {
    via: "csv",
    source: args.source,
    sourceDetail: args.sourceDetail ?? null,
    filename: args.filename ?? null,
    submittedBy: args.actor ?? "mcp",
    columnMap: args.columnMap,
    defaultZip: args.defaultZip ?? null,
    restrictZips: !!args.restrictZips,
    dryRun: !!args.dryRun,
    tags: args.tags,
    nameOrder: args.nameOrder ?? "auto",
  });
}
