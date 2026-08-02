/**
 * public-dashboard.js — renders the public Executive Command Centre from the
 * aggregate snapshot (dashboardMetrics/public). No authentication required and
 * no patient-identifying data is ever read here. Read-only: no exports, prints,
 * downloads or edits.
 */

import { readSnapshot, subscribeSnapshot, currentShift, shiftLabel } from "./metrics.js";
import { auth } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const PAL = ["#ff8342", "#38e1ff", "#34d399", "#fbbf24", "#a78bfa", "#fb7185", "#60a5fa", "#f472b6", "#5eead4", "#fdba74"];
const charts = {};
let current = null, dailyRange = 30, activeScope = "shift", lastShiftStart = null;

const EMPTY_AGG = {
  totals: { total: 0, active: 0, closed: 0, pending: 0, completed: 0, newToday: 0 },
  averages: { transferMinutes: null, longestWaitingMinutes: 0 },
  highlights: { topFacility: { name: "—", count: 0 }, topReceiving: { name: "—", count: 0 }, topStation: { name: "—", count: 0 }, topVehicle: { name: "—", count: 0 }, topDistrict: { name: "—", count: 0 } },
  byDistrict: [], topReferring: [], topReceiving: [], topStations: [], vehicles: [], routes: [],
  alerts: { waitingOver2h: 0, noVehicle: 0, inactiveVehicles: 0, highVolumeFacilities: [] },
};

const SCOPE_LABELS = { shift: "Current shift", prevShift: "Previous shift", today: "Today", d7: "Last 7 days", d30: "Last 30 days", all: "All time" };

