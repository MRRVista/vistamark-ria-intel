-- v0.41.0 -- Lawyer COI outreach: one follow-up after no reply.
--
-- conversation_id is captured when the draft is created (a sent draft gets a
-- new message id, the conversation id survives). The follow-up pass reads the
-- conversation: sent and unanswered past the card's followUpDays -> one reply
-- draft in the same thread; answered -> followup_state 'replied'.
-- lib/lawyer/engine.ts ensureLawyerSchema() applies the same statements, so a
-- deploy that has not run migrations yet still works.

ALTER TABLE lawyer_leads ADD COLUMN IF NOT EXISTS conversation_id TEXT;
--> statement-breakpoint
ALTER TABLE lawyer_leads ADD COLUMN IF NOT EXISTS sent_at TIMESTAMP;
--> statement-breakpoint
ALTER TABLE lawyer_leads ADD COLUMN IF NOT EXISTS replied_at TIMESTAMP;
--> statement-breakpoint
ALTER TABLE lawyer_leads ADD COLUMN IF NOT EXISTS followup_state VARCHAR(24);
--> statement-breakpoint
ALTER TABLE lawyer_leads ADD COLUMN IF NOT EXISTS followup_at TIMESTAMP;
--> statement-breakpoint
ALTER TABLE lawyer_leads ADD COLUMN IF NOT EXISTS followup_message_id TEXT;
--> statement-breakpoint
ALTER TABLE lawyer_leads ADD COLUMN IF NOT EXISTS followup_checked_at TIMESTAMP;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS lawyer_leads_followup_idx ON lawyer_leads (status, followup_state, created_at);
