/**
 * assistant-widget.js — embeddable AI assistant for the public dashboard.
 * Self-contained: reads the same public aggregate snapshot the dashboard uses,
 * talks to the Cloudflare/Gemini proxy (which holds the key + guardrails), and
 * renders into the #ga-* elements. Loaded as a separate module so it never
 * touches public-dashboard.js. Aggregate-only; no patient data is ever sent.
 */

import { db } from "./firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ======= EDIT THIS if your Worker URL ever changes =======
const PROXY_URL = "https://gset-insights.gset.workers.dev";
// =========================================================

let DATA = {
  updatedAt: null, currentShift: "—",
  totals: { allTime: 0, last30Days: 0, today: 0, active: 0, closed: 0 },
  momChangePct: 0, avgTransferMinutes: 0,
  byDistrict: [], topReferring: [], topReceiving: [], topStations: [], routes: [], dailyTrend: [],
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// ---- read + map the real dashboardMetrics/public snapshot -------------------
function mapSnapshot(s) {
  const all = (s.scopes && s.scopes.all) || s || {};
  const d30 = (s.scopes && s.scopes.d30) || all;
  const today = (s.scopes && s.scopes.today) || {};
  const pick = (a) => (Array.isArray(a) ? a : []).slice(0, 5).map((x) => ({ name: x.name, count: x.count }));
  return {
    updatedAt: s.updatedAt || null,
    currentShift: (s.shiftMeta && s.shiftMeta.currentLabel) || "—",
    totals: {
      allTime: all.totals?.total ?? 0, last30Days: d30.totals?.total ?? 0, today: today.totals?.total ?? 0,
      active: all.totals?.active ?? 0, closed: all.totals?.closed ?? 0,
    },
    momChangePct: s.momChangePct ?? 0,
    avgTransferMinutes: all.averages?.transferMinutes ?? 0,
    byDistrict: (d30.byDistrict?.length ? d30.byDistrict : all.byDistrict || []).map((x) => ({ name: x.name, count: x.count })),
    topReferring: pick(d30.topReferring?.length ? d30.topReferring : all.topReferring),
    topReceiving: pick(d30.topReceiving?.length ? d30.topReceiving : all.topReceiving),
    topStations: pick(d30.topStations?.length ? d30.topStations : all.topStations),
    routes: (d30.routes?.length ? d30.routes : all.routes || []).slice(0, 6),
    dailyTrend: (s.daily || []).slice(-7).map((d) => ({ day: d.label || d.key, count: d.referrals ?? d.count ?? 0 })),
  };
}

async function loadData() {
  try {
    const snap = await getDoc(doc(db, "dashboardMetrics", "public"));
    if (snap.exists()) DATA = mapSnapshot(snap.data());
  } catch (_) { /* leave defaults; assistant still loads */ }
}

// ---- charts from mapped data -----------------------------------------------
const barsFrom = (rows) => {
  if (!rows.length) return "";
  const m = Math.max(...rows.map((r) => r.n)) || 1;
  return `<div class="ga-bars">${rows.map((r) => `<div class="ga-bar-row"><span>${esc(r.label)}</span><span class="ga-track"><span class="ga-fill" style="width:${Math.round(r.n / m * 100)}%"></span></span><span class="ga-val">${r.n}</span></div>`).join("")}</div>`;
};
function chartHtml(k) {
  if (k === "districts") return barsFrom(DATA.byDistrict.map((d) => ({ label: d.name, n: d.count })));
  if (k === "facilities") return barsFrom(DATA.topReferring.map((d) => ({ label: d.name, n: d.count })));
  if (k === "trend") {
    const t = DATA.dailyTrend.map((d) => d.count);
    if (!t.length) return "";
    const m = Math.max(...t) || 1;
    return `<div class="ga-spark">${t.map((v) => `<div style="height:${Math.round(v / m * 100)}%" title="${v}"></div>`).join("")}</div>`;
  }
  return "";
}

// ---- proxy call ------------------------------------------------------------
const history = [];
async function askLLM() {
  const res = await fetch(PROXY_URL, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: history, metrics: DATA }),
  });
  if (!res.ok) { if (res.status === 429) throw new Error("busy"); throw new Error("proxy " + res.status); }
  return (await res.json()).answer || "";
}

