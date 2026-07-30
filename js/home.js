/**
 * home.js — welcome screen. Shows the time-aware greeting, live date/time,
 * live Gauteng weather and a set of role-filtered 3D navigation tiles.
 */

import { requireAuth, can, greeting, fmtDateLong, fmtTime, fetchWeather } from "./app.js";
import { renderShell } from "./layout.js";

const TILES = [
  { href: "capture.html", icon: "fa-notes-medical", title: "Capture Patient", desc: "Open a new transfer journey", cap: "capturePatient" },
  { href: "journeys.html", icon: "fa-route", title: "Active Journeys", desc: "Close or continue transfers", cap: "viewDashboard" },
  { href: "dashboard.html", icon: "fa-chart-line", title: "Dashboard", desc: "Live KPIs and analytics", cap: "viewDashboard" },
  { href: "heatmaps.html", icon: "fa-map-location-dot", title: "Heatmaps", desc: "Pickup & receiving density", cap: "viewHeatmaps" },
  { href: "reports.html", icon: "fa-file-export", title: "Reports", desc: "Export Excel, PDF & CSV", cap: "exportReports" },
  { href: "admin.html", icon: "fa-user-shield", title: "Users & Setup", desc: "Manage accounts and data", cap: "adminSetup" },
];

(async () => {
  const { profile } = await requireAuth();
  await renderShell("home", profile);

  const content = document.getElementById("pageContent");
  content.appendChild(document.getElementById("pageTpl").content.cloneNode(true));

  document.getElementById("greeting").textContent = greeting();
  document.getElementById("welcomeName").textContent = `Welcome, ${profile.name}`;
  document.getElementById("welcomeRole").innerHTML =
    `<i class="fa-solid fa-id-badge me-1 text-ems"></i>${profile.role}` +
    (profile.district ? ` · ${profile.district}` : "");

  // Live clock in the hero.
  const tickHero = () => {
    const now = new Date();
    document.getElementById("heroDate").textContent = fmtDateLong(now);
    document.getElementById("heroTime").textContent = fmtTime(now);
  };
  tickHero();
  setInterval(tickHero, 1000);

  // Hero weather.
  fetchWeather()
    .then((wx) => {
      document.getElementById("heroWx").innerHTML =
        `<i class="fa-solid ${wx.icon} me-1 text-ems"></i>${wx.temp}°C · ${wx.label}`;
    })
    .catch(() => { document.getElementById("heroWx").innerHTML = `<span class="text-faint">unavailable</span>`; });

  // Role-filtered 3D tiles.
  const tilesEl = document.getElementById("tiles");
  tilesEl.innerHTML = TILES.filter((t) => can(profile, t.cap)).map((t) => `
    <div class="col-sm-6 col-lg-4">
      <a class="nav-tile h-100" href="${t.href}">
        <div class="tile-icon"><i class="fa-solid ${t.icon}"></i></div>
        <h3>${t.title}</h3>
        <p>${t.desc}</p>
      </a>
    </div>`).join("");

  // Optional GSAP entrance (loaded via CDN in the page head fallback below).
  try {
    const { gsap } = await import("https://cdn.jsdelivr.net/npm/gsap@3.12.5/+esm");
    gsap.from(".nav-tile", { y: 24, opacity: 0, duration: .5, stagger: .06, ease: "power2.out" });
    gsap.from("#welcomeName", { y: 14, opacity: 0, duration: .5, ease: "power2.out" });
  } catch (_) { /* animation is progressive enhancement only */ }
})();
