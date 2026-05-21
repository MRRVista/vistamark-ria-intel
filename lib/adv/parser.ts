import { XMLParser } from "fast-xml-parser";
import type { FirmInsert } from "../db/schema";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: true,
  trimValues: true,
  isArray: (name) => ["Firm", "Custodian", "PrivateFund", "State"].includes(name),
});

type RawAdv = any;

export function parseAdvXml(xml: string): FirmInsert[] {
  const doc = parser.parse(xml);
  const root = doc.IAPDFirmSECReport ?? doc.IAPDFirmStateReport ?? doc;
  const firms = root?.Firms?.Firm ?? [];
  return firms.map(normalizeFirm).filter((f: FirmInsert | null): f is FirmInsert => f != null);
}

function normalizeFirm(raw: RawAdv): FirmInsert | null {
  const info = raw.Info ?? {};
  const crd = num(info["@_FirmCrdNb"]);
  if (!crd) return null;

  const addr = raw.MainAddr ?? {};
  const rgstn = raw.Rgstn ?? {};
  const filing = raw.Filing ?? {};
  const p1a = raw.FormInfo?.Part1A ?? {};

  // Item5* and Item9* are DIRECT children of Part1A — no Item5/Item9 wrapper.
  const item1 = p1a.Item1 ?? {};
  const item2a = p1a.Item2A ?? {};
  const item5a = p1a.Item5A ?? {};
  const item5b = p1a.Item5B ?? {};
  const item5d = p1a.Item5D ?? {};
  const item5e = p1a.Item5E ?? {};
  const item5f = p1a.Item5F ?? {};
  const item5g = p1a.Item5G ?? {};
  const item9a = p1a.Item9A ?? {};
  const item11 = p1a.Item11 ?? {};

  // Website (from Item1.WebAddrs.WebAddr — may be string or array)
  const webAddrs = item1.WebAddrs ?? {};
  const webRaw = webAddrs.WebAddr;
  const webAddr = Array.isArray(webRaw) ? webRaw[0] : webRaw;

  // Item5F — Regulatory AUM and account counts (uppercase letter codes).
  const discAum = num(item5f["@_Q5F2A"]);
  const nonDiscAum = num(item5f["@_Q5F2B"]);
  const regAum = num(item5f["@_Q5F2C"]);
  const discAccts = num(item5f["@_Q5F2D"]);
  const nonDiscAccts = num(item5f["@_Q5F2E"]);
  const totalAccts = num(item5f["@_Q5F2F"]);

  // Item5A — employees; Item5B — IAR count
  const totalEmployees = num(item5a["@_TtlEmp"]);
  const iarCount = num(item5b["@_Q5B1"]);

  // Item5D — client breakdown. Format Q5D{LETTER}{1=count, 3=assets}.
  //   A=Individuals (other than HNW), B=HNW individuals,
  //   C=Banking/thrift, D=Inv companies (RICs), E=BDCs,
  //   F=Pooled investment vehicles, G=Pension plans, H=Charitable orgs,
  //   I=State/municipal entities, J=Other investment advisers,
  //   K=Insurance cos, L=Sovereign wealth funds, M=Corporations, N=Other
  const clientAssets = (letter: string) => num(item5d[`@_Q5D${letter}3`]);
  const sumNullable = (...vals: (number | null)[]): number | null => {
    const ok = vals.filter((v): v is number => v != null);
    return ok.length === 0 ? null : ok.reduce((a, b) => a + b, 0);
  };
  const pctOf = (amt: number | null): string | null => {
    if (amt == null || regAum == null || regAum === 0) return null;
    return pct((amt / regAum) * 100);
  };

  // Item9A — custody flags
  const custodyOfCash = yn(item9a["@_Q9A1A"]);
  const custodyOfSecurities = yn(item9a["@_Q9A1B"]);
  const hasCustody = custodyOfCash === true || custodyOfSecurities === true;

  // Item11 — disclosure flag
  const hasDrp = yn(item11["@_Q11"]);

  // Registration status — use Q2A1 (federally registered) + Rgstn.@_St
  const q2a1 = yn(item2a["@_Q2A1"]);
  const status = registrationStatus(rgstn, q2a1);

  // Large adviser flag: $100M+ RAUM is the SEC threshold
  const isLargeAdv = regAum != null && regAum >= 100_000_000;

  return {
    crdNumber: crd,
    secNumber: str(info["@_SECNb"]),
    legalName: str(info["@_LegalNm"]) ?? str(info["@_BusNm"]) ?? `Firm ${crd}`,
    primaryBusinessName: str(info["@_BusNm"]),
    mainOfficeStreet: str(addr["@_Strt1"]),
    mainOfficeCity: str(addr["@_City"]),
    mainOfficeState: str(addr["@_State"]),
    mainOfficeZip: str(addr["@_PostlCd"]),
    mainOfficeCountry: str(addr["@_Cntry"]),
    website: str(webAddr),
    mainPhone: str(addr["@_PhNb"]),
    email: null,

    totalAum: regAum,
    discretionaryAum: discAum,
    nonDiscretionaryAum: nonDiscAum,
    totalAccounts: totalAccts,
    discretionaryAccounts: discAccts,
    nonDiscretionaryAccounts: nonDiscAccts,
    totalEmployees,
    registeredIarCount: iarCount,

    registrationStatus: status,
    secRegistrationDate: parseDate(rgstn["@_Dt"]),
    isLargeAdviser: isLargeAdv,

    pctIndividualNonHnw: pctOf(clientAssets("A")),
    pctIndividualHnw: pctOf(clientAssets("B")),
    pctPensionPlans: pctOf(clientAssets("G")),
    pctCharitableOrgs: pctOf(clientAssets("H")),
    pctCorporations: pctOf(clientAssets("M")),
    pctOtherInstitutional: pctOf(sumNullable(clientAssets("C"), clientAssets("K"), clientAssets("L"))),
    pctPooledInvestment: pctOf(sumNullable(clientAssets("D"), clientAssets("E"), clientAssets("F"))),
    pctGovernmentEntities: pctOf(clientAssets("I")),
    pctOther: pctOf(sumNullable(clientAssets("J"), clientAssets("N"))),

    compAumPct: yn(item5e["@_Q5E1"]) ?? false,
    compHourly: yn(item5e["@_Q5E2"]) ?? false,
    compFixedFee: yn(item5e["@_Q5E3"]) ?? false,
    compCommission: yn(item5e["@_Q5E4"]) ?? false,
    compPerformance: yn(item5e["@_Q5E5"]) ?? false,
    compSubscription: yn(item5e["@_Q5E6"]) ?? false,
    compOther: yn(item5e["@_Q5E7"]) ?? false,

    // Item5G — services offered. Mapped to actual Form ADV question numbers:
    //   Q5G1=Financial planning, Q5G2=PM for individuals, Q5G3=PM for inv cos,
    //   Q5G4=PM for pooled vehicles, Q5G5=PM for inst clients, Q5G6=Pension consulting,
    //   Q5G7=Adviser selection, Q5G8=Publications, Q5G9=Ratings,
    //   Q5G10=Market timing, Q5G11=Educational seminars (Q5G12=Other not stored)
    svcFinancialPlanning: yn(item5g["@_Q5G1"]) ?? false,
    svcPortfolioManagementIndiv: yn(item5g["@_Q5G2"]) ?? false,
    svcPortfolioManagementInvCo: yn(item5g["@_Q5G3"]) ?? false,
    svcPortfolioManagementPooled: yn(item5g["@_Q5G4"]) ?? false,
    svcPortfolioManagementInst: yn(item5g["@_Q5G5"]) ?? false,
    svcPensionConsulting: yn(item5g["@_Q5G6"]) ?? false,
    svcAdvisorSelection: yn(item5g["@_Q5G7"]) ?? false,
    svcPublicationSubscription: yn(item5g["@_Q5G8"]) ?? false,
    svcSecurityRatings: yn(item5g["@_Q5G9"]) ?? false,
    svcMarketTiming: yn(item5g["@_Q5G10"]) ?? false,
    svcEducationalSeminars: yn(item5g["@_Q5G11"]) ?? false,

    hasCustody,
    custodyAum: null,
    custodyAccounts: null,

    hasDisclosures: hasDrp ?? false,
    disclosureCount: 0,
    lastFilingDate: parseDate(filing["@_Dt"]),
    rawJson: JSON.stringify(raw),
  };
}

