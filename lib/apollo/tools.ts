/**
 * MCP tool handlers for Apollo.io contact + company enrichment.
 *
 * Tools:
 *   apollo_people_search      — find people by name / title / company / location (no credits)
 *   apollo_person_enrich      — reveal one person's professional email + profile (credits)
 *   apollo_people_bulk_enrich — the same for up to 10 people in one call (credits)
 *   apollo_org_search         — find companies by name / location / size (no credits)
 *   apollo_org_enrich         — one company's profile by domain (no credits)
 *   apollo_enrich_prospect    — enrich a row of OUR prospects DB in place, tagged so it
 *                               is never re-billed (credits; writes to Postgres)
 *
 * Why this family exists: the Hinsdale assessor pool, 990 board rosters, and
 * Form ADV advisor lists all give NAMES but not professional contact details.
 * Apollo is the cheapest API that fills that gap (Free plan includes API
 * access), with the same published-professional-email discipline the rest of
 * the outreach stack enforces. Personal emails and phones are opt-in flags,
 * off by default.
 */

import {
  apolloGet,
  apolloPost,
  isLockedEmail,
  type ApolloBulkMatchResponse,
  type ApolloMatchResponse,
  type ApolloOrgEnrichResponse,
  type ApolloOrgSearchResponse,
  type ApolloOrganization,
  type ApolloPeopleSearchResponse,
  type ApolloPerson,
} from "./client";
import { prospectLookup, prospectUpdate } from "../prospects/queries";

const DATA_SOURCE = "Apollo.io (apollo.io)";

// ------------------------------------------------------------- shaping

function shapePerson(p: ApolloPerson | null | undefined) {
  if (!p) return null;
  const org = p.organization ?? null;
  const email = p.email && !isLockedEmail(p.email) ? p.email : null;
  return {
    apolloId: p.id ?? null,
    firstName: p.first_name ?? null,
    lastName: p.last_name ?? null,
    name: p.name ?? [p.first_name, p.last_name].filter(Boolean).join(" ") ?? null,
    title: p.title ?? null,
    headline: p.headline ?? null,
    seniority: p.seniority ?? null,
    departments: p.departments ?? [],
    email,
    emailLocked: isLockedEmail(p.email),
    emailStatus: email ? p.email_status ?? null : null,
    personalEmails: p.personal_emails ?? [],
    phones: (p.phone_numbers ?? []).map((n) => ({
      number: n.sanitized_number ?? n.raw_number ?? null,
      type: n.type ?? null,
      status: n.status ?? null,
    })),
    linkedinUrl: p.linkedin_url ?? null,
    twitterUrl: p.twitter_url ?? null,
    location: [p.city, p.state, p.country].filter(Boolean).join(", ") || null,
    organization: org
      ? {
          apolloId: org.id ?? null,
          name: org.name ?? p.organization_name ?? null,
          domain: org.primary_domain ?? null,
          website: org.website_url ?? null,
          linkedinUrl: org.linkedin_url ?? null,
          industry: org.industry ?? null,
          employees: org.estimated_num_employees ?? null,
          location: [org.city, org.state, org.country].filter(Boolean).join(", ") || null,
        }
      : p.organization_name
        ? { apolloId: null, name: p.organization_name, domain: null, website: null, linkedinUrl: null, industry: null, employees: null, location: null }
        : null,
    employmentHistory: (p.employment_history ?? []).slice(0, 6).map((e) => ({
      organization: e.organization_name ?? null,
      title: e.title ?? null,
      start: e.start_date ?? null,
      end: e.end_date ?? null,
      current: e.current ?? null,
    })),
  };
}

function shapeOrg(o: ApolloOrganization | null | undefined) {
  if (!o) return null;
  return {
    apolloId: o.id ?? null,
    name: o.name ?? null,
    domain: o.primary_domain ?? null,
    website: o.website_url ?? null,
    linkedinUrl: o.linkedin_url ?? null,
    industry: o.industry ?? null,
    description: o.short_description ? `${o.short_description.slice(0, 400)}${o.short_description.length > 400 ? "…" : ""}` : null,
    foundedYear: o.founded_year ?? null,
    employees: o.estimated_num_employees ?? null,
    annualRevenue: o.annual_revenue ?? null,
    annualRevenuePrinted: o.annual_revenue_printed ?? null,
    totalFunding: o.total_funding ?? null,
    ticker: o.publicly_traded_symbol ? `${o.publicly_traded_symbol}${o.publicly_traded_exchange ? ` (${o.publicly_traded_exchange})` : ""}` : null,
    phone: o.phone ?? null,
    address: o.raw_address ?? [o.street_address, o.city, o.state, o.postal_code, o.country].filter(Boolean).join(", ") ?? null,
    location: [o.city, o.state, o.country].filter(Boolean).join(", ") || null,
    keywords: (o.keywords ?? []).slice(0, 25),
    technologies: (o.technology_names ?? []).slice(0, 25),
  };
}

