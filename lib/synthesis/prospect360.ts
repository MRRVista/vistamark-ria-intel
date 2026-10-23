/**
 * prospect_360 — one named person, every dataset, one dossier.
 *
 * Fan-out (parallel): prospects DB · 990 board index · Section 16 insiders ·
 * Form D related persons · IDFPR licenses · Cook + PTAX parcel buyers/sellers ·
 * employer plans (if an employer is known) · Apollo (opt-in, free search only).
 *
 * Join rule: every row is scored for identity match (last name exact, first
 * name exact or initial, geography agreement when both sides carry one). Rows
 * under the floor are dropped; the survivors become Evidence, the evidence
 * becomes a wealth-signal score and ranked angles.
 */
import {
  fanOut,
  type SourceResult,
  type Evidence,
  splitName,
  samePerson,
  normName,
  rowsOf,
  pick,
  num,
  usd,
  monthsAgo,
  isoDaysAgo,
  wealthSignalScore,
  coverage,
  hasEnv,
} from "./core";
import { buildProspectAngles } from "./angles";

export interface Prospect360Args {
  name: string;
  city?: string;
  state?: string;
  zip?: string;
  employer?: string;
  lookbackMonths?: number;
  includeContact?: boolean;
  nameOrder?: "auto" | "first-last" | "last-first";
}

const FLOOR = 0.45;

function geoAgree(row: { city?: unknown; zip?: unknown; state?: unknown }, want: { city?: string; zip?: string; state?: string }): number {
  let score = 0.8; // unknown geography on either side
  const rc = typeof row.city === "string" ? row.city.toLowerCase().trim() : "";
  const rz = typeof row.zip === "string" ? row.zip.slice(0, 5) : "";
  const rs = typeof row.state === "string" ? row.state.toUpperCase() : "";
  if (want.zip && rz) score = rz === want.zip.slice(0, 5) ? 1.0 : 0.3;
  else if (want.city && rc) score = rc === want.city.toLowerCase().trim() ? 1.0 : 0.4;
  if (want.state && rs && rs !== want.state.toUpperCase()) score = Math.min(score, 0.3);
  return score;
}

function nameScore(candidate: unknown, want: string): number {
  if (typeof candidate !== "string") return 0;
  if (!samePerson(candidate, want)) return 0;
  const a = splitName(candidate);
  const b = splitName(want);
  if (a.first && b.first && a.first === b.first) return 1.0;
  if (a.first && b.first) return 0.65; // initial match only
  return 0.55; // surname only on one side
}

