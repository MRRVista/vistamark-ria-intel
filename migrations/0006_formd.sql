-- v0.19.0 — SEC Form D exempt-offering corpus.
-- Fed by api/cron/ingest-formd (EDGAR daily index) and
-- api/admin/backfill-formd (DERA quarterly data sets, 2008Q1 → present).
CREATE TABLE IF NOT EXISTS "form_d_offerings" (
  "accession_number" varchar(25) PRIMARY KEY NOT NULL,
  "cik" varchar(10),
  "entity_name" text,
  "entity_type" varchar(64),
  "jurisdiction" varchar(64),
  "year_of_incorporation" varchar(16),
  "city" varchar(128),
  "state_or_country" varchar(8),
  "state_or_country_description" varchar(64),
  "filing_date" date,
  "submission_type" varchar(10),
  "is_amendment" boolean,
  "date_of_first_sale" varchar(16),
  "industry_group" varchar(64),
  "investment_fund_type" varchar(64),
  "is_pooled_fund" boolean,
  "federal_exemptions" text,
  "minimum_investment" bigint,
  "is_indefinite_offering" boolean DEFAULT false,
  "total_offering_amount" bigint,
  "total_amount_sold" bigint,
  "total_remaining" bigint,
  "total_investors" integer,
  "has_non_accredited_investors" boolean,
  "related_persons_json" text,
  "source" varchar(24) NOT NULL,
  "first_seen_at" timestamp DEFAULT now() NOT NULL,
  "last_updated_at" timestamp DEFAULT now() NOT NULL,
  "raw_json" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "formd_entity_name_idx" ON "form_d_offerings" ("entity_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "formd_filing_date_idx" ON "form_d_offerings" ("filing_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "formd_state_idx" ON "form_d_offerings" ("state_or_country");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "formd_cik_idx" ON "form_d_offerings" ("cik");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "formd_industry_idx" ON "form_d_offerings" ("industry_group");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "formd_fund_type_idx" ON "form_d_offerings" ("investment_fund_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "formd_amount_idx" ON "form_d_offerings" ("total_offering_amount");
