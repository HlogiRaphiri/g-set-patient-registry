/**
 * dashboard.js — executive dashboard. Computes KPIs and eleven Chart.js
 * visualisations from the (optionally filtered) set of records.
 *
 * READ COST: the page opens on the last DEFAULT_DAYS days (by incident date)
 * plus every open journey — not the whole register. Moving the From date back
 * and pressing Apply loads the wider range; large ranges ask first
 * (range-load.js). The six-month chart comes from the running monthly totals
 * (one read) while no other filter is set.
 */

import { requireAuth, countUp, fmtStamp, esc, toast } from "./app.js";
import { renderShell } from "./layout.js";
import { getPatientsByDate, countPatientsByDate, getActivePatients, getStations, getVehicles } from "./data-service.js";
import { refreshSnapshot } from "./metrics.js";
import { readMonthlyTotals } from "./registry-stats.js";
import { rangeLoader, daysAgo } from "./range-load.js";
import * as S from "./stats.js";
import { overdueSummary, overdueRows, hoursOpen, fmtDuration, thresholds } from "./overdue.js";
import { rowDistrict, DISTRICTS } from "./districts.js";

const CH = {}; // live chart instances
const C = {
  ems: "#ff8342", ems2: "#ff6b1a", cyan: "#38e1ff", green: "#34d399",
  amber: "#fbbf24", grey: "#7c8db5", grid: "rgba(120,160,255,.10)", text: "#9db0d6",
};
const PALETTE = ["#ff8342", "#38e1ff", "#34d399", "#fbbf24", "#a78bfa", "#fb7185", "#60a5fa", "#f472b6", "#5eead4", "#fdba74"];

const DEFAULT_DAYS = 7;   // ~200 records/day → ~1,400 reads per open
const DEFAULT_FROM = daysAgo(DEFAULT_DAYS - 1);

let allRows = [];        // records in the loaded date range
let openRows = [];       // every open journey, whatever its date
let monthTotals = null;  // all-time referrals per month, from the running totals

const loader = rangeLoader({
  defaultFrom: DEFAULT_FROM,
  count: countPatientsByDate,
  load: async (from, to) => {
    [allRows, openRows] = await Promise.all([getPatientsByDate(from, to), getActivePatients()]);
  },
});

(async () => {
  const { profile } = await requireAuth("viewDashboard");
  await renderShell("dashboard", profile);
  document.getElementById("pageContent").appendChild(document.getElementById("pageTpl").content.cloneNode(true));

  Chart.defaults.color = C.text;
  Chart.defaults.font.family = "Inter, sans-serif";
  Chart.defaults.plugins.legend.labels.boxWidth = 12;

  document.getElementById("fFrom").value = DEFAULT_FROM;
  const [, stations, vehicles, months] = await Promise.all([
    loader.ensure(), getStations(), getVehicles(), readMonthlyTotals().catch(() => null),
  ]);
  monthTotals = months;

  // Keep the public aggregate snapshot fresh (throttled; reads no patient
  // records beyond the open journeys).
  refreshSnapshot().catch(() => {});

  // Populate filter dropdowns.
  // Filter options come from the canonical list, not from whatever casing
  // happens to be present in the reference collection.
  fill("fDistrict", DISTRICTS.slice().sort());
  fill("fStation", stations.map((s) => s.name).sort());
  fill("fVehicle", vehicles.map((v) => v.registration).sort());

  document.getElementById("applyFilters").addEventListener("click", () => applyRange());
  document.getElementById("refreshBtn").addEventListener("click", async () => {
    if (await applyRange({ reload: true })) toast("info", "Refreshed", "Latest records loaded.");
  });
  document.getElementById("clearFilters").addEventListener("click", () => {
    ["fTo", "fDistrict", "fStation", "fVehicle", "fStatus"].forEach((id) => (document.getElementById(id).value = ""));
    document.getElementById("fFrom").value = DEFAULT_FROM;
    applyRange();
  });

  render();
})();

/** Load the From/To range if it changed (asking first when it is large), then redraw. */
async function applyRange(opts) {
  try {
    const ok = await loader.ensure(opts);
    render();
    return ok;
  } catch (err) {
    toast("err", "Couldn’t load records", err.message || "Try again shortly.");
    return false;
  }
}

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
  const f = readFilters();
  const rows = S.applyFilters(allRows, f);
  // Open journeys are current state, so the date range does not hide them: an
  // old journey nobody closed is exactly what "Open Too Long" must surface.
  const openNow = f.status === "Closed" ? [] : S.applyFilters(openRows, { ...f, from: "", to: "", status: "" });
  paintKpis(rows, openNow, f);
  paintCharts(rows, f);
  paintRecent(rows);
}