function csvList(v: string[] | string | undefined): string[] | undefined {
  if (v == null) return undefined;
  const arr = Array.isArray(v) ? v : String(v).split(",");
  const out = arr.map((s) => s.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

// -------------------------------------------------------- people search

export interface ApolloPeopleSearchArgs {
  q?: string;
  personName?: string;
  titles?: string[] | string;
  seniorities?: string[] | string;
  organizationNames?: string[] | string;
  organizationDomains?: string[] | string;
  personLocations?: string[] | string;
  organizationLocations?: string[] | string;
  page?: number;
  perPage?: number;
}

export async function apolloPeopleSearch(args: ApolloPeopleSearchArgs) {
  const perPage = Math.min(Math.max(args.perPage ?? 10, 1), 100);
  const res = await apolloPost<ApolloPeopleSearchResponse>("mixed_people/search", {
    q_keywords: args.q,
    q_person_name: args.personName,
    person_titles: csvList(args.titles),
    person_seniorities: csvList(args.seniorities),
    q_organization_name: Array.isArray(args.organizationNames) ? args.organizationNames.join(" ") : args.organizationNames,
    q_organization_domains_list: csvList(args.organizationDomains),
    person_locations: csvList(args.personLocations),
    organization_locations: csvList(args.organizationLocations),
    page: args.page ?? 1,
    per_page: perPage,
  });
  const people = [...(res.people ?? []), ...(res.contacts ?? [])];
  return {
    dataSource: DATA_SOURCE,
    creditsSpent: 0,
    note: "Search results never spend credits, so emails come back LOCKED (emailLocked:true). Pick the right person, then call apollo_person_enrich with their apolloId (or name + organization) to reveal the professional email — that is the call that costs a credit. Titles/seniorities/locations are Apollo's free-text filters (seniorities: owner, founder, c_suite, partner, vp, head, director, manager, senior, entry).",
    pagination: res.pagination ?? null,
    people: people.map(shapePerson),
  };
}

// -------------------------------------------------------- person enrich

export interface ApolloPersonEnrichArgs {
  apolloId?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  organizationName?: string;
  domain?: string;
  linkedinUrl?: string;
  revealPersonalEmails?: boolean;
  revealPhoneNumber?: boolean;
}

function matchBody(a: ApolloPersonEnrichArgs): Record<string, unknown> {
  return {
    id: a.apolloId,
    first_name: a.firstName,
    last_name: a.lastName,
    name: a.name,
    email: a.email,
    organization_name: a.organizationName,
    domain: a.domain,
    linkedin_url: a.linkedinUrl,
  };
}

function hasIdentity(a: ApolloPersonEnrichArgs): boolean {
  return !!(a.apolloId || a.email || a.linkedinUrl || ((a.name || (a.firstName && a.lastName)) && (a.organizationName || a.domain)));
}

export async function apolloPersonEnrich(args: ApolloPersonEnrichArgs) {
  if (!hasIdentity(args)) {
    return {
      dataSource: DATA_SOURCE,
      error: "Not enough to match on. Provide apolloId, OR email, OR linkedinUrl, OR a name (name / firstName+lastName) together with organizationName or domain.",
      person: null,
    };
  }
  const res = await apolloPost<ApolloMatchResponse>("people/match", {
    ...matchBody(args),
    reveal_personal_emails: !!args.revealPersonalEmails,
    reveal_phone_number: !!args.revealPhoneNumber,
  });
  const person = shapePerson(res.person);
  return {
    dataSource: DATA_SOURCE,
    matched: !!person,
    creditsSpent: person?.email ? 1 : 0,
    note: "emailStatus 'verified' is deliverable; 'guessed' is a pattern inference — still validate (ZeroBounce/NeverBounce) before anything sends. Personal emails and phones are only returned when their reveal flags are passed. A null person means Apollo has no record, not an error.",
    person,
  };
}

// ---------------------------------------------------- people bulk enrich

export interface ApolloPeopleBulkEnrichArgs {
  people: ApolloPersonEnrichArgs[];
  revealPersonalEmails?: boolean;
  revealPhoneNumber?: boolean;
}

export async function apolloPeopleBulkEnrich(args: ApolloPeopleBulkEnrichArgs) {
  const details = (args.people ?? []).slice(0, 10);
  if (!details.length) return { dataSource: DATA_SOURCE, error: "Provide 1–10 people.", matches: [] };
  const bad = details.map((d, i) => (hasIdentity(d) ? null : i)).filter((i) => i != null);
  if (bad.length) {
    return { dataSource: DATA_SOURCE, error: `people[${bad.join(", ")}] lack a matchable identity (apolloId | email | linkedinUrl | name + organizationName/domain).`, matches: [] };
  }
  const res = await apolloPost<ApolloBulkMatchResponse>("people/bulk_match", {
    details: details.map(matchBody),
    reveal_personal_emails: !!args.revealPersonalEmails,
    reveal_phone_number: !!args.revealPhoneNumber,
  });
  const matches = (res.matches ?? []).map(shapePerson);
  return {
    dataSource: DATA_SOURCE,
    requested: details.length,
    matched: matches.filter(Boolean).length,
    creditsSpent: res.credits_consumed ?? matches.filter((m) => m?.email).length,
    note: "matches[] is positional — index i answers people[i]; null means no Apollo record. Max 10 per call (Apollo's bulk cap).",
    matches,
  };
}

// ------------------------------------------------------------ org search

export interface ApolloOrgSearchArgs {
  name?: string;
  locations?: string[] | string;
  employeeRanges?: string[] | string;
  industryKeywords?: string[] | string;
  page?: number;
  perPage?: number;
}

export async function apolloOrgSearch(args: ApolloOrgSearchArgs) {
  if (!args.name && !args.locations && !args.industryKeywords) {
    return { dataSource: DATA_SOURCE, error: "Provide at least one of name, locations, industryKeywords.", organizations: [] };
  }
  const perPage = Math.min(Math.max(args.perPage ?? 10, 1), 100);
  const res = await apolloPost<ApolloOrgSearchResponse>("mixed_companies/search", {
    q_organization_name: args.name,
    organization_locations: csvList(args.locations),
    organization_num_employees_ranges: csvList(args.employeeRanges),
    q_organization_keyword_tags: csvList(args.industryKeywords),
    page: args.page ?? 1,
    per_page: perPage,
  });
  const orgs = [...(res.organizations ?? []), ...(res.accounts ?? [])];
  return {
    dataSource: DATA_SOURCE,
    creditsSpent: 0,
    note: "Company search never spends credits. employeeRanges use Apollo's 'min,max' strings (e.g. '11,50', '51,200', '1001,5000'). Use the returned domain with apollo_org_enrich for the full profile, or with apollo_people_search (organizationDomains) to list its people.",
    pagination: res.pagination ?? null,
    organizations: orgs.map(shapeOrg),
  };
}

// ------------------------------------------------------------ org enrich

export interface ApolloOrgEnrichArgs {
  domain: string;
}

export async function apolloOrgEnrich(args: ApolloOrgEnrichArgs) {
  const domain = (args.domain ?? "").trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0]!;
  if (!domain) return { dataSource: DATA_SOURCE, error: "domain is required (e.g. 'vistamark.com').", organization: null };
  const res = await apolloGet<ApolloOrgEnrichResponse>("organizations/enrich", { domain });
  return {
    dataSource: DATA_SOURCE,
    domain,
    creditsSpent: 0,
    note: "Company profile as held by Apollo — revenue and headcount are estimates. For the SEC-filed numbers use edgar_* tools; for 990 figures use propublica_org_990.",
    organization: shapeOrg(res.organization),
  };
}

// --------------------------------------------------- enrich OUR prospect

/**
 * Enrich one row of the first-party prospects DB in place.
 *
 * Billing discipline mirrors lib/prospects/append.ts: every attempt stamps
 * `append:apollo:tried`, a hit also stamps `email:apollo`, and a row already
 * carrying the tried tag is skipped unless force=true. Emails land as
 * emailStatus='unverified' and email_opt_in untouched — the ZeroBounce /
 * NeverBounce pass and the draft-then-approve gate are unchanged downstream.
 * An existing email is never overwritten unless overwriteEmail=true.
 */
export interface ApolloEnrichProspectArgs {
  prospectId: number;
  organizationName?: string;
  domain?: string;
  linkedinUrl?: string;
  revealPersonalEmails?: boolean;
  force?: boolean;
  overwriteEmail?: boolean;
  dryRun?: boolean;
  actor?: string;
}

const TRIED_TAG = "append:apollo:tried";
const HIT_TAG = "email:apollo";

export async function apolloEnrichProspect(args: ApolloEnrichProspectArgs) {
  if (args.prospectId == null) return { dataSource: DATA_SOURCE, error: "prospectId is required." };
  const found = await prospectLookup({ id: Number(args.prospectId) });
  const row = (found as any)?.row;
  if (!row) return { dataSource: DATA_SOURCE, prospectId: args.prospectId, error: "No such prospect." };

  const tags: string[] = row.tags ?? [];
  if (tags.includes(TRIED_TAG) && !args.force) {
    return {
      dataSource: DATA_SOURCE,
      prospectId: row.id,
      skipped: true,
      reason: `Already attempted (tag ${TRIED_TAG}); pass force=true to retry and spend a credit.`,
      currentEmail: row.email ?? null,
    };
  }
  if (row.consent?.doNotContact) {
    return { dataSource: DATA_SOURCE, prospectId: row.id, skipped: true, reason: "do-not-contact is set; not enriching." };
  }

  const firstName = row.name?.first ?? undefined;
  const lastName = row.name?.last ?? undefined;
  const organizationName = args.organizationName ?? row.profile?.employer ?? undefined;
  const linkedinUrl = args.linkedinUrl ?? row.profile?.linkedinUrl ?? undefined;
  const matchArgs: ApolloPersonEnrichArgs = {
    firstName,
    lastName,
    organizationName,
    domain: args.domain,
    linkedinUrl,
    revealPersonalEmails: !!args.revealPersonalEmails,
  };
  if (!hasIdentity(matchArgs)) {
    return {
      dataSource: DATA_SOURCE,
      prospectId: row.id,
      skipped: true,
      reason: "Prospect has no employer or LinkedIn URL on record, so Apollo cannot match on name alone. Pass organizationName, domain, or linkedinUrl.",
    };
  }
  if (args.dryRun) {
    return { dataSource: DATA_SOURCE, prospectId: row.id, dryRun: true, wouldMatchOn: matchArgs, currentEmail: row.email ?? null };
  }

  let result: Awaited<ReturnType<typeof apolloPersonEnrich>>;
  try {
    result = await apolloPersonEnrich(matchArgs);
  } catch (e) {
    // Our failure (network, quota, bad key) — never mark the prospect tried.
    return { dataSource: DATA_SOURCE, prospectId: row.id, error: e instanceof Error ? e.message : String(e), markedTried: false };
  }

  const person = result.person;
  const addTags = [TRIED_TAG];
  const update: Parameters<typeof prospectUpdate>[0] = { id: row.id, actor: args.actor ?? "apollo_enrich_prospect" };
  const changes: string[] = [];

  if (person) {
    if (person.email && (!row.email || args.overwriteEmail)) {
      update.email = person.email;
      addTags.push(HIT_TAG);
      changes.push(`email (${person.emailStatus ?? "unknown"})`);
    }
    if (person.title && !row.profile?.title) { update.title = person.title; changes.push("title"); }
    if (person.organization?.name && !row.profile?.employer) { update.employer = person.organization.name; changes.push("employer"); }
    if (person.linkedinUrl && !row.profile?.linkedinUrl) { update.linkedinUrl = person.linkedinUrl; changes.push("linkedinUrl"); }
    if (person.seniority && /^(owner|founder|c_suite|partner|vp)$/.test(person.seniority)) {
      update.wealthSignals = { apolloSeniority: person.seniority };
    }
  }
  update.addTags = addTags;
  update.event = {
    kind: "enrich",
    detail: person ? `apollo match: ${changes.length ? changes.join(", ") : "no new fields"}` : "apollo: no match",
    meta: { provider: "apollo", apolloId: person?.apolloId ?? null, emailStatus: person?.emailStatus ?? null, creditsSpent: result.creditsSpent },
  };

  const saved = await prospectUpdate(update);
  return {
    dataSource: DATA_SOURCE,
    prospectId: row.id,
    matched: !!person,
    creditsSpent: result.creditsSpent,
    fieldsUpdated: changes,
    tagsAdded: addTags,
    note: "Email (if any) saved as emailStatus='unverified'; validate before it can be contactable. The attempt is tagged so this row is never re-billed without force=true.",
    person,
    row: saved.row,
  };
}
