import {
  pgTable,
  serial,
  text,
  varchar,
  integer,
  bigint,
  numeric,
  boolean,
  timestamp,
  date,
  index,
  uniqueIndex,
  primaryKey,
  pgEnum,
} from "drizzle-orm/pg-core";

export const registrationStatusEnum = pgEnum("registration_status", [
  "sec_registered",
  "state_registered",
  "exempt_reporting",
  "terminated",
  "pending",
  "unknown",
]);

export const firms = pgTable(
  "firms",
  {
    crdNumber: integer("crd_number").primaryKey(),
    secNumber: varchar("sec_number", { length: 32 }),
    legalName: text("legal_name").notNull(),
    primaryBusinessName: text("primary_business_name"),
    mainOfficeStreet: text("main_office_street"),
    mainOfficeCity: varchar("main_office_city", { length: 128 }),
    mainOfficeState: varchar("main_office_state", { length: 4 }),
    mainOfficeZip: varchar("main_office_zip", { length: 16 }),
    mainOfficeCountry: varchar("main_office_country", { length: 64 }),
    website: text("website"),
    mainPhone: varchar("main_phone", { length: 32 }),
    email: text("email"),
    totalAum: bigint("total_aum", { mode: "number" }),
    discretionaryAum: bigint("discretionary_aum", { mode: "number" }),
    nonDiscretionaryAum: bigint("non_discretionary_aum", { mode: "number" }),
    totalAccounts: integer("total_accounts"),
    discretionaryAccounts: integer("discretionary_accounts"),
    nonDiscretionaryAccounts: integer("non_discretionary_accounts"),
    totalEmployees: integer("total_employees"),
    registeredIarCount: integer("registered_iar_count"),
    registrationStatus: registrationStatusEnum("registration_status").notNull().default("unknown"),
    secRegistrationDate: date("sec_registration_date"),
    isLargeAdviser: boolean("is_large_adviser").default(false),
    pctIndividualNonHnw: numeric("pct_individual_non_hnw", { precision: 5, scale: 2 }),
    pctIndividualHnw: numeric("pct_individual_hnw", { precision: 5, scale: 2 }),
    pctPensionPlans: numeric("pct_pension_plans", { precision: 5, scale: 2 }),
    pctCharitableOrgs: numeric("pct_charitable_orgs", { precision: 5, scale: 2 }),
    pctCorporations: numeric("pct_corporations", { precision: 5, scale: 2 }),
    pctOtherInstitutional: numeric("pct_other_institutional", { precision: 5, scale: 2 }),
    pctPooledInvestment: numeric("pct_pooled_investment", { precision: 5, scale: 2 }),
    pctGovernmentEntities: numeric("pct_government_entities", { precision: 5, scale: 2 }),
    pctOther: numeric("pct_other", { precision: 5, scale: 2 }),
    compAumPct: boolean("comp_aum_pct").default(false),
    compHourly: boolean("comp_hourly").default(false),
    compFixedFee: boolean("comp_fixed_fee").default(false),
    compCommission: boolean("comp_commission").default(false),
    compPerformance: boolean("comp_performance").default(false),
    compSubscription: boolean("comp_subscription").default(false),
    compOther: boolean("comp_other").default(false),
    svcFinancialPlanning: boolean("svc_financial_planning").default(false),
    svcPortfolioManagementIndiv: boolean("svc_portfolio_mgmt_indiv").default(false),
    svcPortfolioManagementInst: boolean("svc_portfolio_mgmt_inst").default(false),
    svcPortfolioManagementInvCo: boolean("svc_portfolio_mgmt_invco").default(false),
    svcPortfolioManagementPooled: boolean("svc_portfolio_mgmt_pooled").default(false),
    svcPensionConsulting: boolean("svc_pension_consulting").default(false),
    svcAdvisorSelection: boolean("svc_advisor_selection").default(false),
    svcPublicationSubscription: boolean("svc_publication_subscription").default(false),
    svcSecurityRatings: boolean("svc_security_ratings").default(false),
    svcMarketTiming: boolean("svc_market_timing").default(false),
    svcEducationalSeminars: boolean("svc_educational_seminars").default(false),
    hasCustody: boolean("has_custody").default(false),
    custodyAum: bigint("custody_aum", { mode: "number" }),
    custodyAccounts: integer("custody_accounts"),
    hasDisclosures: boolean("has_disclosures").default(false),
    disclosureCount: integer("disclosure_count").default(0),
    lastFilingDate: date("last_filing_date"),
    lastAnnualUpdate: date("last_annual_update"),
    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    lastUpdatedAt: timestamp("last_updated_at").notNull().defaultNow(),
    rawJson: text("raw_json"),
  },
  (t) => ({
    secNumberIdx: uniqueIndex("firms_sec_number_idx").on(t.secNumber),
    nameIdx: index("firms_name_idx").on(t.legalName),
    stateIdx: index("firms_state_idx").on(t.mainOfficeState),
    aumIdx: index("firms_aum_idx").on(t.totalAum),
    cityStateIdx: index("firms_city_state_idx").on(t.mainOfficeCity, t.mainOfficeState),
    statusIdx: index("firms_status_idx").on(t.registrationStatus),
  })
);

