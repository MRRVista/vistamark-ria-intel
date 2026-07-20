/**
 * v0.19.0 — SEC Form D exempt-offering corpus (stored locally, complementing
 * the live EDGAR full-text `formd_search` tool with queryable history).
 *
 * Kept in a separate module so the change is purely additive — fold into
 * lib/db/schema.ts whenever convenient. Tables are created by the hand-run
 * migrations/0006_formd.sql (custom runner), not drizzle-kit generate.
 *
 * Sources:
 *   - EDGAR daily form index (near-real-time; api/cron/ingest-formd)
 *   - DERA quarterly Form D data sets, 2008Q1 → present
 *     (api/admin/backfill-formd; zips archived to R2 when configured)
 */
import {
  pgTable,
  text,
  varchar,
  integer,
  bigint,
  boolean,
  timestamp,
  date,
  index,
} from "drizzle-orm/pg-core";

export const formDOfferings = pgTable(
  "form_d_offerings",
  {
    accessionNumber: varchar("accession_number", { length: 25 }).primaryKey(),
    cik: varchar("cik", { length: 10 }),
    entityName: text("entity_name"),
    entityType: varchar("entity_type", { length: 64 }),
    jurisdiction: varchar("jurisdiction", { length: 64 }),
    yearOfIncorporation: varchar("year_of_incorporation", { length: 16 }),
    city: varchar("city", { length: 128 }),
    stateOrCountry: varchar("state_or_country", { length: 8 }),
    stateOrCountryDescription: varchar("state_or_country_description", { length: 64 }),
    filingDate: date("filing_date"),
    submissionType: varchar("submission_type", { length: 10 }),
    isAmendment: boolean("is_amendment"),
    // Date string, or the literal "YetToOccur" when the issuer marked it so.
    dateOfFirstSale: varchar("date_of_first_sale", { length: 16 }),
    industryGroup: varchar("industry_group", { length: 64 }),
    investmentFundType: varchar("investment_fund_type", { length: 64 }),
    isPooledFund: boolean("is_pooled_fund"),
    // Comma-joined exemption items, e.g. "06b,3C,3C.1"
    federalExemptions: text("federal_exemptions"),
    minimumInvestment: bigint("minimum_investment", { mode: "number" }),
    // Issuers may file the offering amount as "Indefinite" — flagged here,
    // with totalOfferingAmount left NULL in that case.
    isIndefiniteOffering: boolean("is_indefinite_offering").default(false),
    totalOfferingAmount: bigint("total_offering_amount", { mode: "number" }),
    totalAmountSold: bigint("total_amount_sold", { mode: "number" }),
    totalRemaining: bigint("total_remaining", { mode: "number" }),
    totalInvestors: integer("total_investors"),
    hasNonAccreditedInvestors: boolean("has_non_accredited_investors"),
    relatedPersonsJson: text("related_persons_json"),
    // "edgar-daily" | "dera-backfill"
    source: varchar("source", { length: 24 }).notNull(),
    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    lastUpdatedAt: timestamp("last_updated_at").notNull().defaultNow(),
    rawJson: text("raw_json"),
  },
  (t) => ({
    entityNameIdx: index("formd_entity_name_idx").on(t.entityName),
    filingDateIdx: index("formd_filing_date_idx").on(t.filingDate),
    stateIdx: index("formd_state_idx").on(t.stateOrCountry),
    cikIdx: index("formd_cik_idx").on(t.cik),
    industryIdx: index("formd_industry_idx").on(t.industryGroup),
    fundTypeIdx: index("formd_fund_type_idx").on(t.investmentFundType),
    amountIdx: index("formd_amount_idx").on(t.totalOfferingAmount),
  })
);

export type FormDOffering = typeof formDOfferings.$inferSelect;
export type FormDOfferingInsert = typeof formDOfferings.$inferInsert;
