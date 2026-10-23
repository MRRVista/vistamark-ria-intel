/**
 * Form ADV Part 2A/2B brochures via IAPD (adviserinfo.sec.gov).
 *
 * Verified live 2026-10-21:
 *   GET https://api.adviserinfo.sec.gov/search/firm/<crd>
 *     → { hits: { hits: [ { _source: { iacontent: "<JSON string>" } } ] } }
 *     iacontent.basicInformation  (firmName, otherNames, iaScope, advFilingDate, SEC#, crs)
 *     iacontent.iaFirmAddressDetails.officeAddress
 *     iacontent.registrationStatus / noticeFilings (state notice filings)
 *     iacontent.brochures = { part2ExemptFlag, brochuredetails: [ { brochureVersionID, brochureName, dateSubmitted } ] }
 *   GET https://api.adviserinfo.sec.gov/search/firm?query=<name>&nrows=N  → name search
 *   PDF: https://files.adviserinfo.sec.gov/IAPD/Content/Common/crd_iapd_Brochure.aspx?BRCHR_VRSN_ID=<id>
 *
 * The IAPD JSON carries NO AUM / employee / client figures — those come from
 * the Form ADV Part 1 bulk feed, which this repo already ingests into the
 * `firms` table. When DATABASE_URL is set we attach that row (best-effort).
 *
 * Text extraction: NOT done. Brochure PDFs use compressed streams with
 * Type0/CIDFontType2 fonts (verified on a live brochure), which need a real
 * PDF parser + ToUnicode CMap decoding to extract text correctly; there is no
 * PDF dependency in this repo, and a regex-on-streams hack would return
 * garbage for most filers. We return URLs only and say so.
 */
import { sql } from "drizzle-orm";
import { jsonFetch } from "../data/http";
import { db, isDbReady } from "../db";

const API = "https://api.adviserinfo.sec.gov/search/firm";
const PDF = "https://files.adviserinfo.sec.gov/IAPD/Content/Common/crd_iapd_Brochure.aspx?BRCHR_VRSN_ID=";

function parseMaybeJson(v: any): any {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function usDateToIso(s: any): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s ?? "").trim());
  if (!m) return s ? String(s) : null;
  return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
}

async function localFirmRow(crd: number) {
  if (!isDbReady()) return null;
  try {
    const r: any = await db.execute(sql`
      SELECT legal_name, total_aum, discretionary_aum, total_accounts, total_employees,
             registered_iar_count, main_office_city, main_office_state, website
      FROM firms WHERE crd_number = ${crd} LIMIT 1`);
    const row = (r?.rows ?? r)?.[0];
    if (!row) return null;
    return {
      totalAum: row.total_aum != null ? Number(row.total_aum) : null,
      discretionaryAum: row.discretionary_aum != null ? Number(row.discretionary_aum) : null,
      totalAccounts: row.total_accounts ?? null,
      totalEmployees: row.total_employees ?? null,
      registeredIars: row.registered_iar_count ?? null,
      website: row.website ?? null,
      source: "Form ADV Part 1 bulk feed (local firms table)",
    };
  } catch {
    return null;
  }
}

export interface AdvBrochuresArgs {
  crd?: number | string;
  firmName?: string;
  extractText?: boolean;
}

