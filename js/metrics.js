/**
 * metrics.js — the aggregate engine behind the public Executive Dashboard.
 *
 * PRIVACY CONTRACT: this module turns patient records into an *aggregate-only*
 * snapshot (counts, averages, top facilities/stations/vehicles by volume,
 * district totals, trend arrays, alert counts, top referral routes). It never
 * writes a name, age, diagnosis or any patient-identifying field into the
 * snapshot. The snapshot lives at dashboardMetrics/public, the only document
 * readable without authentication — so the public view exposes operations data,
 * never PHI (POPIA-safe).
 *
 * SHIFTS: EMS runs two 12-hour shifts — Day 07:00–19:00 and Night 19:00–07:00
 * (SAST). The snapshot pre-computes the same aggregate for several windows
 * (current shift, previous shift, today, 7 days, 30 days, all time) so the
 * dashboard can default to the *current shift* and visibly reset at each
 * changeover, while filters widen the view. No records are ever deleted.
 *
 * Free-tier note: there is no Cloud Function on the Spark plan, so the snapshot
 * is (re)written client-side by authenticated staff — on every capture, every
 * close, and every time an operational dashboard loads.
 */

import { db, COL } from "./firebase-config.js";
import { doc, getDoc, setDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAllPatients, getStations, getDistricts, getVehicles } from "./data-service.js";
import * as S from "./stats.js";

const METRICS = COL.metrics || "dashboardMetrics"; // works even if COL isn't updated
const PUBLIC_DOC = "public";
const DAY = 86400000, HR = 3600000;
const toDate = (ts) => (ts?.toDate ? ts.toDate() : ts ? new Date(ts) : null);
const ymd = (d) => d.toISOString().slice(0, 10);
const round1 = (n) => Math.round(n * 10) / 10;

/* =======================================================  shift windows  */
/** Wall-clock parts in Africa/Johannesburg (SAST, UTC+2, no DST). */
function sastParts(d = new Date()) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  });
  const p = {}; f.formatToParts(d).forEach((x) => { if (x.type !== "literal") p[x.type] = x.value; });
  let h = parseInt(p.hour, 10); if (h === 24) h = 0;
  return { y: +p.year, mo: +p.month, d: +p.day, h };
}
/** A SAST wall-clock time expressed as the correct UTC instant. */
const sastInstant = (y, mo, d, h) => new Date(Date.UTC(y, mo - 1, d, h - 2, 0, 0, 0));

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

/* =======================================================  helpers  */
function windowCounts(rows, key) {
  const d7 = ymd(new Date(Date.now() - 7 * DAY));
  const d14 = ymd(new Date(Date.now() - 14 * DAY));
  const last = {}, prior = {};
  rows.forEach((r) => {
    const v = r[key]; if (!v || !r.date) return;
    if (r.date > d7) last[v] = (last[v] || 0) + 1;
    else if (r.date > d14) prior[v] = (prior[v] || 0) + 1;
  });
  return { last, prior };
}
const trendSign = (l, p) => (l > p ? "up" : l < p ? "down" : "flat");

function topList(rows, key, n = 10) {
  const total = rows.filter((r) => r[key]).length || 1;
  const { last, prior } = windowCounts(rows, key);
  return S.countBy(rows, key, n).map(([name, count]) => ({
    name, count, pct: round1((count / total) * 100), trend: trendSign(last[name] || 0, prior[name] || 0),
  }));
}

function daily(rows, days = 30) {
  const created = {}, done = {};
  rows.forEach((r) => {
    if (r.date) created[r.date] = (created[r.date] || 0) + 1;
    const cd = toDate(r.timeDelivered) || toDate(r.closedAt);
    if (cd) { const k = ymd(cd); done[k] = (done[k] || 0) + 1; }
  });
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i); const k = ymd(d);
    out.push({ date: k, label: k.slice(5), referrals: created[k] || 0, completed: done[k] || 0 });
  }
  return out;
}

function monthly(rows, months = 6) {
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(); d.setMonth(d.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("en-ZA", { month: "short", year: "2-digit" });
    out.push({ key, label, referrals: rows.filter((r) => (r.date || "").startsWith(key)).length });
  }
  return out;
}

