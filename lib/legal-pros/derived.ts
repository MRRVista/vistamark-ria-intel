/**
 * legal-pros / derived — attorney signals derived from data we already hold or
 * from a court index, plus the family's routing doctrine.
 *
 *   dol_sch_c_legal_counsel  — Postgres rollup of Form 5500 Schedule C providers with
 *                              service code 29 (Legal): ERISA / employee-benefits counsel
 *                              ranked by the plans and plan assets they advise.
 *   courtlistener_counsel    — CourtListener REST v4 RECAP docket search (type=r) by
 *                              practice-area preset, with counsel / firm / party tallies.
 *   legal_pros_playbook      — no network; which tool per practice area + guardrails.
 *
 * Schedule C: reuses the dol_sch_c_providers ⋈ plans (⋈ dol_sch_h_i) join shape from
 * lib/filings-people/schedule-c.ts. assetsJoin / missingTable / emptyResponse are
 * private there, so small copies live here; normalizeProviderName and
 * SCH_C_ROLE_CODES are imported.
 */
import { sql, type SQL } from "drizzle-orm";
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import { db, isDbReady } from "../db";
import { schHTableExists } from "../dol-5500/schedule-h";
import { SCH_C_ROLE_CODES, normalizeProviderName } from "../filings-people/schedule-c-parse";
import { cached, clampInt, HOUR, jsonWithBackoff, stripTags, trim } from "../web-intel/common";

// ---------------------------------------------------------------------------
// dol_sch_c_legal_counsel
// ---------------------------------------------------------------------------

const SCH_C_DS = "DOL Form 5500 Schedule C Part I Item 2, service code 29 = Legal (Postgres dol_sch_c_providers ⋈ plans ⋈ dol_sch_h_i)";
const LEGAL_CODES = SCH_C_ROLE_CODES["legal"] ?? ["29"];

function rowsOf(r: any): any[] {
  return (r?.rows ?? r) as any[];
}

/** Copy of schedule-c.ts assetsJoin: F_5500 lost TOT_ASSETS_EOY_AMT in 2024, so fall back to Schedule H/I. */
async function assetsJoin(): Promise<{ join: SQL; assets: SQL }> {
  if (await schHTableExists()) {
    return { join: sql`LEFT JOIN dol_sch_h_i shi ON shi.ack_id = p.ack_id`, assets: sql`COALESCE(pl.tot_assets_eoy_amt, shi.tot_assets_eoy_amt)` };
  }
  return { join: sql``, assets: sql`pl.tot_assets_eoy_amt` };
}

function missingTable(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /relation "?[\w.]+"? does not exist|42P01/i.test(m);
}

function emptyResponse(reason: string) {
  return {
    dataSource: SCH_C_DS,
    asOf: new Date().toISOString().slice(0, 10),
    returned: 0,
    rows: [],
    empty: true,
    note: `${reason} Run migrations (POST /api/admin/migrate) then POST /api/admin/refresh-dol-sch-c?year=YYYY with Bearer CRON_SECRET to load Schedule C; refresh-dol-5500 for the same year supplies sponsor names, and refresh-dol-sch-h supplies plan assets.`,
  };
}

function legalCodeCondition(): SQL {
  // service_codes is '29,50' — match code 29 as a whole token.
  const pattern = `(^|,)(${LEGAL_CODES.join("|")})(,|$)`;
  return sql`p.service_codes ~ ${pattern}`;
}

export interface SchCLegalCounselArgs {
  state?: string;
  city?: string;
  sponsorState?: string;
  filingYear?: number;
  minPlans?: number;
  nameContains?: string;
  providerEin?: string;
  sortBy?: "plans" | "comp" | "assets";
  limit?: number;
  offset?: number;
}

