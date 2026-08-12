/**
 * layout.js — renders the sidebar + topbar shell shared by all inner pages.
 * Call renderShell(active, profile) after auth resolves; it injects the nav,
 * highlights the active item, hides items the role can’t use, and starts the
 * clock + weather widgets.
 */

import { CAPS } from "./firebase-config.js";
import { startClock, fetchWeather, paintUserChip, initSidebar } from "./app.js";
import { startJourneyReminder, stopJourneyReminder } from "./journey-reminder.js";

const NAV = [
  { id: "home", href: "home.html", icon: "fa-house", label: "Home", cap: null },
  { id: "dashboard", href: "dashboard.html", icon: "fa-chart-line", label: "Operational Dashboard", cap: "viewDashboard" },
  { id: "executive", href: "public-dashboard.html", icon: "fa-tower-cell", label: "Operations Centre", cap: "viewExecutive" },
  { id: "capture", href: "capture.html", icon: "fa-notes-medical", label: "Capture Patient", cap: "capturePatient" },
  { id: "journeys", href: "journeys.html", icon: "fa-route", label: "Journeys", cap: "viewJourneys" },
  { id: "heatmaps", href: "heatmaps.html", icon: "fa-map-location-dot", label: "Heatmaps", cap: "viewHeatmaps" },
  { id: "reports", href: "reports.html", icon: "fa-file-export", label: "Reports", cap: "exportReports" },
];
const ADMIN_NAV = [
  { id: "admin", href: "admin.html", icon: "fa-user-shield", label: "Users & Setup", cap: "adminSetup" },
  { id: "audit", href: "admin.html#audit", icon: "fa-clipboard-list", label: "Audit Logs", cap: "viewAudit" },
];

export async function renderShell(active, profile) {
  const caps = CAPS[profile.role] || {};
  const allowed = (item) => !item.cap || caps[item.cap];

  const mainItems = NAV.filter(allowed).map((n) => navHTML(n, active)).join("");
  const adminItems = ADMIN_NAV.filter(allowed).map((n) => navHTML(n, active)).join("");
  const adminBlock = adminItems ? `<div class="nav-section-label">Administration</div>${adminItems}` : "";

  const shell = document.getElementById("appShell");
  shell.innerHTML = `
    <div class="sidebar-backdrop"></div>
    <aside class="sidebar">
      <div class="brand">
        <img src="assets/logo.png" alt="G-Set logo" />
        <div>
          <div class="brand-name">G-SET</div>
          <div class="brand-sub">Patient Registry</div>
        </div>
      </div>
      <nav class="flex-grow-1 overflow-auto">
        <div class="nav-section-label">Operations</div>
        ${mainItems}
        ${adminBlock}
      </nav>
      <button class="nav-link-item w-100 border-0 bg-transparent text-start" data-logout>
        <i class="fa-solid fa-arrow-right-from-bracket"></i> Sign out
      </button>
    </aside>

    <div class="main">
      <header class="topbar">
        <button class="btn btn-ghost btn-sm mobile-toggle" aria-label="Menu"><i class="fa-solid fa-bars"></i></button>
        <div class="me-auto">
          <div class="clock mono" id="clock">--:--:--</div>
          <div class="text-faint" id="clockDate" style="font-size:.76rem">—</div>
        </div>
        <div class="d-none d-md-flex align-items-center gap-2 text-dim me-2" id="wxWidget" title="Gauteng weather">
          <i class="fa-solid fa-cloud"></i><span class="mono">—</span>
        </div>
        <div class="user-chip">
          <div class="avatar" id="avatar">U</div>
          <div class="d-none d-sm-block">
            <div style="font-size:.86rem;font-weight:600" id="chipName">—</div>
            <span class="role-badge" id="chipRole">—</span>
          </div>
        </div>
      </header>
      <main class="content" id="pageContent"></main>
    </div>`;

  paintUserChip(profile);
  initSidebar();
  startClock();
  loadWeatherWidget();

  // Open-journey reminder. Only for roles that can actually close a journey —
  // prompting a manager to close records they have no rights to close would be
  // pure noise.
  if (CAPS[profile?.role]?.closeJourney) {
    startJourneyReminder(profile);
    document.querySelector("[data-logout]")?.addEventListener("click", stopJourneyReminder, { once: true });
  }
}

function navHTML(n, active) {
  return `<a class="nav-link-item ${n.id === active ? "active" : ""}" href="${n.href}">
    <i class="fa-solid ${n.icon}"></i> ${n.label}</a>`;
}

async function loadWeatherWidget() {
  const w = document.getElementById("wxWidget");
  if (!w) return;
  try {
    const wx = await fetchWeather();
    w.innerHTML = `<i class="fa-solid ${wx.icon}"></i><span class="mono">${wx.temp}°C</span><span class="d-none d-lg-inline text-faint">${wx.label}</span>`;
  } catch {
    w.innerHTML = `<i class="fa-solid fa-cloud"></i><span class="text-faint">Weather offline</span>`;
  }
}