export const firmHistory = pgTable(
  "firm_history",
  {
    id: serial("id").primaryKey(),
    crdNumber: integer("crd_number").notNull().references(() => firms.crdNumber, { onDelete: "cascade" }),
    filingDate: date("filing_date").notNull(),
    totalAum: bigint("total_aum", { mode: "number" }),
    discretionaryAum: bigint("discretionary_aum", { mode: "number" }),
    totalAccounts: integer("total_accounts"),
    totalEmployees: integer("total_employees"),
    registeredIarCount: integer("registered_iar_count"),
    rawJson: text("raw_json"),
  },
  (t) => ({
    crdFilingIdx: uniqueIndex("firm_history_crd_filing_idx").on(t.crdNumber, t.filingDate),
    crdIdx: index("firm_history_crd_idx").on(t.crdNumber),
  })
);

export const advisors = pgTable(
  "advisors",
  {
    crdNumber: integer("crd_number").primaryKey(),
    firstName: varchar("first_name", { length: 128 }),
    middleName: varchar("middle_name", { length: 128 }),
    lastName: varchar("last_name", { length: 128 }),
    suffix: varchar("suffix", { length: 32 }),
    fullName: text("full_name").notNull(),
    currentFirmCrd: integer("current_firm_crd").references(() => firms.crdNumber),
    title: text("title"),
    hasDisclosures: boolean("has_disclosures").default(false),
    disclosureCount: integer("disclosure_count").default(0),
    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    lastUpdatedAt: timestamp("last_updated_at").notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: index("advisors_name_idx").on(t.lastName, t.firstName),
    currentFirmIdx: index("advisors_current_firm_idx").on(t.currentFirmCrd),
    fullNameIdx: index("advisors_full_name_idx").on(t.fullName),
  })
);

export const advisorHistory = pgTable(
  "advisor_history",
  {
    id: serial("id").primaryKey(),
    advisorCrd: integer("advisor_crd").notNull().references(() => advisors.crdNumber, { onDelete: "cascade" }),
    firmCrd: integer("firm_crd").notNull().references(() => firms.crdNumber),
    startDate: date("start_date"),
    endDate: date("end_date"),
    title: text("title"),
    discoveredAt: timestamp("discovered_at").notNull().defaultNow(),
  },
  (t) => ({
    advisorIdx: index("advisor_history_advisor_idx").on(t.advisorCrd),
    firmIdx: index("advisor_history_firm_idx").on(t.firmCrd),
    activeIdx: index("advisor_history_active_idx").on(t.firmCrd, t.endDate),
  })
);