/** "Since 2026-10-26", "2026-10-01 to 2026-10-31", "All time"… for the Total card. */
function rangeLabel(f) {
  if (f.from && f.to) return `${f.from} to ${f.to}`;
  if (f.from) return `Since ${f.from}`;
  if (f.to) return `Up to ${f.to}`;
  return "All time";
}

/* ---------------------------------------------------------------- KPIs */

/**
 * "Open Too Long" KPI. Counts active journeys past the review threshold and
 * names the oldest, so the card points at a specific record rather than just
 * raising an abstract number.
 *
 * Reads nothing — it works on the rows the dashboard already loaded.
 */
function overdueCard(rows) {
  const now = new Date();
  const { total, critical, unknown } = overdueSummary(rows, now);
  const t = thresholds();

  if (!total) {
    return {
      label: "Open Too Long", icon: "fa-hourglass-half", text: "None",
      foot: unknown ? `${unknown} with no capture time` : `Nothing open beyond ${fmtDuration(t.overdue)}`,
    };
  }

  const oldest = overdueRows(rows, now)[0];
  const age = fmtDuration(hoursOpen(oldest, now));
  const foot = critical
    ? `${critical} long overdue · oldest ${age}`
    : `Oldest ${age} · ${oldest?.incidentNumber || ""}`;

  return { label: "Open Too Long", icon: "fa-hourglass-half", value: total, foot };
}

function paintKpis(rows, openNow, f) {
  const k = S.kpis(rows);
  const cards = [
    { label: "Total Patients", icon: "fa-users", value: k.total, foot: rangeLabel(f) },
    { label: "Active Journeys", icon: "fa-satellite-dish", value: openNow.length },
    overdueCard(openNow),
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

/** Six-month series from the running monthly totals, shaped like S.monthlyTrend(). */
function monthlyFromTotals(totals, months = 6) {
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(); d.setMonth(d.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    out.push([d.toLocaleDateString("en-ZA", { month: "short", year: "2-digit" }), totals[key] || 0]);
  }
  return out;
}

function paintCharts(rows, f) {
  // 14 days, or fewer when a shorter range is loaded — days before the range
  // would otherwise show as false zeros.
  const today = new Date().toISOString().slice(0, 10);
  const rangeDays = f.from ? Math.round((new Date(f.to || today) - new Date(f.from)) / 86400000) + 1 : 14;
  const daily = S.dailyTrend(rows, Math.max(1, Math.min(14, rangeDays)));
  mk("cDaily", { type: "line", data: { labels: daily.map((x) => x[0]), datasets: [{ label: "Patients", data: daily.map((x) => x[1]), borderColor: C.ems, backgroundColor: "rgba(255,131,66,.15)", fill: true, tension: .35, pointRadius: 2 }] }, options: { plugins: { legend: { display: false } } } });

  const k = S.kpis(rows);
  mk("cStatus", { type: "doughnut", _noScales: true, data: { labels: ["Active", "Closed"], datasets: [{ data: [k.active, k.completed], backgroundColor: [C.cyan, C.grey], borderWidth: 0 }] }, options: { cutout: "62%", plugins: { legend: { position: "bottom" } } } });

  // The loaded range is only DEFAULT_DAYS by default, so with no filter beyond that
  // default the six months come from the running totals instead. Any explicit
  // filter switches back to the loaded rows, as before.
  const unfiltered = f.from === DEFAULT_FROM && !f.to && !f.district && !f.station && !f.vehicle && !f.status;
  const monthly = monthTotals && unfiltered ? monthlyFromTotals(monthTotals, 6) : S.monthlyTrend(rows, 6);
  mk("cMonthly", { type: "bar", data: { labels: monthly.map((x) => x[0]), datasets: [{ label: "Patients", data: monthly.map((x) => x[1]), backgroundColor: C.ems2, borderRadius: 6 }] }, options: { plugins: { legend: { display: false } } } });

  // Normalised so one district cannot appear twice in different casing.
  const dist = S.countBy(rows.map((r) => ({ ...r, district: rowDistrict(r) })), "district", 6);
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
      <td>${esc(rowDistrict(r))}</td>
      <td class="mono">${esc(r.vehicle || "")}</td>
      <td>${fmtStamp(r.createdAt)}</td>
      <td><span class="status-pill ${r.closed ? "status-closed" : "status-active"}">${r.closed ? "Closed" : "Active"}</span></td>
    </tr>`).join("");
}
