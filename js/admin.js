/**
 * admin.js — Superuser control centre.
 *
 * User provisioning note: the Firebase Admin SDK needs a server (Blaze plan),
 * which this free-tier build deliberately avoids. Instead we create accounts
 * with a *secondary* Firebase app instance so creating a user never disturbs
 * the Superuser's own session. "Disable" flips a Firestore flag that the auth
 * guard enforces on every page load; a full Auth-level disable is done from the
 * Firebase console (documented in the README).
 */

import { firebaseConfig, db, auth, COL, ROLE_LIST, ROLES } from "./firebase-config.js";
import { requireAuth, esc, toast, writeAudit, fmtStamp, confirmDialog } from "./app.js";
import { renderShell } from "./layout.js";
import { getDistricts, getFacilities, getVehicles, invalidate } from "./data-service.js";
import { seedAll, collectionCount } from "./seed.js";

import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, getDocs, doc, setDoc, updateDoc, addDoc, query, orderBy, limit, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let usersTable, facTable, vehTable, auditTable, districts = [];

(async () => {
  const { profile } = await requireAuth("adminSetup");
  await renderShell("admin", profile);
  document.getElementById("pageContent").appendChild(document.getElementById("pageTpl").content.cloneNode(true));

  districts = await getDistricts();

  // Tabs.
  document.querySelectorAll("#adminTabs [data-tab]").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.tab)));
  if (location.hash === "#audit") switchTab("audit");

  fillRoleAndDistricts();
  wireUsers();
  wireFacilities();
  wireVehicles();
  wireSetup();

  loadUsers();
})();

function switchTab(tab) {
  document.querySelectorAll("#adminTabs .nav-link").forEach((x) => x.classList.toggle("active", x.dataset.tab === tab));
  document.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== tab));
  if (tab === "facilities") loadFacilities();
  if (tab === "vehicles") loadVehicles();
  if (tab === "audit") loadAudit();
  if (tab === "setup") loadCounts();
}

function fillRoleAndDistricts() {
  const roleSel = document.getElementById("nuRole");
  ROLE_LIST.forEach((r) => { const o = document.createElement("option"); o.textContent = r; roleSel.appendChild(o); });
  const dNames = districts.map((d) => d.name).sort();
  ["nuDistrict", "afDistrict", "avDistrict"].forEach((id) => {
    const sel = document.getElementById(id);
    dNames.forEach((n) => { const o = document.createElement("option"); o.textContent = n; sel.appendChild(o); });
  });
}

/* ------------------------------------------------------------------ Users */
function wireUsers() {
  document.getElementById("genPass").addEventListener("click", () => {
    document.getElementById("nuPass").value = Math.random().toString(36).slice(2, 8) + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
  });
  document.getElementById("createUserForm").addEventListener("submit", createUser);
  document.querySelector('[data-pane="users"]').addEventListener("click", onUserAction);
  document.getElementById("confirmReset").addEventListener("click", sendReset);
}

async function loadUsers() {
  const snap = await getDocs(collection(db, COL.users));
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (usersTable) usersTable.destroy();
  const tbody = document.querySelector("#usersTable tbody");
  tbody.innerHTML = rows.map((u) => `
    <tr>
      <td>${esc(u.name)}</td>
      <td class="mono" style="font-size:.85rem">${esc(u.email)}</td>
      <td><span class="role-badge">${esc(u.role)}</span></td>
      <td>${esc(u.district || "—")}</td>
      <td>${u.disabled ? '<span class="status-pill status-closed">Disabled</span>' : '<span class="status-pill status-active">Active</span>'}</td>
      <td class="text-nowrap">
        <button class="btn btn-ghost btn-sm" data-reset="${esc(u.email)}" title="Reset password"><i class="fa-solid fa-key"></i></button>
        ${u.role === ROLES.SUPERUSER ? "" : `<button class="btn btn-ghost btn-sm" data-toggle="${u.id}" data-disabled="${!!u.disabled}" title="${u.disabled ? "Enable" : "Disable"}"><i class="fa-solid ${u.disabled ? "fa-user-check" : "fa-user-slash"}"></i></button>`}
      </td>
    </tr>`).join("");
  usersTable = $("#usersTable").DataTable({ pageLength: 10, order: [[0, "asc"]], language: { search: "", searchPlaceholder: "Filter users…" } });
}

