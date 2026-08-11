/**
 * SQL datetime formatting utilities.
 * All functions return SQLite-compatible datetime strings in UTC.
 */
function padNum(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDate(d: Date): string {
  return `${d.getUTCFullYear()}-${padNum(d.getUTCMonth() + 1)}-${padNum(d.getUTCDate())} ${padNum(d.getUTCHours())}:${padNum(d.getUTCMinutes())}:${padNum(d.getUTCSeconds())}`;
}

export function nowSqlDateTime(): string {
  return formatDate(new Date());
}

export function nowSqlDateTimePlusMinutes(minutes: number): string {
  return formatDate(new Date(Date.now() + minutes * 60 * 1000));
}

export function nowSqlDateTimePlusHours(hours: number): string {
  return formatDate(new Date(Date.now() + hours * 60 * 60 * 1000));
}
