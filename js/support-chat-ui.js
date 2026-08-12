/**
 * support-chat-ui.js — the docked panel for the support channel.
 *
 * ECC personnel see a single thread to the administrator. The administrator
 * sees an inbox of active threads and can open any one of them.
 *
 * The panel is closed by default and holds no listener until it is opened, so
 * a user who never uses it costs nothing at all.
 */

import { sendMessage, subscribeThread, subscribeThreads, purgeExpired, isAdmin, chatConfig, sanitise } from "./support-chat.js";
import { toast, esc } from "./app.js";

const CSS = `
.sc-fab{position:fixed;right:18px;bottom:18px;z-index:1050;width:52px;height:52px;border-radius:50%;
  border:0;cursor:pointer;background:var(--ems-500,#ff6b1a);color:#fff;font-size:1.15rem;
  box-shadow:0 10px 26px rgba(0,0,0,.42);transition:transform .18s ease}
.sc-fab:hover{transform:scale(1.07)}
.sc-fab .sc-dot{position:absolute;top:2px;right:2px;width:13px;height:13px;border-radius:50%;
  background:#38e1ff;border:2px solid var(--navy-900,#050a1f);display:none}
.sc-fab.sc-alert .sc-dot{display:block}

.sc-panel{position:fixed;right:18px;bottom:80px;z-index:1051;width:340px;max-width:calc(100vw - 36px);
  height:460px;max-height:calc(100vh - 120px);display:none;flex-direction:column;border-radius:16px;
  overflow:hidden;background:var(--navy-800,#0a1230);border:1px solid rgba(120,160,255,.18);
  box-shadow:0 22px 60px rgba(0,0,0,.5)}
.sc-panel.sc-open{display:flex}
.sc-head{padding:11px 14px;border-bottom:1px solid rgba(120,160,255,.14);display:flex;
  align-items:center;gap:8px}
.sc-head h3{font-size:.92rem;margin:0;font-weight:700;flex:1}
.sc-head button{border:0;background:transparent;color:var(--text-dim,#9db0d6);cursor:pointer;font-size:.95rem}
.sc-note{padding:7px 14px;font-size:.7rem;line-height:1.35;color:#fbbf24;
  background:rgba(251,191,36,.09);border-bottom:1px solid rgba(251,191,36,.18)}
.sc-body{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.sc-msg{max-width:82%;padding:8px 11px;border-radius:12px;font-size:.83rem;line-height:1.4;word-break:break-word}
.sc-mine{align-self:flex-end;background:var(--ems-500,#ff6b1a);color:#fff;border-bottom-right-radius:4px}
.sc-theirs{align-self:flex-start;background:rgba(120,160,255,.12);color:var(--text,#eaf0ff);border-bottom-left-radius:4px}
.sc-meta{display:block;font-size:.63rem;opacity:.72;margin-top:3px}
.sc-empty{margin:auto;text-align:center;font-size:.8rem;color:var(--text-dim,#9db0d6);padding:0 12px}
.sc-foot{padding:9px;border-top:1px solid rgba(120,160,255,.14);display:flex;gap:6px}
.sc-foot textarea{flex:1;resize:none;height:38px;border-radius:9px;padding:8px 10px;font-size:.82rem;
  background:rgba(120,160,255,.08);border:1px solid rgba(120,160,255,.2);color:var(--text,#eaf0ff)}
.sc-foot textarea:focus{outline:2px solid var(--cyan-400,#38e1ff);outline-offset:-1px}
.sc-foot button{border:0;border-radius:9px;padding:0 13px;background:var(--ems-500,#ff6b1a);color:#fff;
  font-weight:700;cursor:pointer;font-size:.8rem}
.sc-foot button:disabled{opacity:.5;cursor:not-allowed}
.sc-thread{width:100%;text-align:left;border:0;border-radius:10px;padding:9px 11px;margin-bottom:6px;
  background:rgba(120,160,255,.09);color:var(--text,#eaf0ff);cursor:pointer;font-size:.82rem}
.sc-thread:hover{background:rgba(120,160,255,.17)}
.sc-thread span{display:block;font-size:.68rem;color:var(--text-dim,#9db0d6);margin-top:2px}
@media (max-width:576px){.sc-panel{right:8px;bottom:74px;width:calc(100vw - 16px);height:70vh}}
@media (prefers-reduced-motion: reduce){.sc-fab{transition:none}}`;

let unsub = null, openThread = null, myProfile = null, panel = null, fab = null;

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
}

function timeOf(m) {
  const d = m?.createdAt?.toDate ? m.createdAt.toDate() : null;
  return d ? d.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" }) : "sending…";
}

