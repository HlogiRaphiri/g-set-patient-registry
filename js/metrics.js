/**
 * metrics.js — the aggregate engine behind the public Executive Dashboard.
 *
 * PRIVACY CONTRACT: this module produces an *aggregate-only* snapshot (counts,
 * averages, top facilities/stations/vehicles by volume, district totals, trend
 * arrays, alert counts, top referral routes). It never writes a name, age,
 * diagnosis or any patient-identifying field into the snapshot. The snapshot
 * lives at dashboardMetrics/public, the only document readable without
 * authentication — so the public view exposes operations data, never PHI
 * (POPIA-safe).
 *
 * SHIFTS: EMS runs two 12-hour shifts — Day 07:00–19:00 and Night 19:00–07:00
 * (SAST). The snapshot pre-computes the same aggregate for several windows
 * (current shift, previous shift, today, 7 days, 30 days, all time) so the
 * dashboard can default to the *current shift* and visibly reset at each
 * changeover, while filters widen the view. No records are ever deleted.
 *
 * SOURCE DATA: the snapshot is built from the running totals in
 * registry-stats.js (updated in the same batch as every capture, close and
 * vehicle correction) plus the list of OPEN journeys. It never reads the whole
 * register, so its cost does not grow as the register does.
 *
 * Free-tier note: there is no Cloud Function on the Spark plan, so the snapshot
 * is (re)written client-side by authenticated staff — after captures, closes
 * and vehicle edits, and when the operational dashboard loads — throttled by
 * refreshSnapshot() below.
 */

import { db, COL } from "./firebase-config.js";
import { doc, getDoc, setDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getActivePatients, getStations, getDistricts, getVehicles } from "./data-service.js";
import { currentShift, shiftLabel } from "./shifts.js";
import { readStatsBuckets, mergeBuckets, emptyBucket, plottable, mondayOf, ymd, toDate } from "./registry-stats.js";

// Re-exported so existing importers (public-dashboard.js) keep working.
export { currentShift, shiftLabel };

const METRICS = COL.metrics || "dashboardMetrics"; // works even if COL isn't updated
const PUBLIC_DOC = "public";
const DAY = 86400000, HR = 3600000;
const round1 = (n) => Math.round(n * 10) / 10;

/* =======================================================  helpers  */
const entriesDesc = (m) => Object.entries(m || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
const sum = (m) => Object.values(m || {}).reduce((s, n) => s + n, 0);
const trendSign = (l, p) => (l > p ? "up" : l < p ? "down" : "flat");

/** Days between the earliest and latest date, inclusive (min 1). */
function spanOf(dates) {
  const ds = dates.filter(Boolean).sort();
  if (!ds.length) return 1;
  return Math.max(1, (new Date(ds[ds.length - 1]) - new Date(ds[0])) / DAY + 1);
}

/**
 * Top `n` names with share and a trend arrow (last 7 days vs the 7 before).
 * @param {Record<string, number>} map counts for the scope
 * @param {{last?: object, prior?: object}} trend counts in the two trend windows
 */
function topList(map, n, trend) {
  const total = sum(map) || 1;
  return entriesDesc(map).slice(0, n).map(([name, count]) => ({
    name, count, pct: round1((count / total) * 100),
    trend: trendSign(trend.last?.[name] || 0, trend.prior?.[name] || 0),
  }));
}

function daily(days, n = 30) {
  const created = {}, done = {};
  days.forEach((d) => { created[d.date] = d.total; done[d.date] = d.delivered; });
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i); const k = ymd(d);
    out.push({ date: k, label: k.slice(5), referrals: created[k] || 0, completed: done[k] || 0 });
  }
  return out;
}

function monthly(byMonth, months = 6) {
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(); d.setMonth(d.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("en-ZA", { month: "short", year: "2-digit" });
    out.push({ key, label, referrals: byMonth[key] || 0 });
  }
  return out;
}

function weekly(byWeek, weeks = 8) {
  const out = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const mon = mondayOf(new Date(Date.now() - i * 7 * DAY)); const k = ymd(mon);
    out.push({ week: k, label: k.slice(5), referrals: byWeek[k] || 0 });
  }
  return out;
}

