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

export type Firm = typeof firms.$inferSelect;
export type FirmInsert = typeof firms.$inferInsert;
export type Advisor = typeof advisors.$inferSelect;
export type AdvisorInsert = typeof advisors.$inferInsert;
export type FirmHistory = typeof firmHistory.$inferSelect;
export type FirmCustodian = typeof firmCustodians.$inferSelect;
export type PrivateFund = typeof privateFunds.$inferSelect;