export const firmCustodians = pgTable(
  "firm_custodians",
  {
    id: serial("id").primaryKey(),
    firmCrd: integer("firm_crd").notNull().references(() => firms.crdNumber, { onDelete: "cascade" }),
    custodianName: text("custodian_name").notNull(),
    custodianCrd: integer("custodian_crd"),
    custodianSecNumber: varchar("custodian_sec_number", { length: 32 }),
    custodyType: varchar("custody_type", { length: 64 }),
    aumHeld: bigint("aum_held", { mode: "number" }),
    accountsHeld: integer("accounts_held"),
  },
  (t) => ({
    firmIdx: index("firm_custodians_firm_idx").on(t.firmCrd),
    custodianIdx: index("firm_custodians_name_idx").on(t.custodianName),
  })
);

export const privateFunds = pgTable(
  "private_funds",
  {
    id: serial("id").primaryKey(),
    firmCrd: integer("firm_crd").notNull().references(() => firms.crdNumber, { onDelete: "cascade" }),
    fundName: text("fund_name").notNull(),
    fundId: varchar("fund_id", { length: 64 }),
    fundType: varchar("fund_type", { length: 64 }),
    grossAssetValue: bigint("gross_asset_value", { mode: "number" }),
    minimumInvestment: bigint("minimum_investment", { mode: "number" }),
    beneficialOwners: integer("beneficial_owners"),
    masterFeederStatus: varchar("master_feeder_status", { length: 32 }),
  },
  (t) => ({
    firmIdx: index("private_funds_firm_idx").on(t.firmCrd),
    fundIdIdx: index("private_funds_fund_id_idx").on(t.fundId),
  })
);

export const ingestRuns = pgTable("ingest_runs", {
  id: serial("id").primaryKey(),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at"),
  source: varchar("source", { length: 64 }).notNull(),
  feedDate: date("feed_date"),
  firmsProcessed: integer("firms_processed").default(0),
  firmsInserted: integer("firms_inserted").default(0),
  firmsUpdated: integer("firms_updated").default(0),
  status: varchar("status", { length: 32 }).notNull().default("running"),
  errorMessage: text("error_message"),
});

export const nonprofits = pgTable(
  "nonprofits",
  {
    ein: varchar("ein", { length: 9 }).primaryKey(),
    name: text("name").notNull(),
    inCareOf: text("in_care_of"),
    street: text("street"),
    city: varchar("city", { length: 128 }),
    state: varchar("state", { length: 4 }),
    zip: varchar("zip", { length: 16 }),
    groupCode: varchar("group_code", { length: 8 }),
    subsection: integer("subsection"),
    affiliation: integer("affiliation"),
    classification: varchar("classification", { length: 32 }),
    rulingDate: varchar("ruling_date", { length: 8 }),
    deductibility: integer("deductibility"),
    foundation: integer("foundation"),
    activityCodes: varchar("activity_codes", { length: 32 }),
    organizationCode: integer("organization_code"),
    statusCode: integer("status_code"),
    taxPeriod: varchar("tax_period", { length: 8 }),
    assetCode: integer("asset_code"),
    incomeCode: integer("income_code"),
    filingReqCode: varchar("filing_req_code", { length: 4 }),
    pfFilingReqCode: varchar("pf_filing_req_code", { length: 4 }),
    acctPeriod: varchar("acct_period", { length: 4 }),
    assetAmt: bigint("asset_amt", { mode: "number" }),
    incomeAmt: bigint("income_amt", { mode: "number" }),
    revenueAmt: bigint("revenue_amt", { mode: "number" }),
    nteeCode: varchar("ntee_code", { length: 8 }),
    sortName: text("sort_name"),
    region: varchar("region", { length: 8 }),
    lastUpdatedAt: timestamp("last_updated_at").notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: index("nonprofits_name_idx").on(t.name),
    stateIdx: index("nonprofits_state_idx").on(t.state),
    subsectionIdx: index("nonprofits_subsection_idx").on(t.subsection),
    nteeIdx: index("nonprofits_ntee_idx").on(t.nteeCode),
    assetCdIdx: index("nonprofits_asset_cd_idx").on(t.assetCode),
    stateSubsecIdx: index("nonprofits_state_subsec_idx").on(t.state, t.subsection),
  })
);

