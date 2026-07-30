/**
 * data-service.js — thin data layer over Firestore.
 * Loads and caches reference data (facilities, stations, districts, vehicles),
 * provides patient CRUD used by the capture/journey flows, and a reusable
 * type-ahead autocomplete widget.
 */

import { db, COL } from "./firebase-config.js";
import {
  collection, getDocs, query, where, orderBy, limit,
  doc, setDoc, getDoc, updateDoc, addDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const cache = {};

async function loadCollection(name) {
  if (cache[name]) return cache[name];
  const snap = await getDocs(collection(db, name));
  cache[name] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return cache[name];
}
export function invalidate(name) { delete cache[name]; }

export const getFacilities = () => loadCollection(COL.facilities);
export const getStations = () => loadCollection(COL.stations);
export const getDistricts = () => loadCollection(COL.districts);
export const getVehicles = () => loadCollection(COL.vehicles);

/* --------------------------------------------------------------- Patients */

export async function createPatient(data) {
  const ref = await addDoc(collection(db, COL.patients), {
    ...data,
    status: "Active",
    closed: false,
    timeDelivered: null,
    createdAt: serverTimestamp(),
  });
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
  await updateDoc(ref, {
    status: "Closed",
    closed: true,
    timeDelivered: serverTimestamp(),
    closedBy: actor,
    closedAt: serverTimestamp(),
  });
}

export async function getAllPatients() {
  const snap = await getDocs(query(collection(db, COL.patients), orderBy("createdAt", "desc")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getActivePatients() {
  const snap = await getDocs(query(collection(db, COL.patients), where("closed", "==", false)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
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
export function attachAutocomplete(input, getItems, { toText, toSub, onPick } = {}) {
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

  const filter = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { list.style.display = "none"; return; }
    render(items.filter((m) => toText(m).toLowerCase().includes(q)));
  };

  input.addEventListener("input", filter);
  input.addEventListener("focus", filter);
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