export async function dolSchCLegalCounsel(args: SchCLegalCounselArgs = {}) {
  if (!isDbReady()) return emptyResponse("DATABASE_URL not configured.");
  const anyState = typeof args.state === "string" && /^(any|all|\*)$/i.test(args.state.trim());
  const state = anyState ? null : (args.state?.trim() || "IL").toUpperCase();
  const nameNorm = args.nameContains ? normalizeProviderName(args.nameContains) ?? args.nameContains.toUpperCase() : null;
  const ein = args.providerEin ? args.providerEin.replace(/\D/g, "") : null;
  if (!state && !args.city && !args.sponsorState && !nameNorm && !ein) {
    return {
      dataSource: SCH_C_DS,
      error: "Unbounded query refused. Give a geography (state — default IL — or city / sponsorState) or a name (nameContains / providerEin).",
      rows: [],
    };
  }
  const limit = clampInt(args.limit, 25, 1, 100);
  const offset = Math.max(0, Number(args.offset ?? 0) || 0);
  const minPlans = Math.max(1, Number(args.minPlans ?? 1) || 1);
  const sortBy = args.sortBy === "comp" || args.sortBy === "assets" ? args.sortBy : "plans";

  try {
    const conds: SQL[] = [legalCodeCondition()];
    if (state) conds.push(sql`p.provider_state = ${state}`);
    if (args.city) conds.push(sql`p.provider_city ILIKE ${args.city.trim()}`);
    if (args.sponsorState) conds.push(sql`pl.spons_dfe_mail_state = ${args.sponsorState.trim().toUpperCase()}`);
    if (args.filingYear) conds.push(sql`p.filing_year = ${Number(args.filingYear)}`);
    if (nameNorm) conds.push(sql`p.provider_name_norm LIKE ${`%${nameNorm}%`}`);
    if (ein) conds.push(sql`p.provider_ein = ${ein}`);
    const where = sql.join(conds, sql` AND `);
    const shi = await assetsJoin();
    const join = sql`${args.sponsorState ? sql`JOIN plans pl ON pl.ack_id = p.ack_id` : sql`LEFT JOIN plans pl ON pl.ack_id = p.ack_id`} ${shi.join}`;

    // One row per (provider, plan filing) first so a firm listed twice on the same
    // Schedule C (e.g. direct + indirect lines) does not double-count plan assets.
    const perPlan = sql`
      SELECT COALESCE(p.provider_name_norm, '') AS norm, COALESCE(p.provider_ein, '') AS ein, p.ack_id,
             MAX(p.provider_name) AS provider_name,
             MAX(p.provider_city) AS provider_city, MAX(p.provider_state) AS provider_state,
             MAX(p.filing_year) AS filing_year,
             SUM(COALESCE(p.direct_comp,0) + COALESCE(p.indirect_comp,0))::bigint AS comp,
             MAX(${shi.assets})::bigint AS assets,
             MAX(COALESCE(pl.spons_dfe_name, pl.plan_name)) AS sponsor,
             MAX(pl.spons_dfe_mail_state) AS sponsor_state,
             MAX(pl.tot_active_partcp_cnt) AS participants
      FROM dol_sch_c_providers p ${join}
      WHERE ${where}
      GROUP BY 1, 2, 3`;

    const orderBy =
      sortBy === "comp"
        ? sql`total_comp DESC NULLS LAST, plans DESC`
        : sortBy === "assets"
          ? sql`total_plan_assets DESC NULLS LAST, plans DESC`
          : sql`plans DESC, total_plan_assets DESC NULLS LAST, total_comp DESC NULLS LAST`;

    const providers = rowsOf(
      await db.execute(sql`
        WITH per_plan AS (${perPlan})
        SELECT norm, ein,
               mode() WITHIN GROUP (ORDER BY provider_name) AS provider_name,
               mode() WITHIN GROUP (ORDER BY provider_city) AS provider_city,
               mode() WITHIN GROUP (ORDER BY provider_state) AS provider_state,
               COUNT(*)::int AS plans,
               COUNT(DISTINCT sponsor)::int AS sponsors,
               SUM(comp)::bigint AS total_comp,
               SUM(assets)::bigint AS total_plan_assets,
               COUNT(assets)::int AS plans_with_assets,
               MIN(filing_year) AS first_year, MAX(filing_year) AS last_year,
               COUNT(*) OVER ()::int AS total_providers
        FROM per_plan
        GROUP BY norm, ein
        HAVING COUNT(*) >= ${minPlans}
        ORDER BY ${orderBy}, provider_name
        LIMIT ${limit} OFFSET ${offset}`)
    );

    if (!providers.length) {
      const any = rowsOf(await db.execute(sql`SELECT COUNT(*)::int AS n FROM dol_sch_c_providers`))[0]?.n ?? 0;
      if (!any) return emptyResponse("dol_sch_c_providers is empty (ingest has not run).");
      return {
        dataSource: SCH_C_DS,
        asOf: new Date().toISOString().slice(0, 10),
        returned: 0,
        total: 0,
        rows: [],
        note: "No Schedule C rows with service code 29 (Legal) matched. state/city filter the LAW FIRM's address as the filer typed it; try sponsorState instead, drop minPlans, or shorten nameContains. sponsorState needs the plans table loaded for the same year (refresh-dol-5500).",
      };
    }

    // Top 3 sponsors (by plan assets, then comp) for each returned provider.
    const keys = providers.map((r) => sql`(${r.norm}, ${r.ein})`);
    const topSponsors = rowsOf(
      await db.execute(sql`
        WITH per_plan AS (${perPlan}),
        ranked AS (
          SELECT norm, ein, sponsor, sponsor_state, assets, comp, participants, filing_year,
                 ROW_NUMBER() OVER (PARTITION BY norm, ein ORDER BY assets DESC NULLS LAST, comp DESC NULLS LAST, filing_year DESC) AS rn
          FROM per_plan
          WHERE (norm, ein) IN (${sql.join(keys, sql`, `)}))
        SELECT * FROM ranked WHERE rn <= 3 ORDER BY norm, ein, rn`)
    );
    const sponsorsByKey = new Map<string, any[]>();
    for (const s of topSponsors) {
      const k = `${s.norm}|${s.ein}`;
      const arr = sponsorsByKey.get(k) ?? [];
      arr.push({
        sponsor: s.sponsor ?? null,
        state: s.sponsor_state ?? null,
        planAssetsEoy: s.assets != null ? Number(s.assets) : null,
        compUsd: s.comp != null ? Number(s.comp) : null,
        participants: s.participants ?? null,
        filingYear: s.filing_year,
      });
      sponsorsByKey.set(k, arr);
    }

    return {
      dataSource: SCH_C_DS,
      asOf: new Date().toISOString().slice(0, 10),
      filters: { state: state ?? "ANY", city: args.city ?? null, sponsorState: args.sponsorState ?? null, filingYear: args.filingYear ?? null, minPlans, nameContains: args.nameContains ?? null, sortBy },
      returned: providers.length,
      total: providers[0]?.total_providers ?? providers.length,
      rows: providers.map((r) => ({
        name: r.provider_name,
        ein: r.ein || null,
        city: r.provider_city ?? null,
        state: r.provider_state ?? null,
        practiceAreas: ["ERISA / employee benefits (Schedule C code 29 Legal)"],
        plans: r.plans,
        sponsors: r.sponsors,
        totalCompUsd: r.total_comp != null ? Number(r.total_comp) : null,
        totalPlanAssetsUsd: r.total_plan_assets != null ? Number(r.total_plan_assets) : null,
        plansWithAssets: r.plans_with_assets,
        years: r.first_year === r.last_year ? String(r.first_year) : `${r.first_year}-${r.last_year}`,
        topSponsors: sponsorsByKey.get(`${r.norm}|${r.ein}`) ?? [],
        source: "dol_sch_c_providers",
      })),
      note:
        "Law firms paid $5,000+ by a plan and coded 29 (Legal) on Schedule C — the best free signal of who actually does ERISA / employee-benefits work for Chicago-area plans. " +
        "Grouped by normalized name + EIN (filers type names freely, so one firm may appear under several spellings/EINs — merge by eye; pass providerEin once known). " +
        "state/city are the firm's address as the filer typed it (default IL); sponsorState filters by plan sponsor instead. " +
        "Plan assets are F_5500 totals falling back to Schedule H/I — null until that ingest runs (plansWithAssets shows coverage). Sponsor names are null for years without the plans table loaded. " +
        "Public filing records, not consent to contact: cite 'listed as legal provider on Form 5500 Schedule C (DOL FOIA file year N)'. For named attorneys and a contact page, look the firm up with acebc_fellow_search / leading_lawyers_search and verify individuals via ardc_lawyer_lookup.",
    };
  } catch (e) {
    if (missingTable(e)) return emptyResponse("Table dol_sch_c_providers (migration 0009) or plans (0002) does not exist yet.");
    throw e;
  }
}

