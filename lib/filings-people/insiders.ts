/**
 * SEC Forms 3/4/5 (Section 16 insider ownership reports) — live from EDGAR.
 *
 *   insider_transactions — by issuer (ticker/CIK) or by reporting owner
 *                          (person CIK / name), parsed from the ownership XML.
 *   insider_by_location  — EDGAR full-text search for a place name across
 *                          Forms 3/4/5, then each hit's XML is parsed and the
 *                          reporting owner's filing ADDRESS is verified.
 *
 * Sources (verified live 2026-10-21):
 *   data.sec.gov/submissions/CIK##########.json — per-CIK filing list; for an
 *     issuer it includes Forms 4 filed about it; for a person (reporting
 *     owner) it lists their Forms 3/4/5 across every issuer.
 *   Archives/edgar/data/<cik>/<accNoDash>/<file>.xml — the raw ownershipDocument.
 *     submissions' primaryDocument is the XSL-rendered path
 *     ("xslF345X06/form4.xml"); stripping the xsl prefix gives the raw XML.
 *     Fallback: the filing's index.json directory listing.
 *   efts.sec.gov/LATEST/search-index — full-text search; the reporting
 *     owner's street/city/zip IS indexed text in the ownership XML.
 */
import { companyTickers, padCik, submissions } from "../edgar/client";
import {
  ARCHIVES,
  accDashed,
  accNoDash,
  bool,
  entitySearch,
  errMsg,
  findFilingXml,
  ftsSearch,
  isoDaysAgo,
  mapPool,
  num,
  secText,
  str,
  stripCik,
  xml,
} from "./sec";

export const TRANSACTION_CODES: Record<string, string> = {
  P: "Open-market or private purchase",
  S: "Open-market or private sale",
  A: "Grant/award from issuer",
  D: "Disposition to issuer",
  F: "Tax withholding (shares withheld to pay exercise price/tax)",
  M: "Exercise/conversion of derivative (exempt)",
  C: "Conversion of derivative",
  X: "Exercise of in/at-the-money derivative",
  O: "Exercise of out-of-the-money derivative",
  G: "Gift",
  J: "Other acquisition/disposition (see footnotes)",
  K: "Equity swap or similar",
  I: "Discretionary transaction (Rule 16b-3(f))",
  L: "Small acquisition (Rule 16a-6)",
  W: "Acquisition/disposition by will or laws of descent",
  Z: "Deposit into/withdrawal from voting trust",
  H: "Expiration (or cancellation) of long derivative position",
  E: "Expiration of short derivative position",
  U: "Disposition pursuant to tender of shares in change-of-control",
  V: "Transaction voluntarily reported earlier than required",
};

export interface ParsedOwner {
  cik: string | null;
  name: string | null;
  street1: string | null;
  street2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  isDirector: boolean;
  isOfficer: boolean;
  isTenPercentOwner: boolean;
  isOther: boolean;
  officerTitle: string | null;
  otherText: string | null;
  relationship: string;
}

export interface ParsedTxn {
  table: "non-derivative" | "derivative";
  kind: "transaction" | "holding";
  security: string | null;
  date: string | null;
  code: string | null;
  codeLabel: string | null;
  shares: number | null;
  price: number | null;
  acquiredDisposed: "A" | "D" | null;
  sharesOwnedAfter: number | null;
  directIndirect: "D" | "I" | null;
  indirectNature: string | null;
  underlying?: string | null;
  exercisePrice?: number | null;
}

export interface ParsedOwnershipDoc {
  form: string | null;
  periodOfReport: string | null;
  issuer: { cik: string | null; name: string | null; ticker: string | null };
  owners: ParsedOwner[];
  transactions: ParsedTxn[];
  aff10b5One: boolean | null;
}

