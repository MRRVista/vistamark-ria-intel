/**
 * Synthesis playbooks — the triangulation doctrine, in one place.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * 131 tools is a library, not a brain. What turns the library into intelligence
 * is knowing WHICH datasets confirm WHICH signal, in what order, and what the
 * confirmed signal is worth to a sales conversation. That knowledge used to
 * live in Matt's head and in ad hoc prompts. It now lives here, rendered three
 * ways from one source of truth:
 *
 *   1. /api/ask system prompt  — buildSystemPrompt() appends renderDoctrine()
 *                                so every Ask turn reasons like an analyst.
 *   2. synthesis_playbooks tool — any MCP client (Randall, Claude, a human in
 *                                the console) can pull the recipes on demand.
 *   3. Randall directive card   — vistarandall's seeded brain-stem directive
 *                                quotes the doctrine so his own loop (which
 *                                attaches VistaIntel as a hosted MCP toolset)
 *                                reaches for the composite tools first.
 *
 * Every playbook is a hypothesis → evidence → confirmation → angle chain.
 * The composites in this family implement the fan-out mechanically; the
 * playbooks say what the fan-out MEANS.
 */

export interface Playbook {
  id: string;
  /** The question a partner actually asks. */
  question: string;
  /** The hypothesis the data can confirm or kill. */
  hypothesis: string;
  /** Ordered steps: tool + what to look for. Parallel groups share a step number. */
  steps: Array<{ step: number; tool: string; lookFor: string }>;
  /** What counts as confirmed — minimum independent sources that must agree. */
  confirmation: string;
  /** The sales/marketing angle the confirmed signal unlocks. */
  angle: string;
  /** Hard stops. */
  neverInfer: string;
  /** Composite tool that runs this playbook in one call, if one exists. */
  composite?: string;
}