function routes(b, n = 8) {
  return Object.values(b.routes).sort((x, y) => y.n - x.n).slice(0, n)
    .map((e) => ({ from: e.from, to: e.to, count: e.n }));
}

/**
 * Geocoded routes for the live map. Each entry is one referring→receiving pair
 * with coordinates, a patient count and a per-vehicle breakdown. All
 * aggregate — vehicle registrations are operational identifiers, never PHI.
 *
 * Journeys whose facilities could not be geocoded are counted in
 * `routeMapUnplotted` rather than dropped silently, so the dashboard can say
 * that the map is incomplete instead of quietly under-reporting.
 */
function buildRouteMap(b, n = 45) {
  let unplotted = 0;
  const list = [];
  for (const e of Object.values(b.routes)) {
    const g1 = b.geo[e.ea], g2 = b.geo[e.eb];
    const ok = e.p > 0 && g1 && g2 && plottable(g1[0], g1[1]) && plottable(g2[0], g2[1]);
    unplotted += Math.max(0, e.n - (ok ? e.p : 0));
    if (ok) list.push({ from: e.from, to: e.to, fromLat: g1[0], fromLng: g1[1], toLat: g2[0], toLng: g2[1], count: e.p, byVehicle: { ...e.v } });
  }
  const out = list.sort((x, y) => y.count - x.count).slice(0, n);
  out.unplotted = unplotted;
  return out;
}

/** `lastMap` is fleet-wide: registration → time of last captured trip (ms). */
function vehicleUtil(byVehicle, vehicles, lastMap, span) {
  const max = Math.max(1, ...Object.values(byVehicle));
  const listSrc = vehicles && vehicles.length ? vehicles.map((v) => v.registration) : Object.keys(byVehicle);
  const now = Date.now();
  return listSrc.map((reg) => {
    const t = byVehicle[reg] || 0;
    const last = lastMap[reg];
    return { registration: reg, trips: t, perDay: round1(t / span), utilPct: Math.round((t / max) * 100), inactiveHrs: last ? Math.round((now - last) / HR) : null };
  }).sort((a, b) => b.trips - a.trips).slice(0, 12);
}

function alerts(active, byReferring, vehicles, lastMap) {
  const now = Date.now();
  const waitingOver2h = active.filter((r) => { const d = toDate(r.createdAt); return d && now - d.getTime() > 2 * HR; }).length;
  const noVehicle = active.filter((r) => !(r.vehicle || "").trim()).length;
  const vlist = vehicles && vehicles.length ? vehicles.map((v) => v.registration) : Object.keys(lastMap);
  const inactiveVehicles = vlist.filter((v) => !lastMap[v] || now - lastMap[v] > 12 * HR).length; // fleet-wide
  const vals = Object.values(byReferring).sort((a, b) => a - b);
  const median = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
  const thresh = Math.max(3, median * 2);
  const highVolumeFacilities = entriesDesc(byReferring).filter(([, c]) => c >= thresh).map(([f]) => f).slice(0, 5);
  return { waitingOver2h, noVehicle, inactiveVehicles, highVolumeFacilities };
}

/**
 * The per-window aggregate.
 * @param {object} b       merged counter bucket for the window
 * @param {object[]} active open journeys that fall inside the window
 * @param {object} ctx     { vehicles, lastMap, span, trendLast, trendPrior, newToday }
 */
