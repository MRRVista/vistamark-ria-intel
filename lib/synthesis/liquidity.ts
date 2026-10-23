/**
 * liquidity_event_radar — "where is money in motion in our zips right now?"
 *
 * Wave 1 (parallel): Cook parcel sales + IDOR PTAX transfers (Hinsdale is split
 * Cook/DuPage, so both run every time) + Section 16 filers at the location +
 * Form D related persons at the location.
 * Wave 2 (parallel, capped): cross-reference the distinct names against the
 * prospect DB and the 990 board index so each event carries "already known /
 * do-not-contact" and "chairs a foundation" context.
 */
import { fanOut, type SourceResult, rowsOf, num, usd, splitName, normName, isoDaysAgo, coverage, monthsAgo } from "./core";

export interface RadarArgs {
  zip?: string;
  city?: string;
  state?: string;
  lookbackDays?: number;
  minPrice?: number;
  maxEvents?: number;
  crossReference?: boolean;
}

interface RadarEvent {
  kind: "home_sale" | "insider_filing" | "formd_person";
  date: string | null;
  amount: number | null;
  parties: string[];
  headline: string;
  detail: Record<string, unknown>;
  source: string;
  known?: { inDb: boolean; doNotContact: boolean; leadStatus?: string; boardSeats?: number; boardOrgs?: string[] };
  actionable?: boolean;
  angle?: string;
}

const PERSONISH = /\b(llc|inc|trust|trustee|bank|corp|company|co\b|ltd|association|church|partners|properties|holdings|builders|homes|lp\b)/i;