export const PLAYBOOKS: Playbook[] = [
  {
    id: "prospect-360",
    question: "Who is this person, what are they worth, who do they know, and why would they take a meeting?",
    hypothesis: "A named individual in the target zips is a qualified prospect with a reachable angle.",
    steps: [
      { step: 1, tool: "prospects_search", lookFor: "already in our DB? consent block, lead status, prior touchpoints — the record of what already happened" },
      { step: 1, tool: "irs990_boards_of_person", lookFor: "board seats → civic identity, co-board members, org size (assets) as proxy for peer wealth tier" },
      { step: 1, tool: "insider_transactions", lookFor: "Section 16 filings → public-company officer/director; open-market sales = liquidity events; 10b5-1 plans = scheduled liquidity" },
      { step: 1, tool: "formd_related_persons", lookFor: "executive officer / director / promoter of a Reg D issuer → private-company owner or GP with carried interest" },
      { step: 1, tool: "idfpr_licensee_search", lookFor: "professional license (physician, CPA, attorney-adjacent, architect) → income tier + employer" },
      { step: 2, tool: "cook_parcel_sales", lookFor: "buyer/seller name match → home value tier, recent purchase (new neighbor) or sale (downsizing / relocating)" },
      { step: 2, tool: "il_ptax_transfers", lookFor: "DuPage/statewide transfer declarations with consideration → same as above outside Cook" },
      { step: 2, tool: "dol_plan_search", lookFor: "if an employer is known: sponsor's 401(k)/DB plan size → rollover opportunity, executive deferred comp" },
      { step: 3, tool: "apollo_people_search", lookFor: "title, employer, professional email domain — free match; enrich only with intent to contact" },
      { step: 3, tool: "web_search", lookFor: "bio, LinkedIn-visible title, recent news, speaking, alma mater — the human detail that personalizes" },
    ],
    confirmation: "Identity is confirmed only when ≥2 independent sources agree on name + geography (zip/city) or name + employer. One source = a lead, not a prospect.",
    angle: "Rank hooks: (1) liquidity event in the last 12 months (sale, Form 4 sale, business exit) → 'the money is in motion' opener; (2) shared board or institution with Matt or a client → warm-path intro; (3) professional affinity (physician → tax-aware planning, CPA → referral partner, founder → concentrated-stock playbook); (4) local identity (Hinsdale, DuPage, the specific school or parish) → neighbor-to-neighbor.",
    neverInfer: "Never state net worth as a fact — only the evidence (home value, comp, filing). Never contact without a published professional email and a consent check. Never use personal (home) emails or phones.",
    composite: "prospect_360",
  },
  {
    id: "org-360",
    question: "What is this institution, who runs its money, who is the incumbent, and when is it in play?",
    hypothesis: "A nonprofit / plan sponsor / company is an addressable iCIO or advisory mandate.",
    steps: [
      { step: 1, tool: "irs990_filing_search", lookFor: "assets, invested securities, endowment, Part IX 11f investment-management fees (fees paid = incumbent exists = displaceable)" },
      { step: 1, tool: "irs_eo_search", lookFor: "BMF classification, foundation code (private foundation = 5% payout discipline = investment committee)" },
      { step: 1, tool: "dol_plan_search", lookFor: "sponsor's ERISA plans: assets, participants, DB flag (DB plan = actuarial pressure = advisor conversation)" },
      { step: 1, tool: "search_rias", lookFor: "is the org itself an RIA? (then it is a channel partner, not a prospect)" },
      { step: 2, tool: "irs990_board", lookFor: "board + officers, treasurer / investment-committee titles, comp, hours — the decision makers" },
      { step: 2, tool: "dol_sch_c_providers_by_plan", lookFor: "named service providers + fees → the incumbent advisor/recordkeeper by name" },
      { step: 2, tool: "propublica_org_990", lookFor: "multi-year financial trend: shrinking net assets or investment income = pain; growing = capacity" },
      { step: 2, tool: "usaspending_awards_search", lookFor: "federal grant dependence → reserve-policy conversation" },
      { step: 2, tool: "ppp_lookup", lookFor: "took PPP → cash-flow sensitivity in 2020; a datapoint for the story, not a judgment" },
      { step: 3, tool: "edgar_fulltext_search", lookFor: "mentions in filings (a company's 10-K naming the foundation; an 8-K naming a sponsor change)" },
      { step: 3, tool: "gleif_entity_search", lookFor: "entity family tree — parent / affiliates that share a board or a treasurer" },
    ],
    confirmation: "Mandate is 'in play' when ≥2 of: investment-management fees > 0 and rising, treasurer/IC chair changed on the newest 990, net assets fell while fees rose, a Schedule C provider changed year over year.",
    angle: "Lead with the benchmark they cannot see: endowment_percentile_rank / nacubo_benchmark_lookup for a college; peer plan fees for a sponsor; '3 foundations your size in DuPage pay X bps' for a foundation. The angle is 'you are paying for an outcome you are not getting' — said politely, with their own numbers.",
    neverInfer: "Never name an incumbent that is not on Schedule C or the 990. Never infer dissatisfaction — infer only that a comparison is available.",
    composite: "org_360",
  },
  {
    id: "liquidity-radar",
    question: "Where is money in motion in our zips right now?",
    hypothesis: "Recent transactions and filings reveal households whose balance sheet just changed.",
    steps: [
      { step: 1, tool: "cook_parcel_sales", lookFor: "sales above threshold in the last N months → buyer (new neighbor, relocation) and seller (downsizing, estate)" },
      { step: 1, tool: "il_ptax_transfers", lookFor: "same for DuPage (Hinsdale is split Cook/DuPage — run both every time)" },
      { step: 1, tool: "insider_by_location", lookFor: "Forms 4 filed by owners with a local address → public-company exec selling stock" },
      { step: 1, tool: "formd_search", lookFor: "Reg D issuers with a local address raising capital → founders about to have liquidity or GPs raising a fund" },
      { step: 2, tool: "irs990_people_search", lookFor: "cross-reference every name from step 1 against the board index — a seller who chairs a foundation is a different conversation" },
      { step: 2, tool: "prospects_search", lookFor: "which of these are already in the DB (and their status) — never re-prospect a client or a do-not-contact" },
    ],
    confirmation: "An event is 'actionable' when the name resolves to a household in a target zip AND no do-not-contact flag AND a published professional email path exists (Hunter/Apollo/firm domain).",
    angle: "Timing is the angle. Sellers: 'what to do with proceeds before year-end'. Buyers: 'welcome to Hinsdale' + a property-tax-appeal or mortgage-rate note (useful, not salesy). Form 4 sellers: concentrated-stock / 10b5-1 planning. Form D founders: pre-liquidity planning (QSBS, trusts) — the earliest and most valuable conversation.",
    neverInfer: "Never contact on the strength of a parcel record alone. Never reference the transaction price in outreach. Never mention a Form 4 sale to the filer as if it were news to them.",
    composite: "liquidity_event_radar",
  },
  {
    id: "relationship-graph",
    question: "What is the warmest path to this person or institution?",
    hypothesis: "Shared board service, shared plan sponsorship, or shared Form D issuers connect a target to someone we already know.",
    steps: [
      { step: 1, tool: "irs990_boards_of_person", lookFor: "seed person's seats" },
      { step: 1, tool: "irs990_board", lookFor: "seed org's board" },
      { step: 2, tool: "irs990_people_search", lookFor: "co-board members of each seat (same org, latest return)" },
      { step: 2, tool: "irs990_boards_of_person", lookFor: "each co-member's OTHER seats (depth 2)" },
      { step: 3, tool: "prospects_search", lookFor: "intersect the graph with our DB: clients, qualified prospects, referral partners" },
      { step: 3, tool: "search_advisors", lookFor: "any node who is an IAR → competitor or channel partner" },
    ],
    confirmation: "A warm path is real when the connector is (a) a client or partner in our DB, or (b) sits on a board with both Matt/Vistamark's known network and the target. Two-hop paths need a named connector at each hop.",
    angle: "Ask the connector for the intro, never the target cold. Frame the intro around the shared institution ('you both serve on the X board') — it is the one fact both sides already know is true.",
    neverInfer: "Never claim a relationship exists because two names share a board — board service is public, friendship is not. Say 'serves alongside', never 'knows'.",
    composite: "relationship_graph",
  },
  {
    id: "market-regime",
    question: "What is the market telling us, and what should clients hear from us this week?",
    hypothesis: "Rates, liquidity, valuation, vol and growth nowcasts combine into one regime with a client-facing message.",
    steps: [
      { step: 1, tool: "morning_market_brief", lookFor: "curve, credit, liquidity, growth, inflation, sentiment — the 22-indicator composite" },
      { step: 1, tool: "nyfed_recession_probability", lookFor: "12-month recession odds from the term spread" },
      { step: 1, tool: "atlfed_gdpnow", lookFor: "current-quarter growth nowcast and its revision direction" },
      { step: 1, tool: "shiller_cape", lookFor: "valuation vs history — the 10-year expected-return conversation" },
      { step: 1, tool: "cboe_vol_history", lookFor: "VIX / SKEW regime; term structure (fear is cheap or expensive)" },
      { step: 1, tool: "damodaran_erp", lookFor: "implied equity risk premium — what the market is paying for risk" },
      { step: 2, tool: "nyfed_term_premia", lookFor: "is the long end moving on growth, inflation or term premium?" },
      { step: 2, tool: "philfed_spf", lookFor: "consensus forecasts to contrast with the nowcast" },
    ],
    confirmation: "A regime call needs ≥3 pillars pointing the same way. Mixed pillars = 'late-cycle, data-dependent' and say so.",
    angle: "Translate every regime into three client sentences: what changed, what we did about it, what we are watching. Then one prospect sentence: the thing a prospect's current advisor probably has not told them (e.g. CAPE-implied returns vs their plan's assumed return).",
    neverInfer: "Indicators, not predictions. Never attach a probability the tool did not report. Never time the market in writing.",
    composite: "market_regime_brief",
  },
  {
    id: "icio-ria-prospect",
    question: "Which boutique RIAs need an outsourced CIO?",
    hypothesis: "Planning-led, fee-only RIAs with growing AUM and no investment staff buy iCIO.",
    steps: [
      { step: 1, tool: "search_rias", lookFor: "state/city, AUM $100M–$2B, offersFinancialPlanning, high % HNW, low employee count" },
      { step: 2, tool: "get_aum_history", lookFor: "AUM growing faster than headcount → capacity strain" },
      { step: 2, tool: "adv_brochures", lookFor: "brochure language: 'model portfolios', 'third-party managers', no CFA on staff" },
      { step: 2, tool: "search_advisors", lookFor: "IAR roster — no one with a CIO/research title" },
      { step: 3, tool: "find_alumni", lookFor: "where their people came from — a shared alma firm is an intro" },
      { step: 3, tool: "nport_fund_search", lookFor: "if they run a fund: holdings → investment philosophy" },
    ],
    confirmation: "Fit is confirmed when AUM/employee > $50M AND no investment-titled IAR AND brochure describes outsourced or model-based management.",
    angle: "'You are a planner who has become a portfolio manager by accident.' Offer the CFA/CAIA bench without the payroll. Cite their own AUM-per-head trend.",
    neverInfer: "Never describe a firm's investment process beyond what the ADV/brochure says. Never contact a firm that custodies with Vistamark's clients' custodian in a way that looks like poaching.",
  },
  {
    id: "endowment-benchmark",
    question: "How does this college's endowment stack up, and is that a conversation?",
    hypothesis: "A below-median growth trajectory vs size peers is a mandate conversation with the CFO or investment committee.",
    steps: [
      { step: 1, tool: "endowment_lookup", lookFor: "history, net return, withdrawals" },
      { step: 1, tool: "endowment_percentile_rank", lookFor: "national rank" },
      { step: 1, tool: "endowment_peer_set", lookFor: "±25% size peers, same control" },
      { step: 2, tool: "endowment_growth_history", lookFor: "CAGR 3/5/10, worst year, declining-year count" },
      { step: 2, tool: "nacubo_benchmark_lookup", lookFor: "cohort returns and spending rate to compare" },
      { step: 2, tool: "irs990_filing_search", lookFor: "the college's 990: invest_mgmt_fees, endowment_eoy, board" },
      { step: 3, tool: "irs990_board", lookFor: "trustees with finance titles — the audience" },
    ],
    confirmation: "Conversation-worthy when 5-yr CAGR trails the NACUBO cohort by >150 bps OR decade comparison shows decelerating CAGR while fees rose.",
    angle: "A one-page 'where you rank' chart is the opener — endowment_percentile_rank + peer CAGR table in an Excel export. Numbers they cannot get from their current consultant without asking for them.",
    neverInfer: "IPEDS lags ~2 fiscal years; say so. Never attribute underperformance to the incumbent — attribute it to the peer gap.",
  },
];