export async function prospect360(args: Prospect360Args) {
  const name = String(args.name ?? "").trim();
  if (name.length < 3) throw new Error("prospect_360: `name` (first + last) is required");
  const state = (args.state ?? "IL").toUpperCase();
  const { first, last } = splitName(name, args.nameOrder ?? "auto");
  const canonical = first ? `${first} ${last}` : last;
  const lookback = Math.max(1, Math.min(args.lookbackMonths ?? 24, 120));
  const since = isoDaysAgo(Math.round(lookback * 30.44));
  const want = { city: args.city, zip: args.zip, state };
  const apolloReady = hasEnv("APOLLO_API_KEY");

  const results = await fanOut([
    { tool: "prospects_search", args: { q: canonical, limit: 10 } },
    { tool: "irs990_boards_of_person", args: { name: canonical, limit: 25 } },
    { tool: "insider_transactions", args: { ownerName: `${last} ${first}`.trim(), maxFilings: 6, sinceDate: since } },
    { tool: "formd_related_persons", args: { query: `"${canonical}"`, personState: state, startDate: since, limit: 8 } },
    { tool: "idfpr_licensee_search", args: { lastName: last, ...(first ? { firstName: first } : {}), status: "ANY", limit: 25 } },
    { tool: "cook_parcel_sales", args: { buyerName: last, startDate: since, limit: 40, includeCharacteristics: false } },
    { tool: "cook_parcel_sales", args: { sellerName: last, startDate: since, limit: 40, includeCharacteristics: false } },
    { tool: "il_ptax_transfers", args: { buyerName: last, startDate: since, limit: 40 } },
    { tool: "il_ptax_transfers", args: { sellerName: last, startDate: since, limit: 40 } },
    args.employer
      ? { tool: "dol_plan_search", args: { sponsorName: args.employer, limit: 5 } }
      : { tool: "dol_plan_search", args: {}, skip: "no employer given" },
    args.includeContact
      ? apolloReady
        ? { tool: "apollo_people_search", args: { personName: canonical, ...(args.city ? { personLocations: [`${args.city}, ${state}`] } : {}), perPage: 5 } }
        : { tool: "apollo_people_search", args: {}, skip: "APOLLO_API_KEY not set" }
      : { tool: "apollo_people_search", args: {}, skip: "includeContact=false (free search, no credits — pass includeContact=true)" },
  ]);

  const [db, boards, insider, formd, idfpr, cookBuy, cookSell, ptaxBuy, ptaxSell, plans, apollo] = results;
  const sources: SourceResult[] = results.map((r) => r.src);
  const evidence: Evidence[] = [];
  const profiles: Record<string, unknown[]> = { db: [], boards: [], insider: [], formd: [], licenses: [], property: [], employerPlans: [], contacts: [] };

  // --- prospects DB -------------------------------------------------------
  for (const r of rowsOf(db.data)) {
    const full = r?.name?.full ?? pick(r, "fullName", "name");
    const ns = nameScore(full, canonical);
    if (ns < FLOOR) continue;
    const g = geoAgree({ city: r?.address?.city, zip: r?.address?.zip5, state: r?.address?.state }, want);
    const conf = ns * g;
    if (conf < FLOOR) continue;
    profiles.db.push({
      id: r.id, name: full, email: r.email, emailStatus: r.emailStatus,
      address: r.address, consent: r.consent, lead: r.lead, wealth: { homeValue: r?.wealth?.homeValue, estInvestableAssets: r?.wealth?.estInvestableAssets, wealthScore: r?.wealth?.wealthScore }, tags: r.tags, updatedAt: r.updatedAt,
    });
    evidence.push({
      signal: "in_db", source: "prospects_search", confidence: conf,
      summary: `Already in prospect DB (id ${r.id}, status ${r?.lead?.status ?? "?"}, score ${r?.lead?.score ?? "?"}${r?.consent?.doNotContact ? ", DO NOT CONTACT" : ""})`,
      ref: { id: r.id, doNotContact: r?.consent?.doNotContact, contactableByEmail: r?.consent?.contactableByEmail },
    });
  }
  db.src.rows = profiles.db.length;

  // --- 990 board seats ----------------------------------------------------
  for (const s of rowsOf(boards.data)) {
    const ns = nameScore(s.name, canonical) * (typeof s.score === "number" ? Math.max(0.5, s.score) : 1);
    if (ns < FLOOR) continue;
    // person geography is only on 990-PF rows; org geography is a weak proxy
    const g = s.personZip || s.personCity ? geoAgree({ city: s.personCity, zip: s.personZip, state: s.personState }, want) : 0.85;
    const conf = Math.min(1, ns * g);
    if (conf < FLOOR) continue;
    const assets = num(s.orgTotalAssets);
    profiles.boards.push({ org: s.orgName, ein: s.ein, title: s.title, orgCity: s.orgCity, orgState: s.orgState, orgAssets: assets, taxPeriodEnd: s.taxPeriodEnd, isOfficer: s.isOfficer, compOrg: s.compOrg, score: s.score });
    evidence.push({
      signal: "board_seat", source: "irs990_boards_of_person",
      confidence: conf * (assets && assets > 1e7 ? 1 : 0.8),
      summary: `${s.title ?? "board member"} at ${s.orgName} (${s.orgCity ?? ""}, ${s.orgState ?? ""}; assets ${usd(assets)})`,
      amount: assets, date: s.taxPeriodEnd ?? null, ref: { ein: s.ein, orgName: s.orgName },
    });
  }
  boards.src.rows = profiles.boards.length;

  // --- Section 16 insiders -------------------------------------------------
  for (const f of rowsOf(insider.data)) {
    if (f?.error) continue;
    for (const o of f.owners ?? []) {
      const ns = nameScore(o.name, canonical);
      if (ns < FLOOR) continue;
      const g = geoAgree({ city: o.city, zip: o.zip, state: o.state }, want);
      const conf = ns * g;
      if (conf < FLOOR) continue;
      const txns = (f.transactions ?? []).slice(0, 3);
      const sold = txns.filter((t: any) => t.code === "S" || t.acqDisp === "D");
      const value = txns.reduce((a: number, t: any) => a + (num(t.value) ?? 0), 0);
      profiles.insider.push({ issuer: f.issuer, form: f.form, filingDate: f.filingDate, relationship: o.relationship, ownerCity: o.city, rule10b5_1: f.rule10b5_1, transactions: txns.map((t: any) => ({ date: t.date, code: t.codeLabel ?? t.code, shares: t.shares, price: t.price, value: t.value })), url: f.url });
      evidence.push({
        signal: "insider", source: "insider_transactions", confidence: conf,
        summary: `${o.relationship ?? "insider"} of ${f.issuer?.name ?? f.issuer?.ticker ?? "issuer"} — Form ${f.form} ${f.filingDate}${sold.length ? `, ${sold.length} sale(s) ~${usd(value)}` : ""}${f.rule10b5_1 ? ", 10b5-1" : ""}`,
        amount: value || null, date: f.filingDate ?? null, ref: { issuer: f.issuer, accession: f.accession },
      });
    }
  }
  insider.src.rows = profiles.insider.length;

  // --- Form D related persons ---------------------------------------------
  for (const off of rowsOf(formd.data)) {
    if (off?.error) continue;
    for (const p of off.relatedPersons ?? []) {
      const ns = nameScore(p.name, canonical);
      if (ns < FLOOR) continue;
      const addr = String(p.address ?? "").toLowerCase();
      let g = 0.8;
      if (args.zip && addr) g = addr.includes(args.zip) ? 1 : 0.5;
      else if (args.city && addr) g = addr.includes(args.city.toLowerCase()) ? 1 : 0.5;
      const conf = ns * g;
      if (conf < FLOOR) continue;
      const amt = num(off.totalOfferingAmount);
      profiles.formd.push({ issuer: off.issuer, issuerLocation: off.issuerLocation, roles: p.relationships, industry: off.industry, filingDate: off.filingDate, totalOfferingAmount: off.totalOfferingAmount, totalAmountSold: off.totalAmountSold, url: off.url });
      evidence.push({
        signal: "formd_person", source: "formd_related_persons", confidence: conf,
        summary: `${(p.relationships ?? []).join("/") || "related person"} of ${off.issuer} (${off.industry ?? "?"}; offering ${amt ? usd(amt) : off.totalOfferingAmount ?? "?"}) filed ${off.filingDate}`,
        amount: amt, date: off.filingDate ?? null, ref: { issuer: off.issuer, accession: off.accession },
      });
    }
  }
  formd.src.rows = profiles.formd.length;

  // --- IDFPR licenses ------------------------------------------------------
  for (const l of rowsOf(idfpr.data)) {
    const ns = nameScore(l.name ?? `${l.firstName ?? ""} ${l.lastName ?? ""}`, canonical);
    if (ns < FLOOR) continue;
    const g = geoAgree({ city: l.city, zip: l.zip, state }, want);
    const conf = ns * g;
    if (conf < FLOOR) continue;
    profiles.licenses.push({ name: l.name, profession: l.profession, licenseType: l.licenseType, status: l.status, specialty: l.specialty, dba: l.dba, city: l.city, zip: l.zip, originallyIssued: l.originallyIssued, yearsLicensed: l.yearsLicensed });
    evidence.push({
      signal: "license", source: "idfpr_licensee_search", confidence: conf,
      summary: `${l.profession ?? l.licenseType} (${l.status}; ${l.city ?? ""} ${l.zip ?? ""})${l.dba ? " — " + l.dba : ""}`,
      ref: { profession: l.profession, licenseType: l.licenseType },
    });
  }
  idfpr.src.rows = profiles.licenses.length;

  // --- property: Cook + PTAX, buyer and seller sides -----------------------
  const propertyRows: Array<{ side: "buy" | "sell"; src: string; row: any }> = [
    ...rowsOf(cookBuy.data).map((row) => ({ side: "buy" as const, src: "cook_parcel_sales", row })),
    ...rowsOf(cookSell.data).map((row) => ({ side: "sell" as const, src: "cook_parcel_sales", row })),
    ...rowsOf(ptaxBuy.data).map((row) => ({ side: "buy" as const, src: "il_ptax_transfers", row })),
    ...rowsOf(ptaxSell.data).map((row) => ({ side: "sell" as const, src: "il_ptax_transfers", row })),
  ];
  const seen = new Set<string>();
  for (const { side, src, row } of propertyRows) {
    const party = side === "buy" ? row.buyer : row.seller;
    const partyNames: string[] = [party, ...(side === "buy" ? row.additionalBuyers ?? [] : [])].filter(Boolean);
    const ns = Math.max(0, ...partyNames.map((p) => nameScore(p, canonical)));
    if (ns < FLOOR) continue;
    const addr = String(row.address ?? "").toLowerCase();
    let g = 0.8;
    if (args.zip && addr) g = addr.includes(args.zip) ? 1 : 0.5;
    else if (args.city && addr) g = addr.includes(args.city.toLowerCase()) ? 1 : 0.5;
    const conf = ns * g;
    if (conf < FLOOR) continue;
    const key = `${row.pin ?? row.documentNumber ?? row.docNo}-${side}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const price = num(row.salePrice ?? row.fullConsideration ?? row.netConsideration);
    const date = row.saleDate ?? row.recorded ?? row.instrumentDate ?? null;
    profiles.property.push({ side, source: src, date, price, address: row.address, pin: row.pin, deedType: row.deedType ?? row.instrumentType, buyer: row.buyer, seller: row.seller, currentOwnerOfRecord: row.currentOwnerOfRecord, principalResidence: row.principalResidence });
    const m = monthsAgo(date);
    evidence.push({
      signal: side === "buy" ? "parcel_buy" : "parcel_sell", source: src, confidence: conf,
      summary: `${side === "buy" ? "Bought" : "Sold"} ${row.address ?? "property"} ${date ?? ""} for ${usd(price)}${m !== null ? ` (${Math.round(m)} mo ago)` : ""}`,
      amount: price, date, ref: { pin: row.pin },
    });
  }
  for (const r of [cookBuy, cookSell, ptaxBuy, ptaxSell]) r.src.rows = profiles.property.filter((p: any) => p.source === r.src.tool).length;

  // --- employer plans ------------------------------------------------------
  for (const p of rowsOf(plans.data).slice(0, 5)) {
    const assets = num(p.totAssetsEoyAmt ?? p.netAssetsEoyAmt);
    profiles.employerPlans.push({ planName: p.planName, sponsor: p.sponsDfeName ?? args.employer, assets, participants: p.totActivePartcpCnt, planType: p.planTypeLabel, planYear: p.planYear, features: p.pensionPlanFeatureCodes, schC: p.schCAttachedInd });
    evidence.push({
      signal: "plan_sponsor", source: "dol_plan_search", confidence: 0.7,
      summary: `Employer plan ${p.planName ?? ""} (${usd(assets)}, ${p.totActivePartcpCnt ?? "?"} active)`,
      amount: assets, date: p.planYear ? `${p.planYear}-12-31` : null,
    });
  }
  plans.src.rows = profiles.employerPlans.length;

  // --- Apollo (free search) ------------------------------------------------
  for (const p of rowsOf(apollo.data).slice(0, 5)) {
    const ns = nameScore(p.name ?? `${p.firstName ?? ""} ${p.lastName ?? ""}`, canonical);
    if (ns < FLOOR) continue;
    profiles.contacts.push({ name: p.name, title: p.title, organization: p.organization?.name, domain: p.organization?.domain, location: p.location, linkedinUrl: p.linkedinUrl, emailLocked: p.emailLocked, emailStatus: p.emailStatus, apolloId: p.apolloId });
    evidence.push({
      signal: "pro_contact", source: "apollo_people_search", confidence: ns * 0.8,
      summary: `${p.title ?? "?"} at ${p.organization?.name ?? "?"} (${p.location ?? "?"}) — professional email ${p.emailLocked ? "available via apollo_person_enrich (1 credit)" : "revealed"}`,
      ref: { apolloId: p.apolloId, domain: p.organization?.domain },
    });
  }
  apollo.src.rows = profiles.contacts.length;

  // --- identity confirmation ----------------------------------------------
  const strong = evidence.filter((e) => e.confidence >= 0.75);
  const confirmedBy = Array.from(new Set(strong.map((e) => e.source)));
  const identity = {
    status: confirmedBy.length >= 2 ? "confirmed" : evidence.length ? "single-source" : "unresolved",
    confirmedBy,
    note:
      confirmedBy.length >= 2
        ? "Two or more independent sources agree on name + geography/employer."
        : evidence.length
        ? "Only one source resolves this name — treat as a lead, not a prospect. Add city/zip or employer to tighten."
        : "No source resolved this name in the target geography.",
  };

  const { score, drivers } = wealthSignalScore(evidence);
  const dnc = profiles.db.some((d: any) => d?.consent?.doNotContact);
  const angles = dnc ? [] : buildProspectAngles(evidence, { firstName: first ? first[0].toUpperCase() + first.slice(1) : undefined, city: args.city });

  return {
    dataSource: "synthesis:prospect_360 (prospects DB · IRS 990 Part VII · SEC Forms 3/4/5 · SEC Form D · IDFPR · Cook Assessor · IDOR PTAX-203 · DOL 5500 · Apollo)",
    subject: { name: canonical, city: args.city ?? null, state, zip: args.zip ?? null, employer: args.employer ?? null, lookbackMonths: lookback },
    identity,
    wealthSignalScore: score,
    scoreDrivers: drivers,
    doNotContact: dnc,
    evidence: evidence
      .sort((a, b) => b.confidence - a.confidence)
      .map((e) => ({ signal: e.signal, confidence: Math.round(e.confidence * 100) / 100, source: e.source, summary: e.summary, date: e.date ?? undefined, amount: e.amount ?? undefined })),
    profiles,
    angles,
    guardrails: [
      "Outreach lands as a DRAFT; Matt approves before send.",
      "Professional (published) email only; never home email/phone.",
      "prospect_lookup consent block governs — do-not-contact wins over any angle.",
      "Never reference transaction prices, filings or deeds in the message.",
    ],
    coverage: coverage(sources),
    sources,
    note:
      "Identity match floor 0.45 (name × geography). Scores are evidence-weighted (see SIGNAL_WEIGHTS) — auditable, not predictive. " +
      "Parcel searches are run on the surname and filtered client-side; common surnames need a zip. Pass employer to pull plan context; pass includeContact=true for a free Apollo match (no credits).",
  };
}
