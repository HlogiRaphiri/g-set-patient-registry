/**
 * data-service.js — thin data layer over Firestore.
 * Loads and caches reference data (facilities, stations, districts, vehicles),
 * provides patient CRUD used by the capture/journey flows, and a reusable
 * type-ahead autocomplete widget.
 */

import { db, COL } from "./firebase-config.js";
import {
  collection, getDocs, getDocsFromCache, getCountFromServer, query, where, orderBy, limit, startAfter,
  doc, getDoc, writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { applyDeltas, captureDeltas, closeDeltas, vehicleDeltas } from "./registry-stats.js";

const cache = {};
// Collections that must be re-read from the server on their next load (e.g.
// straight after an admin add/import), bypassing the local cache once.
const forceServer = new Set();

const mapSnap = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

/**
 * Load a (rarely-changing) reference collection. Served from the persistent
 * local cache when available — costing zero billed reads — and only fetched
 * from the server on first load, on a cache miss, or immediately after the
 * collection has been invalidated by a write. Frequently-changing data
 * (patients) uses getDocs directly and always reads from the server.
 */
async function loadCollection(name) {
  if (cache[name]) return cache[name];
  const col = collection(db, name);

  if (!forceServer.has(name)) {
    try {
      const cached = await getDocsFromCache(col);
      if (!cached.empty) { cache[name] = mapSnap(cached); return cache[name]; }
    } catch (_) { /* nothing cached yet — fall through to the server */ }
  }

  const snap = await getDocs(col); // server read
  forceServer.delete(name);
  cache[name] = mapSnap(snap);
  return cache[name];
}

// Drop the in-memory copy AND force the next load to refresh from the server,
// so a just-written change is never masked by a stale cached copy.
export function invalidate(name) { delete cache[name]; forceServer.add(name); }

export const getFacilities = () => loadCollection(COL.facilities);
export const getStations = () => loadCollection(COL.stations);
export const getDistricts = () => loadCollection(COL.districts);
export const getVehicles = () => loadCollection(COL.vehicles);

/* --------------------------------------------------------------- Patients */

/*
 * Every patient write below goes in ONE atomic batch with its running-totals
 * update (registry-stats.js), so the public dashboard's totals can never drift
 * from the register: if the rules reject the patient write, the counter
 * changes are discarded with it. The counters use increment(), so the batch
 * needs no extra reads.
 */

export async function createPatient(data) {
  const ref = doc(collection(db, COL.patients));
  const batch = writeBatch(db);
  batch.set(ref, {
    ...data,
    status: "Active",
    closed: false,
    timeDelivered: null,
    createdAt: serverTimestamp(),
  });
  applyDeltas(batch, captureDeltas(data, new Date()));
  await batch.commit();
  return ref.id;
}

export async function findPatientByIncident(incidentNumber) {
  const q = query(collection(db, COL.patients), where("incidentNumber", "==", incidentNumber), limit(1));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}

export async function closeJourney(id, actor) {
  const ref = doc(db, COL.patients, id);
  const cur = await getDoc(ref);
  if (!cur.exists()) throw new Error("Record not found.");
  if (cur.data().closed) throw new Error("This journey is already closed and locked.");
  // Two people closing the same journey at once: the second batch fails the
  // rules' isCloseTransition() check, so it is not counted twice either.
  const batch = writeBatch(db);
  batch.update(ref, {
    status: "Closed",
    closed: true,
    timeDelivered: serverTimestamp(),
    closedBy: actor,
    closedAt: serverTimestamp(),
  });
  applyDeltas(batch, closeDeltas(cur.data(), new Date()));
  await batch.commit();
}

/**
 * Update ONLY the G-Set vehicle registration on a captured record.
 * This is the single field that remains editable after a journey is saved.
 * The value is normalised to trimmed UPPERCASE before storage. Writing only
 * these three keys keeps the update within what firestore.rules permits.
 */
export async function updateVehicleRegistration(id, vehicle, actorName) {
  const reg = String(vehicle ?? "").trim().toUpperCase();
  if (!reg) throw new Error("Vehicle registration cannot be empty.");
  const ref = doc(db, COL.patients, id);
  const cur = await getDoc(ref);
  if (!cur.exists()) throw new Error("Record not found.");
  const row = cur.data();
  const batch = writeBatch(db);
  batch.update(ref, {
    vehicle: reg,
    vehicleUpdatedAt: serverTimestamp(),
    vehicleUpdatedBy: actorName || "",
  });
  if ((row.vehicle || "") !== reg) applyDeltas(batch, vehicleDeltas(row, row.vehicle || "", reg, new Date()));
  await batch.commit();
  return reg;
}

/** Newest first, by capture time. */
const byNewest = (rows) => rows.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

/** Combine row lists (e.g. a date range plus the open journeys), one row per id, newest first. */
export function mergeRows(...lists) {
  const m = new Map();
  lists.forEach((l) => (l || []).forEach((r) => m.set(r.id, r)));
  return byNewest([...m.values()]);
}

/**
 * The ENTIRE register — one read per record ever captured. Kept for one-off
 * jobs only; no page loads this on open any more.
 */
export async function getAllPatients() {
  const snap = await getDocs(query(collection(db, COL.patients), orderBy("createdAt", "desc")));
  return mapSnap(snap);
}

/* Date-range loaders. Each costs one read per record returned; the count
 * versions cost one read per 1,000, so a page can say what a range will cost
 * before loading it. `from`/`to` are "YYYY-MM-DD" (inclusive) and optional.
 * Single-field ranges only — no composite index needed. */
function byDateQuery(from, to) {
  const cons = [];
  if (from) cons.push(where("date", ">=", from));
  if (to) cons.push(where("date", "<=", to));
  return query(collection(db, COL.patients), ...cons);
}
/** Records whose incident `date` falls in the range. */
export async function getPatientsByDate(from, to) { return byNewest(mapSnap(await getDocs(byDateQuery(from, to)))); }
export async function countPatientsByDate(from, to) { return (await getCountFromServer(byDateQuery(from, to))).data().count; }

function byCreatedQuery(from, to) {
  const cons = [];
  if (from) cons.push(where("createdAt", ">=", from));
  if (to) cons.push(where("createdAt", "<=", to));
  return query(collection(db, COL.patients), ...cons);
}
/** Records CAPTURED between two Dates (either may be null). */
export async function getPatientsCreatedBetween(from, to) { return byNewest(mapSnap(await getDocs(byCreatedQuery(from, to)))); }
export async function countPatientsCreatedBetween(from, to) { return (await getCountFromServer(byCreatedQuery(from, to))).data().count; }

/**
 * One page of the register, newest first.
 * @param {{pageSize?: number, after?: object|null}} opts `after` is the cursor
 *        returned by the previous page
 * @returns {Promise<{rows: object[], cursor: object|null, done: boolean}>}
 */
export async function getRecentPatients({ pageSize = 300, after = null } = {}) {
  const cons = [orderBy("createdAt", "desc")];
  if (after) cons.push(startAfter(after));
  cons.push(limit(pageSize));
  const snap = await getDocs(query(collection(db, COL.patients), ...cons));
  return { rows: mapSnap(snap), cursor: snap.docs[snap.docs.length - 1] || null, done: snap.size < pageSize };
}

/**
 * Open journeys for one patient on one date — the duplicate-capture check.
 * Equality filters only, so Firestore serves it from single-field indexes:
 * typically 0–1 reads, instead of reading every open journey.
 */
export async function findOpenByPatient(patientName, date) {
  const snap = await getDocs(query(collection(db, COL.patients),
    where("closed", "==", false), where("patientName", "==", patientName), where("date", "==", date)));
  return mapSnap(snap);
}

export async function getActivePatients() {
  const snap = await getDocs(query(collection(db, COL.patients), where("closed", "==", false)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
}

/**
 * Number of open journeys, without downloading them. A count aggregation bills
 * one read per 1,000 matching index entries (minimum one), so this costs a
 * single read while fewer than 1,000 journeys are open.
 * @returns {Promise<number>}
 */
export async function getActiveCount() {
  const snap = await getCountFromServer(query(collection(db, COL.patients), where("closed", "==", false)));
  return snap.data().count;
}

/* ----------------------------------------------------------- Autocomplete */

/**
 * Attach a type-ahead to a text input.
 * @param input        the <input> element
 * @param getItems     () => Promise<array> | array of items
 * @param toText       item => display string
 * @param toSub        item => secondary line (optional)
 * @param onPick       item => void (optional)
 */
export function attachAutocomplete(input, getItems, { toText, toSub, onPick, rank } = {}) {
  toText = toText || ((x) => x.name || String(x));
  const wrap = document.createElement("div");
  wrap.className = "autocomplete-wrap";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const list = document.createElement("div");
  list.className = "autocomplete-list";
  list.style.display = "none";
  wrap.appendChild(list);

  let items = [];
  let activeIdx = -1;
  Promise.resolve(typeof getItems === "function" ? getItems() : getItems).then((r) => (items = r || []));

  const render = (matches) => {
    if (!matches.length) { list.style.display = "none"; return; }
    list.innerHTML = matches.slice(0, 20).map((m, i) => {
      const sub = toSub ? toSub(m) : "";
      return `<div class="autocomplete-item" data-i="${i}">${escapeHtml(toText(m))}${sub ? `<br><small>${escapeHtml(sub)}</small>` : ""}</div>`;
    }).join("");
    list.style.display = "block";
    list._matches = matches;
    activeIdx = -1;
  };

  // Optional relevance ranking: higher score floats to the top; nothing is removed.
  const rankedSort = (arr) => {
    if (!rank) return arr;
    return arr
      .map((m, i) => ({ m, r: rank(m) || 0, i }))
      .sort((a, b) => (b.r - a.r) || (a.i - b.i))
      .map((x) => x.m);
  };

  // When a rank fn and context exist, show the relevant items even before typing.
  const showRelevant = () => {
    if (!rank) return false;
    const relevant = rankedSort(items.filter((m) => (rank(m) || 0) > 0));
    if (!relevant.length) return false;
    render(relevant);
    return true;
  };

  const filter = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { if (!showRelevant()) list.style.display = "none"; return; }
    render(rankedSort(items.filter((m) => toText(m).toLowerCase().includes(q))));
  };

  // On focus, surface context-relevant items first (regardless of any pre-filled
  // value); fall back to normal text filtering.
  const onFocus = () => { if (!showRelevant()) filter(); };

  input.addEventListener("input", filter);
  input.addEventListener("focus", onFocus);
  input.addEventListener("blur", () => setTimeout(() => (list.style.display = "none"), 150));
  input.addEventListener("keydown", (e) => {
    const opts = list.querySelectorAll(".autocomplete-item");
    if (!opts.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, opts.length - 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); }
    else if (e.key === "Enter" && activeIdx >= 0) { e.preventDefault(); opts[activeIdx].dispatchEvent(new Event("mousedown")); return; }
    else return;
    opts.forEach((o, i) => o.classList.toggle("active", i === activeIdx));
  });

  list.addEventListener("mousedown", (e) => {
    const el = e.target.closest(".autocomplete-item");
    if (!el) return;
    const item = list._matches[+el.dataset.i];
    input.value = toText(item);
    list.style.display = "none";
    if (onPick) onPick(item);
  });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