function relationshipLabel(o: Omit<ParsedOwner, "relationship">): string {
  const parts: string[] = [];
  if (o.isDirector) parts.push("Director");
  if (o.isOfficer) parts.push(o.officerTitle ? `Officer (${o.officerTitle})` : "Officer");
  if (o.isTenPercentOwner) parts.push("10% Owner");
  if (o.isOther) parts.push(o.otherText ? `Other (${o.otherText})` : "Other");
  return parts.join("; ") || "Unspecified";
}

export function parseOwnershipXml(text: string): ParsedOwnershipDoc | null {
  const root = xml.parse(text)?.ownershipDocument;
  if (!root) return null;
  const owners: ParsedOwner[] = (root.reportingOwner ?? []).map((ro: any) => {
    const id = ro?.reportingOwnerId ?? {};
    const a = ro?.reportingOwnerAddress ?? {};
    const r = ro?.reportingOwnerRelationship ?? {};
    const base = {
      cik: str(id.rptOwnerCik),
      name: str(id.rptOwnerName),
      street1: str(a.rptOwnerStreet1),
      street2: str(a.rptOwnerStreet2),
      city: str(a.rptOwnerCity),
      state: str(a.rptOwnerState),
      zip: str(a.rptOwnerZipCode),
      isDirector: bool(r.isDirector),
      isOfficer: bool(r.isOfficer),
      isTenPercentOwner: bool(r.isTenPercentOwner),
      isOther: bool(r.isOther),
      officerTitle: str(r.officerTitle),
      otherText: str(r.otherText),
    };
    return { ...base, relationship: relationshipLabel(base) };
  });

  const txns: ParsedTxn[] = [];
  const pushRows = (rows: any[] | undefined, table: ParsedTxn["table"], kind: ParsedTxn["kind"]) => {
    for (const t of rows ?? []) {
      const code = str(t?.transactionCoding?.transactionCode);
      const ad = str(t?.transactionAmounts?.transactionAcquiredDisposedCode);
      const di = str(t?.ownershipNature?.directOrIndirectOwnership);
      txns.push({
        table,
        kind,
        security: str(t?.securityTitle),
        date: str(t?.transactionDate),
        code,
        codeLabel: code ? TRANSACTION_CODES[code] ?? null : null,
        shares: num(t?.transactionAmounts?.transactionShares),
        price: num(t?.transactionAmounts?.transactionPricePerShare),
        acquiredDisposed: ad === "A" || ad === "D" ? ad : null,
        sharesOwnedAfter: num(t?.postTransactionAmounts?.sharesOwnedFollowingTransaction),
        directIndirect: di === "D" || di === "I" ? di : null,
        indirectNature: str(t?.ownershipNature?.natureOfOwnership),
        ...(table === "derivative"
          ? {
              underlying: str(t?.underlyingSecurity?.underlyingSecurityTitle),
              exercisePrice: num(t?.conversionOrExercisePrice),
            }
          : {}),
      });
    }
  };
  pushRows(root.nonDerivativeTable?.nonDerivativeTransaction, "non-derivative", "transaction");
  pushRows(root.derivativeTable?.derivativeTransaction, "derivative", "transaction");
  pushRows(root.nonDerivativeTable?.nonDerivativeHolding, "non-derivative", "holding");
  pushRows(root.derivativeTable?.derivativeHolding, "derivative", "holding");

  const aff = root.aff10b5One;
  return {
    form: str(root.documentType),
    periodOfReport: str(root.periodOfReport),
    issuer: {
      cik: str(root.issuer?.issuerCik),
      name: str(root.issuer?.issuerName),
      ticker: str(root.issuer?.issuerTradingSymbol),
    },
    owners,
    transactions: txns,
    aff10b5One: aff == null || str(aff) == null ? null : bool(aff),
  };
}

export interface LocationFilter {
  ownerCity?: string;
  ownerState?: string;
  ownerZip?: string;
}

