export const APP_TIME_ZONE = "Asia/Bangkok";

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