function mondayOf(d) { const x = new Date(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); x.setHours(0, 0, 0, 0); return x; }
function weekly(rows, weeks = 8) {
  const cnt = {};
  rows.forEach((r) => { if (!r.date) return; const k = ymd(mondayOf(new Date(r.date))); cnt[k] = (cnt[k] || 0) + 1; });
  const out = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const mon = mondayOf(new Date(Date.now() - i * 7 * DAY)); const k = ymd(mon);
    out.push({ week: k, label: k.slice(5), referrals: cnt[k] || 0 });
  }
  return out;
}

function routes(rows, n = 8) {
  const c = {};
  rows.forEach((r) => {
    const a = r.referringFacility, b = r.receivingFacility;
    if (a && b) { const k = a + "\u0000" + b; c[k] = (c[k] || 0) + 1; }
  });
  return Object.entries(c).sort((x, y) => y[1] - x[1]).slice(0, n)
    .map(([k, count]) => { const [from, to] = k.split("\u0000"); return { from, to, count }; });
}

/**
 * Geocoded routes for the live map. Each entry is one referring→receiving pair
 * with coordinates, a total patient count and a per-vehicle breakdown. All
 * aggregate — vehicle registrations are operational identifiers, never PHI.
 */
function buildRouteMap(rows, n = 45) {
  const m = {};
  rows.forEach((r) => {
    const a = r.referringFacility, b = r.receivingFacility;
    if (!a || !b) return;
    const fl = +r.referringLat, fo = +r.referringLng, tl = +r.receivingLat, to = +r.receivingLng;
    if (!isFinite(fl) || !isFinite(fo) || !isFinite(tl) || !isFinite(to)) return; // need coords to plot
    const key = a + "\u0000" + b;
    let e = m[key];
    if (!e) e = m[key] = { from: a, to: b, fromLat: fl, fromLng: fo, toLat: tl, toLng: to, count: 0, byVehicle: {} };
    e.count++;
    const v = (r.vehicle || "").trim() || "Unassigned";
    e.byVehicle[v] = (e.byVehicle[v] || 0) + 1;
  });
  return Object.values(m).sort((x, y) => y.count - x.count).slice(0, n);
}

function vehicleUtil(rows, vehicles, allRows = rows) {
  const trips = {};
  rows.forEach((r) => { const v = r.vehicle; if (v) trips[v] = (trips[v] || 0) + 1; });
  const last = {};
  allRows.forEach((r) => { const v = r.vehicle, d = toDate(r.createdAt); if (v && d) last[v] = Math.max(last[v] || 0, d.getTime()); });
  const max = Math.max(1, ...Object.values(trips));
  const dates = rows.map((r) => r.date).filter(Boolean).sort();
  const span = dates.length ? Math.max(1, (new Date(dates[dates.length - 1]) - new Date(dates[0])) / DAY + 1) : 1;
  const listSrc = vehicles && vehicles.length ? vehicles.map((v) => v.registration) : Object.keys(trips);
  const now = Date.now();
  return listSrc.map((reg) => {
    const t = trips[reg] || 0;
    return { registration: reg, trips: t, perDay: round1(t / span), utilPct: Math.round((t / max) * 100), inactiveHrs: last[reg] ? Math.round((now - last[reg]) / HR) : null };
  }).sort((a, b) => b.trips - a.trips).slice(0, 12);
}

function alerts(rows, vehicles, allRows = rows) {
  const now = Date.now();
  const active = rows.filter((r) => !r.closed);
  const waitingOver2h = active.filter((r) => { const d = toDate(r.createdAt); return d && now - d.getTime() > 2 * HR; }).length;
  const noVehicle = active.filter((r) => !(r.vehicle || "").trim()).length;
  const last = {};
  allRows.forEach((r) => { const v = r.vehicle, d = toDate(r.createdAt); if (v && d) last[v] = Math.max(last[v] || 0, d.getTime()); });
  const vlist = vehicles && vehicles.length ? vehicles.map((v) => v.registration) : Object.keys(last);
  const inactiveVehicles = vlist.filter((v) => !last[v] || now - last[v] > 12 * HR).length; // fleet-wide
  const fc = {};
  rows.forEach((r) => { const f = r.referringFacility; if (f) fc[f] = (fc[f] || 0) + 1; });
  const vals = Object.values(fc).sort((a, b) => a - b);
  const median = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
  const thresh = Math.max(3, median * 2);
  const highVolumeFacilities = Object.entries(fc).filter(([, c]) => c >= thresh).map(([f]) => f).slice(0, 5);
  return { waitingOver2h, noVehicle, inactiveVehicles, highVolumeFacilities };
}

