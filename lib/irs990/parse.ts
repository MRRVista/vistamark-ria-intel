/**
 * IRS Form 990 e-file XML → normalized filing + people records.
 *
 * One function, `parseReturnXml`, takes the raw XML of a single TEOS return
 * (`<objectId>_public.xml`) and returns the header/financial summary plus
 * every officer / director / trustee / key employee listed on it.
 *
 * FORM COVERAGE
 *   990     Part VII Section A   IRS990/Form990PartVIISectionAGrp
 *   990-EZ  Part IV              IRS990EZ/OfficerDirectorTrusteeEmplGrp
 *   990-PF  Part VII             IRS990PF/OfficerDirTrstKeyEmplInfoGrp/OfficerDirTrstKeyEmplGrp
 *   990-T   (no people table)    → returned as { skip: "990T" }
 *
 * SCHEMA DRIFT
 *   TEOS files carry returnVersion="YYYYvN.N". Element names have been stable
 *   since the 2013 "camel-case" schema refresh; everything the loader cares
 *   about is looked up by a short list of candidate tag names so a renamed
 *   field degrades to NULL rather than aborting the file. Pre-2013 schemas
 *   (not in the 2021+ index years we load) are NOT handled.
 *
 * MEMORY
 *   fast-xml-parser builds the whole document; a return is 10–300 KB, so
 *   this is fine. Streaming is handled one level up (one zip entry at a time).
 */

import { XMLParser } from "fast-xml-parser";

export type ReturnType = "990" | "990EZ" | "990PF";