export async function liquidityEventRadar(args: RadarArgs) {
  const city = (args.city ?? (args.zip ? undefined : "Hinsdale")) as string | undefined;
  const zip = args.zip;
  const state = (args.state ?? "IL").toUpperCase();
  const lookbackDays = Math.max(7, Math.min(args.lookbackDays ?? 180, 1095));
  const since = isoDaysAgo(lookbackDays);
  const minPrice = args.minPrice ?? 1_000_000;
  const maxEvents = Math.max(5, Math.min(args.maxEvents ?? 40, 120));
  const location = zip ?? city ?? "Hinsdale";

  const w1 = await fanOut([
    { tool: "cook_parcel_sales", args: { ...(zip ? { zip } : { city: city?.toUpperCase() }), startDate: since, minPrice, limit: 100, includeCharacteristics: false }, timeoutMs: 15000 },
    { tool: "il_ptax_transfers", args: { ...(zip ? { zip } : { city: city?.toUpperCase() }), startDate: since, minPrice, limit: 100 }, timeoutMs: 15000 },
    { tool: "insider_by_location", args: { location, ownerState: state, ...(zip ? { ownerZip: zip } : city ? { ownerCity: city } : {}), startDate: since, maxFilings: 20 }, timeoutMs: 18000 },
    { tool: "formd_related_persons", args: { query: `"${city ?? zip}"`, ...(city ? { personCity: city } : {}), personState: state, startDate: since, limit: 8 }, timeoutMs: 15000 },
  ]);
  const [cook, ptax, insiders, formd] = w1;
  const sources: SourceResult[] = w1.map((r) => r.src);
  const events: RadarEvent[] = [];
  const seen = new Set<string>();

  for (const row of rowsOf(cook.data)) {
    const key = `cook-${row.pin}-${row.saleDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const price = num(row.salePrice);
    events.push({ kind: "home_sale", date: row.saleDate ?? null, amount: price, parties: [row.buyer, row.seller].filter(Boolean), headline: `${row.address ?? row.pin}: ${usd(price)} (${row.deedType ?? "deed"})`, detail: { pin: row.pin, buyer: row.buyer, seller: row.seller, currentOwnerOfRecord: row.currentOwnerOfRecord, class: row.class }, source: "cook_parcel_sales" });
  }
  for (const row of rowsOf(ptax.data)) {
    const key = `ptax-${row.pin ?? row.documentNumber}-${row.recorded ?? row.instrumentDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const price = num(row.fullConsideration ?? row.netConsideration);
    events.push({ kind: "home_sale", date: row.recorded ?? row.instrumentDate ?? null, amount: price, parties: [row.buyer, ...(row.additionalBuyers ?? []), row.seller].filter(Boolean), headline: `${row.address ?? row.pin}: ${usd(price)} (${row.instrumentType ?? "transfer"}${row.principalResidence ? ", principal residence" : ""})`, detail: { pin: row.pin, buyer: row.buyer, seller: row.seller, county: row.county, currentUse: row.currentUse, newConstruction: row.newConstruction }, source: "il_ptax_transfers" });
  }
  cook.src.rows = events.filter((e) => e.source === "cook_parcel_sales").length;
  ptax.src.rows = events.filter((e) => e.source === "il_ptax_transfers").length;

  for (const o of rowsOf(insiders.data)) {
    const key = `ins-${o.ownerCik}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const issuers = (o.issuers ?? []).map((i: any) => i.ticker ?? i.name).filter(Boolean);
    const txns = (o.filings ?? []).flatMap((f: any) => f.txns ?? []);
    const sold = txns.filter((t: string) => /\bS\b|sale/i.test(t));
    events.push({ kind: "insider_filing", date: o.latestFilingDate ?? null, amount: null, parties: [o.name].filter(Boolean), headline: `${o.name} — ${(o.roles ?? []).join("/") || "insider"} at ${issuers.join(", ")}${sold.length ? ` (${sold.length} sale(s))` : ""}`, detail: { ownerCik: o.ownerCik, address: o.address, city: o.city, zip: o.zip, roles: o.roles, issuers: o.issuers, recent: txns.slice(0, 3), urls: (o.filings ?? []).map((f: any) => f.url).slice(0, 2) }, source: "insider_by_location" });
  }
  insiders.src.rows = events.filter((e) => e.source === "insider_by_location").length;

  for (const off of rowsOf(formd.data)) {
    if (off?.error) continue;
    const local = (off.relatedPersons ?? []).filter((p: any) => {
      const a = String(p.address ?? "").toLowerCase();
      return zip ? a.includes(zip) : city ? a.includes(city.toLowerCase()) : true;
    });
    if (!local.length) continue;
    const key = `formd-${off.accession}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const amt = num(off.totalOfferingAmount);
    events.push({ kind: "formd_person", date: off.filingDate ?? null, amount: amt, parties: local.map((p: any) => p.name).filter(Boolean), headline: `${off.issuer} (${off.industry ?? "?"}) raising ${amt ? usd(amt) : off.totalOfferingAmount ?? "?"} — local related persons: ${local.map((p: any) => p.name).join(", ")}`, detail: { issuer: off.issuer, issuerLocation: off.issuerLocation, entityType: off.entityType, totalAmountSold: off.totalAmountSold, investorsCount: off.investorsCount, persons: local.map((p: any) => ({ name: p.name, roles: p.relationships })), url: off.url }, source: "formd_related_persons" });
  }
  formd.src.rows = events.filter((e) => e.source === "formd_related_persons").length;

  // rank: recency × size; insiders and Form D persons get a flat premium because they identify a person directly
  const ranked = events
    .map((e) => {
      const m = monthsAgo(e.date) ?? 12;
      const recency = Math.max(0.2, 1 - m / 12);
      const size = e.amount ? Math.min(1, Math.log10(e.amount) / 7.5) : 0.5;
      const premium = e.kind === "home_sale" ? 0 : 0.35;
      return { e, s: recency * 0.5 + size * 0.5 + premium };
    })
    .sort((a, b) => b.s - a.s)
    .slice(0, maxEvents)
    .map((x) => x.e);

  /* --------------------------- wave 2: cross-reference ---------------------- */
  let xrefCalls = 0;
  if (args.crossReference !== false) {
    const names = Array.from(new Set(ranked.flatMap((e) => e.parties).filter((p) => p && !PERSONISH.test(p)))).slice(0, 14);
    const surnames = Array.from(new Set(names.map((n) => splitName(n, /,/.test(n) ? "last-first" : "last-first").last).filter((s) => s.length >= 3)));
    const calls = surnames.flatMap((s) => [
      { tool: "prospects_search", args: { lastName: s, limit: 20 } },
      { tool: "irs990_people_search", args: { surname: s, orgState: state, limit: 30 } },
    ]);
    xrefCalls = calls.length;
    const xr = await fanOut(calls);
    sources.push(...xr.map((r) => r.src));
    const dbRows = xr.filter((r) => r.src.tool === "prospects_search").flatMap((r) => rowsOf(r.data));
    const boardRows = xr.filter((r) => r.src.tool === "irs990_people_search").flatMap((r) => rowsOf(r.data));
    for (const e of ranked) {
      const party = e.parties.filter((p) => !PERSONISH.test(p));
      const keys = party.map((p) => normName(p));
      const db = dbRows.filter((r) => keys.some((k) => normName(r?.name?.full).split(" ").every((w) => k.includes(w))));
      const seats = boardRows.filter((r) => keys.some((k) => normName(r.name).split(" ").every((w) => k.includes(w))));
      e.known = {
        inDb: db.length > 0,
        doNotContact: db.some((r) => r?.consent?.doNotContact),
        leadStatus: db[0]?.lead?.status,
        boardSeats: seats.length,
        boardOrgs: Array.from(new Set(seats.map((s) => s.orgName))).slice(0, 4),
      };
    }
  }

  for (const e of ranked) {
    const blocked = e.known?.doNotContact || e.known?.leadStatus === "client";
    e.actionable = !blocked && e.parties.some((p) => !PERSONISH.test(p));
    e.angle = blocked
      ? "Blocked: do-not-contact or existing client."
      : e.kind === "home_sale"
      ? "Seller: proceeds-before-year-end checklist. Buyer: welcome + reassessment-appeal note. Never cite the price."
      : e.kind === "insider_filing"
      ? "Concentrated stock / 10b5-1 planning — professional email only; never reference the filing as news."
      : "Pre-liquidity planning (QSBS, trusts, carry) — the earliest conversation is the most valuable.";
  }

  return {
    dataSource: "synthesis:liquidity_event_radar (Cook Assessor Parcel Sales · IDOR PTAX-203 · SEC Forms 3/4/5 by owner location · SEC Form D related persons · prospects DB · IRS 990 Part VII)",
    scope: { location, city: city ?? null, zip: zip ?? null, state, lookbackDays, since, minPrice },
    counts: { events: events.length, returned: ranked.length, homeSales: events.filter((e) => e.kind === "home_sale").length, insiderFilings: events.filter((e) => e.kind === "insider_filing").length, formdPersons: events.filter((e) => e.kind === "formd_person").length, actionable: ranked.filter((e) => e.actionable).length, crossRefCalls: xrefCalls },
    events: ranked.map((e) => ({ kind: e.kind, date: e.date, amount: e.amount, headline: e.headline, parties: e.parties.slice(0, 4), known: e.known, actionable: e.actionable, angle: e.angle, source: e.source, detail: e.detail })),
    guardrails: ["Parcel records alone never justify contact — resolve a professional email path first (Hunter/Apollo), then prospect_lookup for consent.", "Drafts only; Matt approves. Never reference prices, deeds or filings in the message."],
    coverage: coverage(sources),
    sources,
    note: "Ranked by recency × size with a premium for events that name a person directly (insider, Form D). Cross-reference matches on normalized name only — verify before acting on 'known'. Cook data lags ~2 months; PTAX is weekly.",
  };
}