/** The reasoning doctrine — how to think, not what to call. Rendered into Ask
 *  and into Randall's directive card. Kept tight: this rides every turn. */
export const DOCTRINE: string[] = [
  "THINK LIKE AN ANALYST, SELL LIKE A NEIGHBOR.",
  "1. HYPOTHESIS FIRST. Before the first tool call, state (to yourself) the hypothesis the data can confirm or kill and which 3+ datasets bear on it. A question that touches a person, an org, an area or the market has a playbook — run it.",
  "2. FAN OUT, THEN JOIN. Issue the independent calls of a step IN PARALLEL (one round, many tool_use blocks). Join on hard keys when they exist (EIN, CRD, CIK, LEI, UNITID, PIN) and on normalized name + geography when they do not. Never serialize calls that do not depend on each other.",
  "3. TRIANGULATE BEFORE YOU ASSERT. A fact about a person or org stands only when two independent sources agree; a single-source fact is reported as 'one source indicates'. Name the sources. Disagreement between sources is itself a finding — report it.",
  "4. EMPTY ≠ ABSENT. Distinguish 'no data' from 'not ingested' / 'keyed tool without a key' / 'upstream timeout'. The KNOWN-EMPTY list and tool errors tell you which; say which.",
  "5. SCORE, DON'T NARRATE. For prospects, roll evidence into a wealth-signal score with the contributing signals listed; for orgs, an 'in-play' score; for events, an 'actionable' flag. Lead with the score and the top three reasons.",
  "6. EVERY FINDING ENDS IN AN ANGLE. The last section of any prospecting answer is 'Angle' — the ranked hooks (liquidity, warm path, affinity, local identity, benchmark gap) and a draft-ready first line. No angle = not finished.",
  "7. CREATIVE, NOT CUTE. The best hook is a specific, true, useful observation the prospect has not heard from their current advisor. Prefer a number they cannot easily get over a compliment. Pattern-interrupt openers beat 'I hope this finds you well'. Humor is allowed; hype is not.",
  "8. GUARDRAILS ARE PART OF THE ANSWER. Outreach lands as a DRAFT for review; only published professional emails; consent and do-not-contact checked via prospect_lookup before any contact; CAN-SPAM footer; no personal emails/phones; no reference to transaction prices, health, family or anything not public and professional. State which guardrail applies when you hand over an angle.",
  "9. COMPOUND THE DB. When a fan-out surfaces a new qualified person or org, say so and propose the prospects_upsert payload (source + evidence tags) — the system gets smarter when findings are written back, but never write without being asked.",
  "10. BE TERSE AND AUDITABLE. Identifiers beside every entity, as-of dates beside every figure, tool names beside every claim. Tables under 15 rows; larger → Excel.",
];

export function renderDoctrine(): string {
  return ["TRIANGULATION DOCTRINE:", ...DOCTRINE.map((d) => `- ${d}`)].join("\n");
}

/** Compact playbook index for the system prompt — ids, questions, composites.
 *  The full steps are available via the synthesis_playbooks tool so the prompt
 *  stays lean. */
export function renderPlaybookIndex(): string {
  const lines = PLAYBOOKS.map(
    (p) =>
      `- ${p.id}: "${p.question}" → ${p.composite ? `call ${p.composite} first, then drill` : `steps via synthesis_playbooks id=${p.id}`}`
  );
  return ["PLAYBOOKS (hypothesis → fan-out → confirm → angle):", ...lines].join("\n");
}

export function renderPlaybookFull(p: Playbook): string {
  const steps = p.steps
    .map((s) => `   ${s.step}. ${s.tool} — ${s.lookFor}`)
    .join("\n");
  return [
    `## ${p.id} — ${p.question}`,
    `Hypothesis: ${p.hypothesis}`,
    `Steps (same number = run in parallel):`,
    steps,
    `Confirmation: ${p.confirmation}`,
    `Angle: ${p.angle}`,
    `Never infer: ${p.neverInfer}`,
    p.composite ? `Composite: ${p.composite}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