function str(v: any): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}
function num(v: any): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function pct(v: number | null): string | null {
  if (v == null) return null;
  const clamped = Math.max(0, Math.min(100, v));
  return clamped.toFixed(2);
}
function yn(v: any): boolean | null {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase();
  if (s === "Y" || s === "YES" || s === "TRUE" || s === "1") return true;
  if (s === "N" || s === "NO" || s === "FALSE" || s === "0") return false;
  return null;
}
function parseDate(v: any): string | null {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, mm, dd, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}
function registrationStatus(
  rgstn: any,
  q2a1: boolean | null
): "sec_registered" | "state_registered" | "exempt_reporting" | "terminated" | "pending" | "unknown" {
  const type = String(rgstn?.["@_FirmType"] ?? "").toUpperCase();
  if (type.includes("EXEMPT")) return "exempt_reporting";
  if (type.includes("STATE")) return "state_registered";
  if (type.includes("SEC")) return "sec_registered";

  const st = String(rgstn?.["@_St"] ?? "").toUpperCase();
  if (st === "TERMINATED") return "terminated";
  if (st === "PENDING") return "pending";

  // For "Registered" firms appearing in the SEC feed: use Q2A1 (Item2A — federally registered?)
  // and Rgstn status of APPROVED as the signal.
  if (st === "APPROVED" || st === "ACTIVE") {
    if (q2a1 === true) return "sec_registered";
    return "sec_registered"; // assume SEC if approved in SEC feed; state feed would override via FirmType
  }

  return "unknown";
}
