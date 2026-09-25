/**
 * NYSE regular-session calendar, for the closed-market drift rule
 * (Feature 1). Binance's market-status endpoint can't be used for this:
 * for bStocks it reports "TRADING" around the clock with every session
 * field null (friction-log.md C18).
 *
 * Holidays and early closes are NYSE's own, read from the table and
 * footnotes at https://www.nyse.com/markets/hours-calendars on 2026-09-25.
 * The regular session is 9:30 a.m. to 4:00 p.m. ET (1:00 p.m. on early-
 * close days). Times are converted through the America/New_York zone, so
 * daylight saving is handled by the runtime, not by hand.
 *
 * Fail-closed: a date outside the years covered here throws instead of
 * guessing, so the updater posts nothing and the oracle goes stale.
 */

const FULL_CLOSURES: Record<number, string[]> = {
  2026: ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"],
  2027: ["2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"],
};

const EARLY_CLOSES: Record<number, string[]> = {
  2026: ["2026-11-27", "2026-12-24"],
  2027: ["2027-11-26"],
};

const OPEN_MINUTES = 9 * 60 + 30;
const CLOSE_MINUTES = 16 * 60;
const EARLY_CLOSE_MINUTES = 13 * 60;

interface EtParts {
  date: string; // YYYY-MM-DD in New York
  weekday: number; // 0 = Sunday
  minutes: number; // minutes since New York midnight
  year: number;
}

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function etParts(at: Date): EtParts {
  const parts = Object.fromEntries(formatter.formatToParts(at).map((p) => [p.type, p.value]));
  const year = Number(parts.year);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAYS[parts.weekday],
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    year,
  };
}

function known(year: number) {
  if (!(year in FULL_CLOSURES)) {
    throw new Error(`NYSE calendar has no holiday data for ${year} - refusing to guess (add it from nyse.com/markets/hours-calendars)`);
  }
}

/** The regular session's close, in minutes after New York midnight, or null if the exchange doesn't open that day. */
function closeMinutesOn(p: EtParts): number | null {
  known(p.year);
  if (p.weekday === 0 || p.weekday === 6) return null;
  if (FULL_CLOSURES[p.year].includes(p.date)) return null;
  return EARLY_CLOSES[p.year].includes(p.date) ? EARLY_CLOSE_MINUTES : CLOSE_MINUTES;
}

/** True during the NYSE regular session. */
export function isRegularSessionOpen(at: Date): boolean {
  const p = etParts(at);
  const close = closeMinutesOn(p);
  return close !== null && p.minutes >= OPEN_MINUTES && p.minutes < close;
}

/**
 * The most recent regular-session close at or before `at`, as a UTC Date.
 * During a session, that's the previous trading day's close.
 */
export function lastRegularClose(at: Date): Date {
  // Walk back in one-minute-resolution steps of whole days; at most a long
  // weekend plus a holiday, so this is a handful of iterations.
  for (let daysBack = 0; daysBack <= 10; daysBack++) {
    const probe = new Date(at.getTime() - daysBack * 24 * 60 * 60 * 1000);
    const p = etParts(probe);
    const close = closeMinutesOn(p);
    if (close === null) continue;
    if (daysBack === 0 && p.minutes < close) continue; // today's session hasn't closed yet
    // `probe` minus its New York time-of-day, plus the close time.
    return new Date(probe.getTime() - (p.minutes - close) * 60 * 1000 - probe.getUTCSeconds() * 1000 - probe.getUTCMilliseconds());
  }
  throw new Error(`no NYSE regular close found in the 10 days before ${at.toISOString()}`);
}
