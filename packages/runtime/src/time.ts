/** Admission-time timestamps must identify an instant. Date.parse alone
 * silently applies the host timezone and normalizes impossible calendar days. */
export function absoluteTime(value: string, label: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) throw new Error(`${label} must include an explicit UTC Z or timezone offset; do not guess a local time`);
  const [, year, month, day, hour, minute, second = "00", fraction = "0"] = match;
  const local = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(3, "0")}Z`);
  if (!Number.isFinite(local.getTime()) || local.getUTCFullYear() !== Number(year) || local.getUTCMonth() + 1 !== Number(month)
    || local.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
    throw new Error(`${label} is not a valid calendar date and time`);
  }
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error(`${label} has an invalid timezone offset`);
  return instant.toISOString();
}
