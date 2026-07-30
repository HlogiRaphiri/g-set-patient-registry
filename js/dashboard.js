/**
 * dashboard.js — executive dashboard. Loads all patients once, then computes
 * KPIs and eleven Chart.js visualisations from the (optionally filtered) set.
 */

import { requireAuth, countUp, fmtStamp, esc, toast } from "./app.js";
import { renderShell } from "./layout.js";
import { getAllPatients, getDistricts, getStations, getVehicles } from "./data-service.js";
import { writeSnapshot } from "./metrics.js";
import * as S from "./stats.js";

const CH = {}; // live chart instances
const C = {
  ems: "#ff8342", ems2: "#ff6b1a", cyan: "#38e1ff", green: "#34d399",
  amber: "#fbbf24", grey: "#7c8db5", grid: "rgba(120,160,255,.10)", text: "#9db0d6",
};
const PALETTE = ["#ff8342", "#38e1ff", "#34d399", "#fbbf24", "#a78bfa", "#fb7185", "#60a5fa", "#f472b6", "#5eead4", "#fdba74"];

let allRows = [];

(async () => {
  const { profile } = await requireAuth("viewDashboard");
  await renderShell("dashboard", profile);
  document.getElementById("pageContent").appendChild(document.getElementById("pageTpl").content.cloneNode(true));

  Chart.defaults.color = C.text;
  Chart.defaults.font.family = "Inter, sans-serif";
  Chart.defaults.plugins.legend.labels.boxWidth = 12;

  const [rows, districts, stations, vehicles] = await Promise.all([
    getAllPatients(), getDistricts(), getStations(), getVehicles(),
  ]);
  allRows = rows;

  // Refresh the public aggregate snapshot from this load (privacy-safe, no PHI).
  writeSnapshot(rows, { vehicles, stations, districts }).catch(() => {});

  // Populate filter dropdowns.
  fill("fDistrict", districts.map((d) => d.name).sort());
  fill("fStation", stations.map((s) => s.name).sort());
  fill("fVehicle", vehicles.map((v) => v.registration).sort());

  document.getElementById("applyFilters").addEventListener("click", render);
  document.getElementById("refreshBtn").addEventListener("click", async () => {
    allRows = await getAllPatients(); render(); toast("info", "Refreshed", "Latest records loaded.");
  });
  document.getElementById("clearFilters").addEventListener("click", () => {
    ["fFrom", "fTo", "fDistrict", "fStation", "fVehicle", "fStatus"].forEach((id) => (document.getElementById(id).value = ""));
    render();
  });

  render();
})();

function fill(id, values) {
  const sel = document.getElementById(id);
  values.forEach((v) => { const o = document.createElement("option"); o.textContent = v; sel.appendChild(o); });
}

function readFilters() {
  return {
    from: v("fFrom"), to: v("fTo"), district: v("fDistrict"),
    station: v("fStation"), vehicle: v("fVehicle"), status: v("fStatus"),
  };
  function v(id) { return document.getElementById(id).value; }
}

function render() {
  const rows = S.applyFilters(allRows, readFilters());
  paintKpis(rows);
  paintCharts(rows);
  paintRecent(rows);
}

/* ---------------------------------------------------------------- KPIs */
function paintKpis(rows) {
  const k = S.kpis(rows);
  const cards = [
    { label: "Total Patients", icon: "fa-users", value: k.total },
    { label: "Active Journeys", icon: "fa-satellite-dish", value: k.active },
    { label: "Completed", icon: "fa-circle-check", value: k.completed },
    { label: "Patients Today", icon: "fa-calendar-day", value: k.today },
    { label: "Avg Transport", icon: "fa-stopwatch", value: k.avgTransport, suffix: " min", text: k.avgTransport == null ? "—" : null },
    { label: "Top District", icon: "fa-map", text: k.topDistrict.name, foot: `${k.topDistrict.count} patients` },
    { label: "Top EMS Station", icon: "fa-tower-broadcast", text: k.topStation.name, foot: `${k.topStation.count} patients` },
    { label: "Most Used Vehicle", icon: "fa-truck-medical", text: k.topVehicle.name, foot: `${k.topVehicle.count} trips` },
    { label: "Top Referring", icon: "fa-hospital", text: k.topReferring.name, foot: `${k.topReferring.count} patients` },
    { label: "Top Receiving", icon: "fa-house-medical", text: k.topReceiving.name, foot: `${k.topReceiving.count} patients` },
  ];
  const grid = document.getElementById("kpiGrid");
  grid.innerHTML = cards.map((c, i) => `
    <div class="kpi">
      <i class="fa-solid ${c.icon} kpi-icon"></i>
      <div class="kpi-label">${c.label}</div>
      <div class="metric-value" id="kpi${i}" style="${c.text != null ? "font-size:1.15rem" : ""}">${c.text != null ? esc(c.text) : "0"}</div>
      ${c.foot ? `<div class="kpi-foot">${esc(c.foot)}</div>` : ""}
    </div>`).join("");
  cards.forEach((c, i) => {
    if (c.text == null && typeof c.value === "number") countUp(document.getElementById(`kpi${i}`), c.value, { suffix: c.suffix || "" });
  });
}