/** The per-window aggregate. `allRows` is used for fleet-wide idle detection. */
function coreAggregate(rows, refs = {}, allRows = rows) {
  const now = Date.now();
  const active = rows.filter((r) => !r.closed);
  const closed = rows.filter((r) => r.closed);
  const byDMap = {};
  rows.forEach((r) => { const d = r.referringDistrict || r.district; if (d) byDMap[d] = (byDMap[d] || 0) + 1; });
  const byDistrict = Object.entries(byDMap).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));

  const topRef = topList(rows, "referringFacility", 10);
  const topRec = topList(rows, "receivingFacility", 10);
  const topSta = topList(rows, "station", 10);
  const veh = vehicleUtil(rows, refs.vehicles, allRows);
  const longest = active.reduce((m, r) => { const d = toDate(r.createdAt); return d ? Math.max(m, Math.round((now - d.getTime()) / 60000)) : m; }, 0);

  return {
    totals: {
      total: rows.length, active: active.length, closed: closed.length, pending: active.length,
      completed: closed.length, newToday: rows.filter((r) => r.date === ymd(new Date())).length,
    },
    averages: { transferMinutes: S.avgTransportMinutes(closed), longestWaitingMinutes: longest },
    highlights: {
      topFacility: topRef[0] ? { name: topRef[0].name, count: topRef[0].count } : { name: "—", count: 0 },
      topReceiving: topRec[0] ? { name: topRec[0].name, count: topRec[0].count } : { name: "—", count: 0 },
      topStation: topSta[0] ? { name: topSta[0].name, count: topSta[0].count } : { name: "—", count: 0 },
      topVehicle: veh[0] && veh[0].trips ? { name: veh[0].registration, count: veh[0].trips } : { name: "—", count: 0 },
      topDistrict: byDistrict[0] || { name: "—", count: 0 },
    },
    byDistrict, topReferring: topRef, topReceiving: topRec, topStations: topSta,
    vehicles: veh, routes: routes(rows, 8), routeMap: buildRouteMap(rows, 45), alerts: alerts(rows, refs.vehicles, allRows),
  };
}

/**
 * Build the full snapshot: global trend arrays + shift metadata + the six
 * pre-computed aggregate windows. Safe to store world-readable.
 */
export function computeSnapshot(rows, refs = {}) {
  const cs = currentShift();
  const prev = currentShift(new Date(cs.start.getTime() - 1));
  const todayStr = ymd(new Date());
  const d7 = ymd(new Date(Date.now() - 6 * DAY));   // inclusive last 7 days
  const d30 = ymd(new Date(Date.now() - 29 * DAY)); // inclusive last 30 days
  const inWin = (r, s, e) => { const d = toDate(r.createdAt); return d && d >= s && d < e; };

  const scopes = {
    shift: coreAggregate(rows.filter((r) => inWin(r, cs.start, cs.end)), refs, rows),
    prevShift: coreAggregate(rows.filter((r) => inWin(r, prev.start, prev.end)), refs, rows),
    today: coreAggregate(rows.filter((r) => r.date === todayStr), refs, rows),
    d7: coreAggregate(rows.filter((r) => r.date && r.date >= d7), refs, rows),
    d30: coreAggregate(rows.filter((r) => r.date && r.date >= d30), refs, rows),
    all: coreAggregate(rows, refs, rows),
  };

  const mon = monthly(rows, 6);
  const mom = mon.length >= 2 && mon[mon.length - 2].referrals
    ? round1(((mon[mon.length - 1].referrals - mon[mon.length - 2].referrals) / mon[mon.length - 2].referrals) * 100) : null;

  return {
    updatedAt: new Date().toISOString(),
    shiftMeta: {
      currentKey: cs.key, currentStartISO: cs.start.toISOString(), currentEndISO: cs.end.toISOString(), currentLabel: shiftLabel(cs),
      prevKey: prev.key, prevStartISO: prev.start.toISOString(), prevEndISO: prev.end.toISOString(), prevLabel: shiftLabel(prev),
    },
    daily: daily(rows, 30), weekly: weekly(rows, 8), monthly: mon, momChangePct: mom,
    scopes,
    ...scopes.all, // top-level mirror (all-time) for resilience / older readers
  };
}

