/**
 * Prospects module test battery. Pure-function checks run anywhere; the DB
 * section runs when DATABASE_URL is set (use DATABASE_DRIVER=pg for a local
 * Postgres) and expects migration 0006 applied.
 *
 *   DATABASE_DRIVER=pg DATABASE_URL=postgres://... npx tsx scripts/test-prospects.ts
 */
import assert from "node:assert/strict";
import {
  inferColumnMap,
  normalizeAddressLine,
  normalizeEmail,
  normalizeProspect,
  normalizeZip,
  personKey,
  splitFullName,
} from "../lib/prospects/normalize";
import { parseCsv, parseXlsx } from "../lib/prospects/tabular";

let passed = 0;
function ok(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log("  ok  ", name);
    })
    .catch((e) => {
      console.error("  FAIL", name, "\n      ", e?.message ?? e);
      process.exitCode = 1;
    });
}

async function pure() {
  console.log("pure:");
  await ok("address abbreviations collapse", () => {
    assert.equal(normalizeAddressLine("123 N. Main Street"), "123 N MAIN ST");
    assert.equal(normalizeAddressLine("123 North Main St."), "123 N MAIN ST");
    assert.equal(normalizeAddressLine("  333 Chestnut Street, Suite 100 "), "333 CHESTNUT ST STE 100");
    assert.equal(normalizeAddressLine("45 W 1st Avenue Apt #4B"), "45 W 1ST AVE APT # 4B");
  });
  await ok("email normalization (gmail dots/plus, case)", () => {
    assert.equal(normalizeEmail("John.Smith+news@Gmail.com").normalized, "johnsmith@gmail.com");
    assert.equal(normalizeEmail("J.Smith@Example.COM").normalized, "j.smith@example.com");
    assert.equal(normalizeEmail("not-an-email").valid, false);
  });
  await ok("zip normalization pads and splits plus-4", () => {
    assert.deepEqual(normalizeZip(2138), { zip5: "02138", zip4: null });
    assert.deepEqual(normalizeZip("60521-1234"), { zip5: "60521", zip4: "1234" });
    assert.deepEqual(normalizeZip("60521"), { zip5: "60521", zip4: null });
  });
  await ok("name splitting", () => {
    assert.deepEqual(splitFullName("SMITH, JOHN A JR"), { firstName: "John", middleName: "A", lastName: "Smith", suffix: "JR", fullName: "John A Smith Jr." });
    assert.deepEqual(splitFullName("mary ellen van der berg"), { firstName: "Mary", middleName: "Ellen", lastName: "Van Der Berg", suffix: null, fullName: "Mary Ellen Van Der Berg" });
    assert.equal(splitFullName("Patrick O'Brien")!.lastName, "O'Brien");
    assert.equal(splitFullName("Sean McEvilly")!.lastName, "McEvilly");
    assert.deepEqual(splitFullName("GARCIA MARIA & LUIS"), { firstName: "Maria & Luis", middleName: null, lastName: "Garcia", suffix: null, fullName: "Maria & Luis Garcia" });
    assert.equal(splitFullName("Maria & Luis Garcia")!.lastName, "Garcia");
    assert.equal(splitFullName("JOHN SMITH")!.lastName, "Smith", "two-token caps defaults to first-last");
    assert.equal(splitFullName("SMITH JOHN", "last-first")!.lastName, "Smith");
    assert.equal(splitFullName("John Smith", "last-first")!.lastName, "John");
  });
  await ok("person key is spelling-invariant", () => {
    const a = personKey("60521", "Smith", "John", "123 N. Main Street", null);
    const b = personKey("60521", "SMITH", "john", "123 North Main St", null);
    assert.equal(a, b);
    assert.equal(a, "60521|SMITH|JOHN|123 N MAIN ST");
    assert.equal(personKey("60521", null, null, null, "x@y.com"), "EMAIL|x@y.com");
    assert.throws(() => personKey("60521", null, null, null, null));
  });
  await ok("normalizeProspect end to end", () => {
    const n = normalizeProspect({
      fullName: "Doe, Jane",
      email: "Jane.Doe@gmail.com",
      addressLine1: "10 oak brook rd",
      city: "hinsdale",
      state: "Illinois",
      zip: "60521-4400",
      homeValue: "$2,450,000",
      estInvestableAssets: "3.5M",
      ownerOccupied: "Y",
      purchaseDate: "6/15/2019",
      tags: "Golf; Board Member",
      leadStatus: "Qualified",
    });
    assert.equal(n.firstName, "Jane");
    assert.equal(n.lastName, "Doe");
    assert.equal(n.fullName, "Jane Doe");
    assert.equal(n.emailNormalized, "janedoe@gmail.com");
    assert.equal(n.city, "Hinsdale");
    assert.equal(n.state, "IL");
    assert.equal(n.zip5, "60521");
    assert.equal(n.zip4, "4400");
    assert.equal(n.household.homeValue, 2450000);
    assert.equal(n.estInvestableAssets, 3500000);
    assert.equal(n.household.ownerOccupied, true);
    assert.equal(n.household.purchaseDate, "2019-06-15");
    assert.deepEqual(n.tags, ["golf", "board member"]);
    assert.equal(n.leadStatus, "qualified");
    assert.equal(n.addressKey, "10 OAK BROOK RD|60521");
    assert.throws(() => normalizeProspect({ fullName: "No Zip" }), /no zip/i);
    assert.throws(() => normalizeProspect({ fullName: "X Y", zip: "60521", leadStatus: "hot" }), /Invalid leadStatus/);
  });
  await ok("column map inference", () => {
    const { map, unmapped } = inferColumnMap(["PIN", "Owner Name", "Situs Address", "Situs City", "Situs Zip", "Market Value", "Yr Built", "Mystery"]);
    assert.equal(map["PIN"], "sourceRecordId");
    assert.equal(map["Owner Name"], "fullName");
    assert.equal(map["Situs Address"], "addressLine1");
    assert.equal(map["Situs Zip"], "zip");
    assert.equal(map["Market Value"], "homeValue");
    assert.equal(map["Yr Built"], "yearBuilt");
    assert.deepEqual(unmapped, ["Mystery"]);
    const o = inferColumnMap(["Mystery", "Owner Name"], { Mystery: "notes", "Owner Name": "ignore" });
    assert.equal(o.map["Mystery"], "notes");
    assert.equal(o.map["Owner Name"], undefined);
    assert.throws(() => inferColumnMap(["A"], { A: "bogus" }), /unknown target field/);
  });
  await ok("csv parser handles quotes, CRLF, BOM, blank lines", () => {
    const t = parseCsv('﻿Name,Address,Zip\r\n"Smith, John","123 ""Main"" St",60521\r\n\r\nJane Doe,5 Elm Ln,60521\n');
    assert.deepEqual(t.headers, ["Name", "Address", "Zip"]);
    assert.equal(t.rows.length, 2);
    assert.equal(t.rows[0]["Name"], "Smith, John");
    assert.equal(t.rows[0]["Address"], '123 "Main" St');
    const tsv = parseCsv("a\tb\n1\t2");
    assert.deepEqual(tsv.rows, [{ a: "1", b: "2" }]);
  });
  const xlsxPath = process.env.TEST_XLSX;
  if (xlsxPath) {
    await ok("xlsx parser reads shared strings, numbers, dates", async () => {
      const { readFileSync } = await import("node:fs");
      const t = parseXlsx(readFileSync(xlsxPath));
      assert.deepEqual(t.headers, ["First Name", "Last Name", "Email", "Address", "Zip", "Home Value", "Purchase Date"]);
      assert.equal(t.rows.length, 3);
      assert.equal(t.rows[0]["Zip"], "60521");
      assert.equal(t.rows[0]["Home Value"], "1850000");
      assert.equal(t.rows[0]["Purchase Date"], "2021-03-09");
      assert.equal(t.rows[2]["Email"], "");
    });
  }
}