async function createUser(e) {
  e.preventDefault();
  const name = document.getElementById("nuName").value.trim();
  const email = document.getElementById("nuEmail").value.trim();
  const role = document.getElementById("nuRole").value;
  const district = document.getElementById("nuDistrict").value;
  const pass = document.getElementById("nuPass").value;
  if (!name || !email || !role || pass.length < 6) { toast("err", "Missing details", "Fill every field; password ≥ 6 chars."); return; }

  const btn = document.getElementById("createUserBtn");
  btn.disabled = true; btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Creating…`;

  // Secondary app so the Superuser's session is untouched.
  const secondary = initializeApp(firebaseConfig, "provisioner-" + Date.now());
  try {
    const secAuth = getAuth(secondary);
    const cred = await createUserWithEmailAndPassword(secAuth, email, pass);
    await setDoc(doc(db, COL.users, cred.user.uid), {
      name, email, role, district: district || "", disabled: false,
      createdAt: serverTimestamp(),
    });
    await signOut(secAuth);
    await writeAudit("User Created", { email, role });
    toast("ok", "Account created", `${name} can now sign in.`);
    document.getElementById("createUserForm").reset();
    loadUsers();
  } catch (err) {
    const msg = err.code === "auth/email-already-in-use" ? "That email already has an account."
      : err.code === "auth/weak-password" ? "Password is too weak."
      : err.code === "auth/invalid-email" ? "That email is invalid." : "Couldn’t create the account.";
    toast("err", "Failed", msg);
  } finally {
    await deleteApp(secondary).catch(() => {});
    btn.disabled = false; btn.innerHTML = `<i class="fa-solid fa-user-plus me-1"></i>Create Account`;
  }
}

let pendingResetEmail = null;
function onUserAction(e) {
  const reset = e.target.closest("[data-reset]");
  const toggle = e.target.closest("[data-toggle]");
  if (reset) {
    pendingResetEmail = reset.dataset.reset;
    document.getElementById("resetEmail").textContent = pendingResetEmail;
    bootstrap.Modal.getOrCreateInstance(document.getElementById("resetModal")).show();
  } else if (toggle) {
    toggleUser(toggle.dataset.toggle, toggle.dataset.disabled === "true");
  }
}

async function sendReset() {
  if (!pendingResetEmail) return;
  try {
    await sendPasswordResetEmail(auth, pendingResetEmail);
    await writeAudit("Password Reset", { email: pendingResetEmail });
    toast("ok", "Reset link sent", pendingResetEmail);
  } catch { toast("err", "Couldn’t send", "Try again shortly."); }
  bootstrap.Modal.getInstance(document.getElementById("resetModal")).hide();
  pendingResetEmail = null;
}

async function toggleUser(uid, currentlyDisabled) {
  const ok = await confirmDialog({
    title: currentlyDisabled ? "Enable this account?" : "Disable this account?",
    body: currentlyDisabled ? "The user will be able to sign in again." : "The user will be signed out and blocked from signing in.",
    confirmText: currentlyDisabled ? "Enable" : "Disable",
  });
  if (!ok) return;
  await updateDoc(doc(db, COL.users, uid), { disabled: !currentlyDisabled });
  await writeAudit(currentlyDisabled ? "User Enabled" : "User Disabled", { uid });
  toast("ok", currentlyDisabled ? "Account enabled" : "Account disabled");
  loadUsers();
}

/* ------------------------------------------------------------- Facilities */
function wireFacilities() {
  document.getElementById("addFacilityForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("afName").value.trim();
    const district = document.getElementById("afDistrict").value;
    const type = document.getElementById("afType").value;
    const lat = parseFloat(document.getElementById("afLat").value) || null;
    const lng = parseFloat(document.getElementById("afLng").value) || null;
    if (!name || !district) { toast("err", "Missing details", "Name and district are required."); return; }
    try {
      await addDoc(collection(db, COL.facilities), { name, district, type, lat, lng, keywords: name.toLowerCase() });
      await writeAudit("Facility Added", { name });
      invalidate(COL.facilities);
      toast("ok", "Facility added", name);
      document.getElementById("addFacilityForm").reset();
      loadFacilities(true);
    } catch { toast("err", "Failed to add facility"); }
  });
}

async function loadFacilities(force) {
  if (force) invalidate(COL.facilities);
  const facs = await getFacilities();
  if (facTable) facTable.destroy();
  document.querySelector("#facTable tbody").innerHTML = facs.map((f) => `
    <tr><td>${esc(f.name)}</td><td>${esc(f.district)}</td><td>${esc(f.type || "")}</td>
    <td class="mono" style="font-size:.8rem">${f.lat && f.lng ? `${f.lat.toFixed(4)}, ${f.lng.toFixed(4)}` : "—"}</td></tr>`).join("");
  facTable = $("#facTable").DataTable({ pageLength: 15, order: [[0, "asc"]], language: { search: "", searchPlaceholder: "Search 466 facilities…" } });
}

/* --------------------------------------------------------------- Vehicles */
function wireVehicles() {
  document.getElementById("addVehicleForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const reg = document.getElementById("avReg").value.trim();
    const district = document.getElementById("avDistrict").value;
    const type = document.getElementById("avType").value;
    if (!reg || !district) { toast("err", "Missing details", "Registration and district are required."); return; }
    try {
      await setDoc(doc(db, COL.vehicles, reg.toLowerCase().replace(/[^a-z0-9]+/g, "-")), { registration: reg, district, type }, { merge: true });
      await writeAudit("Vehicle Added", { registration: reg });
      invalidate(COL.vehicles);
      toast("ok", "Vehicle added", reg);
      document.getElementById("addVehicleForm").reset();
      loadVehicles(true);
    } catch { toast("err", "Failed to add vehicle"); }
  });
}

async function loadVehicles(force) {
  if (force) invalidate(COL.vehicles);
  const vs = await getVehicles();
  if (vehTable) vehTable.destroy();
  document.querySelector("#vehTable tbody").innerHTML = vs.map((v) =>
    `<tr><td class="mono">${esc(v.registration)}</td><td>${esc(v.district)}</td><td>${esc(v.type || "")}</td></tr>`).join("");
  vehTable = $("#vehTable").DataTable({ pageLength: 15, order: [[0, "asc"]], language: { search: "", searchPlaceholder: "Search vehicles…" } });
}

/* ------------------------------------------------------------------ Audit */
async function loadAudit() {
  const snap = await getDocs(query(collection(db, COL.audit), orderBy("at", "desc"), limit(500)));
  const rows = snap.docs.map((d) => d.data());
  document.getElementById("auditCount").textContent = `${rows.length} recent events`;
  if (auditTable) auditTable.destroy();
  document.querySelector("#auditTable tbody").innerHTML = rows.map((a) => `
    <tr>
      <td class="mono" style="font-size:.82rem">${fmtStamp(a.at)}</td>
      <td><span class="status-pill status-active">${esc(a.action)}</span></td>
      <td>${esc(a.actorName || "")}</td>
      <td>${esc(a.actorRole || "")}</td>
      <td class="text-dim" style="font-size:.82rem">${esc(JSON.stringify(a.details || {}))}</td>
    </tr>`).join("");
  auditTable = $("#auditTable").DataTable({ pageLength: 25, order: [], language: { search: "", searchPlaceholder: "Search audit trail…" } });
}

/* ------------------------------------------------------------------ Setup */
function wireSetup() {
  document.getElementById("seedBtn").addEventListener("click", async () => {
    const btn = document.getElementById("seedBtn");
    const log = document.getElementById("seedLog");
    btn.disabled = true; log.textContent = "";
    const append = (m) => { log.textContent += m + "\n"; log.scrollTop = log.scrollHeight; };
    try {
      await seedAll(append);
      invalidate(COL.facilities); invalidate(COL.stations); invalidate(COL.districts); invalidate(COL.vehicles);
      await writeAudit("System Seeded", {});
      toast("ok", "Import complete", "Reference data is ready.");
      loadCounts();
    } catch (err) {
      append("✗ " + err.message);
      toast("err", "Import failed", err.message);
    } finally { btn.disabled = false; }
  });
}

async function loadCounts() {
  const grid = document.getElementById("countGrid");
  const specs = [
    ["Districts", COL.districts, "fa-map"], ["EMS Stations", COL.stations, "fa-tower-broadcast"],
    ["Facilities", COL.facilities, "fa-hospital"], ["Vehicles", COL.vehicles, "fa-truck-medical"],
    ["Patients", COL.patients, "fa-users"], ["Users", COL.users, "fa-user"],
  ];
  grid.innerHTML = specs.map(([label, , icon]) =>
    `<div class="kpi"><i class="fa-solid ${icon} kpi-icon"></i><div class="kpi-label">${label}</div><div class="metric-value" data-count="${label}">…</div></div>`).join("");
  for (const [label, col] of specs) {
    const n = await collectionCount(col);
    const el = grid.querySelector(`[data-count="${label}"]`);
    if (el) el.textContent = n == null ? "—" : n;
  }
}
