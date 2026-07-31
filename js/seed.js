/**
 * seed.js — one-time (idempotent) population of reference collections.
 * Invoked by the Superuser from Admin > System Setup. Uses batched writes so
 * large imports (facilities, the G-Set vehicle fleet) stay within Firestore
 * limits (500 ops per batch).
 */

import { db, COL } from "./firebase-config.js";
import {
  doc, setDoc, writeBatch, getCountFromServer, collection,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { DISTRICTS, EMS_STATIONS } from "./data/seed-data.js";

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

export async function seedDistricts(onLog = () => {}) {
  for (const name of DISTRICTS) {
    await setDoc(doc(db, COL.districts, slug(name)), { name }, { merge: true });
  }
  onLog(`✓ ${DISTRICTS.length} districts`);
}

export async function seedStations(onLog = () => {}) {
  for (const s of EMS_STATIONS) {
    await setDoc(doc(db, COL.stations, slug(s.name)), s, { merge: true });
  }
  onLog(`✓ ${EMS_STATIONS.length} EMS stations`);
}

/**
 * Import the real G-Set vehicle fleet from data/vehicles.json, keyed by a slug
 * of the registration. Each vehicle stores its registration, district and EMS
 * station. Merge:true keeps re-runs safe. Returns the number imported.
 */
export async function seedVehicles(onLog = () => {}) {
  const res = await fetch("data/vehicles.json");
  if (!res.ok) throw new Error("Couldn’t load data/vehicles.json");
  const vehicles = await res.json();

  let batch = writeBatch(db), n = 0, written = 0;
  for (const v of vehicles) {
    const reg = String(v.registration || "").trim().toUpperCase();
    if (!reg) continue;
    batch.set(doc(db, COL.vehicles, slug(reg)), {
      registration: reg,
      district: v.district || "",
      station: v.station || "",
      keywords: reg.toLowerCase(),
    }, { merge: true });
    n++; written++;
    if (n === 450) { await batch.commit(); onLog(`  …${written}/${vehicles.length} vehicles`); batch = writeBatch(db); n = 0; }
  }
  if (n) await batch.commit();
  onLog(`✓ ${written} G-Set vehicles imported`);
  return written;
}

/**
 * Load data/facilities.json and write every facility, keyed by its source ID,
 * in batches. Merge:true keeps re-runs safe.
 */
export async function seedFacilities(onLog = () => {}) {
  const res = await fetch("data/facilities.json");
  if (!res.ok) throw new Error("Couldn’t load data/facilities.json");
  const facilities = await res.json();

  let batch = writeBatch(db), n = 0, written = 0;
  for (const f of facilities) {
    const id = f.id || slug(f.name);
    batch.set(doc(db, COL.facilities, id), {
      name: f.name, district: f.district, type: f.type,
      lat: f.lat, lng: f.lng, keywords: f.name.toLowerCase(),
    }, { merge: true });
    n++; written++;
    if (n === 450) { await batch.commit(); onLog(`  …${written}/${facilities.length} facilities`); batch = writeBatch(db); n = 0; }
  }
  if (n) await batch.commit();
  onLog(`✓ ${facilities.length} facilities imported`);
}

export async function seedAll(onLog = () => {}) {
  onLog("Seeding reference data…");
  await seedDistricts(onLog);
  await seedStations(onLog);
  await seedVehicles(onLog);
  await seedFacilities(onLog);
  // Mark setup complete.
  await setDoc(doc(db, COL.meta, "setup"), { seededAt: new Date().toISOString() }, { merge: true });
  onLog("All done. Reference data is ready.");
}

export async function collectionCount(name) {
  try { return (await getCountFromServer(collection(db, name))).data().count; }
  catch { return null; }
}