// ---------------------------------------------------------------------------
// courtlistener_counsel
// ---------------------------------------------------------------------------

const CL_BASE = "https://www.courtlistener.com/api/rest/v4/search/";

/** Practice-area presets → RECAP query. Nature-of-suit 791 = Labor: E.R.I.S.A. (PACER civil cover sheet). */
const CL_PRESETS: Record<string, { q: string; natureOfSuit?: string; label: string; note: string }> = {
  erisa: {
    q: `suitNature:791 OR "ERISA"`,
    natureOfSuit: "791",
    label: "ERISA / employee benefits (NOS 791)",
    note: "Federal courts have exclusive or concurrent jurisdiction over most ERISA claims, so this preset is well covered.",
  },
  probate_trust: {
    q: `(trustee OR "breach of trust" OR "trust agreement" OR probate) AND (estate OR trust)`,
    label: "trusts & estates (federal diversity / fiduciary matters only)",
    note: "Probate and most trust litigation sits in Illinois circuit courts (e.g. Cook County Probate Division), which are NOT on CourtListener; federal hits are diversity or ERISA-adjacent fiduciary cases.",
  },
  family: {
    q: `(divorce OR "dissolution of marriage" OR "child custody" OR "marital settlement" OR "domestic relations")`,
    label: "family / matrimonial (federal is thin)",
    note: "Divorce, custody and support are state-court matters (Cook County Domestic Relations Division) and are NOT on CourtListener; federal hits are spill-over (QDRO, bankruptcy, interstate custody). Use aaml_il_fellow_search / collaborative_divorce_il_search for family lawyers.",
  },
};

