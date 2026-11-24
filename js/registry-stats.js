/**
 * registry-stats.js — running totals that let the public snapshot be rebuilt
 * WITHOUT reading the patient register.
 *
 * WHY
 * The snapshot used to be computed from every patient document, so each
 * refresh cost one read per record ever captured — a cost that grows by ~200
 * every day. Now every capture, close and vehicle correction adds its share to
 * a few counter documents IN THE SAME ATOMIC BATCH as the patient write. A
 * refresh reads ~35 counter documents plus the open journeys, whatever the
 * size of the register.
 *
 * DOCUMENTS — all in the `counters` collection, which firestore.rules already
 * lets capture roles create/update and any signed-in user read:
 *   stats-all             all-time totals and name maps, plus byMonth, byWeek,
 *                         vehicleLast (last trip per vehicle), firstDate, builtAt
 *   stats-routes          all-time referring→receiving pairs and coordinates
 *                         (kept apart from stats-all because it is the part that
 *                         grows, and a document is capped at 1 MiB)
 *   stats-day-YYYY-MM-DD  one per incident `date` — the field the today / 7-day /
 *                         30-day scopes have always filtered on
 *   stats-shift-<shiftId> one per 12-hour shift, by capture time
 *
 * BUCKET FIELDS
 *   total, closed           journeys created in the bucket, and how many are closed
 *   transferSum, transferN  minutes from capture to delivery, for the average
 *   delivered               journeys DELIVERED on that day (day documents)
 *   byDistrict, byReferring, byReceiving, byStation, byVehicle   { name: count }
 *   routes  { "<from>|<to>": { n, p, v: { vehicle: count } } }  n = all, p = mappable
 *   geo     { facility: [lat, lng] }
 *   byDate  { "YYYY-MM-DD": count }  (shift documents: for "new today")
 * Map keys are encodeURIComponent()-encoded, so a name containing ".", "/" or
 * "|" is always a valid, unambiguous field name.
 *
 * PRIVACY: the same contract as metrics.js — counts and operational names
 * (facilities, stations, vehicles) only. Never a patient name, age or diagnosis.
 *
 * TRUST: nothing reads these totals until a full rebuild (Admin → Setup →
 * Rebuild Statistics) has stamped stats-all.builtAt. Until then
 * readStatsBuckets() returns null and the public snapshot is left untouched.
 */

import { db, COL } from "./firebase-config.js";
import { rowDistrict } from "./districts.js";
import { currentShift, shiftId } from "./shifts.js";
import {
  collection, doc, getDoc, getDocs, query, where, documentId, writeBatch, increment, getCountFromServer,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const STATS_ALL = "stats-all";
export const STATS_ROUTES = "stats-routes";
const DAY_PREFIX = "stats-day-";
const DAY = 86400000, HR = 3600000;

export const ymd = (d) => d.toISOString().slice(0, 10);

/**
 * Any stored timestamp shape → a valid Date, or null. Records arrive as
 * Firestore Timestamps, but imported ones may hold strings or plain
 * { seconds } maps — and an unreadable value must become null, never an
 * Invalid Date (which throws in toISOString() and would abort a rebuild).
 */
export function toDate(ts) {
  if (!ts) return null;
  let d;
  if (typeof ts.toDate === "function") { try { d = ts.toDate(); } catch { return null; } }
  else if (ts instanceof Date) d = ts;
  else if (typeof ts.seconds === "number") d = new Date(ts.seconds * 1000);
  else d = new Date(ts);
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
}
/** A "YYYY-MM-DD" string that is also a real calendar date. */
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s).getTime());

export const dayId = (date) => DAY_PREFIX + date;
export const shiftDocId = (when) => `stats-shift-${shiftId(when)}`;

const fkey = (s) => encodeURIComponent(String(s));
const unkey = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const routeKey = (a, b) => `${fkey(a)}|${fkey(b)}`;

/** Monday (local time) of the week containing `d`. */
export function mondayOf(d) { const x = new Date(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); x.setHours(0, 0, 0, 0); return x; }
/** Week bucket for an incident date — the same key the weekly chart builds. */
export const weekKey = (date) => ymd(mondayOf(new Date(date)));

