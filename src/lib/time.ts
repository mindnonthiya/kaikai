export const APP_TIME_ZONE = "Asia/Bangkok";

// Thailand has no daylight saving time, so a fixed +07:00 offset is exact.
const OFFSET_MS = 7 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export type RangeKey = "today" | "yesterday" | "7d" | "month" | "last-month";
export type DateRange = { key: RangeKey; start: Date; end: Date; label: string };

export const RANGE_LABELS: Record<RangeKey, string> = {
  today: "วันนี้",
  yesterday: "เมื่อวาน",
  "7d": "7 วัน",
  month: "เดือนนี้",
  "last-month": "เดือนก่อน",
};

export function formatThaiDate(date: Date | string) {
  return new Intl.DateTimeFormat("th-TH", {
    dateStyle: "medium",
    timeZone: APP_TIME_ZONE,
  }).format(new Date(date));
}

export function formatThaiDateTime(date: Date | string) {
  return new Intl.DateTimeFormat("th-TH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: APP_TIME_ZONE,
  }).format(new Date(date));
}

/** e.g. "วันอังคารที่ 13 ตุลาคม" */
export function formatThaiLongDate(date: Date | string) {
  return new Intl.DateTimeFormat("th-TH", { weekday: "long", day: "numeric", month: "long", timeZone: APP_TIME_ZONE }).format(new Date(date));
}

/** e.g. "13 ต.ค." */
export function formatThaiShortDate(date: Date | string) {
  return new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", timeZone: APP_TIME_ZONE }).format(new Date(date));
}

/** e.g. "อ." */
export function formatThaiWeekday(date: Date | string) {
  return new Intl.DateTimeFormat("th-TH", { weekday: "narrow", timeZone: APP_TIME_ZONE }).format(new Date(date));
}

export function formatTime(date: Date | string) {
  return new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: APP_TIME_ZONE }).format(new Date(date));
}

/** Calendar day in Bangkok as "YYYY-MM-DD" (also the value format of <input type="date">). */
export function bangkokDayKey(date: Date | string) {
  return new Date(new Date(date).getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/** UTC instant of 00:00 Bangkok time on the same Bangkok calendar day. */
export function startOfBangkokDay(date: Date) {
  const shifted = new Date(date.getTime() + OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - OFFSET_MS);
}

/** UTC instant of 00:00 Bangkok time on the 1st of the month (monthOffset -1 = previous month). */
export function startOfBangkokMonth(date: Date, monthOffset = 0) {
  const shifted = new Date(date.getTime() + OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + monthOffset, 1) - OFFSET_MS);
}

/** Parses "YYYY-MM-DD" from a date input as midday Bangkok time (stays on that day in every view). */
export function fromBangkokDateInput(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("วันที่ไม่ถูกต้อง");
  const date = new Date(`${value}T12:00:00+07:00`);
  if (Number.isNaN(date.getTime())) throw new Error("วันที่ไม่ถูกต้อง");
  return date;
}

export function parseRange(value: string | string[] | undefined, allowed: RangeKey[], fallback: RangeKey): RangeKey {
  const raw = Array.isArray(value) ? value[0] : value;
  return allowed.includes(raw as RangeKey) ? (raw as RangeKey) : fallback;
}

export function resolveRange(key: RangeKey, now = new Date()): DateRange {
  const today = startOfBangkokDay(now);
  const tomorrow = new Date(today.getTime() + DAY_MS);
  const label = RANGE_LABELS[key];
  switch (key) {
    case "today": return { key, label, start: today, end: tomorrow };
    case "yesterday": return { key, label, start: new Date(today.getTime() - DAY_MS), end: today };
    case "7d": return { key, label, start: new Date(today.getTime() - 6 * DAY_MS), end: tomorrow };
    case "month": return { key, label, start: startOfBangkokMonth(now), end: tomorrow };
    case "last-month": return { key, label, start: startOfBangkokMonth(now, -1), end: startOfBangkokMonth(now) };
  }
}

/** The period of the same length that ends where `range` starts (used for "% vs previous"). */
export function previousRange(range: DateRange): { start: Date; end: Date } {
  if (range.key === "month" || range.key === "last-month") {
    // Month-to-date compares with the same number of days at the start of the previous month.
    const prevStart = startOfBangkokMonth(range.start, -1);
    const length = range.end.getTime() - range.start.getTime();
    const prevMonthEnd = range.start.getTime();
    return { start: prevStart, end: new Date(Math.min(prevStart.getTime() + length, prevMonthEnd)) };
  }
  const length = range.end.getTime() - range.start.getTime();
  return { start: new Date(range.start.getTime() - length), end: range.start };
}

export function isWithin(date: Date | string, start: Date, end: Date) {
  const time = new Date(date).getTime();
  return time >= start.getTime() && time < end.getTime();
}
