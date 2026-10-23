/**
 * FOMC meeting calendar, scraped from
 *   https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm   (verified live 2026-10-22, ~165 KB)
 *
 * Structure: one <div class="panel panel-default"> per year with heading
 * "<YYYY> FOMC Meetings", containing <div class="row fomc-meeting"> blocks:
 *   .fomc-meeting__month <strong>January</strong>  (also "Jan/Feb", "Apr/May", "Oct/Nov")
 *   .fomc-meeting__date  "27-28" | "17-18*" (SEP meeting) | "22 (notation vote)" | "30-1" (month-spanning)
 *   links: Statement PDF/HTML (monetaryYYYYMMDDa), Implementation Note (…a1),
 *          Press Conference (fomcpressconfYYYYMMDD / fomcpresconf…), Projection Materials
 *          (fomcprojtablYYYYMMDD), Minutes (fomcminutesYYYYMMDD) + "(Released Month DD, YYYY)".
 * The page covers the current year ±5 (2021–2027 as of Oct 2026).
 */
import { cached, fetchText, HOUR, htmlToText, MONTHS, MONTH_INDEX, pad2, todayIso, daysUntil, clampInt } from "./common";

const CAL_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
const SITE = "https://www.federalreserve.gov";

export interface FomcMeeting {
  year: number;
  label: string;           // "January 27-28"
  startDate: string;       // ISO
  endDate: string;         // ISO decision day
  sep: boolean;            // Summary of Economic Projections meeting
  notationVote: boolean;
  statementUrl: string | null;
  statementPdf: string | null;
  implementationNoteUrl: string | null;
  pressConferenceUrl: string | null;
  projectionsUrl: string | null;
  minutesUrl: string | null;
  minutesReleased: string | null;   // ISO
  longerRunGoalsUrl: string | null;
}

function abs(href: string): string {
  return href.startsWith("http") ? href : `${SITE}${href}`;
}

function parseReleased(s: string): string | null {
  const m = s.match(/Released\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i);
  if (!m) return null;
  const mi = MONTH_INDEX[m[1]!.toLowerCase()];
  if (mi == null) return null;
  return `${m[3]}-${pad2(mi + 1)}-${pad2(Number(m[2]))}`;
}

export function parseCalendar(html: string): FomcMeeting[] {
  const out: FomcMeeting[] = [];
  const panelRe = /<div class="panel panel-default"><div class="panel-heading"><h4><a id="\d+">(\d{4}) FOMC Meetings<\/a><\/h4><\/div>([\s\S]*?)(?=<div class="panel panel-default">|<div class="panel-footer">|$)/g;
  let pm: RegExpExecArray | null;
  while ((pm = panelRe.exec(html))) {
    const year = Number(pm[1]);
    const panel = pm[2]!;
    const rows = panel.split(/<div class="(?:fomc-meeting--shaded )?row fomc-meeting"/).slice(1);
    for (const row of rows) {
      const monthM = row.match(/fomc-meeting__month[^>]*>\s*<strong>([^<]+)<\/strong>/);
      const dateM = row.match(/fomc-meeting__date[^>]*>([^<]+)</);
      if (!monthM || !dateM) continue;
      const monthRaw = monthM[1]!.trim();
      const dateRaw = htmlToText(dateM[1]!).trim();
      const sep = dateRaw.includes("*");
      const notationVote = /notation vote/i.test(dateRaw);
      const nums = dateRaw.replace(/\(.*?\)/g, "").match(/\d{1,2}/g) ?? [];
      if (!nums.length) continue;
      const monthParts = monthRaw.split("/").map((p) => MONTH_INDEX[p.trim().toLowerCase()]);
      const m0 = monthParts[0];
      if (m0 == null) continue;
      const d0 = Number(nums[0]);
      const d1 = Number(nums[nums.length - 1]);
      let m1 = monthParts.length > 1 && monthParts[1] != null ? monthParts[1]! : m0;
      if (d1 < d0 && m1 === m0) m1 = (m0 + 1) % 12; // "30-1" single-month label
      const y1 = m1 < m0 ? year + 1 : year;
      const startDate = `${year}-${pad2(m0 + 1)}-${pad2(d0)}`;
      const endDate = `${y1}-${pad2(m1 + 1)}-${pad2(d1)}`;
      const link = (re: RegExp): string | null => {
        const m = row.match(re);
        return m ? abs(m[1]!) : null;
      };
      const minutesM = row.match(/fomc-meeting__minutes[\s\S]*$/);
      out.push({
        year,
        label: `${monthRaw} ${dateRaw.replace(/\*/g, "").trim()}${sep ? " (SEP)" : ""}`,
        startDate,
        endDate,
        sep,
        notationVote,
        statementUrl: link(/href="([^"]*\/pressreleases\/monetary\d{8}a\.htm)"/),
        statementPdf: link(/href="([^"]*\/files\/monetary\d{8}a1\.pdf)"/),
        implementationNoteUrl: link(/href="([^"]*\/pressreleases\/monetary\d{8}a1\.htm)"/),
        pressConferenceUrl: link(/href="([^"]*\/fomcpres?s?conf\d{8}\.htm)"/),
        projectionsUrl: link(/href="([^"]*\/fomcprojtabl\d{8}\.htm)"/),
        minutesUrl: link(/href="([^"]*\/fomcminutes\d{8}\.htm)"/),
        minutesReleased: minutesM ? parseReleased(htmlToText(minutesM[0])) : null,
        longerRunGoalsUrl: link(/href="([^"]*\/pressreleases\/monetary\d{8}b\.htm)"/),
      });
    }
  }
  out.sort((a, b) => a.startDate.localeCompare(b.startDate));
  return out;
}