/* ====================================================  coordinate checks  */
/**
 * Bounding box for South Africa, generous at the edges. The service is
 * Gauteng-only, but validating against the country rather than the province
 * leaves room for a genuine cross-border transfer without letting a corrupt
 * coordinate through. Widen deliberately if the service area ever changes.
 */
const ZA_BOUNDS = { latMin: -35.5, latMax: -21.5, lngMin: 15.5, lngMax: 33.5 };

/**
 * Parse one stored coordinate.
 *
 * WHY THIS IS NOT `+value`: JavaScript coerces both null and "" to 0, and
 * isFinite(0) is true — so a facility whose coordinates were never resolved
 * passed validation as the point 0°N 0°E and was plotted in the Gulf of Guinea.
 * That produced arcs running from Gauteng to the Atlantic on the live map.
 *
 * @returns {number|null} null when the value is absent or unusable
 */
export function coord(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

/** Both coordinates present, non-zero, and inside the service area. */
export function plottable(lat, lng) {
  if (lat === null || lng === null || lat === undefined || lng === undefined) return false;
  if (lat === 0 && lng === 0) return false;                       // Null Island
  if (lat < ZA_BOUNDS.latMin || lat > ZA_BOUNDS.latMax) return false;
  if (lng < ZA_BOUNDS.lngMin || lng > ZA_BOUNDS.lngMax) return false;  // also catches swapped lat/lng
  return true;
}

/* ======================================================  delta building  */
/** A value to store as-is (coordinates, timestamps) rather than add. */
class Put { constructor(v) { this.v = v; } }
const put = (v) => new Put(v);

/**
 * Fold delta `d` into `t`: numbers add, put() values replace, maps recurse.
 * With unwrap=true the put() wrappers are removed, giving plain stored data.
 */
function fold(t, d, unwrap) {
  for (const [key, v] of Object.entries(d)) {
    if (v instanceof Put) t[key] = unwrap ? v.v : v;
    else if (typeof v === "number") t[key] = (typeof t[key] === "number" ? t[key] : 0) + v;
    else if (v && typeof v === "object") {
      if (!t[key] || typeof t[key] !== "object" || t[key] instanceof Put) t[key] = {};
      fold(t[key], v, unwrap);
    }
  }
  return t;
}

/** Pending changes, grouped by counter document id. */
class Deltas {
  constructor() { this.docs = new Map(); }
  add(id, delta) {
    if (!id || !delta) return this;
    if (!this.docs.has(id)) this.docs.set(id, {});
    fold(this.docs.get(id), delta, false);
    return this;
  }
}

/** Convert a delta to a Firestore merge payload: numbers become increment(). */
function toWrite(d) {
  const out = {};
  for (const [key, v] of Object.entries(d)) {
    if (v instanceof Put) out[key] = v.v;
    else if (typeof v === "number") out[key] = increment(v);
    else out[key] = toWrite(v);
  }
  return out;
}

/** Add every counter change to `batch` as a merge write. No reads involved. */
export function applyDeltas(batch, deltas) {
  for (const [id, d] of deltas.docs) batch.set(doc(db, COL.counters, id), toWrite(d), { merge: true });
}

/** The per-name counts one journey contributes. */
function namesPart(row) {
  const d = { total: 1 };
  const add = (field, name) => { if (name) d[field] = { [fkey(name)]: 1 }; };
  add("byDistrict", rowDistrict(row));
  add("byReferring", row.referringFacility);
  add("byReceiving", row.receivingFacility);
  add("byStation", row.station);
  add("byVehicle", row.vehicle);
  return d;
}

/** Referring→receiving pair, with coordinates when both ends can be mapped. */
function routeGeo(row) {
  const a = row.referringFacility, b = row.receivingFacility;
  if (!a || !b) return null;
  const fl = coord(row.referringLat), fo = coord(row.referringLng);
  const tl = coord(row.receivingLat), to = coord(row.receivingLng);
  return { a, b, fl, fo, tl, to, ok: plottable(fl, fo) && plottable(tl, to) };
}

const vehicleLabel = (v) => String(v || "").trim() || "Unassigned";

function routePart(row) {
  const g = routeGeo(row);
  if (!g) return null;
  const e = { n: 1 };
  const d = { routes: { [routeKey(g.a, g.b)]: e } };
  if (g.ok) {
    e.p = 1;
    e.v = { [fkey(vehicleLabel(row.vehicle))]: 1 };
    d.geo = { [fkey(g.a)]: put([g.fl, g.fo]), [fkey(g.b)]: put([g.tl, g.to]) };
  }
  return d;
}

/**
 * Counter changes for a newly captured journey.
 * @param {object} row      the patient payload
 * @param {Date|null} created capture time (client clock for a live capture)
 */
export function captureDeltas(row, created, deltas = new Deltas()) {
  const base = namesPart(row);
  const route = routePart(row);
  const day = isDate(row.date) ? dayId(row.date) : null;
  const shift = created ? shiftDocId(created) : null;

  deltas.add(STATS_ALL, base);
  if (route) deltas.add(STATS_ROUTES, route);
  for (const id of [day, shift]) {
    if (!id) continue;
    deltas.add(id, base);
    if (route) deltas.add(id, route);
  }
  if (isDate(row.date)) deltas.add(STATS_ALL, { byMonth: { [row.date.slice(0, 7)]: 1 }, byWeek: { [weekKey(row.date)]: 1 } });
  if (row.vehicle && created) deltas.add(STATS_ALL, { vehicleLast: { [fkey(row.vehicle)]: put(created) } });
  if (shift && isDate(row.date)) deltas.add(shift, { byDate: { [row.date]: 1 } });
  return deltas;
}

/** "Closed" and transfer-time counts, added to the buckets the journey was CREATED in. */
function closedPart(row, transferEnd, deltas) {
  const created = toDate(row.createdAt);
  const part = { closed: 1 };
  if (created && transferEnd && transferEnd > created) {
    part.transferSum = (transferEnd - created) / 60000;
    part.transferN = 1;
  }
  deltas.add(STATS_ALL, part);
  if (isDate(row.date)) deltas.add(dayId(row.date), part);
  if (created) deltas.add(shiftDocId(created), part);
}

/**
 * Counter changes for closing a journey now. Transfer time is measured on the
 * client clock (now − createdAt); the stored timeDelivered is a server
 * timestamp, so the two can differ by a few seconds of clock skew.
 */
export function closeDeltas(row, when = new Date()) {
  const deltas = new Deltas();
  closedPart(row, when, deltas);
  deltas.add(dayId(ymd(when)), { delivered: 1 });
  return deltas;
}

/** Counter changes for correcting a journey's vehicle from `oldV` to `newV`. */
export function vehicleDeltas(row, oldV, newV, when = new Date()) {
  const deltas = new Deltas();
  const created = toDate(row.createdAt);
  const buckets = [isDate(row.date) && dayId(row.date), created && shiftDocId(created)].filter(Boolean);

  const bv = {};
  if (oldV) bv[fkey(oldV)] = (bv[fkey(oldV)] || 0) - 1;
  if (newV) bv[fkey(newV)] = (bv[fkey(newV)] || 0) + 1;
  [STATS_ALL, ...buckets].forEach((id) => deltas.add(id, { byVehicle: bv }));

  const g = routeGeo(row);
  const from = vehicleLabel(oldV), to = vehicleLabel(newV);
  if (g?.ok && from !== to) {
    const rv = { [fkey(from)]: -1, [fkey(to)]: 1 };
    [STATS_ROUTES, ...buckets].forEach((id) => deltas.add(id, { routes: { [routeKey(g.a, g.b)]: { v: rv } } }));
  }

  // Last-trip time drives the "inactive vehicle" alert (12 h). Only a recent
  // journey can change that, so older corrections leave vehicleLast alone.
  if (newV && created && when - created < 12 * HR) {
    deltas.add(STATS_ALL, { vehicleLast: { [fkey(newV)]: put(created) } });
  }
  return deltas;
}

/* ===========================================================  reading  */
const NAME_MAPS = ["byDistrict", "byReferring", "byReceiving", "byStation", "byVehicle"];
const SCALARS = ["total", "closed", "transferSum", "transferN", "delivered"];
const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : 0);