/* ---------------------------------------------------------------- Charts */
function mk(id, cfg) {
  const el = document.getElementById(id);
  if (!el) return;
  if (CH[id]) CH[id].destroy();
  cfg.options = Object.assign({
    responsive: true, maintainAspectRatio: false,
    scales: cfg._noScales ? undefined : {
      x: { grid: { color: C.grid }, ticks: { color: C.text } },
      y: { grid: { color: C.grid }, ticks: { color: C.text }, beginAtZero: true },
    },
  }, cfg.options || {});
  delete cfg._noScales;
  CH[id] = new Chart(el, cfg);
}

function paintCharts(rows) {
  const daily = S.dailyTrend(rows, 14);
  mk("cDaily", { type: "line", data: { labels: daily.map((x) => x[0]), datasets: [{ label: "Patients", data: daily.map((x) => x[1]), borderColor: C.ems, backgroundColor: "rgba(255,131,66,.15)", fill: true, tension: .35, pointRadius: 2 }] }, options: { plugins: { legend: { display: false } } } });

  const k = S.kpis(rows);
  mk("cStatus", { type: "doughnut", _noScales: true, data: { labels: ["Active", "Closed"], datasets: [{ data: [k.active, k.completed], backgroundColor: [C.cyan, C.grey], borderWidth: 0 }] }, options: { cutout: "62%", plugins: { legend: { position: "bottom" } } } });

  const monthly = S.monthlyTrend(rows, 6);
  mk("cMonthly", { type: "bar", data: { labels: monthly.map((x) => x[0]), datasets: [{ label: "Patients", data: monthly.map((x) => x[1]), backgroundColor: C.ems2, borderRadius: 6 }] }, options: { plugins: { legend: { display: false } } } });

  const dist = S.countBy(rows, "district", 6);
  mk("cDistrict", { type: "bar", data: { labels: dist.map((x) => x[0]), datasets: [{ data: dist.map((x) => x[1]), backgroundColor: PALETTE, borderRadius: 6 }] }, options: { indexAxis: "y", plugins: { legend: { display: false } } } });

  const sta = S.countBy(rows, "station", 8);
  mk("cStation", { type: "bar", data: { labels: sta.map((x) => x[0]), datasets: [{ data: sta.map((x) => x[1]), backgroundColor: C.cyan, borderRadius: 6 }] }, options: { indexAxis: "y", plugins: { legend: { display: false } } } });

  const veh = S.countBy(rows, "vehicle", 8);
  mk("cVehicle", { type: "bar", data: { labels: veh.map((x) => x[0]), datasets: [{ data: veh.map((x) => x[1]), backgroundColor: C.green, borderRadius: 6 }] }, options: { plugins: { legend: { display: false } } } });

  const age = S.ageDistribution(rows);
  mk("cAge", { type: "bar", data: { labels: age.bands, datasets: [{ data: age.counts, backgroundColor: C.amber, borderRadius: 6 }] }, options: { plugins: { legend: { display: false } } } });

  mk("cHourly", { type: "line", data: { labels: [...Array(24).keys()].map((h) => `${h}`), datasets: [{ data: S.hourlyActivity(rows), borderColor: C.cyan, backgroundColor: "rgba(56,225,255,.12)", fill: true, tension: .3, pointRadius: 0 }] }, options: { plugins: { legend: { display: false } } } });

  const diag = S.countBy(rows, "diagnosis", 6);
  mk("cDiag", { type: "polarArea", _noScales: true, data: { labels: diag.map((x) => x[0]), datasets: [{ data: diag.map((x) => x[1]), backgroundColor: PALETTE }] }, options: { plugins: { legend: { position: "bottom", labels: { font: { size: 10 } } } }, scales: { r: { grid: { color: C.grid }, ticks: { display: false } } } } });

  const rf = S.countBy(rows, "referringFacility", 8);
  mk("cRefFac", { type: "bar", data: { labels: rf.map((x) => x[0]), datasets: [{ data: rf.map((x) => x[1]), backgroundColor: C.ems, borderRadius: 6 }] }, options: { indexAxis: "y", plugins: { legend: { display: false } } } });

  const rc = S.countBy(rows, "receivingFacility", 8);
  mk("cRecFac", { type: "bar", data: { labels: rc.map((x) => x[0]), datasets: [{ data: rc.map((x) => x[1]), backgroundColor: "#a78bfa", borderRadius: 6 }] }, options: { indexAxis: "y", plugins: { legend: { display: false } } } });
}

/* ---------------------------------------------------------------- Recent */
function paintRecent(rows) {
  const body = document.getElementById("recentBody");
  const recent = rows.slice(0, 12);
  if (!recent.length) {
    body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><i class="fa-solid fa-inbox"></i>No patient records yet. Capture your first transfer to see it here.</div></td></tr>`;
    return;
  }
  body.innerHTML = recent.map((r) => `
    <tr>
      <td class="mono text-ems">${esc(r.incidentNumber)}</td>
      <td>${esc(r.patientName)}</td>
      <td>${esc(r.district || "")}</td>
      <td class="mono">${esc(r.vehicle || "")}</td>
      <td>${fmtStamp(r.createdAt)}</td>
      <td><span class="status-pill ${r.closed ? "status-closed" : "status-active"}">${r.closed ? "Closed" : "Active"}</span></td>
    </tr>`).join("");
}