/* =======================================================  persistence  */
export async function writeSnapshot(rows, refs = {}) {
  const snap = computeSnapshot(rows, refs);
  await setDoc(doc(db, METRICS, PUBLIC_DOC), snap);
  return snap;
}

/* ===================================================  read-quota guards  */
/**
 * QUOTA NOTE — read this before changing the numbers below.
 *
 * refreshSnapshot() calls getAllPatients(), which reads EVERY patient document.
 * Firestore bills one read per document, so the cost of a single refresh grows
 * with the size of the register. It was previously fired on every capture and
 * every journey close, which means the daily read cost grows as
 * (captures per day x records in the register) — i.e. quadratically. On the
 * Spark plan's 50,000 reads/day that wall arrives without warning, and when it
 * does Firestore simply stops answering until the quota resets.
 *
 * Two guards below:
 *   1. COALESCE  — concurrent callers share one in-flight refresh.
 *   2. THROTTLE  — at most one refresh per REFRESH_MIN_MS, shared across tabs
 *                  via localStorage. A skipped call schedules a TRAILING run so
 *                  the last capture in a burst is never lost.
 *
 * This caps refreshes per day, but each refresh still costs one read per
 * record. It buys time; it is not the structural fix. See PHASE 2 in
 * IMPLEMENTATION-NOTES.md (windowed scan + all-time counters).
 */
const REFRESH_MIN_MS = 120000;              // one refresh per 2 minutes, at most
const REFRESH_LOCK_KEY = "gset:lastSnapshotRefresh";

let refreshInFlight = null;                  // shared promise for concurrent callers
let trailingTimer = null;                    // pending trailing refresh
let lastRefreshLocal = 0;                    // fallback when localStorage is unavailable

function lastRefreshAt() {
  try { return Number(localStorage.getItem(REFRESH_LOCK_KEY)) || 0; }
  catch { return lastRefreshLocal; }
}
function markRefreshed(t) {
  lastRefreshLocal = t;
  try { localStorage.setItem(REFRESH_LOCK_KEY, String(t)); } catch { /* private mode */ }
}

/** The actual full recompute. Always reads the whole patient collection. */
async function runRefresh() {
  markRefreshed(Date.now());                 // mark BEFORE, so a slow run still blocks others
  const [rows, stations, districts, vehicles] = await Promise.all([
    getAllPatients(), getStations().catch(() => []), getDistricts().catch(() => []), getVehicles().catch(() => []),
  ]);
  return writeSnapshot(rows, { stations, districts, vehicles });
}

/**
 * Rebuild and publish the aggregate snapshot, throttled.
 * @param {{force?: boolean}} [opts] force:true bypasses the throttle — use only
 *        for an explicit "refresh now" button, never in a capture/close path.
 * @returns {Promise<object|null>} the snapshot, or null when the call was
 *          throttled (a trailing refresh has been scheduled instead).
 */
export async function refreshSnapshot(opts = {}) {
  if (refreshInFlight) return refreshInFlight;           // 1. coalesce

  const waited = Date.now() - lastRefreshAt();
  if (!opts.force && waited < REFRESH_MIN_MS) {          // 2. throttle
    if (!trailingTimer) {                                //    ...with trailing edge
      trailingTimer = setTimeout(() => {
        trailingTimer = null;
        refreshSnapshot().catch(() => {});
      }, REFRESH_MIN_MS - waited + 250);
    }
    return null;
  }

  refreshInFlight = runRefresh().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

/** Read the public snapshot once. Works WITHOUT authentication (rules permit it). */
export async function readSnapshot() {
  const s = await getDoc(doc(db, METRICS, PUBLIC_DOC));
  return s.exists() ? s.data() : null;
}

/**
 * Subscribe to the public snapshot.
 *
 * Replaces polling. A Firestore listener bills a read when the document is
 * first attached and then only when it actually CHANGES — so an idle dashboard
 * costs nothing, where a 30-second poll cost 2,880 reads per day per open tab.
 *
 * @param {(snap: object|null) => void} onData  fired on attach and on change
 * @param {(err: Error) => void} [onError]      transport/permission failures
 * @returns {() => void} unsubscribe
 */
export function subscribeSnapshot(onData, onError) {
  return onSnapshot(
    doc(db, METRICS, PUBLIC_DOC),
    (s) => onData(s.exists() ? s.data() : null),
    (err) => { if (onError) onError(err); }
  );
}