export const plans = pgTable(
  "plans",
  {
    ackId: varchar("ack_id", { length: 40 }).primaryKey(),
    formPlanYearBeginDate: date("form_plan_year_begin_date"),
    formTaxPrd: varchar("form_tax_prd", { length: 8 }),
    typePlanEntityCd: integer("type_plan_entity_cd"),
    typeDfePlanEntityCd: integer("type_dfe_plan_entity_cd"),
    initialFilingInd: boolean("initial_filing_ind"),
    amendedInd: boolean("amended_ind"),
    finalFilingInd: boolean("final_filing_ind"),
    shortPlanYrInd: boolean("short_plan_yr_ind"),
    collectiveBargainInd: boolean("collective_bargain_ind"),
    planYear: integer("plan_year"),
    planName: text("plan_name"),
    sponsDfePn: varchar("spons_dfe_pn", { length: 8 }),
    sponsDfeEin: varchar("spons_dfe_ein", { length: 12 }),
    sponsDfeName: text("spons_dfe_name"),
    sponsDfeDbaName: text("spons_dfe_dba_name"),
    sponsDfeMailAddr1: text("spons_dfe_mail_addr1"),
    sponsDfeMailCity: varchar("spons_dfe_mail_city", { length: 64 }),
    sponsDfeMailState: varchar("spons_dfe_mail_state", { length: 4 }),
    sponsDfeMailZip: varchar("spons_dfe_mail_zip", { length: 16 }),
    sponsDfePhone: varchar("spons_dfe_phone", { length: 20 }),
    adminName: text("admin_name"),
    adminEin: varchar("admin_ein", { length: 12 }),
    adminPhone: varchar("admin_phone", { length: 20 }),
    adminAddr1: text("admin_addr1"),
    adminCity: varchar("admin_city", { length: 64 }),
    adminState: varchar("admin_state", { length: 4 }),
    adminZip: varchar("admin_zip", { length: 16 }),
    totActivePartcpCnt: integer("tot_active_partcp_cnt"),
    totPartcpBoyCnt: integer("tot_partcp_boy_cnt"),
    rtrdSepPartcpRcvgCnt: integer("rtrd_sep_partcp_rcvg_cnt"),
    rtrdSepPartcpFutCnt: integer("rtrd_sep_partcp_fut_cnt"),
    pensionPlanFeatureCodes: text("pension_plan_feature_codes"),
    welfarePlanFeatureCodes: text("welfare_plan_feature_codes"),
    schAAttachedInd: boolean("sch_a_attached_ind"),
    schCAttachedInd: boolean("sch_c_attached_ind"),
    schDAttachedInd: boolean("sch_d_attached_ind"),
    schGAttachedInd: boolean("sch_g_attached_ind"),
    schHAttachedInd: boolean("sch_h_attached_ind"),
    schIAttachedInd: boolean("sch_i_attached_ind"),
    schRAttachedInd: boolean("sch_r_attached_ind"),
    schMbAttachedInd: boolean("sch_mb_attached_ind"),
    schSbAttachedInd: boolean("sch_sb_attached_ind"),
    totAssetsBoyAmt: bigint("tot_assets_boy_amt", { mode: "number" }),
    totAssetsEoyAmt: bigint("tot_assets_eoy_amt", { mode: "number" }),
    netAssetsBoyAmt: bigint("net_assets_boy_amt", { mode: "number" }),
    netAssetsEoyAmt: bigint("net_assets_eoy_amt", { mode: "number" }),
    dateReceived: date("date_received"),
    lastUpdatedAt: timestamp("last_updated_at").notNull().defaultNow(),
  },
  (t) => ({
    sponsorEinIdx: index("plans_sponsor_ein_idx").on(t.sponsDfeEin),
    sponsorNameIdx: index("plans_sponsor_name_idx").on(t.sponsDfeName),
    adminEinIdx: index("plans_admin_ein_idx").on(t.adminEin),
    stateIdx: index("plans_state_idx").on(t.sponsDfeMailState),
    planYearIdx: index("plans_plan_year_idx").on(t.planYear),
    assetsEoyIdx: index("plans_assets_eoy_idx").on(t.totAssetsEoyAmt),
    stateYearIdx: index("plans_state_year_idx").on(t.sponsDfeMailState, t.planYear),
  })
);