/** Pick the aggregate for the active scope, handling shift rollover. */
function pickScope(s, key) {
  const scopes = s.scopes || {};
  if (key === "shift") {
    const live = currentShift(new Date());
    const stale = s.shiftMeta?.currentStartISO !== live.start.toISOString();
    if (stale) return { data: EMPTY_AGG, banner: `New ${live.key === "day" ? "day" : "night"} shift starting`, sub: `${shiftLabel(live)} · awaiting first transfer`, fresh: true };
    return { data: scopes.shift || EMPTY_AGG, banner: `Current ${s.shiftMeta.currentLabel}`, sub: `resets at ${live.key === "day" ? "19:00" : "07:00"}` };
  }
  if (key === "prevShift") return { data: scopes.prevShift || EMPTY_AGG, banner: `Previous ${s.shiftMeta?.prevLabel || "shift"}`, sub: "" };
  return { data: scopes[key] || (key === "all" ? s : EMPTY_AGG), banner: SCOPE_LABELS[key] || "All time", sub: "" };
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = (n) => (n ?? 0).toLocaleString("en-ZA");
function fmtDur(min) {
  if (min == null) return "—";
  min = Math.round(min);
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}
const trendIcon = (t) => t === "up" ? '<i class="fa-solid fa-arrow-trend-up trend-up"></i>'
  : t === "down" ? '<i class="fa-solid fa-arrow-trend-down trend-down"></i>'
  : '<i class="fa-solid fa-minus trend-flat"></i>';

/* ---- live clock ---- */
function tick() {
  const now = new Date();
  document.getElementById("ccTime").textContent = now.toLocaleTimeString("en-ZA", { hour12: false });
  document.getElementById("ccDate").textContent = now.toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
setInterval(tick, 1000); tick();

/* ---- sync freshness label ---- */
function syncLabel() {
  if (!current?.updatedAt) return;
  const secs = Math.max(0, Math.round((Date.now() - new Date(current.updatedAt).getTime()) / 1000));
  const txt = secs < 60 ? `${secs}s ago` : secs < 3600 ? `${Math.round(secs / 60)}m ago` : `${Math.round(secs / 3600)}h ago`;
  document.getElementById("syncInfo").innerHTML = `<i class="fa-solid fa-rotate me-1"></i>Last synced ${txt}`;
  document.getElementById("footSync").textContent = ` · snapshot ${new Date(current.updatedAt).toLocaleString("en-ZA")}`;
}
setInterval(syncLabel, 1000);

/* ---- animated counter ---- */
function countUp(el, target, opts = {}) {
  const dur = 900, start = performance.now(), from = 0;
  const step = (t) => {
    const p = Math.min(1, (t - start) / dur);
    const v = Math.round((from + (target - from) * (1 - Math.pow(1 - p, 3))) * (opts.dp ? 10 : 1)) / (opts.dp ? 10 : 1);
    el.textContent = (opts.pre || "") + (opts.raw ? v : num(v)) + (opts.suf || "");
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ================================================================= render */
function render(s) {
  current = s;
  const root = document.getElementById("dashRoot");
  const picked = pickScope(s, activeScope);
  const d = picked.data;
  const t = d.totals || {}, a = d.averages || {}, h = d.highlights || {};
  lastShiftStart = currentShift(new Date()).start.toISOString();

  const pills = Object.keys(SCOPE_LABELS).map((k) =>
    `<button class="sp ${k === activeScope ? "active" : ""}" data-scope="${k}">${SCOPE_LABELS[k]}</button>`).join("");

  root.innerHTML = `
    <div class="scope-bar">
      <div class="scope-info">
        <span class="scope-dot"></span>
        <div><div class="scope-title">Showing: ${esc(picked.banner)}</div>
          ${picked.sub ? `<div class="scope-sub">${esc(picked.sub)}</div>` : ""}</div>
      </div>
      <div class="scope-pills">${pills}</div>
    </div>

    <div class="kpi-row mb-4">
      ${kpi("fa-truck-medical", "Live Patients", t.active, "var(--cyan-400)")}
      ${kpi("fa-circle-check", "Completed", t.completed, "var(--ok)")}
      ${kpiText("fa-stopwatch", "Avg Transfer Time", fmtDur(a.transferMinutes))}
      ${kpi("fa-list-check", "Total Referrals", t.total)}
      ${kpi("fa-hourglass-half", "Pending", t.pending, "var(--warn)")}
      ${kpi("fa-lock", "Closed", t.closed, "var(--closed)")}
    </div>

    <div class="row g-3 mb-3">
      <div class="col-lg-8"><div class="panel">
        <div class="d-flex justify-content-between align-items-center mb-2">
          <div><h3>Referral History</h3><div class="sub">Whole-province daily trend — referrals vs completed (all data)</div></div>
          <div class="range-pills d-flex gap-2">
            <button class="rp" data-range="7">7 days</button>
            <button class="rp active" data-range="30">30 days</button>
          </div>
        </div>
        <div class="chart-box"><canvas id="cDaily"></canvas></div>
      </div></div>
      <div class="col-lg-4"><div class="panel">
        <h3>Patients by District</h3><div class="sub">${esc(picked.banner)} · referring district share</div>
        <div class="chart-box sm mt-2"><canvas id="cDistrict"></canvas></div>
      </div></div>
    </div>

    <div class="row g-3 mb-3">
      <div class="col-lg-6"><div class="panel">
        <div class="d-flex justify-content-between align-items-center">
          <div><h3>Monthly Trend</h3><div class="sub">Referrals per month (all data)</div></div>
          ${momBadge(s.momChangePct)}
        </div>
        <div class="chart-box sm mt-2"><canvas id="cMonthly"></canvas></div>
      </div></div>
      <div class="col-lg-6"><div class="panel">
        <h3>Weekly Trend</h3><div class="sub">Referrals per week — last 8 (all data)</div>
        <div class="chart-box sm mt-2"><canvas id="cWeekly"></canvas></div>
      </div></div>
    </div>

    <div class="row g-3 mb-3">
      <div class="col-lg-4"><div class="panel">
        <h3 class="mb-1">Top Referring Facilities</h3><div class="sub mb-2">${esc(picked.banner)} · share of referrals</div>
        ${rankList(d.topReferring)}
      </div></div>
      <div class="col-lg-4"><div class="panel">
        <h3 class="mb-1">Top Receiving Facilities</h3><div class="sub mb-2">${esc(picked.banner)} · by volume</div>
        ${rankList(d.topReceiving)}
      </div></div>
      <div class="col-lg-4"><div class="panel">
        <h3 class="mb-1">Most Used EMS Stations</h3><div class="sub mb-2">${esc(picked.banner)} · by transfers</div>
        ${rankList(d.topStations)}
      </div></div>
    </div>

    <div class="row g-3 mb-3">
      <div class="col-lg-7"><div class="panel">
        <h3 class="mb-2">Vehicle Utilisation</h3>
        ${vehicleTable(d.vehicles)}
      </div></div>
      <div class="col-lg-5"><div class="panel">
        <h3 class="mb-2">Operational Alerts</h3>
        ${alertsPanel(d.alerts)}
      </div></div>
    </div>

    <div class="panel mb-3">
      <h3 class="mb-1">Referral Flow — Busiest Routes</h3><div class="sub mb-3">${esc(picked.banner)} · referring → receiving facility, by patient count</div>
      ${flowPanel(d.routes)}
    </div>

    <div class="sum-grid">
      ${sumCard("fa-hospital", "Most Active Facility", h.topFacility)}
      ${sumCard("fa-tower-broadcast", "Most Active EMS Station", h.topStation)}
      ${sumCard("fa-truck-medical", "Most Utilised Vehicle", h.topVehicle)}
      ${sumCardText("fa-hourglass-half", "Longest Waiting Patient", fmtDur(a.longestWaitingMinutes))}
    </div>
  `;

  // animate counters
  root.querySelectorAll("[data-count]").forEach((el) => countUp(el, Number(el.dataset.count)));
  // daily range pills (historical chart)
  root.querySelectorAll(".rp").forEach((b) => b.addEventListener("click", () => {
    root.querySelectorAll(".rp").forEach((x) => x.classList.toggle("active", x === b));
    dailyRange = Number(b.dataset.range); drawDaily(s);
  }));
  // scope filter pills
  root.querySelectorAll(".sp").forEach((b) => b.addEventListener("click", () => {
    activeScope = b.dataset.scope; render(current);
  }));

  drawDaily(s); drawDistrict(d); drawMonthly(s); drawWeekly(s);
  updateRouteMap(d, picked.banner);
  syncLabel();
}

/* ---- card builders ---- */
function kpi(icon, label, value, color) {
  return `<div class="kpi"><i class="fa-solid ${icon} kpi-icon"></i>
    <div class="kpi-label">${label}</div>
    <div class="metric-value" data-count="${value ?? 0}" ${color ? `style="color:${color}"` : ""}>0</div></div>`;
}
function kpiText(icon, label, text) {
  return `<div class="kpi"><i class="fa-solid ${icon} kpi-icon"></i>
    <div class="kpi-label">${label}</div>
    <div class="metric-value" style="color:var(--ems-400)">${esc(text)}</div></div>`;
}
function momBadge(pct) {
  if (pct == null) return "";
  const up = pct >= 0;
  return `<span class="status-pill" style="color:${up ? "var(--ok)" : "var(--danger)"};background:${up ? "rgba(52,211,153,.12)" : "rgba(251,92,92,.12)"};border:1px solid ${up ? "rgba(52,211,153,.3)" : "rgba(251,92,92,.3)"}">
    ${up ? "▲" : "▼"} ${Math.abs(pct)}% vs prev</span>`;
}
function rankList(items) {
  if (!items || !items.length) return `<div class="text-faint" style="font-size:.85rem">No data yet.</div>`;
  return `<ul class="rank">${items.map((it, i) => `
    <li><span class="n">${i + 1}</span>
      <span class="nm" title="${esc(it.name)}">${esc(it.name)}</span>
      ${it.trend ? trendIcon(it.trend) : ""}
      <span class="ct">${num(it.count)}</span>
      ${it.pct != null ? `<span class="pc">${it.pct}%</span>` : ""}
    </li>`).join("")}</ul>`;
}
function vehicleTable(vs) {
  if (!vs || !vs.length) return `<div class="text-faint" style="font-size:.85rem">No vehicle activity yet.</div>`;
  return `<table class="util-table"><thead><tr><th>Vehicle</th><th>Trips</th><th>Per day</th><th style="width:34%">Utilisation</th></tr></thead>
    <tbody>${vs.map((v) => {
      const cls = v.utilPct >= 80 ? "u-green" : v.utilPct >= 60 ? "u-amber" : "u-red";
      return `<tr>
        <td class="mono">${esc(v.registration)}</td>
        <td>${num(v.trips)}</td>
        <td>${v.perDay ?? 0}</td>
        <td><div class="util-bar ${cls}"><span style="width:${Math.max(4, v.utilPct)}%"></span></div>
          <span class="text-faint" style="font-size:.72rem">${v.utilPct}%${v.inactiveHrs != null && v.inactiveHrs > 12 ? ` · idle ${v.inactiveHrs}h` : ""}</span></td>
      </tr>`;
    }).join("")}</tbody></table>
    <div class="text-faint mt-2" style="font-size:.7rem">Utilisation shown relative to the busiest vehicle in the period.</div>`;
}
function alertsPanel(al) {
  al = al || {};
  const hv = al.highVolumeFacilities || [];
  const rows = [
    ["a-red", "fa-hourglass-end", "Patients waiting over 2 hours", al.waitingOver2h || 0, ""],
    ["a-amber", "fa-truck-medical", "Active transfers with no vehicle", al.noVehicle || 0, ""],
    ["a-red", "fa-car-on", "Vehicles inactive over 12 hours", al.inactiveVehicles || 0, ""],
    ["a-amber", "fa-tower-broadcast", "High-volume facilities today", hv.length, hv.length ? esc(hv.join(", ")) : ""],
  ];
  return rows.map(([cls, ic, label, val, sub]) => `
    <div class="alert-item ${cls}">
      <div class="ai-ic"><i class="fa-solid ${ic}"></i></div>
      <div style="min-width:0"><div style="font-size:.86rem">${label}</div>
        ${sub ? `<div class="text-faint" style="font-size:.72rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sub}</div>` : ""}</div>
      <div class="ai-v">${num(val)}</div>
    </div>`).join("");
}
function flowPanel(routes) {
  if (!routes || !routes.length) return `<div class="text-faint" style="font-size:.85rem">No referral routes yet.</div>`;
  const max = Math.max(...routes.map((r) => r.count));
  return routes.map((r) => `
    <div class="flow mb-2">
      <div class="cell from" title="${esc(r.from)}">${esc(r.from)}</div>
      <div class="arrow"><i class="fa-solid fa-arrow-right-long"></i></div>
      <div class="cell to" title="${esc(r.to)}">${esc(r.to)}</div>
      <div class="cnt">${num(r.count)}</div>
      <div class="track"><span style="width:${Math.round((r.count / max) * 100)}%"></span></div>
    </div>`).join("");
}
function sumCard(icon, label, obj) {
  const name = obj?.name && obj.name !== "—" ? obj.name : "—";
  const meta = obj?.count ? `${num(obj.count)} transfers` : "";
  return `<div class="sum"><div class="lb"><i class="fa-solid ${icon} me-1" style="color:var(--ems-400)"></i>${label}</div>
    <div class="vv" title="${esc(name)}">${esc(name)}</div><div class="mt">${meta}</div></div>`;
}
function sumCardText(icon, label, text) {
  return `<div class="sum"><div class="lb"><i class="fa-solid ${icon} me-1" style="color:var(--ems-400)"></i>${label}</div>
    <div class="vv" style="color:var(--ems-400)">${esc(text)}</div><div class="mt">current active journeys</div></div>`;
}

/* ---- charts ---- */
function baseOpts(extra = {}) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { labels: { color: "#9db0d6", boxWidth: 12, font: { family: "Inter" } } } },
    scales: {
      x: { grid: { color: "rgba(120,160,255,.08)" }, ticks: { color: "#64769e", font: { size: 10 } } },
      y: { grid: { color: "rgba(120,160,255,.08)" }, ticks: { color: "#64769e", font: { size: 10 } }, beginAtZero: true },
    }, ...extra,
  };
}
function grad(ctx, hex) {
  const g = ctx.createLinearGradient(0, 0, 0, 300);
  g.addColorStop(0, hex + "55"); g.addColorStop(1, hex + "05"); return g;
}
function drawDaily(s) {
  if (typeof Chart === "undefined") return;
  const data = (s.daily || []).slice(-dailyRange);
  const el = document.getElementById("cDaily"); if (!el) return;
  charts.daily?.destroy();
  const ctx = el.getContext("2d");
  charts.daily = new Chart(ctx, {
    type: "line",
    data: { labels: data.map((d) => d.label), datasets: [
      { label: "Referrals", data: data.map((d) => d.referrals), borderColor: "#ff8342", backgroundColor: grad(ctx, "#ff8342"), fill: true, tension: .35, pointRadius: 0, borderWidth: 2 },
      { label: "Completed", data: data.map((d) => d.completed), borderColor: "#38e1ff", backgroundColor: grad(ctx, "#38e1ff"), fill: true, tension: .35, pointRadius: 0, borderWidth: 2 },
    ] }, options: baseOpts(),
  });
}
function drawDistrict(s) {
  if (typeof Chart === "undefined") return;
  const el = document.getElementById("cDistrict"); if (!el) return;
  charts.district?.destroy();
  const d = s.byDistrict || [];
  charts.district = new Chart(el, {
    type: "doughnut",
    data: { labels: d.map((x) => x.name), datasets: [{ data: d.map((x) => x.count), backgroundColor: PAL, borderColor: "rgba(6,11,28,.6)", borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: "62%",
      plugins: { legend: { position: "bottom", labels: { color: "#9db0d6", boxWidth: 10, font: { size: 10 } } } } },
  });
}
function drawMonthly(s) {
  if (typeof Chart === "undefined") return;
  const el = document.getElementById("cMonthly"); if (!el) return;
  charts.monthly?.destroy();
  const m = s.monthly || [];
  charts.monthly = new Chart(el, {
    type: "bar",
    data: { labels: m.map((x) => x.label), datasets: [{ label: "Referrals", data: m.map((x) => x.referrals), backgroundColor: "#ff8342", borderRadius: 6, maxBarThickness: 42 }] },
    options: baseOpts({ plugins: { legend: { display: false } } }),
  });
}
function drawWeekly(s) {
  if (typeof Chart === "undefined") return;
  const el = document.getElementById("cWeekly"); if (!el) return;
  charts.weekly?.destroy();
  const w = s.weekly || [];
  charts.weekly = new Chart(el, {
    type: "bar",
    data: { labels: w.map((x) => x.label), datasets: [{ label: "Referrals", data: w.map((x) => x.referrals), backgroundColor: "#38e1ff", borderRadius: 6, maxBarThickness: 34 }] },
    options: baseOpts({ plugins: { legend: { display: false } } }),
  });
}

/* ================================================================= route map */
let rmap = null, routeLayer = null, markerLayer = null, lastRouteSig = "";

function lerpColor(a, b, t) {
  const p = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
  const c = (x, y) => Math.round(x + (y - x) * t);
  return `rgb(${c(r1, r2)},${c(g1, g2)},${c(b1, b2)})`;
}
// Quadratic arc between two points, bulged perpendicular so opposite directions separate.
function arcPoints(a, b, n = 26) {
  const [la1, ln1] = a, [la2, ln2] = b;
  const dx = la2 - la1, dy = ln2 - ln1;
  const mx = (la1 + la2) / 2, my = (ln1 + ln2) / 2;
  const cx = mx + (-dy) * 0.18, cy = my + (dx) * 0.18; // control point
  const pts = [];
  for (let i = 0; i <= n; i++) { const t = i / n, u = 1 - t;
    pts.push([u * u * la1 + 2 * u * t * cx + t * t * la2, u * u * ln1 + 2 * u * t * cy + t * t * ln2]);
  }
  return pts;
}
function routeTooltip(r) {
  const items = Object.entries(r.byVehicle).sort((a, b) => b[1] - a[1])
    .map(([v, c]) => `<div class="rt-row"><span>${esc(v)}</span><b>${num(c)}</b></div>`).join("");
  return `<div class="rt-tip"><div class="rt-h">${esc(r.from)} → ${esc(r.to)}</div>
    <div class="rt-total">${num(r.count)} patient${r.count !== 1 ? "s" : ""} transported</div>
    <div class="rt-sub">By vehicle</div>${items}</div>`;
}

function updateRouteMap(agg, bannerLabel) {
  const section = document.getElementById("routeSection");
  const emptyEl = document.getElementById("routeMapEmpty");
  const sub = document.getElementById("routeScopeSub");
  if (!section) return;
  if (typeof L === "undefined") { section.style.display = ""; document.getElementById("routeMap").style.display = "none"; emptyEl.style.display = "block"; emptyEl.textContent = "Live map loads over the internet — offline preview only."; return; }
  const routes = (agg.routeMap || []).filter((r) => isFinite(r.fromLat) && isFinite(r.toLat));
  section.style.display = "";
  if (sub) sub.textContent = `${bannerLabel} · ${routes.length} route${routes.length !== 1 ? "s" : ""} · hover for per-vehicle detail`;
  if (!routes.length) { document.getElementById("routeMap").style.display = "none"; emptyEl.style.display = "block"; emptyEl.textContent = "No geocoded routes in this window yet."; return; }
  document.getElementById("routeMap").style.display = ""; emptyEl.style.display = "none";

  if (!rmap) {
    rmap = L.map("routeMap", { zoomControl: true, attributionControl: true, scrollWheelZoom: false }).setView([-26.15, 28.1], 9);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      subdomains: "abcd", maxZoom: 19, attribution: "&copy; OpenStreetMap &copy; CARTO",
    }).addTo(rmap);
    routeLayer = L.layerGroup().addTo(rmap);
    markerLayer = L.layerGroup().addTo(rmap);
  }
  routeLayer.clearLayers(); markerLayer.clearLayers();

  const max = Math.max(...routes.map((r) => r.count));
  // facility throughput for marker sizing
  const fac = {};
  routes.forEach((r) => {
    (fac[r.from] = fac[r.from] || { name: r.from, lat: r.fromLat, lng: r.fromLng, out: 0, in: 0 }).out += r.count;
    (fac[r.to] = fac[r.to] || { name: r.to, lat: r.toLat, lng: r.toLng, out: 0, in: 0 }).in += r.count;
  });

  const bounds = [];
  routes.forEach((r) => {
    const t = r.count / max;
    const line = L.polyline(arcPoints([r.fromLat, r.fromLng], [r.toLat, r.toLng]), {
      color: lerpColor("#38e1ff", "#ff6b1a", t), weight: 1.6 + t * 6, opacity: 0.5 + t * 0.4, lineCap: "round",
    });
    line.bindTooltip(routeTooltip(r), { sticky: true, className: "rt-wrap", direction: "top" });
    line.on("mouseover", function () { this.setStyle({ weight: (1.6 + t * 6) + 2, opacity: 1 }); });
    line.on("mouseout", function () { this.setStyle({ weight: 1.6 + t * 6, opacity: 0.5 + t * 0.4 }); });
    line.addTo(routeLayer);
    bounds.push([r.fromLat, r.fromLng], [r.toLat, r.toLng]);
  });
  Object.values(fac).forEach((f) => {
    if (!isFinite(f.lat) || !isFinite(f.lng)) return;
    const tot = f.in + f.out;
    L.circleMarker([f.lat, f.lng], {
      radius: 3 + Math.min(11, Math.sqrt(tot)), color: "#0a1224", weight: 1.5,
      fillColor: f.out >= f.in ? "#ff8342" : "#38e1ff", fillOpacity: 0.9,
    }).bindTooltip(`<div class="rt-tip"><div class="rt-h">${esc(f.name)}</div>
      <div class="rt-row"><span>Referred out</span><b>${num(f.out)}</b></div>
      <div class="rt-row"><span>Received in</span><b>${num(f.in)}</b></div></div>`, { className: "rt-wrap", direction: "top" }).addTo(markerLayer);
  });

  // Only refit the view when the route set changes (keeps the user's pan/zoom otherwise).
  const sig = routes.length + ":" + (routes[0] ? routes[0].from + routes[0].to : "");
  if (bounds.length && sig !== lastRouteSig) { rmap.fitBounds(bounds, { padding: [40, 40], maxZoom: 11 }); lastRouteSig = sig; }
  setTimeout(() => rmap.invalidateSize(), 60);
}

/* ================================================================= boot */
function emptyState(msg) {
  document.getElementById("dashRoot").innerHTML = `
    <div class="panel text-center" style="padding:60px 20px">
      <i class="fa-solid fa-satellite-dish" style="font-size:2.4rem;color:var(--glass-line-strong)"></i>
      <h3 class="mt-3">Awaiting first data sync</h3>
      <p class="text-dim" style="max-width:460px;margin:8px auto 0">${msg}</p>
    </div>`;
  document.getElementById("syncInfo").textContent = "";
}

/**
 * Boot. In demo mode we render the canned snapshot and never touch Firestore.
 * Otherwise we simply attach the listener — it fires immediately with the
 * current document, so there is no separate initial read to pay for.
 */
function load() {
  if (isDemo()) { render(DEMO); return; }
  startLive();
}

/* ============================================================ live updates
 *
 * Previously this polled readSnapshot() every 30 seconds. That cost 2,880
 * Firestore reads per day for EVERY open tab, whether or not anything had
 * changed — and this dashboard is public, so the number of open tabs is not
 * something we control. A dozen wall displays left running would have consumed
 * the entire Spark daily read quota on their own, and an exhausted quota means
 * the register stops answering mid-shift.
 *
 * A listener bills a read on attach and then only when the document actually
 * changes. An idle dashboard now costs nothing.
 *
 * The 07:00 / 19:00 shift rollover is pure local clock arithmetic, so it is
 * handled by a timer that re-renders the data already in memory — no reads.
 */
const isDemo = () => new URLSearchParams(location.search).has("demo");

let unsubscribe = null;

function applySnapshot(snap) {
  if (!snap) {
    emptyState("Sign in as staff and open the Operational Dashboard once (or capture a patient) to publish the first aggregate snapshot.");
    return;
  }
  if (snap.updatedAt !== current?.updatedAt) render(snap);
}

function startLive() {
  if (unsubscribe || isDemo()) return;
  unsubscribe = subscribeSnapshot(
    applySnapshot,
    () => {
      // Mid-session hiccup: keep the last good view rather than blanking a wall
      // display. If we never got a first render, say so plainly.
      if (!current) emptyState("Could not reach the live snapshot. Check the Firebase connection, then refresh.");
    }
  );
}

function stopLive() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
}

// Detach while the tab is hidden; reattach (one read) when it returns.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopLive();
  else { startLive(); checkRollover(); }
});

// Shift changeover: re-render what we already hold so the view visibly resets
// at 07:00 and 19:00 even if no new transfer has been captured yet. Zero reads.
function checkRollover() {
  if (!current) return;
  const nowStart = currentShift(new Date()).start.toISOString();
  if (nowStart !== lastShiftStart) render(current);
}
setInterval(checkRollover, 30000);

// Fullscreen toggle.
document.getElementById("fsBtn").addEventListener("click", () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
  else document.exitFullscreen?.();
});

// Context-aware button: signed-in staff get a route back into the console.
onAuthStateChanged(auth, (user) => {
  const btn = document.getElementById("authBtn");
  if (user) { btn.href = "home.html"; btn.innerHTML = '<i class="fa-solid fa-arrow-left"></i> Back to console'; }
  else { btn.href = "index.html"; btn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Staff sign in'; }
});

/* ---- demo snapshot (only used with ?demo=1 or offline preview) ---- */
const DEMO = (function makeDemo() {
  const ALL = {
    totals: { total: 1284, active: 37, closed: 1247, pending: 37, completed: 1247, newToday: 96 },
    averages: { transferMinutes: 96, longestWaitingMinutes: 214 },
    highlights: {
      topFacility: { name: "Chris Hani Baragwanath Hospital", count: 187 },
      topReceiving: { name: "Charlotte Maxeke Hospital", count: 164 },
      topStation: { name: "Bara/Eldos EMS Station", count: 203 },
      topVehicle: { name: "GS-003-GP", count: 142 },
      topDistrict: { name: "City of Johannesburg", count: 512 },
    },
    byDistrict: [
      { name: "City of Johannesburg", count: 512 }, { name: "City of Ekurhuleni", count: 331 },
      { name: "City of Tshwane", count: 268 }, { name: "Sedibeng", count: 104 }, { name: "West Rand", count: 69 },
    ],
    topReferring: [
      { name: "Chris Hani Baragwanath Hospital", count: 187, pct: 14.6, trend: "up" },
      { name: "Tembisa Hospital", count: 143, pct: 11.1, trend: "up" },
      { name: "Lillian Ngoyi CHC", count: 121, pct: 9.4, trend: "flat" },
      { name: "Steve Biko Academic Hospital", count: 98, pct: 7.6, trend: "down" },
      { name: "Sebokeng Hospital", count: 84, pct: 6.5, trend: "up" },
    ],
    topReceiving: [
      { name: "Charlotte Maxeke Hospital", count: 164, pct: 12.8, trend: "up" },
      { name: "Chris Hani Baragwanath Hospital", count: 151, pct: 11.8, trend: "flat" },
      { name: "Steve Biko Academic Hospital", count: 132, pct: 10.3, trend: "up" },
      { name: "Helen Joseph Hospital", count: 89, pct: 6.9, trend: "down" },
      { name: "Rahima Moosa Hospital", count: 77, pct: 6.0, trend: "up" },
    ],
    topStations: [
      { name: "Bara/Eldos EMS Station", count: 203, pct: 15.8, trend: "up" },
      { name: "Tembisa EMS Station", count: 168, pct: 13.1, trend: "up" },
      { name: "Mamelodi EMS Station", count: 129, pct: 10.0, trend: "flat" },
      { name: "Sebokeng EMS Station", count: 96, pct: 7.5, trend: "up" },
      { name: "Krugersdorp EMS Station", count: 71, pct: 5.5, trend: "down" },
    ],
    vehicles: [
      { registration: "GS-003-GP", trips: 142, perDay: 4.7, utilPct: 100, inactiveHrs: 1 },
      { registration: "GS-001-GP", trips: 128, perDay: 4.3, utilPct: 90, inactiveHrs: 2 },
      { registration: "GS-006-GP", trips: 97, perDay: 3.2, utilPct: 68, inactiveHrs: 4 },
      { registration: "GS-002-GP", trips: 74, perDay: 2.5, utilPct: 52, inactiveHrs: 9 },
      { registration: "GS-008-GP", trips: 41, perDay: 1.4, utilPct: 29, inactiveHrs: 16 },
    ],
    routes: [
      { from: "Tembisa Hospital", to: "Steve Biko Academic Hospital", count: 64 },
      { from: "Lillian Ngoyi CHC", to: "Chris Hani Baragwanath Hospital", count: 58 },
      { from: "Sebokeng Hospital", to: "Charlotte Maxeke Hospital", count: 41 },
      { from: "Bheki Mlangeni Hospital", to: "Helen Joseph Hospital", count: 37 },
      { from: "Kopanong Hospital", to: "Chris Hani Baragwanath Hospital", count: 29 },
    ],
    routeMap: [
      { from: "Tembisa Hospital", to: "Steve Biko Academic Hospital", fromLat: -25.9966, fromLng: 28.2140, toLat: -25.7280, toLng: 28.2010, count: 64, byVehicle: { "GS-001-GP": 24, "GS-003-GP": 21, "GS-006-GP": 12, Unassigned: 7 } },
      { from: "Lillian Ngoyi CHC", to: "Chris Hani Baragwanath Hospital", fromLat: -25.7050, fromLng: 28.1100, toLat: -26.2606, toLng: 27.9441, count: 58, byVehicle: { "GS-003-GP": 26, "GS-002-GP": 19, "GS-008-GP": 13 } },
      { from: "Sebokeng Hospital", to: "Charlotte Maxeke Hospital", fromLat: -26.5580, fromLng: 27.8480, toLat: -26.1875, toLng: 28.0430, count: 41, byVehicle: { "GS-001-GP": 18, "GS-006-GP": 15, Unassigned: 8 } },
      { from: "Bheki Mlangeni Hospital", to: "Helen Joseph Hospital", fromLat: -26.2660, fromLng: 27.8480, toLat: -26.1686, toLng: 27.9930, count: 37, byVehicle: { "GS-002-GP": 20, "GS-003-GP": 17 } },
      { from: "Kopanong Hospital", to: "Chris Hani Baragwanath Hospital", fromLat: -26.6760, fromLng: 27.9290, toLat: -26.2606, toLng: 27.9441, count: 29, byVehicle: { "GS-006-GP": 14, "GS-001-GP": 9, "GS-008-GP": 6 } },
      { from: "Rahima Moosa Hospital", to: "Charlotte Maxeke Hospital", fromLat: -26.1740, fromLng: 27.9780, toLat: -26.1875, toLng: 28.0430, count: 24, byVehicle: { "GS-003-GP": 13, "GS-002-GP": 11 } },
      { from: "Tembisa Hospital", to: "Chris Hani Baragwanath Hospital", fromLat: -25.9966, fromLng: 28.2140, toLat: -26.2606, toLng: 27.9441, count: 19, byVehicle: { "GS-001-GP": 11, "GS-006-GP": 8 } },
    ],
    alerts: { waitingOver2h: 6, noVehicle: 3, inactiveVehicles: 2, highVolumeFacilities: ["Chris Hani Baragwanath Hospital", "Tembisa Hospital"] },
  };
  const sc = (n, f) => Math.max(0, Math.round((n || 0) * f));
  const scaleVeh = (bv, f) => Object.fromEntries(Object.entries(bv).map(([k, v]) => [k, sc(v, f)]).filter(([, v]) => v > 0));
  const scaleAgg = (A, f) => ({
    totals: { total: sc(A.totals.total, f), active: sc(A.totals.active, f), closed: sc(A.totals.closed, f), pending: sc(A.totals.active, f), completed: sc(A.totals.closed, f), newToday: sc(A.totals.newToday, f) },
    averages: { transferMinutes: A.averages.transferMinutes, longestWaitingMinutes: Math.round(A.averages.longestWaitingMinutes * Math.min(1, f * 2)) },
    highlights: Object.fromEntries(Object.entries(A.highlights).map(([k, v]) => [k, { ...v, count: sc(v.count, f) }])),
    byDistrict: A.byDistrict.map((x) => ({ ...x, count: sc(x.count, f) })),
    topReferring: A.topReferring.map((x) => ({ ...x, count: sc(x.count, f) })),
    topReceiving: A.topReceiving.map((x) => ({ ...x, count: sc(x.count, f) })),
    topStations: A.topStations.map((x) => ({ ...x, count: sc(x.count, f) })),
    vehicles: A.vehicles.map((v) => ({ ...v, trips: sc(v.trips, f), perDay: Math.round(v.perDay * f * 10) / 10 })),
    routes: A.routes.map((r) => ({ ...r, count: sc(r.count, f) })),
    routeMap: A.routeMap.map((r) => ({ ...r, count: Math.max(1, sc(r.count, f)), byVehicle: scaleVeh(r.byVehicle, f) })).filter((r) => Object.keys(r.byVehicle).length),
    alerts: { waitingOver2h: sc(A.alerts.waitingOver2h, f), noVehicle: sc(A.alerts.noVehicle, f), inactiveVehicles: A.alerts.inactiveVehicles, highVolumeFacilities: f > 0.2 ? A.alerts.highVolumeFacilities : [] },
  });
  const cs = currentShift(), prev = currentShift(new Date(cs.start.getTime() - 1));
  return {
    updatedAt: new Date().toISOString(),
    shiftMeta: {
      currentKey: cs.key, currentStartISO: cs.start.toISOString(), currentEndISO: cs.end.toISOString(), currentLabel: shiftLabel(cs),
      prevKey: prev.key, prevStartISO: prev.start.toISOString(), prevEndISO: prev.end.toISOString(), prevLabel: shiftLabel(prev),
    },
    daily: Array.from({ length: 30 }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() - (29 - i));
      const base = 30 + Math.round(18 * Math.sin(i / 3)) + (i % 7 < 5 ? 12 : -6);
      return { date: d.toISOString().slice(0, 10), label: d.toISOString().slice(5, 10), referrals: Math.max(6, base + (i % 4)), completed: Math.max(4, base - 5 + (i % 3)) };
    }),
    weekly: Array.from({ length: 8 }, (_, i) => ({ week: i, label: `W${i + 1}`, referrals: 180 + Math.round(60 * Math.sin(i)) })),
    monthly: [
      { key: "1", label: "Feb 26", referrals: 742 }, { key: "2", label: "Mar 26", referrals: 831 },
      { key: "3", label: "Apr 26", referrals: 798 }, { key: "4", label: "May 26", referrals: 905 },
      { key: "5", label: "Jun 26", referrals: 968 }, { key: "6", label: "Jul 26", referrals: 1046 },
    ],
    momChangePct: 8.1,
    scopes: {
      shift: scaleAgg(ALL, 0.05), prevShift: scaleAgg(ALL, 0.06), today: scaleAgg(ALL, 0.09),
      d7: scaleAgg(ALL, 0.28), d30: scaleAgg(ALL, 0.85), all: ALL,
    },
    ...ALL,
  };
})();

load();