/** Positive counts only (a corrected vehicle can leave a 0 behind). */
function counts(m, decode) {
  const out = {};
  for (const [key, v] of Object.entries(m || {})) {
    const n = num(v);
    if (n > 0) out[decode ? unkey(key) : key] = n;
  }
  return out;
}
function addCounts(t, s) { for (const [k, n] of Object.entries(s)) t[k] = (t[k] || 0) + n; }

export function emptyBucket() {
  const b = { routes: {}, geo: {}, byDate: {} };
  SCALARS.forEach((f) => (b[f] = 0));
  NAME_MAPS.forEach((f) => (b[f] = {}));
  return b;
}

/** Stored counter document → bucket with decoded names. */
function normalize(raw = {}) {
  const b = emptyBucket();
  SCALARS.forEach((f) => (b[f] = num(raw[f])));
  NAME_MAPS.forEach((f) => (b[f] = counts(raw[f], true)));
  b.byDate = counts(raw.byDate, false);
  for (const [rk, e] of Object.entries(raw.routes || {})) {
    const [ea, eb] = rk.split("|");
    if (eb === undefined) continue;
    const n = num(e?.n), p = num(e?.p);
    if (n <= 0) continue;
    b.routes[rk] = { from: unkey(ea), to: unkey(eb), ea, eb, n, p, v: counts(e?.v, true) };
  }
  for (const [ek, g] of Object.entries(raw.geo || {})) {
    if (Array.isArray(g) && g.length === 2) b.geo[ek] = g;
  }
  return b;
}