// Phase 3 — IPEDS institutional directory + endowment market values + NACUBO public benchmarks.
export const ipedsInstitutions = pgTable(
  "ipeds_institutions",
  {
    unitid: integer("unitid").primaryKey(),
    instnm: text("instnm").notNull(),
    city: varchar("city", { length: 128 }),
    state: varchar("state", { length: 4 }),
    zip: varchar("zip", { length: 16 }),
    sector: integer("sector"),
    control: integer("control"),
    iclevel: integer("iclevel"),
    obereg: integer("obereg"),
    webaddr: text("webaddr"),
    closedDate: varchar("closed_date", { length: 16 }),
    lastUpdatedAt: timestamp("last_updated_at").notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: index("ipeds_inst_name_idx").on(t.instnm),
    stateIdx: index("ipeds_inst_state_idx").on(t.state),
    sectorIdx: index("ipeds_inst_sector_idx").on(t.sector),
    controlIdx: index("ipeds_inst_control_idx").on(t.control),
  })
);

export const endowments = pgTable(
  "endowments",
  {
    unitid: integer("unitid").notNull(),
    fyear: integer("fyear").notNull(),
    fileType: varchar("file_type", { length: 4 }).notNull(),
    marketValueBoy: bigint("market_value_boy", { mode: "number" }),
    marketValueEoy: bigint("market_value_eoy", { mode: "number" }),
    // Renamed from `contributions` in v0.5.0. IPEDS variable f2h03 is
    // "Total net additions to endowment for the year" = EOY minus BOY,
    // not gift inflows. The old name was misleading.
    netChangeInEndowment: bigint("net_change_in_endowment", { mode: "number" }),
    netInvestmentReturn: bigint("net_investment_return", { mode: "number" }),
    withdrawals: bigint("withdrawals", { mode: "number" }),
    otherAdjustments: bigint("other_adjustments", { mode: "number" }),
    lastUpdatedAt: timestamp("last_updated_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.unitid, t.fyear] }),
    fyearIdx: index("endowments_fyear_idx").on(t.fyear),
    eoyIdx: index("endowments_eoy_idx").on(t.marketValueEoy),
    unitidIdx: index("endowments_unitid_idx").on(t.unitid),
  })
);

export const nacuboBenchmarks = pgTable(
  "nacubo_benchmarks",
  {
    fyear: integer("fyear").notNull(),
    cohort: varchar("cohort", { length: 64 }).notNull(),
    cohortCount: integer("cohort_count"),
    totalAssets: bigint("total_assets", { mode: "number" }),
    medianValue: bigint("median_value", { mode: "number" }),
    return1y: numeric("return_1y", { precision: 6, scale: 3 }),
    return3y: numeric("return_3y", { precision: 6, scale: 3 }),
    return5y: numeric("return_5y", { precision: 6, scale: 3 }),
    return10y: numeric("return_10y", { precision: 6, scale: 3 }),
    spendingRate: numeric("spending_rate", { precision: 6, scale: 3 }),
    spendingAmount: bigint("spending_amount", { mode: "number" }),
    assetAllocJson: text("asset_alloc_json"),
    source: varchar("source", { length: 32 }),
    lastUpdatedAt: timestamp("last_updated_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.fyear, t.cohort] }),
    fyearIdx: index("nacubo_benchmarks_fyear_idx").on(t.fyear),
    cohortIdx: index("nacubo_benchmarks_cohort_idx").on(t.cohort),
  })
);

