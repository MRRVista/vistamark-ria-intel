/**
 * Keyed, low-cost contact tools — Hunter.io and ZeroBounce.
 *
 * PROFESSIONAL-ONLY: these resolve and validate WORK addresses at a company domain.
 * There is no option to reveal personal/webmail addresses, and Hunter results whose
 * address is webmail are dropped. Nothing found here is contactable until it has
 * passed validation (zerobounce_validate or hunter_email_verifier) AND the
 * draft-then-approve gate.
 *
 * Hunter.io v2 (https://api.hunter.io/v2, key HUNTER_API_KEY, query param api_key):
 *   GET /domain-search  domain|company, limit(≤100), offset, type=personal|generic,
 *                       seniority=junior,senior,executive, department=executive,finance,...
 *   GET /email-finder   domain|company + first_name/last_name|full_name, max_duration 3-20
 *   GET /email-verifier email  (202 = still running → poll the same request)
 *   GET /account        plan + requests used/available (free)
 *   Errors: {"errors":[{"id","code","details"}]} — verified live: unauthenticated call
 *   returns 401 authentication_failed.
 *
 * ZeroBounce v2 (key ZEROBOUNCE_API_KEY; base https://api.zerobounce.net, regional
 * api-us./api-eu. variants — set ZEROBOUNCE_API_BASE to override):
 *   GET  /v2/validate?api_key&email[&ip_address&timeout]
 *   POST /v2/validatebatch {api_key, email_batch:[{email_address, ip_address}], timeout} (≤200/call)
 *        → {email_batch:[...], errors:[{error, email_address}]}
 *   GET  /v2/getcredits?api_key → {"Credits": n}  (-1 = invalid key)
 *   Error shape: {"error":"Invalid API Key or your account ran out of credits"}.
 *   Note: the endpoint sits behind Cloudflare and rejected our anonymous probe from this
 *   sandbox with 1020 — re-verify from Vercel once a key is set.
 */
import { politeFetch, redactUrl } from "../data/http";

const HUNTER_BASE = "https://api.hunter.io/v2";
const ZB_BASE = () => (process.env.ZEROBOUNCE_API_BASE || "https://api.zerobounce.net").replace(/\/+$/, "");

const VALIDATION_GATE =
  "Not contactable yet: every address must pass validation (zerobounce_validate, or hunter_email_verifier status 'valid') and the draft-then-approve gate before anything sends.";

function hunterKey(): string {
  const k = process.env.HUNTER_API_KEY;
  if (!k) throw new Error("HUNTER_API_KEY not set — add it in Vercel to enable hunter_* tools");
  return k;
}

function zbKey(): string {
  const k = process.env.ZEROBOUNCE_API_KEY;
  if (!k) throw new Error("ZEROBOUNCE_API_KEY not set — add it in Vercel to enable zerobounce_* tools");
  return k;
}

function cleanDomain(d: string): string {
  return String(d)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "");
}

const WEBMAIL = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|comcast|att|sbcglobal|verizon|protonmail|proton|gmx|mail|zoho)\.(com|net|me)$/i;