function norm(s: string | null | undefined) {
  return (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function ownerMatchesLocation(o: ParsedOwner, f: LocationFilter): boolean {
  if (f.ownerState && norm(o.state) !== norm(f.ownerState)) return false;
  if (f.ownerCity && norm(o.city) !== norm(f.ownerCity)) return false;
  if (f.ownerZip && !norm(o.zip).startsWith(norm(f.ownerZip).slice(0, 5))) return false;
  return true;
}

function hasLocFilter(f: LocationFilter) {
  return !!(f.ownerCity || f.ownerState || f.ownerZip);
}

interface FilingRef {
  cik: string; // CIK whose archive path we use
  accession: string;
  form: string;
  filingDate: string | null;
  primaryDocument?: string | null;
  fileName?: string | null;
}

async function fetchOwnershipDoc(ref: FilingRef): Promise<{ url: string; doc: ParsedOwnershipDoc | null }> {
  const dir = `${ARCHIVES}/${stripCik(ref.cik)}/${accNoDash(ref.accession)}`;
  let name = ref.fileName ?? null;
  if (!name && ref.primaryDocument) {
    // "xslF345X06/form4.xml" → raw "form4.xml"
    name = ref.primaryDocument.replace(/^xsl[^/]*\//i, "");
    if (!/\.xml$/i.test(name)) name = null;
  }
  let url = name ? `${dir}/${name}` : null;
  if (url) {
    try {
      return { url, doc: parseOwnershipXml(await secText(url)) };
    } catch {
      url = null;
    }
  }
  const found = await findFilingXml(ref.cik, ref.accession);
  if (!found) return { url: `${dir}/`, doc: null };
  return { url: found, doc: parseOwnershipXml(await secText(found)) };
}

function filingFromSubmissions(cik: string, recent: Record<string, any[]>, forms: Set<string>, since?: string): FilingRef[] {
  const out: FilingRef[] = [];
  const f = recent.form ?? [];
  for (let i = 0; i < f.length; i++) {
    const form = String(f[i]);
    if (!forms.has(form)) continue;
    const fd = recent.filingDate?.[i] ?? null;
    if (since && fd && fd < since) continue;
    out.push({
      cik,
      accession: recent.accessionNumber[i],
      form,
      filingDate: fd,
      primaryDocument: recent.primaryDocument?.[i] ?? null,
    });
  }
  return out;
}

async function resolveIssuerCik(args: { ticker?: string; issuerCik?: string | number; issuerName?: string }) {
  if (args.issuerCik != null && String(args.issuerCik).trim()) return { cik: padCik(args.issuerCik), matched: null as any };
  const tickers = await companyTickers();
  if (args.ticker) {
    const t = args.ticker.trim().toUpperCase();
    const hit = tickers.find((x) => x.ticker.toUpperCase() === t);
    if (hit) return { cik: padCik(hit.cik), matched: hit };
  }
  if (args.issuerName) {
    const n = args.issuerName.trim().toLowerCase();
    const hit = tickers.find((x) => x.title.toLowerCase() === n) ?? tickers.find((x) => x.title.toLowerCase().includes(n));
    if (hit) return { cik: padCik(hit.cik), matched: hit };
  }
  return { cik: null, matched: null };
}

export interface InsiderTransactionsArgs extends LocationFilter {
  ticker?: string;
  issuerCik?: string | number;
  issuerName?: string;
  ownerCik?: string | number;
  ownerName?: string;
  forms?: string; // "4" default; e.g. "3,4,5"
  sinceDate?: string;
  codes?: string; // e.g. "P,S"
  maxFilings?: number;
  includeHoldings?: boolean;
}

export async function insiderTransactions(args: InsiderTransactionsArgs) {
  const dataSource = "SEC EDGAR Forms 3/4/5 ownership XML (data.sec.gov submissions + Archives, live)";
  const maxFilings = Math.max(1, Math.min(args.maxFilings ?? 6, 20));
  const formSet = new Set<string>();
  for (const f of String(args.forms ?? "4").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)) {
    formSet.add(f);
    formSet.add(`${f}/A`);
  }
  const codeSet = args.codes
    ? new Set(String(args.codes).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))
    : null;
  const loc: LocationFilter = { ownerCity: args.ownerCity, ownerState: args.ownerState, ownerZip: args.ownerZip };

  let mode: "issuer" | "owner";
  let subjectCik: string | null = null;
  let subjectName: string | null = null;
  let ownerCandidates: Array<{ cik: string; name: string }> | undefined;

  if (args.ownerCik != null || args.ownerName) {
    mode = "owner";
    if (args.ownerCik != null && String(args.ownerCik).trim()) {
      subjectCik = padCik(args.ownerCik);
    } else {
      const cands = await entitySearch(String(args.ownerName));
      ownerCandidates = cands.slice(0, 8).map((c) => ({ cik: padCik(c.cik), name: c.name }));
      if (!cands.length) {
        return {
          dataSource,
          mode,
          error: `No EDGAR entity matched '${args.ownerName}'. EDGAR stores insiders as 'LAST FIRST MIDDLE' — try 'Smith John' or just the last name, or pass ownerCik.`,
          filings: [],
        };
      }
      subjectCik = padCik(cands[0]!.cik);
    }
  } else if (args.ticker || args.issuerCik != null || args.issuerName) {
    mode = "issuer";
    const r = await resolveIssuerCik(args);
    if (!r.cik) {
      return {
        dataSource,
        mode,
        error: `Could not resolve issuer from ${JSON.stringify({ ticker: args.ticker, issuerName: args.issuerName })}. Use edgar_company_lookup or pass issuerCik.`,
        filings: [],
      };
    }
    subjectCik = r.cik;
  } else {
    return {
      dataSource,
      error: "Provide an issuer (ticker / issuerCik / issuerName) or a reporting owner (ownerCik / ownerName). For 'insiders who live in X' use insider_by_location.",
      filings: [],
    };
  }

  const sub = await submissions(subjectCik!);
  subjectName = sub.name ?? null;
  const refs = filingFromSubmissions(subjectCik!, sub.filings?.recent ?? {}, formSet, args.sinceDate).slice(0, maxFilings);

  const parsed = await mapPool(refs, 4, async (ref) => {
    try {
      const { url, doc } = await fetchOwnershipDoc(ref);
      return { ref, url, doc, error: null as string | null };
    } catch (e) {
      return { ref, url: null, doc: null, error: errMsg(e) };
    }
  });

  const filings: any[] = [];
  let skippedByLocation = 0;
  for (const p of parsed) {
    if (!p.doc) {
      filings.push({ accession: p.ref.accession, form: p.ref.form, filingDate: p.ref.filingDate, error: p.error ?? "no ownership XML found", url: p.url });
      continue;
    }
    const owners = hasLocFilter(loc) ? p.doc.owners.filter((o) => ownerMatchesLocation(o, loc)) : p.doc.owners;
    if (hasLocFilter(loc) && owners.length === 0) {
      skippedByLocation++;
      continue;
    }
    let txns = p.doc.transactions;
    if (!args.includeHoldings) txns = txns.filter((t) => t.kind === "transaction");
    if (codeSet) txns = txns.filter((t) => t.code && codeSet.has(t.code));
    if (codeSet && txns.length === 0) continue;
    filings.push({
      accession: accDashed(p.ref.accession),
      form: p.doc.form ?? p.ref.form,
      filingDate: p.ref.filingDate,
      periodOfReport: p.doc.periodOfReport,
      issuer: p.doc.issuer,
      owners: owners.map((o) => ({
        cik: o.cik,
        name: o.name,
        relationship: o.relationship,
        address: [o.street1, o.street2].filter(Boolean).join(", ") || null,
        city: o.city,
        state: o.state,
        zip: o.zip,
      })),
      rule10b5_1: p.doc.aff10b5One,
      transactions: txns.map((t) => ({
        security: t.security,
        date: t.date,
        code: t.code,
        codeLabel: t.codeLabel,
        acqDisp: t.acquiredDisposed,
        shares: t.shares,
        price: t.price,
        value: t.shares != null && t.price != null ? Math.round(t.shares * t.price) : null,
        ownedAfter: t.sharesOwnedAfter,
        directIndirect: t.directIndirect,
        ...(t.indirectNature ? { indirectNature: t.indirectNature } : {}),
        ...(t.table === "derivative" ? { derivative: true, underlying: t.underlying, exercisePrice: t.exercisePrice } : {}),
        ...(t.kind === "holding" ? { holdingOnly: true } : {}),
      })),
      url: p.url,
    });
  }

  return {
    dataSource,
    mode,
    subject: { cik: subjectCik, name: subjectName, ...(mode === "owner" && sub.addresses?.mailing ? { mailingAddress: sub.addresses.mailing } : {}) },
    ...(ownerCandidates && ownerCandidates.length > 1 ? { otherOwnerMatches: ownerCandidates.slice(1) } : {}),
    filingsParsed: parsed.length,
    returned: filings.length,
    ...(hasLocFilter(loc) ? { locationFilter: loc, skippedByLocation } : {}),
    filings,
    note:
      `Parsed the ${parsed.length} most recent ${[...formSet].filter((f) => !f.endsWith("/A")).join("/")} filing(s) (cap 20/call; raise maxFilings or set sinceDate). ` +
      "Codes: P=open-market buy, S=sale, A=grant, M=option exercise, F=tax withholding, G=gift. Owner address is the address ON THE FILING — often the company HQ, sometimes the insider's home. " +
      (mode === "owner" ? "Owner mode uses the person's own EDGAR CIK filing list (all issuers)." : "Issuer mode lists Forms filed about this issuer.") +
      " Location filters (ownerCity/ownerState/ownerZip) apply only to the filings parsed in this call — for a place-first search use insider_by_location.",
  };
}

export interface InsiderByLocationArgs {
  location: string; // e.g. "Hinsdale"
  ownerState?: string;
  ownerZip?: string;
  ownerCity?: string;
  forms?: string; // default "3,4,5"
  startDate?: string;
  endDate?: string;
  maxFilings?: number;
}

export async function insiderByLocation(args: InsiderByLocationArgs) {
  const dataSource = "SEC EDGAR full-text search (efts.sec.gov) + Forms 3/4/5 ownership XML (live)";
  const loc = String(args.location ?? "").trim();
  if (!loc) return { dataSource, error: "location is required (e.g. 'Hinsdale', 'Oak Brook', or a ZIP like '60521').", owners: [] };
  const maxFilings = Math.max(1, Math.min(args.maxFilings ?? 20, 30));
  const forms = args.forms ?? "3,4,5";
  const startDate = args.startDate ?? isoDaysAgo(365 * 5);
  const endDate = args.endDate ?? new Date().toISOString().slice(0, 10);
  const q = /\s/.test(loc) && !/^".*"$/.test(loc) ? `"${loc}"` : loc;

  const hits: Awaited<ReturnType<typeof ftsSearch>>["hits"] = [];
  let total: number | null = null;
  for (let from = 0; hits.length < maxFilings && from < 100; from += 10) {
    const r = await ftsSearch({ q, forms, startDate, endDate, from });
    total = r.total;
    if (!r.hits.length) break;
    // FTS returns one hit per indexed DOCUMENT; dedupe to one per filing.
    for (const h of r.hits) if (!hits.some((x) => x.adsh === h.adsh)) hits.push(h);
    if (total != null && from + 10 >= total) break;
  }
  const take = hits.slice(0, maxFilings);

  // City match default: if the location looks like a ZIP, filter on ZIP; otherwise on city text.
  const isZip = /^\d{5}(-\d{4})?$/.test(loc);
  const filter: LocationFilter = {
    ownerState: args.ownerState,
    ownerZip: args.ownerZip ?? (isZip ? loc : undefined),
    ownerCity: args.ownerCity ?? (isZip ? undefined : loc.replace(/"/g, "")),
  };

  const parsed = await mapPool(take, 4, async (h) => {
    const cik = h.ciks[0];
    if (!cik) return { h, url: null, doc: null, error: "hit has no CIK" };
    try {
      const { url, doc } = await fetchOwnershipDoc({ cik, accession: h.adsh, form: h.form ?? "4", filingDate: h.fileDate, fileName: h.fileName && /\.xml$/i.test(h.fileName) ? h.fileName : null });
      return { h, url, doc, error: null as string | null };
    } catch (e) {
      return { h, url: null, doc: null, error: errMsg(e) };
    }
  });

  const owners = new Map<string, any>();
  let nonMatching = 0;
  let parseFailures = 0;
  for (const p of parsed) {
    if (!p.doc) {
      parseFailures++;
      continue;
    }
    const matched = p.doc.owners.filter((o) => ownerMatchesLocation(o, filter));
    if (!matched.length) {
      nonMatching++;
      continue;
    }
    for (const o of matched) {
      const key = o.cik ?? o.name ?? "?";
      const cur =
        owners.get(key) ??
        {
          ownerCik: o.cik,
          name: o.name,
          address: [o.street1, o.street2].filter(Boolean).join(", ") || null,
          city: o.city,
          state: o.state,
          zip: o.zip,
          roles: new Set<string>(),
          issuers: new Map<string, any>(),
          latestFilingDate: null as string | null,
          filings: [] as any[],
        };
      cur.roles.add(o.relationship);
      const ik = p.doc.issuer.cik ?? p.doc.issuer.name ?? "?";
      if (!cur.issuers.has(ik)) cur.issuers.set(ik, { cik: p.doc.issuer.cik, name: p.doc.issuer.name, ticker: p.doc.issuer.ticker });
      if (!cur.latestFilingDate || (p.h.fileDate && p.h.fileDate > cur.latestFilingDate)) cur.latestFilingDate = p.h.fileDate;
      const tx = p.doc.transactions.filter((t) => t.kind === "transaction");
      if (cur.filings.length < 2)
        cur.filings.push({
          form: p.doc.form,
          filed: p.h.fileDate,
          issuer: p.doc.issuer.ticker ?? p.doc.issuer.name,
          txns: tx.slice(0, 3).map((t) => `${t.date ?? ""} ${t.code ?? ""} ${t.shares ?? ""}@${t.price ?? "-"} → ${t.sharesOwnedAfter ?? ""}`.trim()),
          url: p.url,
        });
      owners.set(key, cur);
    }
  }

  const out = [...owners.values()]
    .map((o) => ({ ...o, roles: [...o.roles], issuers: [...o.issuers.values()] }))
    .sort((a, b) => String(b.latestFilingDate ?? "").localeCompare(String(a.latestFilingDate ?? "")));

  return {
    dataSource,
    request: { query: q, forms, startDate, endDate, verifyFilter: filter },
    ftsTotalMatches: total,
    filingsParsed: parsed.length,
    verifiedOwners: out.length,
    rejectedNotAtLocation: nonMatching,
    parseFailures,
    owners: out,
    note:
      "Recall limits (be explicit with the user): EDGAR full-text search matches the place name ANYWHERE in the filing text — issuer address, footnotes, entity names — so every hit is re-verified against the REPORTING OWNER's address parsed from the XML (rejectedNotAtLocation counts the false positives). " +
      "Most insiders file with the COMPANY's address, not their home, so a Hinsdale resident who files c/o their employer's HQ will NOT appear; conversely 'Oak Brook' surfaces everyone at an Oak Brook-HQ'd company. " +
      `Only the first ${maxFilings} hits (cap 30) are parsed — narrow the date range or page via startDate/endDate when ftsTotalMatches is larger. ` +
      "Use ownerState (e.g. 'IL') to disambiguate common town names. Follow up on a person with insider_transactions {ownerCik}.",
  };
}
