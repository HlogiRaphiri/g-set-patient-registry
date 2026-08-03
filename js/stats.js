/**
 * stats.js — pure functions that turn an array of patient records into the
 * KPIs and chart series used by the dashboard and reports. No Firestore or
 * DOM access here so it stays easy to reason about and reuse.
 */

import { rowDistrict, canonicalDistrict } from "./districts.js";

const toDate = (ts) => (ts?.toDate ? ts.toDate() : ts ? new Date(ts) : null);

export function applyFilters(rows, f = {}) {
  return rows.filter((r) => {
    // Compared canonically: the district was stored both UPPERCASE and in
    // Title Case, so a literal comparison silently dropped half the records.
    if (f.district && rowDistrict(r) !== canonicalDistrict(f.district)) return false;
    if (f.station && r.station !== f.station) return false;
    if (f.vehicle && r.vehicle !== f.vehicle) return false;
    if (f.status === "Active" && r.closed) return false;
    if (f.status === "Closed" && !r.closed) return false;
    if (f.diagnosis && !(r.diagnosis || "").toLowerCase().includes(f.diagnosis.toLowerCase())) return false;
    if (f.facility) {
      const q = f.facility.toLowerCase();
      if (!(r.referringFacility || "").toLowerCase().includes(q) &&
          !(r.receivingFacility || "").toLowerCase().includes(q)) return false;
    }
    if (f.from && r.date && r.date < f.from) return false;
    if (f.to && r.date && r.date > f.to) return false;
    return true;
  });
}

const topKey = (rows, key) => {
  const c = {};
  rows.forEach((r) => { const v = r[key]; if (v) c[v] = (c[v] || 0) + 1; });
  const e = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  return e ? { name: e[0], count: e[1] } : { name: "—", count: 0 };
};

/** Average transport time in minutes across closed journeys. */
export function avgTransportMinutes(rows) {
  const durs = [];
  rows.forEach((r) => {
    const a = toDate(r.createdAt), b = toDate(r.timeDelivered);
    if (a && b && b > a) durs.push((b - a) / 60000);
  });
  if (!durs.length) return null;
  return Math.round(durs.reduce((s, x) => s + x, 0) / durs.length);
}

export function kpis(rows) {
  const today = new Date().toISOString().slice(0, 10);
  const closed = rows.filter((r) => r.closed);
  return {
    total: rows.length,
    active: rows.filter((r) => !r.closed).length,
    completed: closed.length,
    today: rows.filter((r) => r.date === today).length,
    avgTransport: avgTransportMinutes(closed),
    topDistrict: topKey(rows.map((r) => ({ ...r, district: rowDistrict(r) })), "district"),
    topStation: topKey(rows, "station"),
    topVehicle: topKey(rows, "vehicle"),
    topReferring: topKey(rows, "referringFacility"),
    topReceiving: topKey(rows, "receivingFacility"),
  };
}

/** Counts of a field, sorted descending, limited to `n`. */
export function countBy(rows, key, n = 10) {
  const c = {};
  rows.forEach((r) => { const v = r[key]; if (v) c[v] = (c[v] || 0) + 1; });
  return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n);
}

/** Daily counts for the last `days` days ending today. */
export function dailyTrend(rows, days = 14) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push([key.slice(5), rows.filter((r) => r.date === key).length]);
  }
  return out;
}

/** Monthly counts for the last `months` months. */
export function monthlyTrend(rows, months = 6) {
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(); d.setMonth(d.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("en-ZA", { month: "short", year: "2-digit" });
    out.push([label, rows.filter((r) => (r.date || "").startsWith(key)).length]);
  }
  return out;
}

/** Activity by hour of day (0–23) using capture time. */
export function hourlyActivity(rows) {
  const buckets = new Array(24).fill(0);
  rows.forEach((r) => { const d = toDate(r.createdAt); if (d) buckets[d.getHours()]++; });
  return buckets;
}

/** Age distribution across standard bands. */
export function ageDistribution(rows) {
  const bands = ["0-9", "10-19", "20-29", "30-39", "40-49", "50-59", "60-69", "70+"];
  const counts = new Array(bands.length).fill(0);
  rows.forEach((r) => {
    const a = Number(r.age);
    if (isNaN(a)) return;
    const idx = a >= 70 ? 7 : Math.min(6, Math.floor(a / 10));
    counts[idx]++;
  });
  return { bands, counts };
}
