/**
 * journey-reminder.js — animated prompt to close open patient journeys.
 *
 * A corner notification, deliberately NOT a modal. This runs on the ECC
 * capture console, where a dimmed overlay in front of an operator coordinating
 * a transfer would be a patient-safety problem rather than a UX annoyance. The
 * paramedic occupies the bottom-right corner, blocks nothing, dismisses itself,
 * and never takes keyboard focus.
 *
 * The character is Vester's own commissioned artwork (assets/paramedic.png),
 * used as the actual image rather than a redrawn approximation — so the face is
 * exactly as drawn, and the placard is positioned clear of it by construction.
 *
 * READ COST
 * The open-journey count comes from getActivePatients(), a `closed == false`
 * query that bills one read per OPEN journey — not per record in the register.
 * It is called at most once every COUNT_MIN_MS, and the result is shared with
 * any caller that already has rows loaded (see poke()). On a 12-hour shift this
 * is tens of reads, not thousands.
 */

import { getActivePatients } from "./data-service.js";

/* ------------------------------------------------------------- settings */

const SETTINGS_KEY = "gset:journeyReminder";

const DEFAULTS = {
  enabled: true,
  intervalMinutes: 45,      // normal reminder cadence
  highThreshold: 15,        // immediate reminder at or above this many open
  onScreenSeconds: 9,       // how long the paramedic stays before walking off
};

export function reminderSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; }
  catch { return { ...DEFAULTS }; }
}

export function setReminderSettings(patch) {
  const next = { ...reminderSettings(), ...patch };
  next.intervalMinutes = Math.max(5, Number(next.intervalMinutes) || DEFAULTS.intervalMinutes);
  next.highThreshold = Math.max(2, Number(next.highThreshold) || DEFAULTS.highThreshold);
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  return next;
}

const COUNT_MIN_MS = 60000;   // never re-query the open count more often than this
const SPRITE = "assets/paramedic.png";

/* ---------------------------------------------------------------- styles */

const CSS = `
.jr-wrap{position:fixed;right:18px;bottom:18px;z-index:1080;width:300px;
  pointer-events:none;transform:translateX(140%);opacity:0;
  transition:transform .95s cubic-bezier(.22,.9,.3,1),opacity .4s ease}
.jr-wrap.jr-in{transform:translateX(0);opacity:1}
.jr-wrap.jr-out{transform:translateX(140%);opacity:0;transition-duration:.7s,.5s}

/* The figure. Sized so the face reads clearly at a glance. */
.jr-figure{position:relative;width:150px;margin-left:auto;display:block}
.jr-figure img{position:relative;z-index:1;width:100%;height:auto;display:block;
  filter:drop-shadow(0 10px 18px rgba(0,0,0,.45))}
.jr-wrap.jr-in .jr-figure{animation:jrWalk .62s ease-in-out 4, jrSettle .5s ease-out 2.5s both}

/* Placard. Anchored to the LOWER half of the figure and extending leftwards,
   so it cannot reach the head. top:46% sits at belt height — the face occupies
   roughly the top quarter of the sprite, so there is a wide safety margin. */
.jr-card{z-index:2;position:absolute;top:46%;left:0;width:190px;padding:11px 13px;
  border-radius:13px;background:#fff;color:#12233d;pointer-events:auto;
  box-shadow:0 12px 28px rgba(0,0,0,.4);transform-origin:right center;
  animation:jrNudge 2.4s ease-in-out 1.2s 3}
.jr-card::after{content:"";position:absolute;right:-7px;top:24px;width:14px;height:14px;
  background:#fff;transform:rotate(45deg)}
.jr-msg{font-size:.82rem;line-height:1.4;font-weight:600;margin:0 0 8px}
.jr-msg b{color:#c2410c}
.jr-actions{display:flex;gap:6px}
.jr-btn{flex:1;border:0;border-radius:8px;padding:6px 8px;font-size:.75rem;font-weight:700;
  cursor:pointer;background:#12233d;color:#fff;transition:background .16s ease}
.jr-btn:hover{background:#1e3a63}
.jr-btn.jr-later{background:#e8edf6;color:#3c4a63}
.jr-btn.jr-later:hover{background:#d7deeb}
.jr-btn:focus-visible{outline:2px solid #ff6b1a;outline-offset:2px}

.jr-wrap.jr-high .jr-card{background:#fff4ed;border:1.5px solid #fb923c}
.jr-wrap.jr-high .jr-card::after{background:#fff4ed;border-right:1.5px solid #fb923c;border-top:1.5px solid #fb923c}

/* Walking bob — a slight rock and vertical lift, no rotation of the head. */
@keyframes jrWalk{
  0%,100%{transform:translateY(0) rotate(0)}
  25%{transform:translateY(-7px) rotate(-1.6deg)}
  75%{transform:translateY(-7px) rotate(1.6deg)}
}
@keyframes jrSettle{from{transform:translateY(-3px)}to{transform:translateY(0)}}
@keyframes jrNudge{
  0%,88%,100%{transform:rotate(0)}
  92%{transform:rotate(-2.4deg)}
  96%{transform:rotate(2.4deg)}
}

@media (max-width:576px){
  .jr-wrap{right:10px;bottom:10px;width:250px}
  .jr-figure{width:120px}
  .jr-card{width:158px;top:44%}
}

/* WCAG 2.1 AA — motion must not be forced on anyone. The notification still
   appears and still reads; it simply stops moving. */
@media (prefers-reduced-motion: reduce){
  .jr-wrap{transition:opacity .3s ease;transform:none}
  .jr-wrap.jr-out{transform:none}
  .jr-wrap.jr-in .jr-figure,.jr-card{animation:none}
}`;

