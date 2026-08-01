/**
 * app.js — shared helpers used by every authenticated page.
 * Handles: session/role guard, the live clock & greeting, Gauteng weather,
 * toast notifications, confirmation dialogs, audit logging, the sidebar,
 * and generation of unique sequential incident numbers.
 */

import { auth, db, COL, CAPS, ROLES } from "./firebase-config.js";
import {
  onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, addDoc, collection, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ---------------------------------------------------------------- Session */

/**
 * Guard a page. Resolves with { user, profile } once a signed-in user with a
 * profile is confirmed. Redirects to the login page otherwise. Optionally
 * enforces a capability; if the user lacks it they are sent to the home page.
 */
export function requireAuth(capability) {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        location.replace("index.html");
        return;
      }
      const snap = await getDoc(doc(db, COL.users, user.uid));
      if (!snap.exists()) {
        // Authenticated but no profile record — treat as unauthorised.
        await signOut(auth);
        location.replace("index.html");
        return;
      }
      const profile = snap.data();
      if (profile.disabled) {
        await signOut(auth);
        location.replace("index.html?disabled=1");
        return;
      }
      if (capability && !(CAPS[profile.role] || {})[capability]) {
        toast("info", "No access", "Your role can’t open that page.");
        setTimeout(() => location.replace("home.html"), 900);
        return;
      }
      window.__gset = { user, profile };
      resolve({ user, profile });
    });
  });
}

export function can(profile, capability) {
  return !!(CAPS[profile.role] || {})[capability];
}

export async function logout() {
  try { await writeAudit("Logout", {}); } catch (_) {}
  await signOut(auth);
  location.replace("index.html");
}

/* ------------------------------------------------------------------ Audit */

/**
 * Append an immutable audit entry. Fails silently so logging never blocks the
 * primary user action.
 */
export async function writeAudit(action, details = {}) {
  try {
    const p = window.__gset?.profile;
    const u = window.__gset?.user;
    await addDoc(collection(db, COL.audit), {
      action,
      details,
      actorUid: u?.uid || "system",
      actorName: p?.name || "System",
      actorEmail: p?.email || u?.email || "",
      actorRole: p?.role || "",
      at: serverTimestamp(),
    });
  } catch (e) {
    console.warn("audit failed", e);
  }
}

/* -------------------------------------------------------- Incident numbers */

/**
 * Atomically produce the next sequential, date-based, never-duplicated
 * incident number, e.g. GS-20260729-000001. A per-day counter document is
 * incremented inside a transaction so concurrent captures can’t collide.
 */
export async function nextIncidentNumber(date = new Date()) {
  const ymd = fmtYMD(date);
  const ref = doc(db, COL.counters, `incident-${ymd}`);
  try {
    // maxAttempts capped (default is 5). Retrying is useful for genuine write
    // contention, but pointless — and harmful — when the backend is rate-limiting
    // us, so we keep the burst small and then surface a clear error.
    const seq = await runTransaction(db, async (tx) => {
      const s = await tx.get(ref);
      const current = s.exists() ? s.data().value : 0;
      const next = current + 1;
      tx.set(ref, { value: next, ymd }, { merge: true });
      return next;
    }, { maxAttempts: 3 });
    return `GS-${ymd}-${String(seq).padStart(6, "0")}`;
  } catch (err) {
    if (err && err.code === "resource-exhausted") {
      const e = new Error("Firestore daily free-tier quota reached. Incident numbers will resume after the quota resets (00:00 US Pacific), or after upgrading the project to the Blaze plan.");
      e.code = "resource-exhausted";
      throw e;
    }
    throw err;
  }
}

/* ------------------------------------------------------------- Date & time */