function renderMessages(rows) {
  const body = panel.querySelector(".sc-body");
  const myUid = myProfile?.uid || window.__gset?.user?.uid;
  if (!rows.length) {
    body.innerHTML = `<div class="sc-empty">No messages. Anything sent here clears automatically after ${chatConfig.TTL_MINUTES / 60} hours.</div>`;
    return;
  }
  body.innerHTML = rows.map((m) => {
    const mine = m.fromUid === myUid;
    return `<div class="sc-msg ${mine ? "sc-mine" : "sc-theirs"}">${esc(m.body)}
      <span class="sc-meta">${mine ? "You" : esc(m.fromName)} · ${timeOf(m)}</span></div>`;
  }).join("");
  body.scrollTop = body.scrollHeight;
}

function openConversation(uid, title) {
  if (unsub) { unsub(); unsub = null; }
  openThread = uid;
  panel.querySelector(".sc-head h3").textContent = title;
  panel.querySelector('[data-sc="back"]').style.display = isAdmin(myProfile) ? "" : "none";
  panel.querySelector(".sc-foot").style.display = "flex";
  purgeExpired(uid);
  unsub = subscribeThread(uid, renderMessages, () => {
    panel.querySelector(".sc-body").innerHTML =
      `<div class="sc-empty">Could not load the conversation. Check your connection, then reopen.</div>`;
  });
}

function openInbox() {
  if (unsub) { unsub(); unsub = null; }
  openThread = null;
  panel.querySelector(".sc-head h3").textContent = "Support requests";
  panel.querySelector('[data-sc="back"]').style.display = "none";
  panel.querySelector(".sc-foot").style.display = "none";
  unsub = subscribeThreads((threads) => {
    const body = panel.querySelector(".sc-body");
    if (!threads.length) { body.innerHTML = `<div class="sc-empty">No active requests.</div>`; return; }
    body.innerHTML = "";
    threads.forEach((t) => {
      const when = t.lastAt?.toDate
        ? t.lastAt.toDate().toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })
        : "";
      const b = el("button", "sc-thread",
        `${esc(t.lastFrom || "Unknown")}<span>${esc(t.lastRole || "")} · ${when}</span>`);
      b.addEventListener("click", () => openConversation(t.id, t.lastFrom || "Conversation"));
      body.appendChild(b);
    });
  }, () => {});
}

async function send() {
  const box = panel.querySelector("textarea");
  const btn = panel.querySelector(".sc-foot button");
  const text = box.value;

  const check = sanitise(text);
  if (!check.ok) { toast("err", "Not sent", check.reason); return; }

  btn.disabled = true;
  try {
    await sendMessage(openThread, myProfile, text);
    box.value = "";
  } catch (err) {
    toast("err", "Not sent", err?.message || "Try again.");
  } finally {
    btn.disabled = false;
    box.focus();
  }
}

/**
 * Mount the chat launcher.
 * @param {object} profile signed-in user profile
 */
export function mountSupportChat(profile) {
  if (document.getElementById("scFab")) return;
  myProfile = profile;

  const style = el("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  fab = el("button", "sc-fab", `<i class="fa-solid fa-comment-dots"></i><span class="sc-dot"></span>`);
  fab.id = "scFab";
  fab.type = "button";
  fab.title = "Support chat";
  fab.setAttribute("aria-label", "Open support chat");

  panel = el("div", "sc-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Support chat");
  panel.innerHTML = `
    <div class="sc-head">
      <h3>Support</h3>
      <button type="button" data-sc="back" title="Back to requests" style="display:none"><i class="fa-solid fa-arrow-left"></i></button>
      <button type="button" data-sc="close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="sc-note">
      Cleared automatically after ${chatConfig.TTL_MINUTES / 60} hours. Do not send patient names,
      ID numbers or incident numbers.
    </div>
    <div class="sc-body"></div>
    <div class="sc-foot">
      <textarea placeholder="Describe the problem…" maxlength="${chatConfig.MAX_LENGTH}" aria-label="Message"></textarea>
      <button type="button">Send</button>
    </div>`;

  document.body.append(fab, panel);

  const admin = isAdmin(profile);

  fab.addEventListener("click", () => {
    const open = panel.classList.toggle("sc-open");
    fab.classList.remove("sc-alert");
    if (!open) { if (unsub) { unsub(); unsub = null; } return; }
    // Reclaim the corner if the journey reminder happens to be standing there.
    document.querySelector(".jr-wrap")?.remove();
    if (admin) openInbox();
    else openConversation(profile?.uid || window.__gset?.user?.uid, "System administrator");
  });

  panel.addEventListener("click", (e) => {
    const act = e.target.closest("[data-sc]")?.dataset.sc;
    if (act === "close") { panel.classList.remove("sc-open"); if (unsub) { unsub(); unsub = null; } }
    if (act === "back" && admin) openInbox();
  });

  panel.querySelector(".sc-foot button").addEventListener("click", send);
  panel.querySelector("textarea").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
}

/** Tear down on sign-out. */
export function unmountSupportChat() {
  if (unsub) { unsub(); unsub = null; }
  document.getElementById("scFab")?.remove();
  panel?.remove();
  panel = null; fab = null; openThread = null; myProfile = null;
}
