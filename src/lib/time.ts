export const APP_TIME_ZONE = "Asia/Bangkok";

// Thailand has no daylight saving time, so a fixed +07:00 offset is exact.
const OFFSET_MS = 7 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_DAY_START_HOUR = 0;

export const DAY_START_HOUR_OPTIONS = [
  { hour: 0, label: "00:00 น. (เที่ยงคืน — ปกติ)" },
  { hour: 1, label: "01:00 น. (ตี 1)" },
  { hour: 2, label: "02:00 น. (ตี 2)" },
  { hour: 3, label: "03:00 น. (ตี 3)" },
  { hour: 4, label: "04:00 น. (ตี 4)" },
  { hour: 5, label: "05:00 น. (ตี 5)" },
  { hour: 6, label: "06:00 น. (6 โมงเช้า)" },
  { hour: 7, label: "07:00 น. (7 โมงเช้า)" },
  { hour: 8, label: "08:00 น. (8 โมงเช้า)" },
  { hour: 9, label: "09:00 น. (9 โมงเช้า)" },
  { hour: 10, label: "10:00 น. (10 โมงเช้า)" },
  { hour: 11, label: "11:00 น. (11 โมงเช้า)" },
  { hour: 12, label: "12:00 น. (เที่ยงวัน)" },
] as const;

export function normalizeDayStartHour(hour: unknown): number {
  const n = Number(hour);
  return Number.isInteger(n) && n >= 0 && n <= 12 ? n : DEFAULT_DAY_START_HOUR;
}

export type RangeKey = "today" | "yesterday" | "7d" | "month" | "last-month" | "all";
export type DateRange = { key: RangeKey; start: Date; end: Date; label: string; dayStartHour?: number };

export const RANGE_LABELS: Record<RangeKey, string> = {
  today: "วันนี้",
  yesterday: "เมื่อวาน",
  "7d": "7 วัน",
  month: "เดือนนี้",
  "last-month": "เดือนก่อน",
  all: "ทั้งหมด",
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

/** e.g. "ตุลาคม 2569" */
export function formatThaiMonthYear(date: Date | string) {
  return new Intl.DateTimeFormat("th-TH", { month: "long", year: "numeric", timeZone: APP_TIME_ZONE }).format(new Date(date));
}

/** e.g. "อ." */
export function formatThaiWeekday(date: Date | string) {
  return new Intl.DateTimeFormat("th-TH", { weekday: "narrow", timeZone: APP_TIME_ZONE }).format(new Date(date));
}

export function formatTime(date: Date | string) {
  return new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: APP_TIME_ZONE }).format(new Date(date));
}

/** Business day in Bangkok as "YYYY-MM-DD" (also the value format of <input type="date">). */
export function bangkokDayKey(date: Date | string, dayStartHour = DEFAULT_DAY_START_HOUR) {
  const hour = normalizeDayStartHour(dayStartHour);
  return new Date(new Date(date).getTime() + OFFSET_MS - hour * HOUR_MS).toISOString().slice(0, 10);
}

/** Business month in Bangkok as "YYYY-MM". */
export function bangkokMonthKey(date: Date | string, dayStartHour = DEFAULT_DAY_START_HOUR) {
  return bangkokDayKey(date, dayStartHour).slice(0, 7);
}

/** Formats Date as "YYYY-MM-DDTHH:mm" for <input type="datetime-local"> in Bangkok timezone. */
export function toBangkokDateTimeInput(date: Date | string = new Date()): string {
  const d = new Date(date);
  const shifted = new Date(d.getTime() + OFFSET_MS);
  return shifted.toISOString().slice(0, 16);
}

/** Parses "YYYY-MM-DDTHH:mm" from a datetime-local input as Bangkok timezone into an ISO string. */
export function fromBangkokDateTimeInput(value: string): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    return new Date().toISOString();
  }
  return new Date(`${value.slice(0, 16)}:00+07:00`).toISOString();
}

/** UTC instant of the business-day boundary (default 00:00 Bangkok time) on the same Bangkok business day. */
export function startOfBangkokDay(date: Date, dayStartHour = DEFAULT_DAY_START_HOUR) {
  const offset = OFFSET_MS - normalizeDayStartHour(dayStartHour) * HOUR_MS;
  const shifted = new Date(date.getTime() + offset);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - offset);
}

/** UTC instant of the business-day boundary on the 1st of the month (monthOffset -1 = previous month). */
export function startOfBangkokMonth(date: Date, monthOffset = 0, dayStartHour = DEFAULT_DAY_START_HOUR) {
  const offset = OFFSET_MS - normalizeDayStartHour(dayStartHour) * HOUR_MS;
  const shifted = new Date(date.getTime() + offset);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + monthOffset, 1) - offset);
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

export function resolveRange(key: RangeKey, now = new Date(), dayStartHour = DEFAULT_DAY_START_HOUR): DateRange {
  const hour = normalizeDayStartHour(dayStartHour);
  const today = startOfBangkokDay(now, hour);
  const tomorrow = new Date(today.getTime() + DAY_MS);
  const label = RANGE_LABELS[key];
  switch (key) {
    case "today": return { key, label, start: today, end: tomorrow, dayStartHour: hour };
    case "yesterday": return { key, label, start: new Date(today.getTime() - DAY_MS), end: today, dayStartHour: hour };
    case "7d": return { key, label, start: new Date(today.getTime() - 6 * DAY_MS), end: tomorrow, dayStartHour: hour };
    case "month": return { key, label, start: startOfBangkokMonth(now, 0, hour), end: tomorrow, dayStartHour: hour };
    case "last-month": return { key, label, start: startOfBangkokMonth(now, -1, hour), end: startOfBangkokMonth(now, 0, hour), dayStartHour: hour };
    case "all": return { key, label, start: startOfBangkokDay(new Date(Date.UTC(2020, 0, 1)), hour), end: tomorrow, dayStartHour: hour };
  }
}

/** The period of the same length that ends where `range` starts (used for "% vs previous"). */
export function previousRange(range: DateRange, dayStartHour = range.dayStartHour ?? DEFAULT_DAY_START_HOUR): { start: Date; end: Date } {
  const hour = normalizeDayStartHour(dayStartHour);
  if (range.key === "all") {
    return { start: range.start, end: range.start };
  }
  if (range.key === "month" || range.key === "last-month") {
    // Month-to-date compares with the same number of days at the start of the previous month.
    const prevStart = startOfBangkokMonth(range.start, -1, hour);
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