function asList(v: unknown, max: number, each = 80): string[] {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : String(v).split(/\s*;\s*|\n/);
  return arr.map((x) => trim(x, each)).filter((x): x is string => !!x).slice(0, max);
}

export interface CourtlistenerCounselArgs {
  preset?: string;
  q?: string;
  court?: string;
  filedAfter?: string;
  filedBefore?: string;
  attorney?: string;
  party?: string;
  limit?: number;
}

export async function courtlistenerCounsel(args: CourtlistenerCounselArgs = {}) {
  const presetKey = args.preset ? String(args.preset).toLowerCase().trim() : "";
  const preset = presetKey && presetKey !== "custom" ? CL_PRESETS[presetKey] : undefined;
  if (presetKey && presetKey !== "custom" && !preset) {
    throw new Error(`courtlistener_counsel: unknown preset '${presetKey}'. Use erisa | probate_trust | family | custom (with q).`);
  }
  const free = (args.q ?? "").trim();
  const attorney = (args.attorney ?? "").trim();
  const party = (args.party ?? "").trim();
  if (!preset && !free && !attorney && !party) {
    throw new Error("courtlistener_counsel: give a `preset` (erisa | probate_trust | family) or a `q` / `attorney` / `party` filter.");
  }
  const q = [preset?.q ? `(${preset.q})` : null, free ? `(${free})` : null].filter(Boolean).join(" AND ");
  const court = (args.court ?? "ilnd").trim();
  const limit = clampInt(args.limit, 10, 1, 20);

  // Same GET parameters as the website's RECAP search form (docs: "copy the GET
  // parameters from the front end"). party_name / atty_name are the sidebar
  // filters the operators page says to use instead of party:/attorney: in q.
  const params = new URLSearchParams({ type: "r", order_by: "dateFiled desc" });
  if (q) params.set("q", q);
  if (court) params.set("court", court);
  if (args.filedAfter) params.set("filed_after", String(args.filedAfter));
  if (args.filedBefore) params.set("filed_before", String(args.filedBefore));
  if (attorney) params.set("atty_name", attorney);
  if (party) params.set("party_name", party);
  const url = `${CL_BASE}?${params.toString()}`;

  const token = process.env.COURTLISTENER_TOKEN?.trim();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = `Token ${token}`;

  const data = await cached(`clc:${token ? "k" : "a"}:${url}`, HOUR, () =>
    jsonWithBackoff<any>(url, {
      source: "CourtListener",
      headers,
      timeoutMs: 25_000,
      retryAfterMs: 2500,
      hint429: token
        ? "daily quota exhausted for this token"
        : "anonymous access is throttled per IP (125/day shared); set COURTLISTENER_TOKEN (free account at courtlistener.com) for 5,000 req/day",
    })
  );

  const raw: any[] = Array.isArray(data?.results) ? data.results : [];
  const attorneyTally = new Map<string, number>();
  const firmTally = new Map<string, number>();
  const bump = (m: Map<string, number>, names: string[]) => {
    for (const n of names) m.set(n, (m.get(n) ?? 0) + 1);
  };
  const dockets = raw.slice(0, limit).map((r) => {
    const attorneys = asList(r.attorney, 8);
    const firms = asList(r.firm, 6, 100);
    const parties = asList(r.party, 6);
    bump(attorneyTally, attorneys);
    bump(firmTally, firms);
    const docUrl = r.docket_absolute_url ?? r.absolute_url;
    return {
      caseName: trim(r.caseName, 140),
      court: r.court_id ?? r.court ?? null,
      dateFiled: r.dateFiled ?? null,
      dateTerminated: r.dateTerminated ?? null,
      docketNumber: r.docketNumber ?? null,
      suitNature: trim(r.suitNature, 60),
      cause: trim(r.cause, 80),
      assignedTo: trim(r.assignedTo, 60),
      parties,
      attorneys,
      firms,
      url: docUrl ? `https://www.courtlistener.com${docUrl}` : null,
      snippet: trim(stripTags(r.recap_documents?.[0]?.description ?? r.recap_documents?.[0]?.snippet ?? ""), 160),
    };
  });
  const top = (m: Map<string, number>, n: number) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, n)
      .map(([name, cases]) => ({ name, cases }));

  return {
    dataSource: `CourtListener REST v4 search, type=r (RECAP federal dockets)${preset ? ` — preset ${presetKey}: ${preset.label}` : ""}`,
    asOf: new Date().toISOString().slice(0, 10),
    authenticated: Boolean(token),
    query: { q: q || null, court, filedAfter: args.filedAfter ?? null, filedBefore: args.filedBefore ?? null, attorney: attorney || null, party: party || null },
    totalMatches: data?.count ?? null,
    returned: dockets.length,
    topAttorneys: top(attorneyTally, 10),
    topFirms: top(firmTally, 10),
    rows: dockets,
    note:
      [
        preset?.note,
        "Counsel/firm names come straight from the docket's PACER party/attorney block when RECAP has it — newly filed dockets usually carry only the case header, so attorneys/firms/suitNature are sparse on the newest page; set filedBefore (e.g. a year back) for fuller party blocks. " +
          "totalMatches is approximate (±6%) above 2,000. Court slugs: ilnd N.D. Ill. (default), ilcd, ilsd, ca7. " +
          "Public court records, not consent to contact; cite 'counsel of record in <case>, <court> (CourtListener/RECAP)'. Verify Illinois attorneys with ardc_lawyer_lookup before any outreach.",
      ]
        .filter(Boolean)
        .join(" "),
  };
}

