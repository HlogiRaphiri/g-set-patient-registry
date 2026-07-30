/**
 * seed.js — one-time (idempotent) population of reference collections.
 * Invoked by the Superuser from Admin > System Setup. Uses batched writes so
 * the 466-facility import stays within Firestore limits (500 ops per batch).
 */

import { db, COL } from "./firebase-config.js";
import {
  doc, setDoc, writeBatch, getCountFromServer, collection,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { DISTRICTS, EMS_STATIONS, SAMPLE_VEHICLES } from "./data/seed-data.js";

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

export async function seedVehicles(onLog = () => {}) {
  for (const v of SAMPLE_VEHICLES) {
    await setDoc(doc(db, COL.vehicles, slug(v.registration)), v, { merge: true });
  }
  onLog(`✓ ${SAMPLE_VEHICLES.length} starter vehicles`);
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