// ---- chat UI ---------------------------------------------------------------
let busy = false, speakOn = false;
function add(role, html) {
  const chat = $("ga-chat");
  const d = document.createElement("div");
  d.className = "ga-msg ga-" + role;
  d.innerHTML = `<div class="ga-who">${role === "user" ? "You" : "G"}</div><div class="ga-bubble">${html}</div>`;
  chat.appendChild(d); chat.scrollTop = chat.scrollHeight;
  return d;
}
async function ask(text) {
  if (!text.trim() || busy) return;
  busy = true; $("ga-send").disabled = true;
  add("user", esc(text)); $("ga-q").value = ""; history.push({ role: "user", content: text });
  const t = add("bot", '<span class="ga-dots"><span></span><span></span><span></span></span>');
  try {
    const raw = await askLLM(); history.push({ role: "assistant", content: raw });
    let chart = "none"; const m = raw.match(/\[chart:(districts|facilities|trend)\]/i); if (m) chart = m[1].toLowerCase();
    const clean = raw.replace(/\[chart:[a-z]+\]/ig, "").trim();
    t.querySelector(".ga-bubble").innerHTML = esc(clean).replace(/\n/g, "<br>") + (chart !== "none" ? chartHtml(chart) : "");
    if (speakOn) say(clean);
  } catch (err) {
    t.querySelector(".ga-bubble").innerHTML = err.message === "busy"
      ? "The assistant is busy (free-tier rate limit) — please try again in a moment."
      : "⚠️ Couldn’t reach the assistant just now — please try again.";
  } finally { busy = false; $("ga-send").disabled = false; }
}

// ---- voice out -------------------------------------------------------------
const synth = window.speechSynthesis;
let voices = [];
function loadVoices() {
  voices = (synth ? synth.getVoices() : []).filter((v) => /en/i.test(v.lang));
  const sel = $("ga-voice");
  if (!voices.length) { sel.innerHTML = "<option>Default</option>"; return; }
  sel.innerHTML = voices.map((v, i) => `<option value="${i}">${v.name} (${v.lang})</option>`).join("");
  const za = voices.findIndex((v) => /en-ZA/i.test(v.lang)), gb = voices.findIndex((v) => /en-GB/i.test(v.lang));
  sel.value = za >= 0 ? za : gb >= 0 ? gb : 0;
}
function say(t) {
  if (!synth) return; synth.cancel();
  const u = new SpeechSynthesisUtterance(t.replace(/[*_#>`]/g, ""));
  const v = voices[+$("ga-voice").value]; if (v) u.voice = v;
  u.rate = parseFloat($("ga-rate").value) || 1; synth.speak(u);
}

// ---- boot ------------------------------------------------------------------
(async function init() {
  if (!$("ga-panel")) return; // panel markup not present
  add("bot", `Hi! Ask me about the operational data in plain language — I keep track of the conversation and only ever see <span class="ga-stat">aggregate</span> figures, never patient details.`);

  ["How did we do this month?", "Which district needs attention?", "Show the 7-day trend", "Top referring facilities", "Where should we focus?"]
    .forEach((c) => { const b = document.createElement("div"); b.className = "ga-chip"; b.textContent = c; b.onclick = () => ask(c); $("ga-chips").appendChild(b); });

  $("ga-send").onclick = () => ask($("ga-q").value);
  $("ga-q").addEventListener("keydown", (e) => { if (e.key === "Enter") ask($("ga-q").value); });
  $("ga-gear").onclick = () => { const s = $("ga-settings"); s.style.display = s.style.display === "flex" ? "none" : "flex"; };
  $("ga-test").onclick = () => say("This is the G-Set Insights assistant.");
  $("ga-speak").onclick = () => { speakOn = !speakOn; $("ga-speak").classList.toggle("on", speakOn); if (speakOn) say("Voice answers on."); else synth && synth.cancel(); };

  if (synth) { synth.onvoiceschanged = loadVoices; loadVoices(); }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = $("ga-mic");
  if (!SR) { mic.disabled = true; mic.title = "Voice input not supported in this browser"; }
  else {
    const rec = new SR(); rec.lang = "en-ZA"; rec.interimResults = false; let listening = false;
    mic.onclick = () => { try { listening ? rec.stop() : rec.start(); } catch (e) { mic.disabled = true; } };
    rec.onstart = () => { listening = true; mic.classList.add("live"); };
    rec.onend = () => { listening = false; mic.classList.remove("live"); };
    rec.onerror = (e) => { listening = false; mic.classList.remove("live"); if (e.error === "not-allowed") { mic.disabled = true; mic.title = "Allow microphone access to speak"; } };
    rec.onresult = (e) => { const s = e.results[0][0].transcript; $("ga-q").value = s; ask(s); };
  }

  await loadData();
})();