// ---------------------------------------------------------------------------
// legal_pros_playbook
// ---------------------------------------------------------------------------

const PLAYBOOK = {
  purpose:
    "Find Chicago-area attorneys by practice area for Vistamark's referral-partner network (estate planners, matrimonial counsel who need an independent CIO for divorcing clients, ERISA counsel who sit beside plan sponsors) and for prospect intelligence (who advises a plan or an estate).",
  licensing: {
    note: "Illinois attorneys are NOT in IDFPR — idfpr_licensee_search returns no lawyers. They are licensed and disciplined by the ARDC (Attorney Registration & Disciplinary Commission of the Supreme Court of Illinois).",
    verification: "ardc_lawyer_lookup is a VERIFICATION layer, not a discovery tool: confirm status (Active/Authorized to practice), admission year, firm, city and any discipline for every name you plan to contact. Run it last.",
  },
  routing: [
    {
      practiceArea: "ERISA / employee benefits",
      discover: ["dol_sch_c_legal_counsel (Form 5500 Schedule C code 29 — firms actually paid by plans; rank by plans / plan assets; best free signal)", "acebc_fellow_search (American College of Employee Benefits Counsel fellows)", "leading_lawyers_search category 'Employee Benefits'", "courtlistener_counsel preset erisa (ERISA litigators in N.D. Ill.)"],
      verify: "ardc_lawyer_lookup",
      enrich: "dol_sch_c_plans_by_provider for a firm's full plan book; dol_plan_search for the sponsors.",
    },
    {
      practiceArea: "Trusts & estates / estate planning / elder",
      discover: ["actec_fellow_search (ACTEC fellows, state IL + city)", "leading_lawyers_search categories 'Trust, Will & Estate Planning', 'Tax: Individual', 'Elder'", "cepc_member_search / naela_il_search where a public listing exists"],
      verify: "ardc_lawyer_lookup",
      enrich: "courtlistener_counsel preset probate_trust is thin — probate is in Cook County circuit court, not on CourtListener.",
    },
    {
      practiceArea: "Family / matrimonial / collaborative divorce",
      discover: ["aaml_il_fellow_search (AAML Illinois fellows)", "collaborative_divorce_il_search (Collaborative Divorce Illinois professionals — includes financial neutrals)", "leading_lawyers_search categories 'Family', 'Adoption'"],
      verify: "ardc_lawyer_lookup",
      enrich: "courtlistener_counsel preset family is spill-over only — divorce/custody dockets live in state Domestic Relations divisions.",
    },
    {
      practiceArea: "Other / litigation / business",
      discover: ["courtlistener_counsel with a free q (party, subject) and court ilnd/ilcd/ilsd/ca7", "leading_lawyers_search with the matching category"],
      verify: "ardc_lawyer_lookup",
      enrich: "courtlistener_search (web-intel) for a specific party's docket history.",
    },
  ],
  dataNotes: [
    "Directories (ACTEC, AAML, ACEBC, Leading Lawyers, Collaborative Divorce IL) are peer / membership rosters — strong quality filters, but membership is not a license check.",
    "Schedule C providers appear only for plans paying them $5,000+ (mostly 100+ participant plans) and names are typed by the filer — merge spelling variants by eye, prefer EIN once known.",
    "CourtListener covers federal PACER dockets (RECAP) and published opinions. Illinois circuit courts (probate, domestic relations, chancery) are not indexed; the ARDC roster is also not on CourtListener.",
    "Anonymous CourtListener calls are throttled per IP (sandbox saw 429 '125/day'); set COURTLISTENER_TOKEN on Vercel for 5,000/day.",
  ],
  guardrails: [
    "Results are public directory / registry / court / filing records — never consent to contact and never a client relationship. Do not describe an attorney as 'working with' Vistamark; use 'listed in <directory>' / 'serves alongside' / 'counsel of record in' language.",
    "Professional / firm contact details only (firm phone, firm email, firm website, profile URL). No home addresses, personal emails or cell numbers, even when a registry exposes them.",
    "Cite the dataset and as-of date in anything that leaves the system (e.g. 'ACTEC fellow directory, retrieved 2026-10-24'; 'Form 5500 Schedule C, DOL FOIA file year 2024').",
    "Verify ARDC status before outreach; drop anyone not Active / Authorized or with a discipline flag unless the user explicitly asks to keep them.",
    "Outreach to attorneys is referral-partner marketing, not investment advice: no performance claims, no client names, Vistamark's compliance disclosures apply, and every send passes through the existing outreach guardrails (validated professional email, opt-out, one touch before a reply).",
    "Respect each directory's terms: cache 6-24 h, never bulk-dump a roster (every tool requires a geography or name filter), and do not republish directory content wholesale.",
  ],
};

