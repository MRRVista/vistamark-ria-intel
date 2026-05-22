/**
 * Phase 1 smoke test — IRS BMF CSV streaming parser, bmfRowToRecord mapping,
 * and ProPublica EIN validation.
 *
 * Run: npx tsx scripts/test-phase1.ts
 * Exits non-zero if any assertion fails (good for CI).
 */
import {
  newStreamState,
  consumeCsvChunk,
  finishCsvStream,
  bmfRowToRecord,
} from "../lib/irs-bmf/parser";
import { parseIntOrNull } from "../lib/irs-bmf/columns";

let failures = 0;
function assert(cond: boolean, label: string) {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    failures++;
  } else {
    console.log(`OK:   ${label}`);
  }
}

// 1) CSV streaming parser
const sample =
  `"EIN","NAME","ICO","STREET","CITY","STATE","ZIP","GROUP","SUBSECTION","AFFILIATION","CLASSIFICATION","RULING","DEDUCTIBILITY","FOUNDATION","ACTIVITY","ORGANIZATION","STATUS","TAX_PERIOD","ASSET_CD","INCOME_CD","FILING_REQ_CD","PF_FILING_REQ_CD","ACCT_PD","ASSET_AMT","INCOME_AMT","REVENUE_AMT","NTEE_CD","SORT_NAME"\n` +
  `"123456789","ACME, INC.","JOHN DOE","100 MAIN ST","HINSDALE","IL","60521","0","3","3","1000","202301","1","11","0000","1","01","202312","9","9","990","000","12","12500000000","8500000000","8500000000","B41","ACME"\n` +
  `"234567890","BETA FOUNDATION","","200 OAK","CHICAGO","IL","60601","0","3","3","1000","202205","1","13","0000","1","01","202212","8","7","990PF","1","12","45000000","12000000","12000000","T22","BETA FOUNDATION"\n`;

const state = newStreamState();
const rows: string[][] = [];
consumeCsvChunk(state, sample, (r) => rows.push(r));
finishCsvStream(state, (r) => rows.push(r));

assert(rows.length === 3, "parsed 3 rows (header + 2 data)");
assert(rows[1]![0] === "123456789", "row 1 EIN");
assert(rows[1]![1] === "ACME, INC.", "embedded comma preserved in quoted field");
assert(rows[2]![1] === "BETA FOUNDATION", "row 2 NAME");
assert(rows[1]![27] === "ACME", "row 1 SORT_NAME (last col)");

// 2) Chunk boundary mid-quote
const state2 = newStreamState();
const rows2: string[][] = [];
consumeCsvChunk(state2, `"123","HELLO, `, (r) => rows2.push(r));
consumeCsvChunk(state2, `WORLD","FOO"\n`, (r) => rows2.push(r));
finishCsvStream(state2, (r) => rows2.push(r));
assert(rows2.length === 1, "row split across chunks reassembles to 1 row");
assert(rows2[0]![1] === "HELLO, WORLD", "embedded comma across chunk boundary");

// 3) Escaped quotes
const state3 = newStreamState();
const rows3: string[][] = [];
consumeCsvChunk(state3, `"1","ACME ""BIG"" CO","X"\n`, (r) => rows3.push(r));
finishCsvStream(state3, (r) => rows3.push(r));
assert(rows3[0]![1] === `ACME "BIG" CO`, "escaped double-quote handled");

// 4) bmfRowToRecord
const record = bmfRowToRecord(rows[1]!, "eo3");
assert(record !== null, "row → record produces non-null");
assert(record!.ein === "123456789", "EIN preserved");
assert(record!.name === "ACME, INC.", "NAME preserved");
assert(record!.state === "IL", "STATE uppercased");
assert(record!.subsection === 3, "SUBSECTION parsed as int");
assert(record!.assetCode === 9, "ASSET_CD parsed");
assert(record!.assetAmt === 12500000000, "ASSET_AMT parsed as number");
assert(record!.region === "eo3", "region tagged");

// 5) EIN edge cases
const short = bmfRowToRecord(["12345", "x", "", "", "", "IL"], "eo1");
assert(short !== null && short.ein === "000012345", "short EIN zero-padded to 9");

const noEin = bmfRowToRecord(["", "x"], "eo1");
assert(noEin === null, "missing EIN → null");

const noName = bmfRowToRecord(["123456789", "", "ICO"], "eo1");
assert(noName === null, "missing NAME → null");

const bogusEin = bmfRowToRecord(["ABCDEFGHI", "x"], "eo1");
assert(bogusEin === null, "non-numeric EIN → null");

// 6) parseIntOrNull
assert(parseIntOrNull("123") === 123, "parseInt 123");
assert(parseIntOrNull("") === null, "parseInt empty → null");
assert(parseIntOrNull("  42  ") === 42, "parseInt trims");
assert(parseIntOrNull("abc") === null, "parseInt non-numeric → null");
assert(parseIntOrNull(undefined) === null, "parseInt undefined → null");

// 7) ProPublica EIN normalization (async)
import { getOrganization } from "../lib/propublica/client";
(async () => {
  let badEinThrown = false;
  try {
    await getOrganization("12345");
  } catch (e: any) {
    if (e?.message?.includes("Invalid EIN")) badEinThrown = true;
  }
  assert(badEinThrown, "ProPublica rejects short EIN");

  console.log("");
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  process.exit(failures);
})();