export function loadCalendar(): Promise<FomcMeeting[]> {
  return cached("fedboard:fomc-calendar", 6 * HOUR, async () => {
    const html = await fetchText(CAL_URL, 25000, 2, "text/html,*/*");
    const meetings = parseCalendar(html);
    if (meetings.length < 8) throw new Error(`FOMC calendar parse found only ${meetings.length} meetings — page layout may have changed`);
    return meetings;
  });
}

/** Most recent meeting whose statement link exists (used by fomc_statement default). */
export async function latestStatement(): Promise<{ url: string; date: string } | null> {
  const meetings = await loadCalendar();
  const today = todayIso();
  for (let i = meetings.length - 1; i >= 0; i--) {
    const m = meetings[i]!;
    if (m.endDate <= today && m.statementUrl) return { url: m.statementUrl, date: m.endDate };
  }
  return null;
}

function compact(m: FomcMeeting, full: boolean) {
  const base: Record<string, unknown> = {
    dates: `${m.startDate}..${m.endDate}`,
    decisionDay: m.endDate,
    label: m.label,
    sep: m.sep || undefined,
    notationVote: m.notationVote || undefined,
    statement: m.statementUrl ?? undefined,
    minutes: m.minutesUrl ?? undefined,
    minutesReleased: m.minutesReleased ?? undefined,
  };
  if (full) {
    // Short-form links (site-relative) keep a 8-meeting year under ~6 KB.
    const rel = (u: string | null) => (u ? u.replace(SITE, "") : undefined);
    base.statement = rel(m.statementUrl);
    base.minutes = rel(m.minutesUrl);
    base.implementationNote = rel(m.implementationNoteUrl);
    base.pressConference = rel(m.pressConferenceUrl);
    base.projections = rel(m.projectionsUrl);
    base.statementPdf = rel(m.statementPdf);
    base.longerRunGoals = rel(m.longerRunGoalsUrl);
  }
  return base;
}

export async function fomcCalendar(args: { year?: number; upcoming?: number; links?: boolean }) {
  const meetings = await loadCalendar();
  const today = todayIso();
  const thisYear = Number(today.slice(0, 4));
  const year = args.year ? clampInt(args.year, thisYear, 1990, thisYear + 6) : thisYear;
  const upcomingN = clampInt(args.upcoming, 4, 0, 16);
  const full = args.links === true;

  const upcoming = meetings.filter((m) => m.endDate >= today);
  const past = meetings.filter((m) => m.endDate < today);
  const next = upcoming[0] ?? null;
  const last = past[past.length - 1] ?? null;
  const years = Array.from(new Set(meetings.map((m) => m.year))).sort();
  const schedule = meetings.filter((m) => m.year === year);
  if (!schedule.length) {
    throw new Error(`No FOMC meetings for ${year} on the calendar page (covers ${years[0]}–${years[years.length - 1]})`);
  }
  return {
    source: "Federal Reserve Board — FOMC Meeting calendars, statements, and minutes",
    url: CAL_URL,
    fetchedAt: new Date().toISOString(),
    today,
    nextMeeting: next
      ? { ...compact(next, full), daysUntilDecision: daysUntil(next.endDate), inProgress: next.startDate <= today }
      : null,
    lastMeeting: last ? { ...compact(last, full), daysSinceDecision: -daysUntil(last.endDate) } : null,
    upcoming: upcoming.slice(0, upcomingN).map((m) => ({ decisionDay: m.endDate, label: m.label, sep: m.sep || undefined })),
    year,
    schedule: schedule.map((m) => compact(m, full)),
    yearsAvailable: years,
    linkBase: full ? SITE : undefined,
    notes: [
      "SEP = meeting with a Summary of Economic Projections (dot plot). Decision day is the last day of the meeting; the statement releases at 2:00 p.m. ET.",
      "Minutes are released three weeks after the decision day.",
    ],
  };
}

export { MONTHS };