export function legalProsPlaybook(args: { practiceArea?: string } = {}) {
  const pa = (args.practiceArea ?? "").toLowerCase().trim();
  const routing = pa
    ? PLAYBOOK.routing.filter((r) => {
        const key = r.practiceArea.toLowerCase();
        if (/erisa|benefit|401|pension|retirement/.test(pa)) return key.startsWith("erisa");
        if (/estate|trust|probate|elder|planning/.test(pa)) return key.startsWith("trusts");
        if (/family|divorce|matrimon|custod|collaborative/.test(pa)) return key.startsWith("family");
        return key.startsWith("other");
      })
    : PLAYBOOK.routing;
  return {
    dataSource: "legal-pros routing doctrine (static, no network)",
    asOf: "2026-10-24",
    purpose: PLAYBOOK.purpose,
    licensing: PLAYBOOK.licensing,
    routing,
    dataNotes: PLAYBOOK.dataNotes,
    guardrails: PLAYBOOK.guardrails,
    workflow: ["1. discover via the practice-area tools above", "2. de-duplicate across directories by name + firm", "3. ardc_lawyer_lookup each name", "4. hunter_email_finder / firm site for a professional email, zerobounce_validate", "5. log as referral-partner prospect; cite sources"],
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const DERIVED_TOOLS: ToolDef[] = [
  {
    name: "dol_sch_c_legal_counsel",
    description:
      "ERISA / employee-benefits law firms ranked by the retirement and welfare plans that pay them, from DOL Form 5500 Schedule C Part I Item 2 rows with service code 29 (Legal) in Postgres (dol_sch_c_providers joined to plans and Schedule H/I for sponsor names and plan assets). Groups by normalized provider name + EIN and returns per firm: name, EIN, city/state (firm address as filed), distinct plans, distinct sponsors, total compensation (USD), total plan assets, filing-year span and the top 3 sponsors by plan assets. Filters: state (firm state, default IL; 'ANY' to drop), city, sponsorState (plan sponsor's state), filingYear, minPlans, nameContains, providerEin, sortBy plans|comp|assets, limit ≤100, offset. Returns empty:true with an ingest hint until migration 0009 + refresh-dol-sch-c have run. Best free signal of who actually does ERISA work for Chicago-area plans; firms only, so follow with acebc_fellow_search / leading_lawyers_search for named attorneys and ardc_lawyer_lookup to verify. Public filing records, not consent to contact — cite 'Form 5500 Schedule C, DOL FOIA file year N'.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", default: "IL", description: "law firm's state as filed; 'ANY' for nationwide (then give nameContains or sponsorState)" },
        city: { type: "string", description: "law firm's city as filed, e.g. Chicago" },
        sponsorState: { type: "string", description: "plan sponsor's mailing state (needs plans table loaded)" },
        filingYear: { type: "number", description: "DOL FOIA file year, e.g. 2024" },
        minPlans: { type: "number", default: 1 },
        nameContains: { type: "string", description: "firm name fragment, e.g. 'Seyfarth'" },
        providerEin: { type: "string" },
        sortBy: { type: "string", enum: ["plans", "comp", "assets"], default: "plans" },
        limit: { type: "number", default: 25, maximum: 100 },
        offset: { type: "number", default: 0 },
      },
    },
    handler: dolSchCLegalCounsel,
  },
  {
    name: "courtlistener_counsel",
    description:
      "Find litigators by practice area from federal dockets: CourtListener REST v4 RECAP search (type=r, live) in a court (default 'ilnd' N.D. Ill.; also ilcd, ilsd, ca7, or several space-separated). preset: 'erisa' (nature of suit 791 / ERISA — well covered, federal jurisdiction), 'probate_trust' and 'family' (THIN — probate, divorce and custody live in Illinois circuit courts, which are not on CourtListener; use the directory tools for those lawyers), or 'custom' with a free q (CourtListener operators, e.g. caseName:\"Acme\" or \"breach of fiduciary duty\"). Optional attorney / party name filters, filedAfter / filedBefore (YYYY-MM-DD), limit ≤20. Returns dockets newest-first (case, court, filed/terminated, docket no., nature of suit, cause, judge, parties, attorneys, firms, URL) plus topAttorneys / topFirms tallies across the returned dockets. Attorneys/firms are empty for dockets whose party block RECAP never captured. Anonymous calls are throttled per IP (~125/day; sandbox saw 429) — set COURTLISTENER_TOKEN for 5,000/day; cached 1 h. Public court records, not consent to contact; verify names with ardc_lawyer_lookup.",
    inputSchema: {
      type: "object",
      properties: {
        preset: { type: "string", enum: ["erisa", "probate_trust", "family", "custom"], description: "practice-area preset; 'custom' uses q only" },
        q: { type: "string", description: "extra CourtListener query (ANDed with the preset)" },
        court: { type: "string", default: "ilnd", description: "court slug(s), e.g. 'ilnd' or 'ilnd ilcd ilsd ca7'" },
        filedAfter: { type: "string", description: "YYYY-MM-DD" },
        filedBefore: { type: "string", description: "YYYY-MM-DD" },
        attorney: { type: "string", description: "attorney name filter (PACER party block)" },
        party: { type: "string", description: "party name filter" },
        limit: { type: "number", default: 10, maximum: 20 },
      },
    },
    handler: courtlistenerCounsel,
  },
  {
    name: "legal_pros_playbook",
    description:
      "Routing doctrine for the legal-pros family (static, no network): which tool to use per practice area (ERISA → dol_sch_c_legal_counsel + acebc_fellow_search; trusts & estates → actec_fellow_search + leading_lawyers_search; family → aaml_il_fellow_search + collaborative_divorce_il_search; litigators → courtlistener_counsel), why Illinois attorneys are NOT in IDFPR (ARDC licenses them; ardc_lawyer_lookup is the verification layer, run last), why Schedule C legal providers are the best free ERISA-counsel signal, CourtListener's state-court gap, and the contact / compliance guardrails (public records ≠ consent; professional contact info only; cite dataset + as-of date; 'listed in / serves alongside' language). Optional practiceArea narrows the routing section. Call this first when asked to find attorneys.",
    inputSchema: {
      type: "object",
      properties: {
        practiceArea: { type: "string", description: "e.g. 'ERISA', 'estate planning', 'divorce' — returns only that route" },
      },
    },
    handler: async (args: any) => legalProsPlaybook(args ?? {}),
  },
];