async function hunterGet(path: string, params: Record<string, string | number | undefined>, timeoutMs = 25000): Promise<{ status: number; body: any }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  qs.set("api_key", hunterKey());
  const url = `${HUNTER_BASE}${path}?${qs}`;
  const res = await politeFetch(url, { timeoutMs, retries: 1 });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!res.ok && res.status !== 202) {
    const e = body?.errors?.[0];
    const detail = e ? `${e.id ?? ""} ${e.details ?? ""}`.trim() : redactUrl(text).slice(0, 200);
    throw new Error(`Hunter ${path} HTTP ${res.status}: ${redactUrl(detail)}`);
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Hunter
// ---------------------------------------------------------------------------

export async function hunterDomainSearch(args: {
  domain?: string;
  company?: string;
  seniority?: string[] | string;
  department?: string[] | string;
  type?: "personal" | "generic";
  limit?: number;
  offset?: number;
}) {
  if (!args.domain && !args.company) throw new Error("hunter_domain_search needs `domain` (preferred) or `company`");
  const list = (v: unknown) => (Array.isArray(v) ? v.join(",") : v ? String(v) : undefined);
  const limit = Math.min(Math.max(1, Math.floor(Number(args.limit) || 10)), 100);
  const { body } = await hunterGet("/domain-search", {
    domain: args.domain ? cleanDomain(args.domain) : undefined,
    company: args.domain ? undefined : args.company,
    seniority: list(args.seniority),
    department: list(args.department),
    type: args.type,
    limit,
    offset: args.offset,
  });
  const d = body?.data ?? {};
  const emails = Array.isArray(d.emails) ? d.emails : [];
  const people = emails
    .filter((e: any) => e?.value && !WEBMAIL.test(e.value))
    .map((e: any) => ({
      email: e.value,
      type: e.type ?? null,
      confidence: e.confidence ?? null,
      firstName: e.first_name ?? null,
      lastName: e.last_name ?? null,
      position: e.position ?? null,
      seniority: e.seniority ?? null,
      department: e.department ?? null,
      linkedin: e.linkedin ?? null,
      verification: e.verification?.status ?? null,
      verifiedOn: e.verification?.date ?? null,
      sourceCount: Array.isArray(e.sources) ? e.sources.length : null,
    }));
  return {
    dataSource: "Hunter.io Domain Search v2",
    domain: d.domain ?? args.domain ?? null,
    organization: d.organization ?? null,
    pattern: d.pattern ?? null,
    acceptAll: d.accept_all ?? null,
    webmailDomain: d.webmail ?? null,
    totalResults: body?.meta?.results ?? null,
    count: people.length,
    emails: people,
    sampleRaw: !people.length && emails.length ? emails[0] : undefined,
    note: `Costs 1 Hunter search credit per call (per 10 emails). acceptAll=true means the server accepts any address, so confidence is capped and verification is inconclusive. ${VALIDATION_GATE}`,
  };
}

export async function hunterEmailFinder(args: {
  domain?: string;
  company?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  maxDuration?: number;
}) {
  if (!args.domain && !args.company) throw new Error("hunter_email_finder needs `domain` (preferred) or `company`");
  if (!(args.firstName && args.lastName) && !args.fullName) throw new Error("hunter_email_finder needs firstName + lastName, or fullName");
  const { body } = await hunterGet(
    "/email-finder",
    {
      domain: args.domain ? cleanDomain(args.domain) : undefined,
      company: args.domain ? undefined : args.company,
      first_name: args.firstName,
      last_name: args.lastName,
      full_name: args.firstName && args.lastName ? undefined : args.fullName,
      max_duration: args.maxDuration ? Math.min(20, Math.max(3, Math.floor(args.maxDuration))) : undefined,
    },
    30000
  );
  const d = body?.data ?? {};
  const email = d.email && !WEBMAIL.test(d.email) ? d.email : null;
  return {
    dataSource: "Hunter.io Email Finder v2",
    found: !!email,
    email,
    score: email ? d.score ?? null : null,
    firstName: d.first_name ?? args.firstName ?? null,
    lastName: d.last_name ?? args.lastName ?? null,
    position: d.position ?? null,
    company: d.company ?? null,
    domain: d.domain ?? args.domain ?? null,
    acceptAll: d.accept_all ?? null,
    verification: d.verification?.status ?? null,
    verifiedOn: d.verification?.date ?? null,
    sourceCount: Array.isArray(d.sources) ? d.sources.length : null,
    note: `Costs 1 Hunter search credit only when an email is returned. score is Hunter's 0-100 confidence; <70 or acceptAll=true is a guess. ${VALIDATION_GATE}`,
  };
}

export async function hunterEmailVerifier(args: { email: string }) {
  if (!args.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(args.email)) throw new Error("hunter_email_verifier needs a syntactically valid `email`");
  let r = await hunterGet("/email-verifier", { email: args.email.trim() }, 30000);
  // 202 = verification still running; Hunter says re-issue the same request (counts once).
  for (let i = 0; i < 2 && r.status === 202; i++) {
    await new Promise((res) => setTimeout(res, 3000));
    r = await hunterGet("/email-verifier", { email: args.email.trim() }, 30000);
  }
  const d = r.body?.data ?? {};
  return {
    dataSource: "Hunter.io Email Verifier v2",
    email: d.email ?? args.email,
    pending: r.status === 202 || undefined,
    status: d.status ?? null,
    score: d.score ?? null,
    acceptAll: d.accept_all ?? null,
    webmail: d.webmail ?? null,
    disposable: d.disposable ?? null,
    mxRecords: d.mx_records ?? null,
    smtpCheck: d.smtp_check ?? null,
    block: d.block ?? null,
    note:
      "status: valid (safe to send after approval), invalid (never send), accept_all / unknown (risky — prefer zerobounce_validate as the tie-breaker), webmail (personal address — out of scope for outreach), disposable (never). Costs 1 Hunter verification credit. " +
      (r.status === 202 ? "Still pending after polling — call again in ~30s." : ""),
  };
}

// ---------------------------------------------------------------------------
// ZeroBounce
// ---------------------------------------------------------------------------

function shapeZb(r: any) {
  return {
    email: r.address ?? null,
    status: r.status ?? null,
    subStatus: r.sub_status || null,
    freeEmail: r.free_email ?? null,
    catchAllDomain: r.catchall_domain ?? null,
    didYouMean: r.did_you_mean || null,
    mxFound: r.mx_found === true || r.mx_found === "true" ? true : r.mx_found === false || r.mx_found === "false" ? false : null,
    mxRecord: r.mx_record || null,
    smtpProvider: r.smtp_provider || null,
    domainAgeDays: r.domain_age_days != null && r.domain_age_days !== "" ? Number(r.domain_age_days) : null,
    activeInDays: r.active_in_days || null,
    processedAt: r.processed_at ?? null,
    sendable: r.status === "valid" && r.free_email !== true && r.free_email !== "true",
  };
}

async function zbJson(res: Response, label: string): Promise<any> {
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`ZeroBounce ${label} HTTP ${res.status}: non-JSON response ${redactUrl(text).slice(0, 120)}`);
  }
  if (!res.ok) throw new Error(`ZeroBounce ${label} HTTP ${res.status}: ${redactUrl(String(body?.error ?? text)).slice(0, 200)}`);
  if (body && typeof body.error === "string" && body.error) throw new Error(`ZeroBounce ${label}: ${redactUrl(body.error)}`);
  return body;
}