// v0.5.0 — SBA PPP Loans (FOIA bulk data, >=$150K loans).
export const pppLoans = pgTable(
  "ppp_loans",
  {
    loanNumber: varchar("loan_number", { length: 20 }).primaryKey(),
    dateApproved: date("date_approved"),
    borrowerName: text("borrower_name").notNull(),
    borrowerAddress: text("borrower_address"),
    borrowerCity: varchar("borrower_city", { length: 128 }),
    borrowerState: varchar("borrower_state", { length: 4 }),
    borrowerZip: varchar("borrower_zip", { length: 16 }),
    loanStatus: varchar("loan_status", { length: 64 }),
    loanStatusDate: date("loan_status_date"),
    initialApprovalAmount: bigint("initial_approval_amount", { mode: "number" }),
    currentApprovalAmount: bigint("current_approval_amount", { mode: "number" }),
    undisbursedAmount: bigint("undisbursed_amount", { mode: "number" }),
    businessType: varchar("business_type", { length: 128 }),
    nonprofitFlag: boolean("nonprofit_flag"),
    naicsCode: varchar("naics_code", { length: 8 }),
    jobsReported: integer("jobs_reported"),
    originatingLender: text("originating_lender"),
    servicingLenderName: text("servicing_lender_name"),
    forgivenessAmount: bigint("forgiveness_amount", { mode: "number" }),
    forgivenessDate: date("forgiveness_date"),
    ruralUrbanIndicator: varchar("rural_urban_indicator", { length: 2 }),
    hubzoneIndicator: varchar("hubzone_indicator", { length: 2 }),
    lmiIndicator: varchar("lmi_indicator", { length: 2 }),
    lastUpdatedAt: timestamp("last_updated_at").notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: index("ppp_loans_name_idx").on(t.borrowerName),
    stateIdx: index("ppp_loans_state_idx").on(t.borrowerState),
    amountIdx: index("ppp_loans_amount_idx").on(t.currentApprovalAmount),
    naicsIdx: index("ppp_loans_naics_idx").on(t.naicsCode),
    businessIdx: index("ppp_loans_business_idx").on(t.businessType),
    nonprofitIdx: index("ppp_loans_nonprofit_idx").on(t.nonprofitFlag),
  })
);

// v0.6.0 — SEC Form 13F institutional holdings.
// Source: SEC Form 13F Data Sets (flattened quarterly TSV bulk files).
//   https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets
// f13f_filings: one row per accession (SUBMISSION + COVERPAGE + SUMMARYPAGE).
// f13f_holdings: one row per INFOTABLE position.
// VALUE units: whole dollars from 2023-01-03 onward, thousands before; the
// ingest writes the whole-dollar-normalized figure into *Usd columns.
export const f13fFilings = pgTable(
  "f13f_filings",
  {
    accessionNumber: varchar("accession_number", { length: 25 }).primaryKey(),
    cik: varchar("cik", { length: 10 }),
    filingDate: date("filing_date"),
    submissionType: varchar("submission_type", { length: 10 }),
    periodOfReport: date("period_of_report"),
    filingManagerName: text("filing_manager_name"),
    filingManagerCity: varchar("filing_manager_city", { length: 64 }),
    filingManagerState: varchar("filing_manager_state", { length: 4 }),
    reportType: varchar("report_type", { length: 40 }),
    crdNumber: varchar("crd_number", { length: 9 }),
    secFileNumber: varchar("sec_file_number", { length: 20 }),
    tableEntryTotal: integer("table_entry_total"),
    tableValueTotal: bigint("table_value_total", { mode: "number" }),
    tableValueTotalUsd: bigint("table_value_total_usd", { mode: "number" }),
    otherManagersCount: integer("other_managers_count"),
    isAmendment: boolean("is_amendment"),
    lastUpdatedAt: timestamp("last_updated_at").notNull().defaultNow(),
  },
  (t) => ({
    managerIdx: index("f13f_filings_manager_idx").on(t.filingManagerName),
    cikIdx: index("f13f_filings_cik_idx").on(t.cik),
    periodIdx: index("f13f_filings_period_idx").on(t.periodOfReport),
    valueIdx: index("f13f_filings_value_idx").on(t.tableValueTotalUsd),
    crdIdx: index("f13f_filings_crd_idx").on(t.crdNumber),
  })
);

