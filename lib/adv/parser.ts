import { XMLParser } from "fast-xml-parser";
import type { FirmInsert } from "../db/schema";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: true,
  trimValues: true,
  isArray: (name) => ["Firm", "Custodian", "PrivateFund"].includes(name),
});

type RawAdv = any;

export function parseAdvXml(xml: string): FirmInsert[] {
  const doc = parser.parse(xml);
  const root = doc.IAPDFirmSECReport ?? doc.IAPDFirmStateReport ?? doc;
  const firms = root?.Firms?.Firm ?? [];
  return firms.map(normalizeFirm).filter((f: FirmInsert | null): f is FirmInsert => f != null);
}

function normalizeFirm(raw: RawAdv): FirmInsert | null {
  const info = raw.Info ?? raw["@_Info"] ?? {};
  const crd = num(info["@_FirmCrdNb"] ?? info.FirmCrdNb ?? raw["@_FirmCrdNb"]);
  if (!crd) return null;
  const addr = raw.MainAddr ?? {};
  const rgstn = raw.Rgstn ?? {};
  const p1a = raw.FormInfo?.Part1A ?? {};
  const item1 = p1a.Item1 ?? {};
  const item5 = p1a.Item5 ?? {};
  const item9 = p1a.Item9 ?? {};
  const item11 = p1a.Item11 ?? {};
  const item5f = item5.Item5F ?? {};
  const regAum = num(item5f["@_Q5F2c"] ?? item5f.Q5F2c);
  const discAum = num(item5f["@_Q5F2a"] ?? item5f.Q5F2a);
  const nonDiscAum = num(item5f["@_Q5F2b"] ?? item5f.Q5F2b);
  const discAccts = num(item5f["@_Q5F2d"] ?? item5f.Q5F2d);
  const nonDiscAccts = num(item5f["@_Q5F2e"] ?? item5f.Q5F2e);
  const totalAccts = num(item5f["@_Q5F2f"] ?? item5f.Q5F2f);
  const item5d = item5.Item5D ?? {};
  const clientPct = (key: string) => num(item5d[`@_${key}`] ?? item5d[key]);
  const item5e = item5.Item5E ?? {};
  const bool5e = (key: string) => yn(item5e[`@_${key}`] ?? item5e[key]);
  const item5g = item5.Item5G ?? {};
  const bool5g = (key: string) => yn(item5g[`@_${key}`] ?? item5g[key]);
  const custAum = num(item9["@_Q9A2a"] ?? item9.Q9A2a);
  const custAccts = num(item9["@_Q9A2b"] ?? item9.Q9A2b);
  const hasCustody = yn(item9["@_Q9A"] ?? item9.Q9A) ?? (custAum != null && custAum > 0);
  const hasDrp = yn(item11["@_Q11"] ?? item11.Q11);
  const item5a = item5.Item5A ?? {};
  const item5b = item5.Item5B ?? {};
  const totalEmployees = num(item5a["@_TotalEmp"] ?? item5a.TotalEmp);
  const iarCount = num(item5b["@_Q5B1"] ?? item5b.Q5B1);

  return {
    crdNumber: crd,
    secNumber: str(info["@_SECNb"] ?? info.SECNb),
    legalName: str(info["@_LegalNm"] ?? info.LegalNm ?? info["@_BusNm"] ?? info.BusNm) ?? `Firm ${crd}`,
    primaryBusinessName: str(info["@_BusNm"] ?? info.BusNm),
    mainOfficeStreet: str(addr["@_Strt1"] ?? addr.Strt1),
    mainOfficeCity: str(addr["@_City"] ?? addr.City),
    mainOfficeState: str(addr["@_State"] ?? addr.State),
    mainOfficeZip: str(addr["@_PostlCd"] ?? addr.PostlCd),
    mainOfficeCountry: str(addr["@_Cntry"] ?? addr.Cntry),
    website: str(item1["@_WebAddr"] ?? item1.WebAddr),
    mainPhone: str(addr["@_Phone"] ?? addr.Phone),
    email: str(item1["@_EmailAddr"] ?? item1.EmailAddr),
    totalAum: regAum,
    discretionaryAum: discAum,
    nonDiscretionaryAum: nonDiscAum,
    totalAccounts: totalAccts,
    discretionaryAccounts: discAccts,
    nonDiscretionaryAccounts: nonDiscAccts,
    totalEmployees,
    registeredIarCount: iarCount,
    registrationStatus: registrationStatus(rgstn),
    secRegistrationDate: parseDate(rgstn["@_FirmDt"] ?? rgstn.FirmDt),
    isLargeAdviser: regAum != null && regAum >= 100_000_000,
    pctIndividualNonHnw: pct(clientPct("Q5D1a")),
    pctIndividualHnw: pct(clientPct("Q5D1b")),
    pctPensionPlans: pct(clientPct("Q5D1d")),
    pctCharitableOrgs: pct(clientPct("Q5D1f")),
    pctCorporations: pct(clientPct("Q5D1k")),
    pctOtherInstitutional: pct(clientPct("Q5D1l")),
    pctPooledInvestment: pct(clientPct("Q5D1c")),
    pctGovernmentEntities: pct(clientPct("Q5D1j")),
    pctOther: pct(clientPct("Q5D1m")),
    compAumPct: bool5e("Q5E1") ?? false,
    compHourly: bool5e("Q5E2") ?? false,
    compFixedFee: bool5e("Q5E3") ?? false,
    compCommission: bool5e("Q5E4") ?? false,
    compPerformance: bool5e("Q5E5") ?? false,
    compSubscription: bool5e("Q5E6") ?? false,
    compOther: bool5e("Q5E7") ?? false,
    svcFinancialPlanning: bool5g("Q5G1") ?? false,
    svcPortfolioManagementIndiv: bool5g("Q5G2") ?? false,
    svcPortfolioManagementInst: bool5g("Q5G3") ?? false,
    svcPortfolioManagementInvCo: bool5g("Q5G4") ?? false,
    svcPortfolioManagementPooled: bool5g("Q5G5") ?? false,
    svcPensionConsulting: bool5g("Q5G6") ?? false,
    svcAdvisorSelection: bool5g("Q5G7") ?? false,
    svcPublicationSubscription: bool5g("Q5G8") ?? false,
    svcSecurityRatings: bool5g("Q5G9") ?? false,
    svcMarketTiming: bool5g("Q5G10") ?? false,
    svcEducationalSeminars: bool5g("Q5G11") ?? false,
    hasCustody: hasCustody ?? false,
    custodyAum: custAum,
    custodyAccounts: custAccts,
    hasDisclosures: hasDrp ?? false,
    disclosureCount: 0,
    lastFilingDate: parseDate(raw["@_FilingDate"] ?? raw.FilingDate ?? info["@_FilingDate"]),
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
function registrationStatus(rgstn: any): "sec_registered" | "state_registered" | "exempt_reporting" | "terminated" | "pending" | "unknown" {
  const type = String(rgstn?.["@_FirmType"] ?? rgstn?.FirmType ?? "").toUpperCase();
  if (type.includes("EXEMPT")) return "exempt_reporting";
  if (type.includes("STATE")) return "state_registered";
  if (type.includes("SEC")) return "sec_registered";
  const status = String(rgstn?.["@_St"] ?? rgstn?.St ?? "").toUpperCase();
  if (status === "TERMINATED") return "terminated";
  if (status === "PENDING") return "pending";
  if (status === "APPROVED" || status === "ACTIVE") return "sec_registered";
  return "unknown";
}