/** Sum several buckets into one (e.g. 30 day buckets → the 30-day scope). */
export function mergeBuckets(list) {
  const m = emptyBucket();
  for (const b of list) {
    if (!b) continue;
    SCALARS.forEach((f) => (m[f] += b[f]));
    [...NAME_MAPS, "byDate"].forEach((f) => addCounts(m[f], b[f]));
    for (const [rk, e] of Object.entries(b.routes)) {
      const t = m.routes[rk] || (m.routes[rk] = { from: e.from, to: e.to, ea: e.ea, eb: e.eb, n: 0, p: 0, v: {} });
      t.n += e.n; t.p += e.p; addCounts(t.v, e.v);
    }
    Object.assign(m.geo, b.geo);
  }
  return m;
}

/**
 * Everything the snapshot needs, in ~35 document reads: stats-all,
 * stats-routes, the current and previous shift, and the last 31 days of day
 * buckets (plus any future-dated ones, which the date scopes have always
 * included).
 *
 * @returns {Promise<object|null>} null until a rebuild has stamped builtAt
 */
export async function readStatsBuckets(now = new Date()) {
  const col = collection(db, COL.counters);
  const allSnap = await getDoc(doc(col, STATS_ALL));
  const allRaw = allSnap.exists() ? allSnap.data() : null;
  if (!allRaw?.builtAt) return null;

  const cs = currentShift(now);
  const prev = currentShift(new Date(cs.start.getTime() - 1));
  const since = ymd(new Date(now.getTime() - 31 * DAY));
  const [routesSnap, curSnap, prevSnap, daysSnap] = await Promise.all([
    getDoc(doc(col, STATS_ROUTES)),
    getDoc(doc(col, shiftDocId(cs.start))),
    getDoc(doc(col, shiftDocId(prev.start))),
    // "stats-day." sorts after every "stats-day-…" id, so this is an open-ended range.
    getDocs(query(col, where(documentId(), ">=", dayId(since)), where(documentId(), "<", "stats-day."))),
  ]);

  const all = normalize(allRaw);
  const routes = normalize(routesSnap.exists() ? routesSnap.data() : {});
  all.routes = routes.routes;
  all.geo = routes.geo;

  const vehicleLast = {};
  for (const [k, ts] of Object.entries(allRaw.vehicleLast || {})) {
    const d = toDate(ts);
    if (d && !Number.isNaN(d.getTime())) vehicleLast[unkey(k)] = d.getTime();
  }

  return {
    all,
    shift: normalize(curSnap.exists() ? curSnap.data() : {}),
    prevShift: normalize(prevSnap.exists() ? prevSnap.data() : {}),
    days: daysSnap.docs.map((d) => Object.assign(normalize(d.data()), { date: d.id.slice(DAY_PREFIX.length) })),
    byMonth: counts(allRaw.byMonth, false),
    byWeek: counts(allRaw.byWeek, false),
    vehicleLast,
    firstDate: isDate(allRaw.firstDate) ? allRaw.firstDate : null,
  };
}