export async function advBrochures(args: AdvBrochuresArgs) {
  const dataSource = "SEC IAPD (api.adviserinfo.sec.gov + files.adviserinfo.sec.gov, live)";
  let crd = args.crd != null && String(args.crd).trim() ? Number(String(args.crd).replace(/\D/g, "")) : null;
  let nameMatches: any[] | undefined;

  if (!crd && args.firmName) {
    const raw = await jsonFetch<any>(`${API}?query=${encodeURIComponent(args.firmName)}&nrows=6&start=0&wt=json`, { timeoutMs: 15000 });
    const hits: any[] = raw?.hits?.hits ?? [];
    nameMatches = hits.map((h) => {
      const s = h?._source ?? {};
      const addr = parseMaybeJson(s.firm_ia_address_details)?.officeAddress ?? {};
      return {
        crd: Number(s.firm_source_id),
        name: s.firm_name,
        scope: s.firm_ia_scope,
        city: addr.city ?? null,
        state: addr.state ?? null,
        branches: s.firm_branches_count ?? null,
      };
    });
    const active = nameMatches.find((m) => m.scope === "ACTIVE") ?? nameMatches[0];
    if (!active) return { dataSource, error: `No IAPD firm matched '${args.firmName}'.`, brochures: [] };
    crd = active.crd;
  }
  if (!crd || !Number.isFinite(crd)) return { dataSource, error: "Provide crd (firm CRD number) or firmName.", brochures: [] };

  const raw = await jsonFetch<any>(`${API}/${crd}`, { timeoutMs: 15000 });
  const src = raw?.hits?.hits?.[0]?._source;
  const content = parseMaybeJson(src?.iacontent ?? src?.content);
  if (!content || typeof content !== "object") {
    return { dataSource, crd, error: "IAPD returned no firm record for this CRD.", ...(src ? { sampleRaw: JSON.stringify(src).slice(0, 500) } : {}), brochures: [] };
  }
  const bi = parseMaybeJson(content.basicInformation) ?? {};
  const office = parseMaybeJson(content.iaFirmAddressDetails)?.officeAddress ?? null;
  const br = parseMaybeJson(content.brochures) ?? {};
  const details: any[] = Array.isArray(br.brochuredetails) ? br.brochuredetails : [];
  const brochures = details
    .map((b) => ({
      brochureVersionId: b.brochureVersionID ?? null,
      name: b.brochureName ?? null,
      dateSubmitted: usDateToIso(b.dateSubmitted),
      url: b.brochureVersionID != null ? `${PDF}${b.brochureVersionID}` : null,
    }))
    .sort((a, b) => String(b.dateSubmitted).localeCompare(String(a.dateSubmitted)));

  const reg = parseMaybeJson(content.registrationStatus);
  const notice = parseMaybeJson(content.noticeFilings);
  const flags = parseMaybeJson(content.orgScopeStatusFlags) ?? {};
  const crsFile = bi?.crs?.fileId;

  const local = await localFirmRow(crd);

  return {
    dataSource,
    crd,
    ...(nameMatches && nameMatches.length > 1 ? { otherNameMatches: nameMatches.filter((m) => m.crd !== crd).slice(0, 5) } : {}),
    firm: {
      name: bi.firmName ?? null,
      otherNames: bi.otherNames ?? [],
      scope: bi.iaScope ?? null,
      secNumber: bi.iaSECNumber ? `${bi.iaSECNumberType ?? "801"}-${bi.iaSECNumber}` : null,
      latestAdvFilingDate: usDateToIso(bi.advFilingDate),
      office,
      secRegistered: flags.isSECRegistered === "Y",
      stateRegistered: flags.isStateRegistered === "Y",
      exemptReportingAdviser: flags.isERARegistered === "Y" || flags.isSECERARegistered === "Y" || flags.isStateERARegistered === "Y",
      registrationStatus: Array.isArray(reg) ? reg.slice(0, 6) : [],
      noticeFilingStates: Array.isArray(notice) ? notice.map((n: any) => n.jurisdiction).filter(Boolean) : [],
      formCrsFileId: crsFile ?? null,
      iapdUrl: `https://adviserinfo.sec.gov/firm/summary/${crd}`,
      adviserPdfUrl: `https://reports.adviserinfo.sec.gov/reports/ADV/${crd}/PDF/${crd}.pdf`,
    },
    adv1Stats: local,
    part2Exempt: br.part2ExemptFlag === "Y",
    brochureCount: brochures.length,
    brochures,
    ...(args.extractText
      ? {
          extractText: {
            done: false,
            reason:
              "Not supported: IAPD brochure PDFs use compressed Type0/CID-font streams that need a real PDF parser (none is bundled). Open the newest brochure URL instead, or pass it to a PDF-capable reader.",
            newestUrl: brochures[0]?.url ?? null,
          },
        }
      : {}),
    note:
      "Brochures are the firm's current Part 2A (firm brochure) and any Part 2A appendices / wrap-fee brochures as filed through IARD; Part 2B (supervised-person supplements) are usually NOT filed with the SEC and therefore won't appear unless combined into a '2A_B' document. " +
      "part2Exempt=true (common for large fund managers/ERAs) means no brochure is filed. IAPD's firm JSON has no AUM — adv1Stats comes from this app's Form ADV Part 1 ingest when available (null otherwise; use search_rias). " +
      "Text extraction is not available (no PDF parser); URLs open the PDF directly.",
  };
}