export const f13fHoldings = pgTable(
  "f13f_holdings",
  {
    accessionNumber: varchar("accession_number", { length: 25 }).notNull(),
    infotableSk: bigint("infotable_sk", { mode: "number" }).notNull(),
    nameOfIssuer: text("name_of_issuer"),
    titleOfClass: varchar("title_of_class", { length: 150 }),
    cusip: varchar("cusip", { length: 9 }),
    figi: varchar("figi", { length: 12 }),
    valueRaw: bigint("value_raw", { mode: "number" }),
    valueUsd: bigint("value_usd", { mode: "number" }),
    sshPrnamt: bigint("ssh_prnamt", { mode: "number" }),
    sshPrnamtType: varchar("ssh_prnamt_type", { length: 10 }),
    putCall: varchar("put_call", { length: 10 }),
    investmentDiscretion: varchar("investment_discretion", { length: 10 }),
    votingAuthSole: bigint("voting_auth_sole", { mode: "number" }),
    votingAuthShared: bigint("voting_auth_shared", { mode: "number" }),
    votingAuthNone: bigint("voting_auth_none", { mode: "number" }),
    periodOfReport: date("period_of_report"),
    lastUpdatedAt: timestamp("last_updated_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.accessionNumber, t.infotableSk] }),
    accessionIdx: index("f13f_holdings_accession_idx").on(t.accessionNumber),
    cusipIdx: index("f13f_holdings_cusip_idx").on(t.cusip),
    issuerIdx: index("f13f_holdings_issuer_idx").on(t.nameOfIssuer),
    valueIdx: index("f13f_holdings_value_idx").on(t.valueUsd),
    periodIdx: index("f13f_holdings_period_idx").on(t.periodOfReport),
  })
);

export type Plan = typeof plans.$inferSelect;
export type PlanInsert = typeof plans.$inferInsert;

export type Firm = typeof firms.$inferSelect;
export type FirmInsert = typeof firms.$inferInsert;
export type Advisor = typeof advisors.$inferSelect;
export type AdvisorInsert = typeof advisors.$inferInsert;
export type FirmHistory = typeof firmHistory.$inferSelect;
export type FirmCustodian = typeof firmCustodians.$inferSelect;
export type PrivateFund = typeof privateFunds.$inferSelect;
export type Nonprofit = typeof nonprofits.$inferSelect;
export type NonprofitInsert = typeof nonprofits.$inferInsert;
export type IpedsInstitution = typeof ipedsInstitutions.$inferSelect;
export type IpedsInstitutionInsert = typeof ipedsInstitutions.$inferInsert;
export type Endowment = typeof endowments.$inferSelect;
export type EndowmentInsert = typeof endowments.$inferInsert;
export type NacuboBenchmark = typeof nacuboBenchmarks.$inferSelect;
export type NacuboBenchmarkInsert = typeof nacuboBenchmarks.$inferInsert;
export type PppLoan = typeof pppLoans.$inferSelect;
export type PppLoanInsert = typeof pppLoans.$inferInsert;
export type F13fFiling = typeof f13fFilings.$inferSelect;
export type F13fFilingInsert = typeof f13fFilings.$inferInsert;
export type F13fHolding = typeof f13fHoldings.$inferSelect;
export type F13fHoldingInsert = typeof f13fHoldings.$inferInsert;