/* ------------------------------------------------------------ the sprite */

let wrap = null, hideTimer = null;

/** First name only, falling back to something neutral rather than "undefined". */
function firstName(profile) {
  const raw = String(profile?.name || profile?.displayName || profile?.email || "").trim();
  if (!raw) return "there";
  const first = raw.split(/[\s.@]+/)[0];
  return first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : "there";
}

function message(name, count, high) {
  return high
    ? `Hey, ${name}! You have <b>${count} open Patient Journeys</b>. Please don't forget to close them. Awe!`
    : `Hey, ${name}! Please don't forget to close your open Patient Journeys. Awe!`;
}

function dismiss() {
  if (!wrap) return;
  clearTimeout(hideTimer); hideTimer = null;
  const el = wrap;
  wrap = null;                       // released immediately: no two paramedics
  el.classList.remove("jr-in");
  el.classList.add("jr-out");
  setTimeout(() => el.remove(), 800);
}

function show(profile, count, high) {
  if (wrap) return;                  // one on screen at a time, always
  const s = reminderSettings();

  wrap = document.createElement("div");
  wrap.className = "jr-wrap" + (high ? " jr-high" : "");
  // A polite live region: announced by screen readers without stealing focus
  // from whatever the operator is typing.
  wrap.setAttribute("role", "status");
  wrap.setAttribute("aria-live", "polite");
  wrap.innerHTML = `
    <div class="jr-figure">
      <div class="jr-card">
        <p class="jr-msg">${message(firstName(profile), count, high)}</p>
        <div class="jr-actions">
          <button type="button" class="jr-btn" data-jr="view">View Open Journeys</button>
          <button type="button" class="jr-btn jr-later" data-jr="close" aria-label="Dismiss reminder">Later</button>
        </div>
      </div>
      <img src="${SPRITE}" alt="" aria-hidden="true">
    </div>`;

  wrap.addEventListener("click", (e) => {
    const act = e.target.closest("[data-jr]")?.dataset.jr;
    if (!act) return;
    if (act === "view") location.href = "journeys.html";
    else dismiss();
  });

  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap?.classList.add("jr-in"));
  hideTimer = setTimeout(dismiss, Math.max(4, s.onScreenSeconds) * 1000);
}

/* ------------------------------------------------------------ the engine */

let timer = null;
let lastCountAt = 0, lastCount = 0;
let highFired = false;          // one immediate alert per crossing, not per tick
let nextNormalAt = 0;
let running = false;
let currentProfile = null;

/**
 * Current number of open journeys, throttled.
 * @param {object[]|null} known rows the caller already has, to avoid a query
 */
async function openCount(known = null) {
  if (Array.isArray(known)) {
    lastCount = known.filter((r) => !r.closed).length;
    lastCountAt = Date.now();
    return lastCount;
  }
  if (Date.now() - lastCountAt < COUNT_MIN_MS) return lastCount;
  try {
    const open = await getActivePatients();
    lastCount = open.length;
    lastCountAt = Date.now();
  } catch {
    // A failed count must never surface as an error to the operator. Keep the
    // last known value and try again on the next tick.
  }
  return lastCount;
}

async function tick(known = null) {
  if (!running || wrap || document.hidden) return;

  const s = reminderSettings();
  const count = await openCount(known);

  // Nothing open: stop reminding, and re-arm the threshold so a later build-up
  // triggers cleanly.
  if (count === 0) { highFired = false; nextNormalAt = Date.now() + s.intervalMinutes * 60000; return; }

  // Immediate high-priority alert, once per crossing of the threshold.
  if (count >= s.highThreshold) {
    if (!highFired) {
      highFired = true;
      nextNormalAt = Date.now() + s.intervalMinutes * 60000;
      show(currentProfile, count, true);
    }
    return;
  }
  highFired = false;              // dropped back below: re-arm

  if (Date.now() >= nextNormalAt) {
    nextNormalAt = Date.now() + s.intervalMinutes * 60000;
    show(currentProfile, count, false);
  }
}

/**
 * Start monitoring. Safe to call on every page — it tears down any previous
 * instance first, so navigating between pages cannot leave two timers running.
 *
 * @param {object} profile signed-in user profile
 */
export function startJourneyReminder(profile) {
  stopJourneyReminder();
  if (!reminderSettings().enabled) return;

  currentProfile = profile;
  running = true;
  nextNormalAt = Date.now() + reminderSettings().intervalMinutes * 60000;

  // 60-second heartbeat. The work is a cheap comparison; the count query behind
  // it is throttled separately by COUNT_MIN_MS.
  timer = setInterval(() => { tick().catch(() => {}); }, 60000);
  document.addEventListener("visibilitychange", onVisible);
}

function onVisible() {
  if (!document.hidden) tick().catch(() => {});
}

/** Tear down. Call on sign-out. */
export function stopJourneyReminder() {
  running = false;
  clearInterval(timer); timer = null;
  document.removeEventListener("visibilitychange", onVisible);
  dismiss();
  highFired = false; lastCountAt = 0; lastCount = 0;
}

/**
 * Feed rows a page has already loaded, so the threshold check costs nothing.
 * journeys.js and dashboard.js both hold the full row set already.
 *
 * @param {object[]} rows
 */
export function poke(rows) {
  if (!running) return;
  tick(rows).catch(() => {});
}

/** Inject styles once, on import. */
(function injectCss() {
  if (document.getElementById("jrStyles")) return;
  const tag = document.createElement("style");
  tag.id = "jrStyles";
  tag.textContent = CSS;
  document.head.appendChild(tag);
})();
