/**
 * shifts.js — EMS shift windows in SAST.
 *
 * EMS runs two 12-hour shifts — Day 07:00–19:00 and Night 19:00–07:00
 * (Africa/Johannesburg, UTC+2, no DST). Shared by the snapshot engine
 * (metrics.js), the running statistics (registry-stats.js) and the public
 * dashboard, so every module agrees on where a shift starts and ends.
 */

const pad = (n) => String(n).padStart(2, "0");

/** Wall-clock parts in Africa/Johannesburg (SAST, UTC+2, no DST). */
export function sastParts(d = new Date()) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  });
  const p = {}; f.formatToParts(d).forEach((x) => { if (x.type !== "literal") p[x.type] = x.value; });
  let h = parseInt(p.hour, 10); if (h === 24) h = 0;
  return { y: +p.year, mo: +p.month, d: +p.day, h };
}

/** A SAST wall-clock time expressed as the correct UTC instant. */
export const sastInstant = (y, mo, d, h) => new Date(Date.UTC(y, mo - 1, d, h - 2, 0, 0, 0));

/** The shift window containing `when`. Day 07:00–19:00, Night 19:00–07:00. */
export function currentShift(when = new Date()) {
  const p = sastParts(when);
  let start, end, key;
  if (p.h >= 7 && p.h < 19) { key = "day"; start = sastInstant(p.y, p.mo, p.d, 7); end = sastInstant(p.y, p.mo, p.d, 19); }
  else if (p.h >= 19) { key = "night"; start = sastInstant(p.y, p.mo, p.d, 19); end = sastInstant(p.y, p.mo, p.d + 1, 7); }
  else { key = "night"; start = sastInstant(p.y, p.mo, p.d - 1, 19); end = sastInstant(p.y, p.mo, p.d, 7); }
  return { key, start, end };
}

export const shiftLabel = (sh) => (sh.key === "day" ? "Day" : "Night") + " shift · " + (sh.key === "day" ? "07:00–19:00" : "19:00–07:00");

/**
 * Stable identifier for the shift containing `when`: the SAST date the shift
 * STARTS on, plus its key — e.g. "2026-11-24-night" runs 24th 19:00 to 25th 07:00.
 */
export function shiftId(when = new Date()) {
  const sh = currentShift(when);
  const p = sastParts(sh.start);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}-${sh.key}`;
}
