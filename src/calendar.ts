/**
 * US equity session calendar in America/New_York.
 *
 * - regular:   09:30-16:00 on a trading day (13:00 close on early-close days)
 * - extended:  04:00-09:30 and close-20:00 on a trading day
 * - overnight: 20:00-04:00 leading into a trading day (the 24/5 window runs
 *              Sun 20:00 → Fri 20:00, and resumes the evening before the
 *              first trading day after a holiday)
 * - weekend:   Fri 20:00 → Sun 20:00
 * - closed:    an NYSE holiday (and the overnight leading into it)
 *
 * Chainlink Stock Token feeds run 24/5, so they are expected to freeze in
 * `weekend` and `closed`.
 */
export type Session = "regular" | "extended" | "overnight" | "closed" | "weekend";

/** NYSE full-day holidays. Extend each year; past the table `holidayTableCovers` is false. */
const HOLIDAYS = new Set([
  // 2026
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
  "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  // 2027
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18",
  "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

/** 13:00 ET early closes. */
const EARLY_CLOSES = new Set(["2026-11-27", "2026-12-24", "2027-11-26"]);

const LAST_COVERED_YEAR = 2027;

export interface EtParts {
  date: string; // YYYY-MM-DD in New York
  weekday: number; // 0 = Sunday
  minutes: number; // minutes since local midnight
  year: number;
}

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  weekday: "short",
});
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function etParts(at: Date): EtParts {
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  const year = Number(p.year);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: WD[p.weekday as string] ?? 0,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    year,
  };
}

function addDays(date: string, n: number): { date: string; weekday: number } {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return { date: d.toISOString().slice(0, 10), weekday: d.getUTCDay() };
}

export function isTradingDay(date: string, weekday: number): boolean {
  return weekday >= 1 && weekday <= 5 && !HOLIDAYS.has(date);
}

export function holidayTableCovers(at: Date): boolean {
  return etParts(at).year <= LAST_COVERED_YEAR;
}

export function sessionAt(at: Date): Session {
  const { date, weekday, minutes } = etParts(at);
  const OPEN = 9 * 60 + 30;
  const close = EARLY_CLOSES.has(date) ? 13 * 60 : 16 * 60;
  const PRE = 4 * 60;
  const POST_END = 20 * 60;

  if (minutes < PRE) {
    // Early morning: the overnight session leading into a trading day.
    if (isTradingDay(date, weekday)) return "overnight";
    return weekday === 6 || weekday === 0 || weekday === 1 ? "weekend" : "closed";
  }
  if (minutes >= POST_END) {
    const t = addDays(date, 1);
    if (isTradingDay(t.date, t.weekday)) return "overnight";
    return weekday === 5 || weekday === 6 || weekday === 0 ? "weekend" : "closed";
  }
  if (weekday === 0 || weekday === 6) return "weekend";
  if (!isTradingDay(date, weekday)) return "closed";
  if (minutes >= OPEN && minutes < close) return "regular";
  return "extended";
}

/** A 24/5 feed is expected to be frozen in these sessions. */
export function isFeedFreezeSession(s: Session): boolean {
  return s === "weekend" || s === "closed";
}