async function withDb() {
  if (!process.env.DATABASE_URL) {
    console.log("db: skipped (DATABASE_URL not set)");
    return;
  }
  console.log("db:");
  const { db } = await import("../lib/db");
  const { sql } = await import("drizzle-orm");
  const { importRecords, importTable } = await import("../lib/prospects/store");
  const { prospectsSearch, prospectLookup, prospectUpdate, prospectsZipSummary, prospectZipTargets, prospectsExportCrm, prospectImportsList } = await import("../lib/prospects/queries");

  await db.execute(sql`TRUNCATE prospect_events, prospects, prospect_households, prospect_imports RESTART IDENTITY`);
  await db.execute(sql`DELETE FROM prospect_zips WHERE zip5 <> '60521'`);

  const csv = [
    "PIN,Owner Name,Situs Address,Situs City,Situs State,Situs Zip,Market Value,Yr Built,Sale Date,Sale Price,Email",
    "09-12-100-001,SMITH JOHN A,123 N. Main Street,HINSDALE,IL,60521,2450000,1928,06/15/2019,2100000,",
    "09-12-100-002,\"DOE, JANE\",10 Oak Brook Rd,Hinsdale,IL,60521-4400,1850000,2005,,,Jane.Doe@gmail.com",
    "09-12-100-003,GARCIA MARIA & LUIS,77 Elm Lane,Hinsdale,Illinois,60521,3100000,1995,3/1/2022,2950000,",
    "09-12-200-001,LEE ROBERT,5 Maple Ct,Oak Brook,IL,60523,1200000,1988,,,",
    ",,no name row,Hinsdale,IL,60521,,,,,",
  ].join("\n");

  let dry: any;
  await ok("dry run maps columns and counts without writing", async () => {
    dry = await importTable(parseCsv(csv), { via: "csv", source: "dupage-assessor-test", dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.columnMap["Owner Name"], "fullName");
    assert.equal(dry.columnMap["Market Value"], "homeValue");
    assert.equal(dry.rowsReceived, 5);
    assert.equal(dry.rowsRejected, 1);
    assert.equal(dry.rowsInserted, 4);
    assert.equal(dry.rowsUpdated, 0);
    assert.deepEqual(dry.zipCounts, { "60521": 3, "60523": 1 });
    const [{ n }] = (await db.execute(sql`select count(*)::int as n from prospects`)).rows as any[];
    assert.equal(n, 0);
  });

  await ok("restrictZips skips out-of-target rows and reports them", async () => {
    const r = await importTable(parseCsv(csv), { via: "csv", source: "dupage-assessor-test", restrictZips: true, dryRun: true });
    assert.equal(r.rowsSkipped, 1);
    assert.deepEqual(r.outOfTargetZips, { "60523": 1 });
  });

  let imp1: any;
  await ok("real import inserts households + people", async () => {
    imp1 = await importTable(parseCsv(csv), { via: "csv", source: "dupage-assessor-test", filename: "assessor.csv", submittedBy: "test" });
    assert.equal(imp1.ok, true);
    assert.equal(imp1.rowsInserted, 4);
    assert.equal(imp1.rowsUpdated, 0);
    assert.equal(imp1.householdsTouched, 4);
    assert.ok(imp1.importId > 0);
    const s = await prospectsSearch({ zip: "60521", sortBy: "last_name", sortDir: "asc" });
    assert.equal(s.total, 3);
    assert.deepEqual(s.rows.map((r) => r.name.full), ["Jane Doe", "Maria & Luis Garcia", "John A Smith"]);
    const smith = s.rows.find((r) => r.name.last === "Smith")!;
    assert.equal(smith.wealth.homeValue, 2450000);
    assert.equal(smith.wealth.purchaseDate, "2019-06-15");
    assert.equal(smith.provenance.sourceRecordId, "09-12-100-001");
    assert.equal(smith.address.line1, "123 N. Main Street");
    assert.equal(smith.lead.status, "new");
    const jane = s.rows.find((r) => r.name.last === "Doe")!;
    assert.equal(jane.email, "Jane.Doe@gmail.com");
    assert.equal(jane.emailStatus, "unverified");
    assert.equal(jane.consent.contactableByEmail, true);
  });

  await ok("re-import with different spelling dedupes and merges", async () => {
    const r = await importRecords(
      [
        { firstName: "John", lastName: "Smith", addressLine1: "123 North Main St", zip: "60521", email: "jsmith@example.com", phone: "6305551212", occupation: "Attorney", tags: ["golf"] },
        // Jane again, no address this time, but the same email -> same row
        { fullName: "Jane Doe", email: "janedoe@gmail.com", zip: "60521", isExecutive: true, notes: "Met at Hinsdale gala", estNetWorthBand: "$5M-$10M" },
        // Household member #2 at Smith's address
        { firstName: "Susan", lastName: "Smith", addressLine1: "123 N Main St", zip: "60521" },
      ],
      { via: "mcp", source: "randall", sourceDetail: "linkedin", submittedBy: "test" }
    );
    assert.equal(r.rowsInserted, 1);
    assert.equal(r.rowsUpdated, 2);
    const s = await prospectsSearch({ zip: "60521" });
    assert.equal(s.total, 4);
    const smith = s.rows.find((r) => r.name.full === "John A Smith")!;
    assert.equal(smith.email, "jsmith@example.com");
    assert.equal(smith.phone, "(630) 555-1212");
    assert.equal(smith.profile.occupation, "Attorney");
    assert.deepEqual(smith.tags, ["golf"]);
    assert.equal(smith.provenance.source, "dupage-assessor-test", "first-seen source preserved");
    assert.equal(smith.wealth.homeValue, 2450000, "household value preserved");
    const jane = s.rows.find((r) => r.name.last === "Doe")!;
    assert.equal(jane.wealth.isExecutive, true);
    assert.equal(jane.notes, "Met at Hinsdale gala");
    assert.equal(jane.wealth.estNetWorthBand, "$5M-$10M");
    assert.equal(jane.address.line1, "10 Oak Brook Rd", "address kept when incoming has none");
    const susan = s.rows.find((r) => r.name.first === "Susan")!;
    assert.equal(susan.householdId, smith.householdId, "same household as John");
    assert.equal(susan.wealth.homeValue, 2450000, "inherits household home value");
  });

  await ok("lookup returns household members + events", async () => {
    const s = await prospectsSearch({ zip: "60521", lastName: "Smith", sortBy: "last_name" });
    const john = s.rows.find((r) => r.name.first === "John")!;
    const l = await prospectLookup({ id: john.id });
    assert.equal(l.row!.name.full, "John A Smith");
    assert.equal(l.household!.members.length, 1);
    assert.equal(l.household!.members[0].fullName, "Susan Smith");
    const byEmail = await prospectLookup({ email: "JSMITH@example.com" });
    assert.equal(byEmail.row!.id, john.id);
  });

  await ok("update: status, consent, note, tags, events; import never demotes", async () => {
    const s = await prospectsSearch({ email: "jsmith@example.com" });
    const id = s.rows[0].id;
    const u = await prospectUpdate({ id, leadStatus: "meeting", leadScore: 88, note: "Lunch 9/10", addTags: ["referral"], emailOptIn: true, optInSource: "verbal", actor: "matt" });
    assert.equal(u.row.lead.status, "meeting");
    assert.equal(u.row.lead.score, 88);
    assert.deepEqual(u.row.tags, ["golf", "referral"]);
    assert.equal(u.row.emailOptIn, true);
    assert.equal(u.eventsLogged, 3);
    // Re-import the same person from a list: status must stay 'meeting', DNC must not flip on
    await importRecords([{ firstName: "John", lastName: "Smith", addressLine1: "123 N Main St", zip: "60521" }], { via: "json", source: "list-broker", submittedBy: "test" });
    const l = await prospectLookup({ id });
    assert.equal(l.row!.lead.status, "meeting");
    assert.equal(l.row!.emailOptIn, true);
    assert.equal(l.events!.length, 3);
    // Opt out: sets doNotEmail, removes from contactable set
    await prospectUpdate({ id, emailOptIn: false, actor: "matt" });
    const c = await prospectsSearch({ zip: "60521", contactableByEmail: true });
    assert.equal(c.rows.some((r) => r.id === id), false);
    // A later import can never un-set the do-not flag
    await importRecords([{ firstName: "John", lastName: "Smith", addressLine1: "123 N Main St", zip: "60521", doNotEmail: false }], { via: "json", source: "list-broker", submittedBy: "test" });
    assert.equal((await prospectLookup({ id })).row!.consent.doNotEmail, true);
    await assert.rejects(prospectUpdate({ id, leadStatus: "hot" }), /Invalid leadStatus/);
  });

  await ok("zip summary + targets", async () => {
    const z = await prospectsZipSummary({});
    const hinsdale = z.zips.find((x) => x.zip5 === "60521")!;
    assert.equal(hinsdale.target!.label, "Hinsdale — Vistamark HQ zip");
    assert.equal(hinsdale.people, 4);
    assert.equal(hinsdale.households, 3);
    assert.equal(hinsdale.withEmail, 2);
    assert.equal(hinsdale.contactableByEmail, 1);
    assert.equal(hinsdale.byStatus.meeting, 1);
    assert.equal(hinsdale.byStatus.new, 3);
    assert.equal(hinsdale.homeValues!.max, 3100000);
    assert.equal(hinsdale.homeValues!.over2m, 2);
    const oak = z.zips.find((x) => x.zip5 === "60523")!;
    assert.equal(oak.target, null);
    assert.equal(oak.people, 1);
    assert.ok(z.recentImports!.length >= 3);

    const added = await prospectZipTargets({ action: "add", zip: "60523", city: "Oak Brook", state: "il", priority: 2 });
    assert.equal(added.zip!.state, "IL");
    const off = await prospectZipTargets({ action: "deactivate", zip: "60523" });
    assert.equal(off.zip!.active, false);
    const list = await prospectZipTargets({ action: "list" });
    assert.equal(list.zips!.length, 2);
    await assert.rejects(prospectZipTargets({ action: "activate", zip: "99999" }), /not in the target list/);
  });

  await ok("filters: home value, tag, status, source, q", async () => {
    assert.equal((await prospectsSearch({ zip: "60521", minHomeValue: 3000000 })).total, 1);
    assert.equal((await prospectsSearch({ tag: "golf" })).total, 1);
    assert.equal((await prospectsSearch({ leadStatus: "meeting,client" })).total, 1);
    assert.equal((await prospectsSearch({ source: "dupage" })).total, 4);
    assert.equal((await prospectsSearch({ q: "gala" })).total, 1);
    assert.equal((await prospectsSearch({ street: "main" })).total, 2);
    assert.equal((await prospectsSearch({ zip: "60521, 60523" })).total, 5);
  });

  await ok("crm export: suppression, incremental sync, ack", async () => {
    const e1 = await prospectsExportCrm({ zip: "60521" });
    assert.equal(e1.returned, 4, "nothing synced yet");
    const john = e1.contacts.find((c) => c.fullName === "John A Smith")!;
    assert.equal(john.email, null, "do-not-email suppresses email in feed");
    assert.equal(john.emailOnFile, "jsmith@example.com");
    assert.equal(john.externalId, `vistaintel:prospect:${john.prospectId}`);
    const jane = e1.contacts.find((c) => c.lastName === "Doe")!;
    assert.equal(jane.email, "janedoe@gmail.com", "latest supplied spelling of the same normalized email wins");
    assert.equal(jane.wealth.homeValue, 1850000);

    const e2 = await prospectsExportCrm({ zip: "60521", markSynced: true, actor: "vistacrm-puller" });
    assert.equal(e2.markedSynced, 4);
    const e3 = await prospectsExportCrm({ zip: "60521" });
    assert.equal(e3.returned, 0, "all synced");
    await prospectUpdate({ id: jane.prospectId, note: "changed after sync" });
    const e4 = await prospectsExportCrm({ zip: "60521" });
    assert.equal(e4.returned, 1, "only the changed row comes back");
    const ack = await prospectsExportCrm({ vistacrmContactIds: { [String(jane.prospectId)]: "crm-abc-123" } });
    assert.equal(ack.markedSynced, 1);
    const l = await prospectLookup({ id: jane.prospectId });
    assert.equal(l.row!.crm.vistacrmContactId, "crm-abc-123");
    assert.equal((await prospectsExportCrm({ zip: "60521" })).returned, 0);
    assert.equal((await prospectLookup({ id: john.prospectId })).events!.some((ev) => ev.kind === "crm_push"), true);
  });

  await ok("import ledger", async () => {
    const l = await prospectImportsList({});
    assert.equal(l.imports[0].status, "done");
    const first = l.imports.find((i) => i.id === imp1.importId)!;
    assert.equal(first.rowsInserted, 4);
    assert.equal(first.rowsRejected, 1);
    assert.equal(first.errors!.length, 1);
    assert.match(first.errors![0]!.error, /neither a name nor an email/);
    assert.equal(first.filename, "assessor.csv");
  });

  await ok("large batch (2,000 rows) stays under the function budget", async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      firstName: `First${i}`,
      lastName: `Last${i % 700}`,
      addressLine1: `${100 + i} Test Blvd`,
      zip: i % 5 === 0 ? "60523" : "60521",
      email: i % 3 === 0 ? `p${i}@example.org` : null,
      homeValue: 500000 + i * 1000,
    }));
    const t0 = Date.now();
    const r = await importRecords(rows, { via: "json", source: "synthetic", submittedBy: "test" });
    const ms = Date.now() - t0;
    assert.equal(r.rowsInserted, 2000);
    assert.ok(ms < 30000, `took ${ms}ms`);
    const again = await importRecords(rows.slice(0, 500), { via: "json", source: "synthetic", submittedBy: "test" });
    assert.equal(again.rowsUpdated, 500);
    assert.equal(again.rowsInserted, 0);
    console.log(`        (2,000 inserts in ${ms}ms locally; Neon HTTP adds ~20-40ms per statement, ${Math.ceil(2000 / 400) * 2 + 3} statements)`);
  });
}

(async () => {
  await pure();
  await withDb();
  console.log(process.exitCode ? "\nSOME TESTS FAILED" : `\nall ${passed} tests passed`);
})();