export const DERIVED_CATALOG: CatalogDomain["tools"] = [
  { name: "dol_sch_c_legal_counsel", backing: "postgres", probe: "unprobed", note: "Schedule C code 29 rollup; empty:true until migration 0009 + refresh-dol-sch-c run; SQL shape verified on local Postgres 16 with synthetic rows" },
  { name: "courtlistener_counsel", backing: "live-api", probe: "unprobed", note: "RECAP type=r; anonymous throttled per IP (sandbox 429 '125/day'); COURTLISTENER_TOKEN lifts to 5k/day; cached 1 h" },
  { name: "legal_pros_playbook", backing: "live-api", probe: "unprobed", note: "static doctrine, no network" },
];

export const DERIVED_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }> = [
  { name: "legalpros: playbook (static)", tool: "legal_pros_playbook", args: { practiceArea: "ERISA" }, note: "no network; expect routing[0].practiceArea to start with 'ERISA' and 6 guardrails" },
  {
    name: "legalpros: Sch C legal counsel IL (tolerates empty/missing table)",
    tool: "dol_sch_c_legal_counsel",
    args: { state: "IL", limit: 3 },
    note: "Returns empty:true with an ingest hint until refresh-dol-sch-c has run; rows have plans/topSponsors once loaded",
  },
];
