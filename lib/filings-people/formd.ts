/**
 * Form D related persons — the founders, GPs, managing members, executive
 * officers and directors listed on Reg D exempt-offering notices.
 *
 * Complements formd_search (lib/edgar/fulltext.ts), which returns only the
 * filing hits: this tool opens each primary_doc.xml and returns the PEOPLE
 * (name, relationships, address) plus the offering economics.
 *
 * Sources (verified live 2026-10-21):
 *   Archives/edgar/data/<cik>/<accNoDash>/primary_doc.xml  — Form D XML
 *     (edgarSubmission → primaryIssuer, relatedPersonsList, offeringData)
 *   data.sec.gov/submissions — issuer's D / D/A list (primaryDocument is
 *     "xslFormDX01/primary_doc.xml"; raw XML = strip the xsl prefix)
 *   efts.sec.gov full-text search with forms=D,D/A for location/name search.
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

export interface FormDPerson {
  name: string;
  relationships: string[];
  clarification: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

export interface ParsedFormD {
  submissionType: string | null;
  issuer: {
    cik: string | null;
    name: string | null;
    street: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    phone: string | null;
    entityType: string | null;
    jurisdiction: string | null;
    yearOfInc: string | null;
  };
  relatedPersons: FormDPerson[];
  industryGroup: string | null;
  fundType: string | null;
  revenueOrNavRange: string | null;
  exemptions: string[];
  isAmendment: boolean | null;
  dateOfFirstSale: string | null;
  minimumInvestment: number | null;
  totalOfferingAmount: number | string | null;
  totalAmountSold: number | null;
  totalRemaining: number | string | null;
  investorsCount: number | null;
  hasNonAccredited: boolean | null;
  salesCommissions: number | null;
  findersFees: number | null;
  salesCompensation: Array<{ name: string | null; crd: string | null; states: string[] }>;
  signer: { name: string | null; title: string | null; date: string | null };
}

function personName(n: any): string {
  const parts = [str(n?.firstName), str(n?.middleName), str(n?.lastName)].filter((p) => p && !/^n\/?a$/i.test(p));
  return parts.join(" ");
}

function amountOrText(v: any): number | string | null {
  const s = str(v);
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : s;
}

export function parseFormDXml(text: string): ParsedFormD | null {
  const root = xml.parse(text)?.edgarSubmission;
  if (!root) return null;
  const pi = root.primaryIssuer ?? {};
  const od = root.offeringData ?? {};
  const persons: FormDPerson[] = (root.relatedPersonsList?.relatedPersonInfo ?? []).map((p: any) => ({
    name: personName(p?.relatedPersonName),
    relationships: (p?.relatedPersonRelationshipList?.relationship ?? []).map((r: any) => str(r)).filter(Boolean),
    clarification: str(p?.relationshipClarification),
    street: [str(p?.relatedPersonAddress?.street1), str(p?.relatedPersonAddress?.street2)].filter(Boolean).join(", ") || null,
    city: str(p?.relatedPersonAddress?.city),
    state: str(p?.relatedPersonAddress?.stateOrCountry),
    zip: str(p?.relatedPersonAddress?.zipCode),
  }));
  const fs = od.typeOfFiling?.dateOfFirstSale ?? {};
  const sig = Array.isArray(od.signatureBlock?.signature) ? od.signatureBlock.signature[0] : od.signatureBlock?.signature;
  const recips = od.salesCompensationList?.recipient;
  const recipList: any[] = Array.isArray(recips) ? recips : recips ? [recips] : [];
  const yoi = pi.yearOfInc ?? {};
  return {
    submissionType: str(root.submissionType),
    issuer: {
      cik: str(pi.cik),
      name: str(pi.entityName),
      street: [str(pi.issuerAddress?.street1), str(pi.issuerAddress?.street2)].filter(Boolean).join(", ") || null,
      city: str(pi.issuerAddress?.city),
      state: str(pi.issuerAddress?.stateOrCountry),
      zip: str(pi.issuerAddress?.zipCode),
      phone: str(pi.issuerPhoneNumber),
      entityType: str(pi.entityType),
      jurisdiction: str(pi.jurisdictionOfInc),
      yearOfInc: str(yoi.value) ?? (bool(yoi.overFiveYears) ? "over five years ago" : null),
    },
    relatedPersons: persons,
    industryGroup: str(od.industryGroup?.industryGroupType),
    fundType: str(od.industryGroup?.investmentFundInfo?.investmentFundType),
    revenueOrNavRange: str(od.issuerSize?.revenueRange) ?? str(od.issuerSize?.aggregateNetAssetValueRange),
    exemptions: (od.federalExemptionsExclusions?.item ?? []).map((i: any) => str(i)).filter(Boolean),
    isAmendment: od.typeOfFiling?.newOrAmendment?.isAmendment == null ? null : bool(od.typeOfFiling.newOrAmendment.isAmendment),
    dateOfFirstSale: str(fs.value) ?? (bool(fs.yetToOccur) ? "yet to occur" : null),
    minimumInvestment: num(od.minimumInvestmentAccepted),
    totalOfferingAmount: amountOrText(od.offeringSalesAmounts?.totalOfferingAmount),
    totalAmountSold: num(od.offeringSalesAmounts?.totalAmountSold),
    totalRemaining: amountOrText(od.offeringSalesAmounts?.totalRemaining),
    investorsCount: num(od.investors?.totalNumberAlreadyInvested),
    hasNonAccredited: od.investors?.hasNonAccreditedInvestors == null ? null : bool(od.investors.hasNonAccreditedInvestors),
    salesCommissions: num(od.salesCommissionsFindersFees?.salesCommissions?.dollarAmount),
    findersFees: num(od.salesCommissionsFindersFees?.findersFees?.dollarAmount),
    salesCompensation: recipList.map((r) => ({
      name: str(r?.recipientName),
      crd: str(r?.recipientCRDNumber),
      states: (() => {
        const s = r?.statesOfSolicitationList?.state;
        return (Array.isArray(s) ? s : s ? [s] : []).map((x: any) => str(x)).filter(Boolean) as string[];
      })(),
    })),
    signer: { name: str(sig?.nameOfSigner), title: str(sig?.signatureTitle), date: str(sig?.signatureDate) },
  };
}

async function fetchFormD(cik: string, acc: string, fileName?: string | null) {
  const dir = `${ARCHIVES}/${stripCik(cik)}/${accNoDash(acc)}`;
  const first = `${dir}/${fileName && /\.xml$/i.test(fileName) ? fileName.replace(/^xsl[^/]*\//i, "") : "primary_doc.xml"}`;
  try {
    return { url: first, doc: parseFormDXml(await secText(first)) };
  } catch {
    const found = await findFilingXml(cik, acc, /primary_doc/i);
    if (!found) return { url: `${dir}/`, doc: null };
    return { url: found, doc: parseFormDXml(await secText(found)) };
  }
}

function compact(d: ParsedFormD, meta: { accession: string; filingDate?: string | null; url: string | null }, personFilter?: (p: FormDPerson) => boolean) {
  const persons = personFilter ? d.relatedPersons.filter(personFilter) : d.relatedPersons;
  return {
    issuer: d.issuer.name,
    issuerCik: d.issuer.cik,
    issuerLocation: [d.issuer.city, d.issuer.state, d.issuer.zip].filter(Boolean).join(", ") || null,
    form: d.submissionType,
    filingDate: meta.filingDate ?? d.signer.date,
    accession: accDashed(meta.accession),
    industry: d.industryGroup + (d.fundType ? ` / ${d.fundType}` : ""),
    entityType: d.issuer.entityType,
    yearOfInc: d.issuer.yearOfInc,
    sizeRange: d.revenueOrNavRange,
    totalOfferingAmount: d.totalOfferingAmount,
    totalAmountSold: d.totalAmountSold,
    minimumInvestment: d.minimumInvestment,
    investorsCount: d.investorsCount,
    dateOfFirstSale: d.dateOfFirstSale,
    exemptions: d.exemptions,
    relatedPersons: persons.map((p) => ({
      name: p.name,
      relationships: p.relationships,
      ...(p.clarification ? { clarification: p.clarification } : {}),
      address: [p.street, p.city, p.state, p.zip].filter(Boolean).join(", ") || null,
    })),
    ...(d.salesCompensation.length ? { salesCompensation: d.salesCompensation } : {}),
    signer: d.signer,
    url: meta.url,
  };
}

export interface FormdRelatedPersonsArgs {
  accession?: string;
  issuerCik?: string | number;
  issuerName?: string;
  query?: string; // search mode: location or name keyword(s)
  personState?: string;
  personCity?: string;
  startDate?: string;
  endDate?: string;
  includeAmendments?: boolean;
  limit?: number;
  filingsPerIssuer?: number;
}

export async function formdRelatedPersons(args: FormdRelatedPersonsArgs) {
  const dataSource = "SEC Form D primary_doc.xml (EDGAR Archives + full-text search, live)";

  // ---- Search mode -------------------------------------------------------
  if (args.query && !args.accession && args.issuerCik == null && !args.issuerName) {
    const limit = Math.max(1, Math.min(args.limit ?? 8, 10));
    // EDGAR FTS quirk (verified 2026-10-21): forms=D matches the ROOT form and
    // already returns D + D/A; forms=D,D/A returns ONLY the D/A subset. So
    // always query D and drop amendments client-side when asked.
    const forms = "D";
    const wantAmendments = args.includeAmendments !== false;
    const startDate = args.startDate ?? isoDaysAgo(730);
    const endDate = args.endDate ?? new Date().toISOString().slice(0, 10);
    const raw = String(args.query).trim();
    const q = /\s/.test(raw) && !/["()]|\bOR\b|\bAND\b/.test(raw) ? `"${raw}"` : raw;
    const hits: Awaited<ReturnType<typeof ftsSearch>>["hits"] = [];
    let total: number | null = null;
    const seenIssuer = new Set<string>();
    for (let from = 0; hits.length < limit && from < 50; from += 10) {
      const r = await ftsSearch({ q, forms, startDate, endDate, from });
      total = r.total;
      if (!r.hits.length) break;
      // newest first, one filing per issuer (amendments repeat the same people)
      for (const h of r.hits.sort((a, b) => String(b.fileDate).localeCompare(String(a.fileDate)))) {
        if (!wantAmendments && h.form !== "D") continue;
        const key = h.ciks[0] ?? h.adsh;
        if (seenIssuer.has(key)) continue;
        seenIssuer.add(key);
        hits.push(h);
        if (hits.length >= limit) break;
      }
      if (total != null && from + 10 >= total) break;
    }
    const personFilter =
      args.personState || args.personCity
        ? (p: FormDPerson) =>
            (!args.personState || (p.state ?? "").toUpperCase() === args.personState.toUpperCase()) &&
            (!args.personCity || (p.city ?? "").toUpperCase() === args.personCity.toUpperCase())
        : undefined;
    const results = await mapPool(hits, 4, async (h) => {
      const cik = h.ciks[0];
      if (!cik) return { accession: h.adsh, error: "hit has no CIK" };
      try {
        const { url, doc } = await fetchFormD(cik, h.adsh, h.fileName);
        if (!doc) return { accession: h.adsh, error: "Form D XML not parseable", url };
        return compact(doc, { accession: h.adsh, filingDate: h.fileDate, url }, personFilter);
      } catch (e) {
        return { accession: h.adsh, error: errMsg(e) };
      }
    });
    return {
      dataSource,
      mode: "search",
      request: { query: q, forms: wantAmendments ? "D (incl. D/A)" : "D only", startDate, endDate },
      ftsTotalMatches: total,
      returned: results.length,
      offerings: results,
      note:
        "Search mode: EDGAR full-text search over Form D text (issuer + related-person addresses, names, clarifications), newest first, de-duplicated to one filing per issuer, top N parsed (cap 10). " +
        "A place name can match the issuer address OR a related person's address — check each person's address. personState/personCity keep only people at that location. " +
        "Related persons = executive officers, directors, promoters (GP / managing member entities appear with the entity name). Form D does NOT disclose investors' names. Default window: last 2 years.",
    };
  }

  // ---- Single filing / issuer mode ---------------------------------------
  let cik: string | null = args.issuerCik != null && String(args.issuerCik).trim() ? padCik(args.issuerCik) : null;
  let acc = args.accession ? accDashed(String(args.accession).trim()) : null;
  if (!cik && args.issuerName) {
    const tickers = await companyTickers();
    const n = args.issuerName.trim().toLowerCase();
    const t = tickers.find((x) => x.title.toLowerCase() === n);
    if (t) cik = padCik(t.cik);
    else {
      const ents = await entitySearch(args.issuerName);
      if (ents.length) cik = padCik(ents[0]!.cik);
    }
    if (!cik) return { dataSource, error: `No EDGAR entity matched '${args.issuerName}'. Try query (search mode) instead.`, offerings: [] };
  }
  if (!cik && acc) {
    // Filer-agent accession prefixes are not the issuer CIK; ask FTS for it.
    const r = await ftsSearch({ q: `"${acc}"` }).catch(() => ({ hits: [] as any[], total: 0 }));
    const h = r.hits.find((x: any) => x.adsh === acc);
    cik = h?.ciks?.[0] ? padCik(h.ciks[0]) : padCik(acc.slice(0, 10));
  }
  if (!cik) {
    return { dataSource, error: "Provide accession, issuerCik, issuerName, or query (search mode).", offerings: [] };
  }

  const sub = await submissions(cik);
  const recent = sub.filings?.recent ?? {};
  const refs: Array<{ acc: string; date: string | null; doc: string | null; form: string }> = [];
  for (let i = 0; i < (recent.form ?? []).length; i++) {
    const f = String(recent.form![i]);
    if (f !== "D" && f !== "D/A") continue;
    refs.push({ acc: recent.accessionNumber![i], date: recent.filingDate?.[i] ?? null, doc: recent.primaryDocument?.[i] ?? null, form: f });
  }
  let targets = acc ? refs.filter((r) => r.acc === acc) : refs.slice(0, Math.max(1, Math.min(args.filingsPerIssuer ?? 1, 5)));
  if (acc && !targets.length) targets = [{ acc, date: null, doc: null, form: "D" }];
  if (!targets.length) {
    return { dataSource, mode: "issuer", issuer: { cik, name: sub.name ?? null }, error: "This CIK has no Form D / D/A filings in its recent submissions.", offerings: [] };
  }
  const offerings = await mapPool(targets, 3, async (t) => {
    try {
      const { url, doc } = await fetchFormD(cik!, t.acc, t.doc);
      if (!doc) return { accession: t.acc, error: "Form D XML not parseable", url };
      return compact(doc, { accession: t.acc, filingDate: t.date, url });
    } catch (e) {
      return { accession: t.acc, error: errMsg(e) };
    }
  });
  return {
    dataSource,
    mode: acc ? "accession" : "issuer",
    issuer: { cik, name: sub.name ?? null },
    totalFormDFilings: refs.length,
    offerings,
    note:
      "Related persons are as listed on the filing (executive officers, directors, promoters; for funds usually the GP / managing member and its principals). Amounts in USD; 'Indefinite' offering amounts are common for open-ended funds. filingsPerIssuer (max 5) returns older D/A amendments too — compare totalAmountSold across them to see the raise progressing.",
  };
}