export async function zerobounceValidate(args: { emails?: string[] | string; email?: string; timeout?: number }) {
  const key = zbKey();
  const raw = args.emails ?? (args.email ? [args.email] : []);
  const list = [...new Set((Array.isArray(raw) ? raw : String(raw).split(/[,;\s]+/)).map((e) => String(e).trim()).filter(Boolean))];
  if (!list.length) throw new Error("zerobounce_validate needs `email` or `emails`");
  if (list.length > 50) throw new Error("zerobounce_validate accepts at most 50 emails per call — split the list");
  const bad = list.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  const good = list.filter((e) => !bad.includes(e));
  let results: any[] = [];
  const errors: any[] = bad.map((e) => ({ email: e, error: "not an email address (not sent)" }));
  const timeout = args.timeout ? Math.min(60, Math.max(3, Math.floor(args.timeout))) : undefined;

  if (good.length === 1) {
    const qs = new URLSearchParams({ api_key: key, email: good[0], ip_address: "" });
    if (timeout) qs.set("timeout", String(timeout));
    const res = await politeFetch(`${ZB_BASE()}/v2/validate?${qs}`, { timeoutMs: 65000, retries: 1 });
    results = [shapeZb(await zbJson(res, "validate"))];
  } else if (good.length > 1) {
    const res = await politeFetch(`${ZB_BASE()}/v2/validatebatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        api_key: key,
        email_batch: good.map((e) => ({ email_address: e, ip_address: null })),
        ...(timeout ? { timeout: Math.max(10, timeout) } : {}),
      }),
      timeoutMs: 90000,
      retries: 0,
    });
    const body = await zbJson(res, "validatebatch");
    results = (Array.isArray(body?.email_batch) ? body.email_batch : []).map(shapeZb);
    for (const e of Array.isArray(body?.errors) ? body.errors : []) {
      if (e?.email_address === "all") throw new Error(`ZeroBounce validatebatch: ${redactUrl(String(e.error))}`);
      errors.push({ email: e?.email_address ?? null, error: e?.error ?? null });
    }
  }
  const tally: Record<string, number> = {};
  for (const r of results) tally[r.status ?? "null"] = (tally[r.status ?? "null"] ?? 0) + 1;
  return {
    dataSource: `ZeroBounce v2 ${good.length > 1 ? "validatebatch" : "validate"}`,
    count: results.length,
    statusCounts: tally,
    results,
    errors: errors.length ? errors : undefined,
    note:
      "This is the REQUIRED validation step before anything sends. Only status 'valid' with freeEmail=false (sendable=true) may proceed to the draft-then-approve gate. invalid / spamtrap / abuse / do_not_mail: never send and mark the row. catch-all / unknown: hold (do not send cold). freeEmail=true is a personal address — out of scope for professional outreach. 1 credit per email; unknown results are not charged.",
  };
}

export async function zerobounceCredits() {
  const key = zbKey();
  const res = await politeFetch(`${ZB_BASE()}/v2/getcredits?${new URLSearchParams({ api_key: key })}`, { timeoutMs: 15000, retries: 1 });
  const body = await zbJson(res, "getcredits");
  const credits = Number(body?.Credits ?? body?.credits);
  if (credits === -1) throw new Error("ZeroBounce getcredits: invalid API key (Credits -1)");
  return {
    dataSource: "ZeroBounce v2 getcredits",
    credits: Number.isFinite(credits) ? credits : null,
    sampleRaw: Number.isFinite(credits) ? undefined : body,
    note: "Remaining validation credits (1 per email validated). Free; does not consume credits.",
  };
}

export async function hunterAccount() {
  const { body } = await hunterGet("/account", {});
  const d = body?.data ?? {};
  return {
    dataSource: "Hunter.io Account v2",
    plan: d.plan_name ?? null,
    resetDate: d.reset_date ?? null,
    requests: d.requests ?? null,
    note: "Free call — shows remaining search and verification credits for the period.",
  };
}
