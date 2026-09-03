/**
 * Prospect record normalization — the dedupe backbone.
 *
 * Two identity keys are derived from every inbound record:
 *   addressKey  'LINE1|ZIP5'                 — one per physical household
 *   personKey   'ZIP5|LAST|FIRST|LINE1'      — one per person at that address
 *               'EMAIL|<email>'              — fallback when no street address
 *
 * The upsert in store.ts matches on email_normalized FIRST, then on personKey,
 * so a purchased list that spells "123 N. Main Street" and a form submission
 * that says "123 North Main St" land on the same row, and a later record that
 * finally supplies an email attaches to the earlier one rather than forking.
 *
 * Everything here is pure and synchronous so it can be unit-tested without a
 * database.
 */

export interface ProspectInput {
  firstName?: string | null;
  middleName?: string | null;
  lastName?: string | null;
  suffix?: string | null;
  fullName?: string | null;
  email?: string | null;
  phone?: string | null;
  phoneMobile?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | number | null;
  zip5?: string | null;
  zip4?: string | null;
  county?: string | null;
  ageBand?: string | null;
  birthYear?: number | string | null;
  occupation?: string | null;
  employer?: string | null;
  title?: string | null;
  industry?: string | null;
  linkedinUrl?: string | null;
  estNetWorthBand?: string | null;
  estInvestableAssets?: number | string | null;
  estIncomeBand?: string | null;
  isBusinessOwner?: boolean | string | null;
  isExecutive?: boolean | string | null;
  hasTrust?: boolean | string | null;
  wealthSignals?: Record<string, unknown> | null;
  leadScore?: number | string | null;
  leadStatus?: string | null;
  emailOptIn?: boolean | string | null;
  optInSource?: string | null;
  doNotContact?: boolean | string | null;
  doNotEmail?: boolean | string | null;
  doNotCall?: boolean | string | null;
  doNotMail?: boolean | string | null;
  // household-level
  homeValue?: number | string | null;
  homeValueSource?: string | null;
  homeValueAsOf?: string | null;
  yearBuilt?: number | string | null;
  sqFt?: number | string | null;
  lotAcres?: number | string | null;
  ownerOccupied?: boolean | string | null;
  purchaseDate?: string | null;
  purchasePrice?: number | string | null;
  estHouseholdIncome?: number | string | null;
  householdSize?: number | string | null;
  householdName?: string | null;
  // provenance
  source?: string | null;
  sourceDetail?: string | null;
  sourceRecordId?: string | null;
  acquiredAt?: string | null;
  tags?: string[] | string | null;
  notes?: string | null;
  raw?: Record<string, unknown> | null;
}

export interface NormalizedProspect {
  personKey: string;
  addressKey: string | null;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  suffix: string | null;
  fullName: string;
  email: string | null;
  emailNormalized: string | null;
  phone: string | null;
  phoneMobile: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip5: string;
  zip4: string | null;
  county: string | null;
  ageBand: string | null;
  birthYear: number | null;
  occupation: string | null;
  employer: string | null;
  title: string | null;
  industry: string | null;
  linkedinUrl: string | null;
  estNetWorthBand: string | null;
  estInvestableAssets: number | null;
  estIncomeBand: string | null;
  isBusinessOwner: boolean | null;
  isExecutive: boolean | null;
  hasTrust: boolean | null;
  wealthSignals: Record<string, unknown>;
  leadScore: number | null;
  leadStatus: string | null;
  emailOptIn: boolean | null;
  optInSource: string | null;
  doNotContact: boolean | null;
  doNotEmail: boolean | null;
  doNotCall: boolean | null;
  doNotMail: boolean | null;
  household: {
    householdName: string | null;
    homeValue: number | null;
    homeValueSource: string | null;
    homeValueAsOf: string | null;
    yearBuilt: number | null;
    sqFt: number | null;
    lotAcres: number | null;
    ownerOccupied: boolean | null;
    purchaseDate: string | null;
    purchasePrice: number | null;
    estHouseholdIncome: number | null;
    householdSize: number | null;
  };
  source: string;
  sourceDetail: string | null;
  sourceRecordId: string | null;
  acquiredAt: string | null;
  tags: string[] | null;
  notes: string | null;
  raw: Record<string, unknown> | null;
}

