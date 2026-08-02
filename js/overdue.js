/**
 * overdue.js — flags journeys that have stayed open too long.
 *
 * An active journey is a patient who has been accepted for transfer but not yet
 * recorded as delivered. A journey still open many hours later is one of two
 * things, and both need somebody to look:
 *
 *   1. A patient genuinely still waiting for, or in, transport.
 *   2. A delivered patient whose record was never closed.
 *
 * The second is far more common and quietly corrupts every figure the system
 * reports upward — active counts, transport averages, shift totals. Neither
 * case surfaces anywhere at present.
 *
 * COST: nothing. Every function here works on rows the caller has already
 * loaded. No queries, no listeners, no writes.
 */

/** Defaults, in hours since capture. Overridable per-installation (below). */
export const DEFAULT_OVERDUE_HOURS = 4;
export const DEFAULT_CRITICAL_HOURS = 12;

const STORE_KEY = "gset:overdueThresholds";

/**
 * Read the thresholds. Kept in localStorage so a shift supervisor can tune them
 * to what the service actually looks like without waiting for a deployment.
 * @returns {{overdue: number, critical: number}}
 */
export function thresholds() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    const overdue = Number(raw.overdue) > 0 ? Number(raw.overdue) : DEFAULT_OVERDUE_HOURS;
    const critical = Number(raw.critical) > overdue ? Number(raw.critical) : DEFAULT_CRITICAL_HOURS;
    return { overdue, critical };
  } catch {
    return { overdue: DEFAULT_OVERDUE_HOURS, critical: DEFAULT_CRITICAL_HOURS };
  }
}

/** Persist new thresholds. Pass hours; critical must exceed overdue. */
export function setThresholds(overdue, critical) {
  const o = Math.max(0.25, Number(overdue) || DEFAULT_OVERDUE_HOURS);
  const c = Math.max(o + 0.25, Number(critical) || DEFAULT_CRITICAL_HOURS);
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ overdue: o, critical: c })); } catch { /* private mode */ }
  return { overdue: o, critical: c };
}

/**
 * Coerce whatever a timestamp field holds into a Date.
 * Rows arrive as Firestore Timestamps from the server, but journeys.js patches
 * closed rows in place with a `{ toDate }` shim, and imported records may carry
 * plain strings — so all three shapes must be handled.
 * @returns {Date|null}
 */
export function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") { try { return value.toDate(); } catch { return null; } }
  if (value instanceof Date) return value;
  if (typeof value.seconds === "number") return new Date(value.seconds * 1000);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Hours a journey has been open. Null for closed journeys and for records with
 * no usable capture timestamp — an unknown age must never be reported as zero,
 * because that would silently hide exactly the malformed records worth finding.
 * @returns {number|null}
 */
export function hoursOpen(row, now = new Date()) {
  if (!row || row.closed) return null;
  const started = toDate(row.createdAt) || toDate(row.timeCaptured);
  if (!started) return null;
  const ms = now.getTime() - started.getTime();
  return ms < 0 ? 0 : ms / 3600000;   // clock skew shows as 0, never negative
}

/**
 * @returns {"ok"|"overdue"|"critical"|"unknown"|"closed"}
 */
export function overdueLevel(row, now = new Date()) {
  if (!row) return "unknown";
  if (row.closed) return "closed";
  const h = hoursOpen(row, now);
  if (h === null) return "unknown";
  const t = thresholds();
  if (h >= t.critical) return "critical";
  if (h >= t.overdue) return "overdue";
  return "ok";
}

/** Active journeys past the overdue threshold, oldest first. */
export function overdueRows(rows = [], now = new Date()) {
  return rows
    .filter((r) => ["overdue", "critical"].includes(overdueLevel(r, now)))
    .sort((a, b) => (hoursOpen(b, now) || 0) - (hoursOpen(a, now) || 0));
}

/** Counts for a KPI card. */
export function overdueSummary(rows = [], now = new Date()) {
  let overdue = 0, critical = 0, unknown = 0;
  for (const r of rows) {
    const lvl = overdueLevel(r, now);
    if (lvl === "overdue") overdue++;
    else if (lvl === "critical") critical++;
    else if (lvl === "unknown") unknown++;
  }
  return { overdue, critical, unknown, total: overdue + critical };
}

/** "3h 20m" / "2d 4h" — readable at a glance in a table cell. */
export function fmtDuration(hours) {
  if (hours === null || hours === undefined) return "—";
  const mins = Math.round(hours * 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

/**
 * Status pill markup for a journey row. Drop-in replacement for the
 * Active/Closed pill: closed and on-time journeys look exactly as before.
 */
export function statusPill(row, now = new Date()) {
  const lvl = overdueLevel(row, now);
  const age = fmtDuration(hoursOpen(row, now));

  if (lvl === "closed") return `<span class="status-pill status-closed">Closed</span>`;
  if (lvl === "critical") {
    return `<span class="status-pill status-critical" title="Open ${age} — well past the review threshold. Confirm the patient was delivered, then close the record.">Overdue ${age}</span>`;
  }
  if (lvl === "overdue") {
    return `<span class="status-pill status-overdue" title="Open ${age} — past the review threshold.">Overdue ${age}</span>`;
  }
  if (lvl === "unknown") {
    return `<span class="status-pill status-unknown" title="No usable capture timestamp on this record, so its age cannot be determined.">Active · age unknown</span>`;
  }
  return `<span class="status-pill status-active" title="Open ${age}">Active</span>`;
}