function coreAggregate(b, active, ctx) {
  const now = Date.now();
  const total = b.total;
  const closed = Math.max(0, total - active.length);
  const byDistrict = entriesDesc(b.byDistrict).map(([name, count]) => ({ name, count }));
  const trend = (f) => ({ last: ctx.trendLast?.[f], prior: ctx.trendPrior?.[f] });

  const topRef = topList(b.byReferring, 10, trend("byReferring"));
  const topRec = topList(b.byReceiving, 10, trend("byReceiving"));
  const topSta = topList(b.byStation, 10, trend("byStation"));
  const veh = vehicleUtil(b.byVehicle, ctx.vehicles, ctx.lastMap, ctx.span);
  const rmap = buildRouteMap(b, 45);
  const longest = active.reduce((m, r) => { const d = toDate(r.createdAt); return d ? Math.max(m, Math.round((now - d.getTime()) / 60000)) : m; }, 0);

  return {
    totals: {
      total, active: active.length, closed, pending: active.length,
      completed: closed, newToday: ctx.newToday,
    },
    averages: { transferMinutes: b.transferN ? Math.round(b.transferSum / b.transferN) : null, longestWaitingMinutes: longest },
    highlights: {
      topFacility: topRef[0] ? { name: topRef[0].name, count: topRef[0].count } : { name: "—", count: 0 },
      topReceiving: topRec[0] ? { name: topRec[0].name, count: topRec[0].count } : { name: "—", count: 0 },
      topStation: topSta[0] ? { name: topSta[0].name, count: topSta[0].count } : { name: "—", count: 0 },
      topVehicle: veh[0] && veh[0].trips ? { name: veh[0].registration, count: veh[0].trips } : { name: "—", count: 0 },
      topDistrict: byDistrict[0] || { name: "—", count: 0 },
    },
    byDistrict, topReferring: topRef, topReceiving: topRec, topStations: topSta,
    vehicles: veh, routes: routes(b, 8), routeMap: rmap, routeMapUnplotted: rmap.unplotted || 0,
    alerts: alerts(active, b.byReferring, ctx.vehicles, ctx.lastMap),
  };
}

/**
 * Build the full snapshot: global trend arrays + shift metadata + the six
 * pre-computed aggregate windows. Safe to store world-readable.
 *
 * @param {object} stats   from readStatsBuckets()
 * @param {object[]} open  every open journey (closed == false)
 * @param {object} refs    { vehicles, stations, districts }
 */
export function computeSnapshot(stats, open = [], refs = {}) {
  const cs = currentShift();
  const prev = currentShift(new Date(cs.start.getTime() - 1));
  const todayStr = ymd(new Date());
  const d7 = ymd(new Date(Date.now() - 6 * DAY));    // inclusive last 7 days
  const d30 = ymd(new Date(Date.now() - 29 * DAY));  // inclusive last 30 days
  const trendCut = ymd(new Date(Date.now() - 7 * DAY));   // trend: last 7 days ...
  const priorCut = ymd(new Date(Date.now() - 14 * DAY));  // ... vs the 7 before
  const inWin = (r, s, e) => { const d = toDate(r.createdAt); return d && d >= s && d < e; };

  const days = stats.days;
  const daysFrom = (from) => days.filter((d) => d.date >= from);
  const activeDates = (list) => list.filter((d) => d.total > 0).map((d) => d.date);
  const todayB = days.find((d) => d.date === todayStr) || emptyBucket();
  const trendLast = mergeBuckets(days.filter((d) => d.date > trendCut));
  const trendPrior = mergeBuckets(days.filter((d) => d.date > priorCut && d.date <= trendCut));
  const d7Days = daysFrom(d7), d30Days = daysFrom(d30);
  const d7B = mergeBuckets(d7Days);
  const firstMonth = Object.keys(stats.byMonth).sort()[0];
  const base = { vehicles: refs.vehicles, lastMap: stats.vehicleLast };

  const shiftScope = (b, sh) => coreAggregate(b, open.filter((r) => inWin(r, sh.start, sh.end)), {
    ...base, span: spanOf(Object.keys(b.byDate)), trendLast: b, trendPrior: null, newToday: b.byDate[todayStr] || 0,
  });

  const scopes = {
    shift: shiftScope(stats.shift, cs),
    prevShift: shiftScope(stats.prevShift, prev),
    today: coreAggregate(todayB, open.filter((r) => r.date === todayStr), {
      ...base, span: 1, trendLast: todayB, trendPrior: null, newToday: todayB.total,
    }),
    d7: coreAggregate(d7B, open.filter((r) => r.date && r.date >= d7), {
      ...base, span: spanOf(activeDates(d7Days)), trendLast: d7B, trendPrior: null, newToday: todayB.total,
    }),
    d30: coreAggregate(mergeBuckets(d30Days), open.filter((r) => r.date && r.date >= d30), {
      ...base, span: spanOf(activeDates(d30Days)), trendLast, trendPrior, newToday: todayB.total,
    }),
    all: coreAggregate(stats.all, open, {
      ...base, span: spanOf([stats.firstDate || (firstMonth ? `${firstMonth}-01` : null), ...activeDates(days)]),
      trendLast, trendPrior, newToday: todayB.total,
    }),
  };

  const mon = monthly(stats.byMonth, 6);
  const mom = mon.length >= 2 && mon[mon.length - 2].referrals
    ? round1(((mon[mon.length - 1].referrals - mon[mon.length - 2].referrals) / mon[mon.length - 2].referrals) * 100) : null;

  return {
    updatedAt: new Date().toISOString(),
    shiftMeta: {
      currentKey: cs.key, currentStartISO: cs.start.toISOString(), currentEndISO: cs.end.toISOString(), currentLabel: shiftLabel(cs),
      prevKey: prev.key, prevStartISO: prev.start.toISOString(), prevEndISO: prev.end.toISOString(), prevLabel: shiftLabel(prev),
    },
    daily: daily(days, 30), weekly: weekly(stats.byWeek, 8), monthly: mon, momChangePct: mom,
    scopes,
    ...scopes.all, // top-level mirror (all-time) for resilience / older readers
  };
}