export const LEAD_STATUSES = [
  "new",
  "researching",
  "qualified",
  "contacted",
  "meeting",
  "client",
  "disqualified",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const EMAIL_STATUSES = ["unknown", "unverified", "valid", "invalid", "bounced"] as const;

// ---------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------

export function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

export function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  // "$1,250,000", "1.25M", "850k"
  let s = String(v).trim().replace(/[$,\s]/g, "");
  if (!s) return null;
  let mult = 1;
  const m = s.match(/^(-?[\d.]+)([kKmMbB])$/);
  if (m) {
    s = m[1];
    mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()] ?? 1;
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * mult) : null;
}

/** Like num() but keeps decimals (acres, coordinates). */
export function dec(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function int(v: unknown): number | null {
  const n = num(v);
  return n == null ? null : Math.trunc(n);
}

export function bool(v: unknown): boolean | null {
  if (v == null || v === "") return null;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["1", "y", "yes", "true", "t", "x", "owner", "own"].includes(s)) return true;
  if (["0", "n", "no", "false", "f", "renter", "rent"].includes(s)) return false;
  return null;
}

export function isoDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // MM/DD/YYYY or M/D/YY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const yy = m[3].length === 2 ? Number(m[3]) + (Number(m[3]) > 40 ? 1900 : 2000) : Number(m[3]);
    return `${yy}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function tagsList(v: unknown): string[] | null {
  if (v == null) return null;
  const arr = Array.isArray(v) ? v : String(v).split(/[;,|]/);
  const out = Array.from(
    new Set(arr.map((t) => String(t).trim().toLowerCase()).filter(Boolean))
  );
  return out.length ? out : null;
}

// ---------------------------------------------------------------------------
// Email / phone / zip
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(v: unknown): { email: string | null; normalized: string | null; valid: boolean } {
  const s = str(v);
  if (!s) return { email: null, normalized: null, valid: false };
  const email = s.replace(/^mailto:/i, "").trim();
  if (!EMAIL_RE.test(email)) return { email, normalized: null, valid: false };
  const [local, domain] = email.toLowerCase().split("@");
  // Gmail ignores dots and +tags in the local part.
  const isGmail = domain === "gmail.com" || domain === "googlemail.com";
  const cleanLocal = isGmail ? local.split("+")[0].replace(/\./g, "") : local.split("+")[0];
  return { email, normalized: `${cleanLocal}@${isGmail ? "gmail.com" : domain}`, valid: true };
}

export function normalizePhone(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith("1"))
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return s;
}

export function normalizeZip(v: unknown): { zip5: string | null; zip4: string | null } {
  if (v == null || v === "") return { zip5: null, zip4: null };
  const raw = String(v).trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return { zip5: null, zip4: null };
  if (digits.length <= 5) {
    // Excel strips leading zeros from New England zips; pad back.
    return { zip5: digits.padStart(5, "0"), zip4: null };
  }
  if (digits.length === 9) return { zip5: digits.slice(0, 5), zip4: digits.slice(5) };
  // 6-8 digits: ambiguous (zip + partial plus-4); keep the first five.
  return { zip5: digits.slice(0, 5), zip4: null };
}

export function normalizeState(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const up = s.toUpperCase();
  if (/^[A-Z]{2}$/.test(up)) return up;
  return STATE_BY_NAME[up] ?? null;
}

const STATE_BY_NAME: Record<string, string> = {
  ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA", COLORADO: "CO",
  CONNECTICUT: "CT", DELAWARE: "DE", FLORIDA: "FL", GEORGIA: "GA", HAWAII: "HI", IDAHO: "ID",
  ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA", KANSAS: "KS", KENTUCKY: "KY", LOUISIANA: "LA",
  MAINE: "ME", MARYLAND: "MD", MASSACHUSETTS: "MA", MICHIGAN: "MI", MINNESOTA: "MN",
  MISSISSIPPI: "MS", MISSOURI: "MO", MONTANA: "MT", NEBRASKA: "NE", NEVADA: "NV",
  "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY",
  "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", OHIO: "OH", OKLAHOMA: "OK", OREGON: "OR",
  PENNSYLVANIA: "PA", "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD",
  TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT", VERMONT: "VT", VIRGINIA: "VA", WASHINGTON: "WA",
  "WEST VIRGINIA": "WV", WISCONSIN: "WI", WYOMING: "WY", "DISTRICT OF COLUMBIA": "DC",
};

// ---------------------------------------------------------------------------
// Address normalization (USPS Pub. 28 style abbreviations, deliberately partial)
// ---------------------------------------------------------------------------

const SUFFIX: Record<string, string> = {
  STREET: "ST", STR: "ST", AVENUE: "AVE", AV: "AVE", ROAD: "RD", DRIVE: "DR", DRV: "DR",
  LANE: "LN", LA: "LN", COURT: "CT", CRT: "CT", PLACE: "PL", BOULEVARD: "BLVD", BOUL: "BLVD",
  CIRCLE: "CIR", CRCL: "CIR", TERRACE: "TER", TERR: "TER", PARKWAY: "PKWY", PKY: "PKWY",
  HIGHWAY: "HWY", TRAIL: "TRL", TR: "TRL", WAY: "WAY", SQUARE: "SQ", LOOP: "LOOP", RUN: "RUN",
  PATH: "PATH", POINT: "PT", PLAZA: "PLZ", CROSSING: "XING", EXTENSION: "EXT", ESTATES: "ESTS",
  ESTATE: "EST", HEIGHTS: "HTS", HOLLOW: "HOLW", MANOR: "MNR", MEADOWS: "MDWS", RIDGE: "RDG",
  VIEW: "VW", VILLAGE: "VLG", WOODS: "WDS", COVE: "CV", CREEK: "CRK", GLEN: "GLN",
  GROVE: "GRV", HILL: "HL", HILLS: "HLS", ISLAND: "IS", LAKE: "LK", PARK: "PARK", PASS: "PASS",
  BEND: "BND", BRIDGE: "BRG", CENTER: "CTR", COMMONS: "CMNS", CURVE: "CURV", GARDENS: "GDNS",
  LANDING: "LNDG", MOUNT: "MT", MOUNTAIN: "MTN", OVERLOOK: "OVLK", SHORE: "SHR", SPRINGS: "SPGS",
  STATION: "STA", VALLEY: "VLY", VISTA: "VIS", WALK: "WALK", ROW: "ROW", ALLEY: "ALY", ANNEX: "ANX",
};
const DIRECTION: Record<string, string> = {
  NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W", NORTHEAST: "NE", NORTHWEST: "NW",
  SOUTHEAST: "SE", SOUTHWEST: "SW", "N.": "N", "S.": "S", "E.": "E", "W.": "W",
};
const UNIT: Record<string, string> = {
  APARTMENT: "APT", "APT.": "APT", SUITE: "STE", "STE.": "STE", UNIT: "UNIT", "#": "#",
  BUILDING: "BLDG", FLOOR: "FL", ROOM: "RM", DEPARTMENT: "DEPT", LOT: "LOT", TRAILER: "TRLR",
};
const ORDINAL_RE = /^(\d+)(ST|ND|RD|TH)$/;

/** Canonical uppercase, abbreviated, punctuation-free street line. */
export function normalizeAddressLine(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const tokens = s
    .toUpperCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+#\s*/g, " # ")
    .replace(/[^A-Z0-9#\/\-\s]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const out: string[] = [];
  for (const raw of tokens) {
    let t = raw;
    if (DIRECTION[t]) t = DIRECTION[t];
    else if (UNIT[t]) t = UNIT[t];
    else if (SUFFIX[t]) t = SUFFIX[t];
    else if (ORDINAL_RE.test(t)) t = t; // keep 1ST/2ND as-is
    out.push(t);
  }
  return out.join(" ") || null;
}

/** Display form: title-cased, light cleanup, no abbreviation rewrite. */
export function prettyAddressLine(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  return s
    .replace(/\s+/g, " ")
    .split(" ")
    .map((w) => (/^[A-Z0-9#\-\/.]+$/.test(w) && w.length <= 3 ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
}

export function addressKey(line1: unknown, zip5: string | null): string | null {
  const n = normalizeAddressLine(line1);
  if (!n || !zip5) return null;
  return `${n}|${zip5}`;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const SUFFIXES = new Set(["JR", "SR", "II", "III", "IV", "V", "ESQ", "MD", "PHD", "DDS", "CPA", "CFA"]);
const PARTICLES = new Set(["VAN", "VON", "DE", "DEL", "DELLA", "DER", "DEN", "TER", "TEN", "DI", "DA", "DU", "DOS", "DAS", "LA", "LE", "MC", "MAC", "ST", "O", "EL", "AL", "BIN", "IBN", "SAN", "SANTA"]);

export type NameOrder = "auto" | "first-last" | "last-first";

export interface NameParts {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  suffix: string | null;
  fullName: string;
}

export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/(^|[\s\-'])(\p{L})/gu, (_m, p, c) => p + c.toUpperCase())
    .replace(/\bMc(\p{L})/gu, (_m, c) => "Mc" + c.toUpperCase())
    .replace(/\bO'(\p{L})/gu, (_m, c) => "O'" + c.toUpperCase());
}

/**
 * Split "Smith, John A. Jr." / "John A Smith Jr" / "SMITH JOHN A" into parts.
 *
 * Order detection (`auto`): a comma always means LAST, FIRST. Otherwise the
 * name is FIRST LAST unless it looks like a county-assessor owner string —
 * ALL CAPS, three-plus tokens ending in an initial ("SMITH JOHN A"), or ALL
 * CAPS with a joint-owner ampersand ("GARCIA MARIA & LUIS") — in which case
 * the first token is the surname. Pass `last-first` for assessor/voter files
 * to force it and avoid the two-token ambiguity ("SMITH JOHN").
 */
export function splitFullName(full: unknown, order: NameOrder = "auto"): NameParts | null {
  const s = str(full);
  if (!s) return null;
  let first: string | null = null;
  let middle: string | null = null;
  let last: string | null = null;
  let suffix: string | null = null;

  const clean = s.replace(/\s+/g, " ").replace(/\./g, "").replace(/\s*&\s*/g, " & ").trim();
  const allCaps = clean === clean.toUpperCase() && /[A-Z]/.test(clean);
  if (clean.includes(",")) {
    // "LAST, FIRST MIDDLE [SUFFIX]" — also "LAST, FIRST, JR"
    const parts = clean.split(",").map((p) => p.trim()).filter(Boolean);
    last = parts[0] ?? null;
    const rest = (parts[1] ?? "").split(" ").filter(Boolean);
    if (parts[2] && SUFFIXES.has(parts[2].toUpperCase())) suffix = parts[2].toUpperCase();
    if (rest.length && SUFFIXES.has(rest[rest.length - 1].toUpperCase())) suffix = rest.pop()!.toUpperCase();
    first = rest.shift() ?? null;
    middle = rest.length ? rest.join(" ") : null;
  } else {
    const toks = clean.split(" ").filter(Boolean);
    if (toks.length && SUFFIXES.has(toks[toks.length - 1].toUpperCase())) suffix = toks.pop()!.toUpperCase();
    const hasAmp = toks.includes("&");
    const looksLastFirst =
      order === "last-first" ||
      (order === "auto" && allCaps && toks.length >= 2 && (hasAmp || (toks.length >= 3 && toks[toks.length - 1].length <= 2)));
    if (toks.length === 1) {
      last = toks[0];
    } else if (looksLastFirst) {
      // LAST FIRST [MIDDLE]  |  LAST FIRST & FIRST2
      last = toks.shift()!;
      if (hasAmp) {
        first = toks.join(" ");
      } else {
        first = toks.shift() ?? null;
        middle = toks.length ? toks.join(" ") : null;
      }
    } else if (hasAmp) {
      // "Maria & Luis Garcia" -> first "Maria & Luis", last "Garcia"
      last = toks.pop()!;
      first = toks.join(" ");
    } else {
      first = toks.shift()!;
      // Fold particles into the surname: "Ludwig van Beethoven" -> last "van Beethoven"
      let i = toks.length - 1;
      while (i > 0 && PARTICLES.has(toks[i - 1].toUpperCase())) i--;
      last = toks.slice(i).join(" ");
      const mid = toks.slice(0, i);
      middle = mid.length ? mid.join(" ") : null;
    }
  }
  const tc = (x: string | null) => (x ? titleCase(x) : null);
  const fn = tc(first), mn = tc(middle), ln = tc(last);
  const fullName = [fn, mn, ln, suffix ? suffix.replace(/^(JR|SR)$/, (m) => m.charAt(0) + m.slice(1).toLowerCase() + ".") : null]
    .filter(Boolean)
    .join(" ");
  return { firstName: fn, middleName: mn, lastName: ln, suffix, fullName };
}

function normalizeNameToken(s: string | null): string {
  return (s ?? "").toUpperCase().replace(/[^A-Z]/g, "");
}

export function personKey(
  zip5: string,
  lastName: string | null,
  firstName: string | null,
  line1: unknown,
  emailNormalized: string | null
): string {
  const ln = normalizeNameToken(lastName);
  const fn = normalizeNameToken(firstName);
  const addr = normalizeAddressLine(line1);
  if (addr && (ln || fn)) return `${zip5}|${ln}|${fn}|${addr}`;
  if (emailNormalized) return `EMAIL|${emailNormalized}`;
  if (ln || fn) return `${zip5}|${ln}|${fn}|`;
  throw new Error("Cannot build a person key: need a name plus an address or an email");
}

// ---------------------------------------------------------------------------
// The main normalizer
// ---------------------------------------------------------------------------

export interface NormalizeOptions {
  nameOrder?: NameOrder;
  defaultSource?: string;
  defaultSourceDetail?: string | null;
  defaultZip?: string | null;
}

export function normalizeProspect(input: ProspectInput, opts: NormalizeOptions = {}): NormalizedProspect {
  // Names: explicit parts win; otherwise split fullName.
  let firstName = str(input.firstName);
  let middleName = str(input.middleName);
  let lastName = str(input.lastName);
  let suffix = str(input.suffix)?.toUpperCase().replace(/\./g, "") ?? null;
  if (!firstName && !lastName) {
    const parts = splitFullName(input.fullName, opts.nameOrder ?? "auto");
    if (parts) {
      firstName = parts.firstName;
      middleName = parts.middleName ?? middleName;
      lastName = parts.lastName;
      suffix = parts.suffix ?? suffix;
    }
  } else {
    // "First Middle" jammed into the first-name column
    if (firstName && !middleName && firstName.includes(" ")) {
      const toks = firstName.split(/\s+/);
      if (toks.length === 2 && toks[1].length <= 2) {
        firstName = toks[0];
        middleName = toks[1];
      }
    }
    if (lastName) {
      const toks = lastName.split(/\s+/);
      if (toks.length > 1 && SUFFIXES.has(toks[toks.length - 1].toUpperCase().replace(/\./g, ""))) {
        suffix = toks.pop()!.toUpperCase().replace(/\./g, "");
        lastName = toks.join(" ");
      }
    }
    firstName = firstName ? titleCase(firstName) : null;
    middleName = middleName ? titleCase(middleName) : null;
    lastName = lastName ? titleCase(lastName) : null;
  }
  const fullName =
    str(input.fullName) && !firstName && !lastName
      ? String(input.fullName).trim()
      : [firstName, middleName, lastName, suffix ? suffix.replace(/^(JR|SR)$/, (m) => m.charAt(0) + m.slice(1).toLowerCase() + ".") : null]
          .filter(Boolean)
          .join(" ");

  const em = normalizeEmail(input.email);

  const zipIn = input.zip5 ?? input.zip ?? null;
  let { zip5, zip4 } = normalizeZip(zipIn);
  if (!zip4 && input.zip4) zip4 = normalizeZip(input.zip4).zip5?.slice(-4) ?? null;
  if (!zip5 && opts.defaultZip) zip5 = normalizeZip(opts.defaultZip).zip5;
  if (!zip5) throw new Error("Record has no zip code" + (fullName ? ` (${fullName})` : ""));

  const addressLine1 = prettyAddressLine(input.addressLine1);
  const addressLine2 = prettyAddressLine(input.addressLine2);

  if (!fullName && !em.normalized) throw new Error("Record has neither a name nor an email");

  const key = personKey(zip5, lastName, firstName, input.addressLine1, em.normalized);
  const source = str(input.source) ?? opts.defaultSource ?? "unknown";

  const emailOptIn = bool(input.emailOptIn);

  return {
    personKey: key,
    addressKey: addressKey(input.addressLine1, zip5),
    firstName,
    middleName,
    lastName,
    suffix,
    fullName: fullName || em.email || "(unknown)",
    email: em.email,
    emailNormalized: em.normalized,
    phone: normalizePhone(input.phone),
    phoneMobile: normalizePhone(input.phoneMobile),
    addressLine1,
    addressLine2,
    city: str(input.city) ? titleCase(String(input.city)) : null,
    state: normalizeState(input.state),
    zip5,
    zip4,
    county: str(input.county) ? titleCase(String(input.county)) : null,
    ageBand: str(input.ageBand),
    birthYear: int(input.birthYear),
    occupation: str(input.occupation),
    employer: str(input.employer),
    title: str(input.title),
    industry: str(input.industry),
    linkedinUrl: str(input.linkedinUrl),
    estNetWorthBand: str(input.estNetWorthBand),
    estInvestableAssets: num(input.estInvestableAssets),
    estIncomeBand: str(input.estIncomeBand),
    isBusinessOwner: bool(input.isBusinessOwner),
    isExecutive: bool(input.isExecutive),
    hasTrust: bool(input.hasTrust),
    wealthSignals: input.wealthSignals && typeof input.wealthSignals === "object" ? input.wealthSignals : {},
    leadScore: int(input.leadScore),
    leadStatus: (() => {
      const s = str(input.leadStatus)?.toLowerCase() ?? null;
      if (!s) return null;
      if (!(LEAD_STATUSES as readonly string[]).includes(s))
        throw new Error(`Invalid leadStatus '${s}' (allowed: ${LEAD_STATUSES.join(", ")})`);
      return s;
    })(),
    emailOptIn,
    optInSource: str(input.optInSource),
    doNotContact: bool(input.doNotContact),
    doNotEmail: bool(input.doNotEmail),
    doNotCall: bool(input.doNotCall),
    doNotMail: bool(input.doNotMail),
    household: {
      householdName: str(input.householdName),
      homeValue: num(input.homeValue),
      homeValueSource: str(input.homeValueSource),
      homeValueAsOf: isoDate(input.homeValueAsOf),
      yearBuilt: int(input.yearBuilt),
      sqFt: int(input.sqFt),
      lotAcres: dec(input.lotAcres),
      ownerOccupied: bool(input.ownerOccupied),
      purchaseDate: isoDate(input.purchaseDate),
      purchasePrice: num(input.purchasePrice),
      estHouseholdIncome: num(input.estHouseholdIncome),
      householdSize: int(input.householdSize),
    },
    source,
    sourceDetail: str(input.sourceDetail) ?? opts.defaultSourceDetail ?? null,
    sourceRecordId: str(input.sourceRecordId),
    acquiredAt: isoDate(input.acquiredAt),
    tags: tagsList(input.tags),
    notes: str(input.notes),
    raw: input.raw ?? null,
  };
}

// ---------------------------------------------------------------------------
// Column mapping for spreadsheet imports
// ---------------------------------------------------------------------------

/**
 * Header synonyms → ProspectInput field. Matching is on the lowercased header
 * with everything but letters/digits stripped, so "First Name", "first_name",
 * "FIRST-NAME" and "FirstName" all collapse to "firstname".
 */
const COLUMN_SYNONYMS: Record<keyof ProspectInput, string[]> = {
  firstName: ["firstname", "first", "fname", "givenname", "ownerfirstname", "owner1first", "firstname1"],
  middleName: ["middlename", "middle", "mi", "middleinitial"],
  lastName: ["lastname", "last", "lname", "surname", "familyname", "ownerlastname", "owner1last", "lastname1"],
  suffix: ["suffix", "namesuffix"],
  fullName: ["fullname", "name", "contactname", "ownername", "owner", "owner1", "taxpayername", "primaryowner", "voter", "votername"],
  email: ["email", "emailaddress", "email1", "primaryemail", "emails", "e-mail", "mail"],
  phone: ["phone", "phonenumber", "homephone", "telephone", "landline", "phone1"],
  phoneMobile: ["mobile", "cell", "cellphone", "mobilephone", "phone2"],
  addressLine1: ["address", "address1", "addressline1", "street", "streetaddress", "situsaddress", "propertyaddress", "siteaddress", "mailingaddress", "addr", "addr1", "residentialaddress", "homeaddress"],
  addressLine2: ["address2", "addressline2", "unit", "apt", "suite", "addr2"],
  city: ["city", "town", "municipality", "situscity", "propertycity"],
  state: ["state", "st", "province", "situsstate", "propertystate"],
  zip: ["zip", "zipcode", "postal", "postalcode", "zip5", "situszip", "propertyzip", "zippostal"],
  zip5: [],
  zip4: ["zip4", "plus4", "zipplus4"],
  county: ["county"],
  ageBand: ["ageband", "agerange", "age"],
  birthYear: ["birthyear", "yob", "yearofbirth", "dobyear"],
  occupation: ["occupation", "profession", "job"],
  employer: ["employer", "company", "companyname", "organization", "business"],
  title: ["title", "jobtitle", "position"],
  industry: ["industry", "sector"],
  linkedinUrl: ["linkedin", "linkedinurl", "linkedinprofile"],
  estNetWorthBand: ["networth", "estnetworth", "networthband", "estimatednetworth", "wealthband", "networthrange"],
  estInvestableAssets: ["investableassets", "estinvestableassets", "liquidassets", "investable", "aumpotential"],
  estIncomeBand: ["income", "incomeband", "incomerange", "estincome", "householdincomeband"],
  isBusinessOwner: ["businessowner", "isbusinessowner", "ownsbusiness"],
  isExecutive: ["executive", "isexecutive", "ceo"],
  hasTrust: ["trust", "hastrust", "intrust", "trustowned"],
  wealthSignals: [],
  leadScore: ["leadscore", "score", "rating"],
  leadStatus: ["leadstatus", "status", "stage"],
  emailOptIn: ["optin", "emailoptin", "subscribed", "consent", "emailconsent"],
  optInSource: ["optinsource", "consentsource"],
  doNotContact: ["donotcontact", "dnc", "nocontact"],
  doNotEmail: ["donotemail", "unsubscribed", "noemail"],
  doNotCall: ["donotcall", "nocall"],
  doNotMail: ["donotmail", "nomail"],
  homeValue: ["homevalue", "marketvalue", "assessedvalue", "estimatedvalue", "avm", "zestimate", "propertyvalue", "value", "totalvalue", "fairmarketvalue", "estvalue", "homeval"],
  homeValueSource: ["homevaluesource", "valuesource"],
  homeValueAsOf: ["homevalueasof", "valuedate", "valueasof", "assessmentyear"],
  yearBuilt: ["yearbuilt", "built", "yrbuilt"],
  sqFt: ["sqft", "squarefeet", "livingarea", "buildingsqft", "sf", "totalsqft"],
  lotAcres: ["acres", "lotacres", "lotsize", "acreage"],
  ownerOccupied: ["owneroccupied", "homestead", "ownerocc", "occupancy"],
  purchaseDate: ["purchasedate", "saledate", "lastsaledate", "deeddate", "recordingdate"],
  purchasePrice: ["purchaseprice", "saleprice", "lastsaleprice", "saleamount"],
  estHouseholdIncome: ["householdincome", "hhincome", "esthouseholdincome"],
  householdSize: ["householdsize", "hhsize", "adults", "persons"],
  householdName: ["householdname", "household"],
  source: ["source", "listsource", "datasource", "origin"],
  sourceDetail: ["sourcedetail", "listname", "campaign"],
  sourceRecordId: ["id", "recordid", "sourceid", "pin", "parcelid", "parcel", "apn", "voterid", "externalid", "contactid"],
  acquiredAt: ["acquiredat", "acquired", "dateacquired", "importdate", "listdate"],
  tags: ["tags", "tag", "labels", "segments"],
  notes: ["notes", "note", "comments", "comment", "remarks"],
  raw: [],
};

export function headerToken(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const TOKEN_TO_FIELD: Record<string, keyof ProspectInput> = (() => {
  const out: Record<string, keyof ProspectInput> = {};
  for (const [field, syns] of Object.entries(COLUMN_SYNONYMS) as Array<[keyof ProspectInput, string[]]>) {
    for (const s of syns) if (!(s in out)) out[s] = field;
  }
  return out;
})();

export interface ColumnMapResult {
  map: Record<string, keyof ProspectInput>; // header -> field
  unmapped: string[];
  fields: Array<keyof ProspectInput>;
}

/**
 * Build header→field mapping. `overrides` (header or headerToken → field)
 * always win, and an override of "" / "ignore" drops the column.
 */
export function inferColumnMap(
  headers: string[],
  overrides: Record<string, string> = {}
): ColumnMapResult {
  const ovByToken: Record<string, string> = {};
  for (const [k, v] of Object.entries(overrides)) ovByToken[headerToken(k)] = v;

  const map: Record<string, keyof ProspectInput> = {};
  const unmapped: string[] = [];
  const used = new Set<string>();
  for (const h of headers) {
    const tok = headerToken(h);
    const ov = ovByToken[tok] ?? ovByToken[h];
    let field: keyof ProspectInput | undefined;
    if (ov !== undefined) {
      if (ov === "" || ov === "ignore") continue;
      if (!(ov in COLUMN_SYNONYMS)) throw new Error(`columnMap: unknown target field '${ov}' for header '${h}'`);
      field = ov as keyof ProspectInput;
    } else {
      field = TOKEN_TO_FIELD[tok];
      // "Owner 2 First" style secondary owners are not mapped automatically.
      if (field && used.has(field) && field !== "tags" && field !== "notes") field = undefined;
    }
    if (field) {
      map[h] = field;
      used.add(field);
    } else {
      unmapped.push(h);
    }
  }
  return { map, unmapped, fields: Array.from(used) as Array<keyof ProspectInput> };
}

/** Apply a column map to a row of header→cell strings. Unmapped columns are kept in `raw`. */
export function rowToInput(
  row: Record<string, unknown>,
  map: Record<string, keyof ProspectInput>
): ProspectInput {
  const input: ProspectInput = { raw: {} };
  for (const [h, v] of Object.entries(row)) {
    const field = map[h];
    if (v == null || String(v).trim() === "") continue;
    if (field) {
      if (field === "tags") {
        const prev = tagsList(input.tags) ?? [];
        input.tags = [...prev, ...(tagsList(v) ?? [])];
      } else if (field === "notes" && input.notes) {
        input.notes = `${input.notes}\n${String(v)}`;
      } else {
        (input as any)[field] = v;
      }
    }
    (input.raw as Record<string, unknown>)[h] = v;
  }
  return input;
}