export function fmtYMD(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}
export function greeting(d = new Date()) {
  const h = d.getHours();
  if (h < 12) return "Good Morning";
  if (h < 17) return "Good Afternoon";
  return "Good Evening";
}
export function fmtDateLong(d = new Date()) {
  return d.toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
export function fmtTime(d = new Date()) {
  return d.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
export function fmtStamp(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString("en-ZA", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Start a ticking clock, writing into the given element ids. */
export function startClock(timeId = "clock", dateId = "clockDate") {
  const tick = () => {
    const now = new Date();
    const t = document.getElementById(timeId);
    const dd = document.getElementById(dateId);
    if (t) t.textContent = fmtTime(now);
    if (dd) dd.textContent = fmtDateLong(now);
  };
  tick();
  setInterval(tick, 1000);
}

/* ---------------------------------------------------------------- Weather */

/**
 * Fetch current weather for a Gauteng location from Open-Meteo (no API key).
 * Defaults to Johannesburg. Returns { temp, code, label, icon }.
 */
export async function fetchWeather(lat = -26.2041, lng = 28.0473) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&current=temperature_2m,weather_code&timezone=Africa%2FJohannesburg`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("weather unavailable");
  const j = await res.json();
  const code = j.current.weather_code;
  const meta = WMO[code] || { label: "—", icon: "fa-cloud" };
  return { temp: Math.round(j.current.temperature_2m), code, label: meta.label, icon: meta.icon };
}

// Minimal WMO weather-code → label/icon map.
const WMO = {
  0: { label: "Clear", icon: "fa-sun" },
  1: { label: "Mostly clear", icon: "fa-cloud-sun" },
  2: { label: "Partly cloudy", icon: "fa-cloud-sun" },
  3: { label: "Overcast", icon: "fa-cloud" },
  45: { label: "Fog", icon: "fa-smog" }, 48: { label: "Rime fog", icon: "fa-smog" },
  51: { label: "Light drizzle", icon: "fa-cloud-rain" }, 53: { label: "Drizzle", icon: "fa-cloud-rain" },
  55: { label: "Dense drizzle", icon: "fa-cloud-rain" },
  61: { label: "Light rain", icon: "fa-cloud-showers-heavy" }, 63: { label: "Rain", icon: "fa-cloud-showers-heavy" },
  65: { label: "Heavy rain", icon: "fa-cloud-showers-heavy" },
  71: { label: "Light snow", icon: "fa-snowflake" }, 80: { label: "Rain showers", icon: "fa-cloud-showers-heavy" },
  81: { label: "Showers", icon: "fa-cloud-showers-heavy" }, 82: { label: "Violent showers", icon: "fa-cloud-showers-heavy" },
  95: { label: "Thunderstorm", icon: "fa-cloud-bolt" }, 96: { label: "Storm + hail", icon: "fa-cloud-bolt" },
  99: { label: "Severe storm", icon: "fa-cloud-bolt" },
};

/* ------------------------------------------------------------------ Toast */

export function toast(kind, title, detail = "") {
  let stack = document.querySelector(".toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "toast-stack";
    document.body.appendChild(stack);
  }
  const icon = kind === "ok" ? "fa-circle-check" : kind === "err" ? "fa-circle-exclamation" : "fa-circle-info";
  const el = document.createElement("div");
  el.className = `toast-msg ${kind}`;
  el.innerHTML = `<i class="fa-solid ${icon} ti"></i><div><div class="tt">${esc(title)}</div>${detail ? `<div class="td">${esc(detail)}</div>` : ""}</div>`;
  stack.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transform = "translateY(10px)"; setTimeout(() => el.remove(), 300); }, 4200);
}

/* ------------------------------------------------------- Confirm dialog */

/**
 * Promise-based confirmation modal. Resolves true/false.
 */
export function confirmDialog({ title = "Are you sure?", body = "", confirmText = "Confirm", danger = false } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;inset:0;z-index:1090;display:grid;place-items:center;background:rgba(3,7,18,.6);backdrop-filter:blur(4px)";
    wrap.innerHTML = `
      <div class="glass glass-strong panel" style="max-width:420px;width:92%;">
        <h3 style="margin:0 0 8px">${esc(title)}</h3>
        <p class="text-dim" style="font-size:.92rem">${esc(body)}</p>
        <div class="d-flex gap-2 justify-content-end mt-3">
          <button class="btn btn-ghost" data-x="0">Cancel</button>
          <button class="btn ${danger ? "btn-ems" : "btn-ems"}" data-x="1">${esc(confirmText)}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) { wrap.remove(); resolve(false); }
      const x = e.target.closest("[data-x]");
      if (x) { wrap.remove(); resolve(x.dataset.x === "1"); }
    });
  });
}

/* ------------------------------------------------------------- Utilities */

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function initials(name = "") {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((n) => n[0]?.toUpperCase()).join("") || "U";
}

/** Animate a number counting up into an element (KPI counters). */
export function countUp(el, target, { duration = 900, decimals = 0, suffix = "" } = {}) {
  if (!el) return;
  const start = performance.now();
  const from = 0;
  const step = (t) => {
    const p = Math.min(1, (t - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    const val = from + (target - from) * eased;
    el.textContent = val.toFixed(decimals) + suffix;
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Wire up the mobile sidebar toggle + backdrop. */
export function initSidebar() {
  const sb = document.querySelector(".sidebar");
  const toggle = document.querySelector(".mobile-toggle");
  const backdrop = document.querySelector(".sidebar-backdrop");
  if (!sb || !toggle) return;
  const close = () => { sb.classList.remove("open"); backdrop?.classList.remove("show"); };
  toggle.addEventListener("click", () => { sb.classList.toggle("open"); backdrop?.classList.toggle("show"); });
  backdrop?.addEventListener("click", close);
  sb.querySelectorAll(".nav-link-item").forEach((a) => a.addEventListener("click", close));
}

/** Populate the shared topbar user chip + wire logout buttons. */
export function paintUserChip(profile) {
  const av = document.getElementById("avatar");
  const nm = document.getElementById("chipName");
  const rl = document.getElementById("chipRole");
  if (av) av.textContent = initials(profile.name);
  if (nm) nm.textContent = profile.name;
  if (rl) rl.textContent = profile.role;
  document.querySelectorAll("[data-logout]").forEach((b) => b.addEventListener("click", logout));
}

/** Hide any element carrying data-cap="X" if the profile lacks capability X. */
export function applyCapVisibility(profile) {
  document.querySelectorAll("[data-cap]").forEach((el) => {
    if (!can(profile, el.dataset.cap)) el.remove();
  });
}