/* =======================================================  persistence  */
export async function writeSnapshot(stats, open, refs = {}) {
  const snap = computeSnapshot(stats, open, refs);
  await setDoc(doc(db, METRICS, PUBLIC_DOC), snap);
  return snap;
}

/* ===================================================  read-quota guards  */
/**
 * QUOTA NOTE — read this before changing the numbers below.
 *
 * A refresh reads ~42 counter documents (registry-stats.js) plus one read per
 * OPEN journey. It no longer reads the register, so its cost stays flat as the
 * register grows. It used to call getAllPatients() — one read per record ever
 * captured, on every capture and close — which is what pushed the project past
 * the Spark plan's 50,000 reads/day.
 *
 * Two guards remain below:
 *   1. COALESCE  — concurrent callers share one in-flight refresh.
 *   2. THROTTLE  — at most one refresh per REFRESH_MIN_MS, shared across tabs
 *                  via localStorage. A skipped call schedules a TRAILING run so
 *                  the last capture in a burst is never lost.
 *
 * The throttle is 30 minutes: at most 48 refreshes per day per browser (the
 * lock is localStorage, so each workstation has its own), however many
 * captures, closes and vehicle edits happen. The public snapshot can therefore
 * lag by up to 30 minutes after a capture.
 */
const REFRESH_MIN_MS = 1800000;             // one refresh per 30 minutes, at most
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

/** The actual recompute: counter buckets + open journeys. */
async function runRefresh() {
  markRefreshed(Date.now());                 // mark BEFORE, so a slow run still blocks others
  const stats = await readStatsBuckets();
  if (!stats) {
    // Before the first rebuild the totals are incomplete; publishing them would
    // show near-zero all-time figures. Leave the existing snapshot in place.
    console.warn("[metrics] Statistics not built yet — run Admin → Setup → Rebuild Statistics. Public snapshot left unchanged.");
    return null;
  }
  const [open, stations, districts, vehicles] = await Promise.all([
    getActivePatients(), getStations().catch(() => []), getDistricts().catch(() => []), getVehicles().catch(() => []),
  ]);
  return writeSnapshot(stats, open, { stations, districts, vehicles });
}

/**
 * Rebuild and publish the aggregate snapshot, throttled.
 * @param {{force?: boolean}} [opts] force:true bypasses the throttle — use only
 *        for an explicit "refresh now" action, never in a capture/close path.
 * @returns {Promise<object|null>} the snapshot, or null when the call was
 *          throttled (a trailing refresh has been scheduled instead) or the
 *          statistics have not been built yet.
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