export interface ParsedPerson {
  seq: number;
  nameRaw: string;
  nameNorm: string;
  surname: string | null;
  isBusiness: boolean;
  title: string | null;
  avgHours: number | null;
  avgHoursRelated: number | null;
  isIndividualTrustee: boolean;
  isInstitutionalTrustee: boolean;
  isOfficer: boolean;
  isKeyEmployee: boolean;
  isHighestComp: boolean;
  isFormer: boolean;
  compOrg: number | null;
  compRelated: number | null;
  compOther: number | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

export interface ParsedFiling {
  ein: string;
  returnType: ReturnType;
  taxYear: number | null;
  taxPeriodBegin: string | null;
  taxPeriodEnd: string | null;
  returnTs: string | null;
  amendedReturn: boolean;
  finalReturn: boolean;
  returnVersion: string | null;
  orgName: string;
  orgName2: string | null;
  inCareOf: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  website: string | null;
  phone: string | null;
  formationYear: number | null;
  mission: string | null;
  grossReceipts: number | null;
  totalRevenue: number | null;
  totalExpenses: number | null;
  totalAssetsEoy: number | null;
  totalLiabilitiesEoy: number | null;
  netAssetsEoy: number | null;
  contributions: number | null;
  investmentIncome: number | null;
  investmentsPublic: number | null;
  investmentsOther: number | null;
  investmentsProgram: number | null;
  endowmentEoy: number | null;
  investMgmtFees: number | null;
  votingMembers: number | null;
  independentMembers: number | null;
  employees: number | null;
  volunteers: number | null;
  signerName: string | null;
  signerTitle: string | null;
  persons: ParsedPerson[];
}

export type ParseResult =
  | { ok: true; filing: ParsedFiling }
  | { ok: false; skip: string };

// Repeating groups must always come back as arrays, even with one member.
const ARRAY_TAGS = new Set([
  "Form990PartVIISectionAGrp",
  "OfficerDirectorTrusteeEmplGrp",
  "OfficerDirTrstKeyEmplGrp",
  "CompensationOfHghstPdEmplOrGrp",
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false, // keep "0012.50" and EINs as strings; we coerce ourselves
  trimValues: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function text(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.length ? v : null;
  if (typeof v === "number") return String(v);
  if (typeof v === "object" && "#text" in (v as any)) return text((v as any)["#text"]);
  return null;
}

function first(obj: any, ...names: string[]): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  for (const n of names) if (obj[n] != null) return obj[n];
  return undefined;
}

function str(obj: any, ...names: string[]): string | null {
  return text(first(obj, ...names));
}

function int(obj: any, ...names: string[]): number | null {
  const s = str(obj, ...names);
  if (s == null) return null;
  const n = Number(String(s).replace(/[,$\s]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function num(obj: any, ...names: string[]): number | null {
  const s = str(obj, ...names);
  if (s == null) return null;
  const n = Number(String(s).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function flag(obj: any, ...names: string[]): boolean {
  const v = first(obj, ...names);
  if (v == null) return false;
  const s = text(v);
  if (s == null) return typeof v === "object"; // bare empty element → present
  return /^(x|true|1)$/i.test(s);
}

function clip(s: string | null, n: number): string | null {
  if (s == null) return null;
  return s.length > n ? s.slice(0, n) : s;
}

function bizName(obj: any): string | null {
  // <BusinessName><BusinessNameLine1Txt>..</BusinessNameLine1Txt><BusinessNameLine2Txt>..
  if (!obj || typeof obj !== "object") return text(obj);
  const l1 = str(obj, "BusinessNameLine1Txt", "BusinessNameLine1");
  const l2 = str(obj, "BusinessNameLine2Txt", "BusinessNameLine2");
  return [l1, l2].filter(Boolean).join(" ") || null;
}

interface Addr {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
}

function address(obj: any): Addr {
  const us = first(obj, "USAddress");
  const fo = first(obj, "ForeignAddress");
  const a: any = us ?? fo ?? null;
  if (!a) return { line1: null, line2: null, city: null, state: null, zip: null, country: null };
  return {
    line1: str(a, "AddressLine1Txt", "AddressLine1"),
    line2: str(a, "AddressLine2Txt", "AddressLine2"),
    city: str(a, "CityNm", "City"),
    state: us ? str(a, "StateAbbreviationCd", "State") : str(a, "ProvinceOrStateNm"),
    zip: us ? normalizeZip(str(a, "ZIPCd", "ZIPCode")) : str(a, "ForeignPostalCd", "PostalCode"),
    country: us ? "US" : str(a, "CountryCd", "Country"),
  };
}

function normalizeZip(z: string | null): string | null {
  if (!z) return null;
  const d = z.replace(/\D/g, "");
  if (d.length >= 9 && !/0000$/.test(d.slice(5, 9))) return `${d.slice(0, 5)}-${d.slice(5, 9)}`;
  return d.slice(0, 5) || null;
}

// Name normalization for matching. Deliberately crude and deterministic:
// uppercase, strip punctuation, drop honorifics and generational suffixes,
// collapse whitespace. "Dr. Robert J. Smith, Jr." → "ROBERT J SMITH".
const HONORIFICS = new Set([
  "MR", "MRS", "MS", "MISS", "DR", "REV", "FR", "SR", "HON", "RABBI", "PASTOR",
  "SISTER", "BROTHER", "BISHOP", "MSGR", "DEACON", "PROF", "CAPT", "COL", "GEN", "LT",
]);
const SUFFIXES = new Set([
  "JR", "SR", "II", "III", "IV", "V", "ESQ", "MD", "PHD", "CPA", "CFA", "JD", "DDS",
  "DO", "RN", "MBA", "CFP", "DVM", "PE", "PC", "LLC", "INC", "LTD",
]);

export function normalizeName(raw: string): { norm: string; surname: string | null } {
  const upper = raw
    .toUpperCase()
    .replace(/[.,'"()]/g, " ")
    .replace(/[^A-Z0-9&\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let tokens = upper.split(" ").filter(Boolean);
  while (tokens.length > 1 && HONORIFICS.has(tokens[0]!)) tokens.shift();
  while (tokens.length > 1 && SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();
  const norm = tokens.join(" ");
  const surname = tokens.length >= 2 ? clip(tokens[tokens.length - 1]!, 64) : null;
  return { norm, surname };
}

const BUSINESS_HINT = /\b(LLC|INC|CORP|CORPORATION|COMPANY|CO|BANK|TRUST|TRUSTEE|N\.?A\.?|LLP|LP|FOUNDATION|ASSOCIATION|ASSN|UNIVERSITY|CHURCH|DIOCESE|SOCIETY|FUND|PARTNERS|GROUP|SERVICES|MANAGEMENT|ADVISORS|CAPITAL)\b/i;

// ---------------------------------------------------------------------------
// people tables
// ---------------------------------------------------------------------------

function personName(g: any): { name: string | null; isBusiness: boolean } {
  const pn = str(g, "PersonNm", "PersonName");
  if (pn) return { name: pn, isBusiness: false };
  const bn = bizName(first(g, "BusinessName", "BusinessNameLine1Txt"));
  if (bn) return { name: bn, isBusiness: true };
  return { name: null, isBusiness: false };
}

function basePerson(seq: number, name: string, isBusiness: boolean): ParsedPerson {
  const { norm, surname } = normalizeName(name);
  return {
    seq,
    nameRaw: clip(name, 200)!,
    nameNorm: clip(norm, 200)!,
    surname: isBusiness ? null : surname,
    isBusiness: isBusiness || BUSINESS_HINT.test(name) && norm.split(" ").length > 2,
    title: null,
    avgHours: null,
    avgHoursRelated: null,
    isIndividualTrustee: false,
    isInstitutionalTrustee: false,
    isOfficer: false,
    isKeyEmployee: false,
    isHighestComp: false,
    isFormer: false,
    compOrg: null,
    compRelated: null,
    compOther: null,
    addressLine1: null,
    city: null,
    state: null,
    zip: null,
  };
}

function persons990(f990: any): ParsedPerson[] {
  const groups: any[] = (f990?.Form990PartVIISectionAGrp as any[]) ?? [];
  const out: ParsedPerson[] = [];
  groups.forEach((g, i) => {
    const { name, isBusiness } = personName(g);
    if (!name) return;
    const p = basePerson(i + 1, name, isBusiness);
    p.title = clip(str(g, "TitleTxt", "Title"), 200);
    p.avgHours = num(g, "AverageHoursPerWeekRt", "AverageHoursPerWeek");
    p.avgHoursRelated = num(g, "AverageHoursPerWeekRltdOrgRt", "AverageHoursPerWeekRelated");
    p.isIndividualTrustee = flag(g, "IndividualTrusteeOrDirectorInd", "IndividualTrusteeOrDirector");
    p.isInstitutionalTrustee = flag(g, "InstitutionalTrusteeInd", "InstitutionalTrustee");
    p.isOfficer = flag(g, "OfficerInd", "Officer");
    p.isKeyEmployee = flag(g, "KeyEmployeeInd", "KeyEmployee");
    p.isHighestComp = flag(g, "HighestCompensatedEmployeeInd", "HighestCompensatedEmployee");
    p.isFormer = flag(g, "FormerOfcrDirectorTrusteeInd", "Former");
    p.compOrg = int(g, "ReportableCompFromOrgAmt", "ReportableCompFromOrganization");
    p.compRelated = int(g, "ReportableCompFromRltdOrgAmt", "ReportableCompFromRelatedOrgs");
    p.compOther = int(g, "OtherCompensationAmt", "OtherCompensation");
    if (p.isInstitutionalTrustee) p.isBusiness = true;
    out.push(p);
  });
  return out;
}

function personsEZ(fez: any): ParsedPerson[] {
  const groups: any[] = (fez?.OfficerDirectorTrusteeEmplGrp as any[]) ?? [];
  const out: ParsedPerson[] = [];
  groups.forEach((g, i) => {
    const { name, isBusiness } = personName(g);
    if (!name) return;
    const p = basePerson(i + 1, name, isBusiness);
    p.title = clip(str(g, "TitleTxt", "Title"), 200);
    p.avgHours = num(g, "AverageHrsPerWkDevotedToPosRt", "AvgHoursPerWkDevotedToPosition");
    p.compOrg = int(g, "CompensationAmt", "Compensation");
    const benefits = int(g, "EmployeeBenefitProgramAmt", "ContriToEmplBenefitPlansEtc") ?? 0;
    const expense = int(g, "ExpenseAccountOtherAllwncAmt", "ExpenseAccountOtherAllowances") ?? 0;
    p.compOther = benefits + expense || null;
    // 990-EZ Part IV does not carry role checkboxes; infer the officer flag
    // from the title so `is_officer` stays meaningful across forms.
    p.isOfficer = /\b(PRES|VP|VICE|SEC|TREAS|CEO|CFO|COO|EXEC|DIRECTOR OF|CHAIR)/i.test(p.title ?? "");
    p.isIndividualTrustee = /\b(DIRECTOR|TRUSTEE|BOARD|MEMBER|CHAIR)\b/i.test(p.title ?? "") && !p.isBusiness;
    out.push(p);
  });
  return out;
}

function personsPF(fpf: any): ParsedPerson[] {
  const info = first(fpf, "OfficerDirTrstKeyEmplInfoGrp") as any;
  const groups: any[] = (info?.OfficerDirTrstKeyEmplGrp as any[]) ?? (fpf?.OfficerDirTrstKeyEmplGrp as any[]) ?? [];
  const out: ParsedPerson[] = [];
  groups.forEach((g, i) => {
    const { name, isBusiness } = personName(g);
    if (!name) return;
    const p = basePerson(i + 1, name, isBusiness);
    p.title = clip(str(g, "TitleTxt", "Title"), 200);
    p.avgHours = num(g, "AverageHrsPerWkDevotedToPosRt", "AvgHoursPerWkDevotedToPosition");
    p.compOrg = int(g, "CompensationAmt", "Compensation");
    const benefits = int(g, "EmployeeBenefitProgramAmt", "ContriToEmplBenefitPlansEtc") ?? 0;
    const expense = int(g, "ExpenseAccountOtherAllwncAmt", "ExpenseAccountOtherAllowances") ?? 0;
    p.compOther = benefits + expense || null;
    const a = address(g);
    p.addressLine1 = clip(a.line1, 200);
    p.city = clip(a.city, 128);
    p.state = clip(a.state, 4);
    p.zip = clip(a.zip, 16);
    p.isOfficer = /\b(PRES|VP|VICE|SEC|TREAS|CEO|CFO|COO|EXEC|CHAIR)/i.test(p.title ?? "");
    p.isIndividualTrustee = /\b(DIRECTOR|TRUSTEE|BOARD|MEMBER|CHAIR)\b/i.test(p.title ?? "") && !p.isBusiness;
    out.push(p);
  });
  return out;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export function parseReturnXml(xml: string): ParseResult {
  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    return { ok: false, skip: `xml-parse: ${err instanceof Error ? err.message : String(err)}` };
  }
  const ret = doc?.Return;
  if (!ret) return { ok: false, skip: "no <Return> root" };
  const hdr = ret.ReturnHeader;
  const data = ret.ReturnData;
  if (!hdr || !data) return { ok: false, skip: "missing ReturnHeader/ReturnData" };

  const rawType = (str(hdr, "ReturnTypeCd", "ReturnType") ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (!["990", "990EZ", "990PF"].includes(rawType)) return { ok: false, skip: rawType || "unknown-type" };
  const returnType = rawType as ReturnType;

  const filer = hdr.Filer ?? {};
  const ein = (str(filer, "EIN") ?? "").replace(/\D/g, "").padStart(9, "0");
  if (ein.length !== 9 || ein === "000000000") return { ok: false, skip: "bad EIN" };

  const name1 = bizName(first(filer, "BusinessName", "Name"));
  if (!name1) return { ok: false, skip: "no filer name" };
  const addr = address(filer);

  const signer = hdr.BusinessOfficerGrp ?? hdr.Officer ?? {};
  const returnVersion = text(ret["@_returnVersion"]);

  const f990 = data.IRS990;
  const fez = data.IRS990EZ;
  const fpf = data.IRS990PF;
  const body: any = f990 ?? fez ?? fpf ?? {};

  let persons: ParsedPerson[] = [];
  const fin: Partial<ParsedFiling> = {};

  if (returnType === "990" && f990) {
    persons = persons990(f990);
    fin.grossReceipts = int(f990, "GrossReceiptsAmt");
    fin.totalRevenue = int(f990, "CYTotalRevenueAmt", "TotalRevenueCurrentYear");
    fin.totalExpenses = int(f990, "CYTotalExpensesAmt", "TotalExpensesCurrentYear");
    fin.totalAssetsEoy = int(f990, "TotalAssetsEOYAmt", "TotalAssetsEOY");
    fin.totalLiabilitiesEoy = int(f990, "TotalLiabilitiesEOYAmt", "TotalLiabilitiesEOY");
    fin.netAssetsEoy = int(f990, "NetAssetsOrFundBalancesEOYAmt", "NetAssetsOrFundBalancesEOY");
    fin.contributions = int(f990, "CYContributionsGrantsAmt", "ContributionsGrantsCurrentYear");
    fin.investmentIncome = int(f990, "CYInvestmentIncomeAmt", "InvestmentIncomeCurrentYear");
    fin.votingMembers = int(f990, "VotingMembersGoverningBodyCnt", "NbrVotingMembersGoverningBody");
    fin.independentMembers = int(f990, "VotingMembersIndependentCnt", "NbrIndependentVotingMembers");
    fin.employees = int(f990, "TotalEmployeeCnt", "TotalNbrEmployees");
    fin.volunteers = int(f990, "TotalVolunteersCnt", "TotalNbrVolunteers");
    // Balance sheet investments (Part X lines 11–13), Part IX 11f fees, Schedule D endowment
    fin.investmentsPublic = int(first(f990, "InvestmentsPubTradedSecGrp") as any, "EOYAmt");
    fin.investmentsOther = int(first(f990, "InvestmentsOtherSecuritiesGrp") as any, "EOYAmt");
    fin.investmentsProgram = int(first(f990, "InvestmentsProgramRelatedGrp") as any, "EOYAmt");
    fin.investMgmtFees = int(first(f990, "FeesForSrvcInvstMgmntFeesGrp", "FeesForServicesInvstMgmntFeesGrp") as any, "TotalAmt");
    const schedD = data.IRS990ScheduleD;
    fin.endowmentEoy = int(first(schedD, "CYEndwmtFundGrp") as any, "EndYearBalanceAmt");
    fin.mission = clip(str(f990, "ActivityOrMissionDesc", "MissionDesc", "ActivityOrMissionDescription"), 2000);
  } else if (returnType === "990EZ" && fez) {
    persons = personsEZ(fez);
    fin.grossReceipts = int(fez, "GrossReceiptsAmt");
    fin.totalRevenue = int(fez, "TotalRevenueAmt", "TotalRevenue");
    fin.totalExpenses = int(fez, "TotalExpensesAmt", "TotalExpenses");
    const assets = first(fez, "Form990TotalAssetsGrp") as any;
    fin.totalAssetsEoy = int(assets, "EOYAmt") ?? int(fez, "TotalAssetsEOYAmt");
    const liab = first(fez, "SumOfTotalLiabilitiesGrp") as any;
    fin.totalLiabilitiesEoy = int(liab, "EOYAmt");
    fin.netAssetsEoy = int(fez, "NetAssetsOrFundBalancesEOYAmt", "NetAssetsOrFundBalancesEOY");
    fin.contributions = int(fez, "ContributionsGiftsGrantsEtcAmt");
    fin.investmentIncome = int(fez, "InvestmentIncomeAmt");
    fin.mission = clip(str(fez, "PrimaryExemptPurposeTxt", "PrimaryExemptPurpose"), 2000);
  } else if (returnType === "990PF" && fpf) {
    persons = personsPF(fpf);
    const analysis = first(fpf, "AnalysisOfRevenueAndExpenses") as any;
    fin.totalRevenue = int(analysis, "TotalRevAndExpnssAmt", "TotalRevenueAndExpenses");
    fin.totalExpenses = int(analysis, "TotalExpensesRevAndExpnssAmt", "TotalExpensesRevAndExpnss");
    fin.contributions = int(analysis, "ContriRcvdRevAndExpnssAmt");
    fin.investmentIncome = int(analysis, "TotalRevAndExpnssAmt") == null ? null : (int(analysis, "DividendsRevAndExpnssAmt") ?? 0) + (int(analysis, "InterestOnSavRevAndExpnssAmt") ?? 0);
    const bs = first(fpf, "Form990PFBalanceSheetsGrp") as any;
    // PF balance sheet: stock + bonds + US/state obligations + other investments (EOY)
    const pfInv = ["CorporateStockEOYAmt", "CorporateBondsEOYAmt", "USGovernmentObligationsEOYAmt", "InvestmentsOtherEOYAmt"].map((t) => int(bs, t));
    fin.investmentsPublic = pfInv.some((v) => v != null) ? pfInv.reduce((a, v) => (a ?? 0) + (v ?? 0), 0 as number | null) : null;
    fin.totalAssetsEoy = int(bs, "TotalAssetsEOYAmt") ?? int(fpf, "TotalAssetsEOYAmt");
    fin.totalLiabilitiesEoy = int(bs, "TotalLiabilitiesEOYAmt");
    fin.netAssetsEoy = int(bs, "TotNetAstOrFundBalancesEOYAmt") ?? int(fpf, "TotNetAstOrFundBalancesEOYAmt");
    fin.grossReceipts = null;
  } else {
    return { ok: false, skip: `missing body for ${returnType}` };
  }

  const taxYr = int(hdr, "TaxYr", "TaxYear");

  const filing: ParsedFiling = {
    ein,
    returnType,
    taxYear: taxYr,
    taxPeriodBegin: str(hdr, "TaxPeriodBeginDt", "TaxPeriodBeginDate"),
    taxPeriodEnd: str(hdr, "TaxPeriodEndDt", "TaxPeriodEndDate"),
    returnTs: str(hdr, "ReturnTs", "Timestamp"),
    amendedReturn: flag(body, "AmendedReturnInd", "AmendedReturn"),
    finalReturn: flag(body, "FinalReturnInd", "FinalReturn", "TerminatedInd"),
    returnVersion: clip(returnVersion, 16),
    orgName: clip(name1, 400)!,
    orgName2: null,
    inCareOf: clip(str(filer, "InCareOfNm", "InCareOfName"), 200),
    addressLine1: clip(addr.line1, 200),
    addressLine2: clip(addr.line2, 200),
    city: clip(addr.city, 128),
    state: clip(addr.state, 4),
    zip: clip(addr.zip, 16),
    country: clip(addr.country, 4),
    website: clip(str(body, "WebsiteAddressTxt", "WebSite"), 300),
    phone: clip(str(filer, "PhoneNum", "Phone"), 24),
    formationYear: int(body, "FormationYr", "YearFormation"),
    mission: fin.mission ?? null,
    grossReceipts: fin.grossReceipts ?? null,
    totalRevenue: fin.totalRevenue ?? null,
    totalExpenses: fin.totalExpenses ?? null,
    totalAssetsEoy: fin.totalAssetsEoy ?? null,
    totalLiabilitiesEoy: fin.totalLiabilitiesEoy ?? null,
    netAssetsEoy: fin.netAssetsEoy ?? null,
    contributions: fin.contributions ?? null,
    investmentIncome: fin.investmentIncome ?? null,
    investmentsPublic: fin.investmentsPublic ?? null,
    investmentsOther: fin.investmentsOther ?? null,
    investmentsProgram: fin.investmentsProgram ?? null,
    endowmentEoy: fin.endowmentEoy ?? null,
    investMgmtFees: fin.investMgmtFees ?? null,
    votingMembers: fin.votingMembers ?? null,
    independentMembers: fin.independentMembers ?? null,
    employees: fin.employees ?? null,
    volunteers: fin.volunteers ?? null,
    signerName: clip(str(signer, "PersonNm", "Name"), 200),
    signerTitle: clip(str(signer, "PersonTitleTxt", "Title"), 200),
    persons,
  };
  return { ok: true, filing };
}