/** All-time referrals per month ("YYYY-MM" → count), or null before the first rebuild. One read. */
export async function readMonthlyTotals() {
  const s = await getDoc(doc(db, COL.counters, STATS_ALL));
  const d = s.exists() ? s.data() : null;
  return d?.builtAt ? counts(d.byMonth, false) : null;
}

/* =====================================================  rebuild & check  */
/**
 * Recompute every counter document from the full register and overwrite it.
 *
 * Reads every patient document ONCE. Run it after this code is first deployed,
 * and again whenever checkStatistics() reports a mismatch. Run it at a quiet
 * hour: a capture that commits between the read and the overwrite is lost from
 * the totals (the next check will show it).
 *
 * @param {(msg: string) => void} [onProgress]
 * @returns {Promise<{records: number, documents: number}>}
 */
export async function rebuildStatistics(onProgress = () => {}) {
  onProgress("Reading every patient record (one read per record)…");
  const snap = await getDocs(collection(db, COL.patients));
  const rows = snap.docs.map((d) => d.data());
  // Oldest first, so put() values (coordinates, last trip) end on the newest.
  rows.sort((a, b) => (toDate(a.createdAt)?.getTime() || 0) - (toDate(b.createdAt)?.getTime() || 0));
  onProgress(`${rows.length.toLocaleString("en-ZA")} records read. Building statistics…`);

  const deltas = new Deltas();
  deltas.add(STATS_ALL, { total: 0 }).add(STATS_ROUTES, { routes: {} });
  let firstDate = null, skipped = 0;
  for (const r of rows) {
    // Build each record's contribution separately, so one malformed record is
    // reported and skipped instead of aborting the whole rebuild.
    const own = new Deltas();
    try {
      const created = toDate(r.createdAt);
      captureDeltas(r, created, own);
      const td = toDate(r.timeDelivered), ca = toDate(r.closedAt);
      if (r.closed) closedPart(r, td, own);
      if (td || ca) own.add(dayId(ymd(td || ca)), { delivered: 1 });
    } catch (err) {
      skipped++;
      if (skipped <= 5) onProgress(`  ! skipped ${r.incidentNumber || "a record"}: ${err?.message || err}`);
      continue;
    }
    for (const [id, d] of own.docs) deltas.add(id, d);
    if (isDate(r.date) && (!firstDate || r.date < firstDate)) firstDate = r.date;
  }
  if (skipped) onProgress(`${skipped} unreadable record(s) skipped — Check Statistics will show the difference.`);
  deltas.add(STATS_ALL, { builtAt: put(new Date()), builtFrom: put(rows.length), firstDate: put(firstDate) });

  const docs = [...deltas.docs].map(([id, d]) => [id, fold({}, d, true)]);
  onProgress(`Writing ${docs.length.toLocaleString("en-ZA")} statistics documents…`);
  for (let i = 0; i < docs.length; i += 400) {
    const batch = writeBatch(db);
    docs.slice(i, i + 400).forEach(([id, data]) => batch.set(doc(db, COL.counters, id), data)); // overwrite, not merge
    await batch.commit();
  }
  onProgress("✓ Statistics rebuilt.");
  return { records: rows.length, documents: docs.length, skipped };
}

/**
 * Compare the running totals with the register itself. Costs 1 read for
 * stats-all plus 1 read per 1,000 records for each of the two counts.
 */
export async function checkStatistics() {
  const col = collection(db, COL.patients);
  const [s, all, closed] = await Promise.all([
    getDoc(doc(db, COL.counters, STATS_ALL)),
    getCountFromServer(col),
    getCountFromServer(query(col, where("closed", "==", true))),
  ]);
  const d = s.exists() ? s.data() : null;
  return {
    builtAt: d?.builtAt ? toDate(d.builtAt) : null,
    statsTotal: num(d?.total), statsClosed: num(d?.closed),
    total: all.data().count, closed: closed.data().count,
  };
}
