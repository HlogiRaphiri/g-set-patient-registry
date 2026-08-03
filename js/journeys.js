/**
 * journeys.js — browse active and closed journeys, search across every field,
 * and close an active journey by capturing its delivery time. Closing writes
 * the delivery timestamp, flips status to Closed and permanently locks the
 * record. Only roles with the closeJourney capability see the close action.
 *
 * Captured records are otherwise immutable — the ONE exception is the G-Set
 * vehicle registration, which capture-capable staff (Superuser / ECC) may
 * correct at any time via the Edit-vehicle action. Records can never be deleted.
 */

import { requireAuth, can, applyCapVisibility, fmtStamp, esc, toast, writeAudit } from "./app.js";
import { renderShell } from "./layout.js";
import { getAllPatients, closeJourney, updateVehicleRegistration, getVehicles, attachAutocomplete } from "./data-service.js";
import { refreshSnapshot } from "./metrics.js";
import { statusPill, overdueSummary, overdueLevel } from "./overdue.js";

/** Normalise a station/district name for tolerant matching. */
const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

let table, allRows = [], currentTab = "active", canClose = false, canEditVehicle = false, profileRef, editRow = null;

(async () => {
  // Journeys shows individual patient records, so it is gated on viewJourneys
  // rather than viewDashboard — management roles have dashboard access but must
  // not reach the per-patient list, including by typing the URL directly.
  const { profile } = await requireAuth("viewJourneys");
  profileRef = profile;
  canClose = can(profile, "closeJourney");
  // The vehicle registration is the only editable field post-capture; gate it
  // to capture-capable staff (Superuser / ECC), matching canCapture() in rules.
  canEditVehicle = can(profile, "capturePatient");
  await renderShell("journeys", profile);

  const content = document.getElementById("pageContent");
  content.appendChild(document.getElementById("pageTpl").content.cloneNode(true));
  applyCapVisibility(profile);

  allRows = await getAllPatients();

  table = $("#journeyTable").DataTable({
    order: [[6, "desc"]],
    pageLength: 15,
    columnDefs: [{ targets: -1, orderable: false }],
    language: { emptyTable: "No journeys to show", search: "", searchPlaceholder: "Filter…" },
  });

  document.querySelectorAll("#tabs [data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("#tabs .nav-link").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      currentTab = b.dataset.tab;
      paint();
    }));

  document.getElementById("quickSearch").addEventListener("input", (e) => table.search(e.target.value).draw());

  // Wire row actions (event delegation on the table body).
  document.querySelector("#journeyTable tbody").addEventListener("click", (e) => {
    const closeBtn = e.target.closest("[data-close]");
    if (closeBtn) { openCloseModal(closeBtn.dataset.close); return; }
    const editBtn = e.target.closest("[data-editveh]");
    if (editBtn) { openVehicleModal(editBtn.dataset.editveh); return; }
  });

  document.getElementById("confirmClose").addEventListener("click", doClose);
  document.getElementById("confirmVehicle").addEventListener("click", doVehicleSave);

  // Vehicle pick-list for the edit modal: suggestions ranked by the record's own
  // station then district (station-first), everything else still selectable, and
  // manual entry always allowed.
  const vehInput = document.getElementById("vehicleReg");
  if (vehInput) {
    attachAutocomplete(vehInput, getVehicles, {
      toText: (v) => v.registration,
      toSub: (v) => [v.station, v.district].filter(Boolean).join(" · "),
      rank: (v) => {
        if (!editRow) return 0;
        const recS = norm(editRow.station);
        const recD = norm(editRow.district);
        if (recS && norm(v.station) && norm(v.station) === recS) return 3;
        if (recD && norm(v.district) && norm(v.district) === recD) return 2;
        return 0;
      },
    });
  }
  if (vehInput) {
    vehInput.addEventListener("input", () => {
      const s = vehInput.selectionStart, en = vehInput.selectionEnd;
      const u = vehInput.value.toUpperCase();
      if (u !== vehInput.value) { vehInput.value = u; try { vehInput.setSelectionRange(s, en); } catch (_) {} }
    });
  }

  paint();
})();

function paint(opts = {}) {
  const rows = allRows.filter((r) => (currentTab === "active" ? !r.closed : r.closed));
  const now = new Date();
  const page = opts.preservePage ? table.page() : 0;

  // Age is computed fresh on every paint, so the pills stay honest as the shift
  // runs on without re-reading anything from Firestore.
  paintOverdueBanner(allRows.filter((r) => !r.closed), now);

  table.clear();
  rows.forEach((r) => {
    const status = statusPill(r, now);

    // Build the action cell: lock/close indicator plus an optional Edit-vehicle button.
    const parts = [];
    if (!r.closed && canClose) {
      parts.push(`<button class="btn btn-ems btn-sm" data-close="${r.id}"><i class="fa-solid fa-lock me-1"></i>Close</button>`);
    }
    if (r.closed) {
      parts.push(`<span class="text-faint" title="Delivered ${esc(fmtStamp(r.timeDelivered))}"><i class="fa-solid fa-lock"></i></span>`);
    }
    if (canEditVehicle) {
      parts.push(`<button class="btn btn-ghost btn-sm" data-editveh="${r.id}" title="Edit G-Set vehicle registration"><i class="fa-solid fa-truck-medical"></i></button>`);
    }
    const action = parts.length
      ? `<div class="d-flex gap-1 justify-content-end align-items-center">${parts.join("")}</div>`
      : `<span class="text-faint">—</span>`;

    table.row.add([
      `<span class="mono text-ems">${esc(r.incidentNumber)}</span>`,
      `${esc(r.patientName)}<br><small class="text-faint">${esc(r.gender || "")}${r.age != null ? " · " + r.age : ""}</small>`,
      esc(r.district || ""),
      esc(r.station || ""),
      `<span class="mono">${esc(r.vehicle || "")}</span>`,
      `<small>${esc(r.referringFacility || "")}<br><i class="fa-solid fa-arrow-down text-ems"></i> ${esc(r.receivingFacility || "")}</small>`,
      fmtStamp(r.createdAt),
      status,
      action,
    ]);
  });
  table.draw();
  if (opts.preservePage && page) table.page(page).draw(false);
}

/**
 * Banner above the table summarising open journeys past the threshold.
 *
 * The table sorts newest-first, so the oldest — i.e. exactly the ones needing
 * attention — sink to the last page where nobody looks. The banner lifts them
 * out, and the button filters the table down to them.
 */
function paintOverdueBanner(activeRows, now) {
  const anchor = document.querySelector("#journeyTable")?.closest(".glass");
  if (!anchor) return;

  let el = document.getElementById("overdueBanner");
  if (!el) {
    el = document.createElement("div");
    el.id = "overdueBanner";
    el.className = "glass panel mb-3";
    el.style.cssText = "border-left:3px solid #fbbf24";
    anchor.parentNode.insertBefore(el, anchor);
    el.addEventListener("click", (e) => {
      if (!e.target.closest("[data-show-overdue]")) return;
      const box = document.getElementById("quickSearch");
      if (box) { box.value = "Overdue"; }
      table.search("Overdue").draw();
    });
  }

  const { overdue, critical, unknown, total } = overdueSummary(activeRows, now);
  if (!total && !unknown) { el.hidden = true; return; }
  el.hidden = false;

  const bits = [];
  if (total) bits.push(`<strong>${total}</strong> open journey${total === 1 ? "" : "s"} past the review threshold${critical ? ` (<strong>${critical}</strong> long overdue)` : ""}`);
  if (unknown) bits.push(`<strong>${unknown}</strong> active record${unknown === 1 ? "" : "s"} with no readable capture time`);

  el.innerHTML = `
    <div class="d-flex align-items-center justify-content-between flex-wrap gap-2">
      <div>
        <i class="fa-solid fa-triangle-exclamation me-2" style="color:#fbbf24"></i>
        ${bits.join(" · ")}
        <div class="text-faint mt-1" style="font-size:.82rem">
          Usually a delivered patient whose record was never closed — which inflates active counts and skews transport averages. Confirm the delivery, then close the record.
        </div>
      </div>
      ${total ? `<button class="btn btn-ghost btn-sm" data-show-overdue><i class="fa-solid fa-filter me-1"></i>Show these</button>` : ""}
    </div>`;
}

/**
 * Ages advance while the page sits open — a journey crossing the threshold at
 * 11:00 should say so at 11:00, not at the next manual refresh. This is pure
 * local arithmetic on rows already in memory: no reads.
 *
 * Redrawing a DataTable sends the user back to page one, so we only redraw when
 * a journey has actually changed level. On every other tick we refresh the
 * banner alone, which is free and disturbs nothing.
 */
let levelSignature = "";
setInterval(() => {
  if (document.hidden || !table) return;
  const now = new Date();
  const active = allRows.filter((r) => !r.closed);
  const sig = active.map((r) => `${r.id}:${overdueLevel(r, now)}`).join("|");
  if (sig === levelSignature) { paintOverdueBanner(active, now); return; }
  levelSignature = sig;
  paint({ preservePage: true });
}, 60000);

/* ------------------------------------------------------------- Close flow */

let pendingId = null;
function openCloseModal(id) {
  const r = allRows.find((x) => x.id === id);
  if (!r) return;
  pendingId = id;
  document.getElementById("cmIncident").textContent = r.incidentNumber;
  document.getElementById("cmPatient").textContent = `${r.patientName} · ${r.diagnosis || ""}`;
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  document.getElementById("deliveredAt").value = now.toISOString().slice(0, 16);
  bootstrap.Modal.getOrCreateInstance(document.getElementById("closeModal")).show();
}

async function doClose() {
  if (!pendingId) return;
  const btn = document.getElementById("confirmClose");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Closing…`;
  try {
    await closeJourney(pendingId, profileRef.name);
    const r = allRows.find((x) => x.id === pendingId);
    if (r) { r.closed = true; r.status = "Closed"; r.timeDelivered = { toDate: () => new Date() }; }
    await writeAudit("Patient Closed", { incidentNumber: r?.incidentNumber });
    refreshSnapshot().catch(() => {});
    toast("ok", "Journey closed", `${r?.incidentNumber} is locked.`);
    bootstrap.Modal.getInstance(document.getElementById("closeModal")).hide();
    paint();
  } catch (err) {
    toast("err", "Couldn’t close", err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-lock me-1"></i> Close & Lock`;
    pendingId = null;
  }
}

/* ---------------------------------------------------- Edit vehicle flow */

let pendingVehId = null;
function openVehicleModal(id) {
  const r = allRows.find((x) => x.id === id);
  if (!r) return;
  pendingVehId = id;
  editRow = r; // drives station-first ranking of the vehicle suggestions
  document.getElementById("vmIncident").textContent = r.incidentNumber;
  document.getElementById("vmPatient").textContent = `${r.patientName} · ${r.diagnosis || ""}`;
  const input = document.getElementById("vehicleReg");
  input.value = (r.vehicle || "").toUpperCase();
  bootstrap.Modal.getOrCreateInstance(document.getElementById("vehicleModal")).show();
  setTimeout(() => input.focus(), 250);
}

async function doVehicleSave() {
  if (!pendingVehId) return;
  const input = document.getElementById("vehicleReg");
  const reg = input.value.trim().toUpperCase();
  if (!reg) { toast("err", "Registration required", "Enter a G-Set vehicle registration."); return; }

  const btn = document.getElementById("confirmVehicle");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Saving…`;
  try {
    const saved = await updateVehicleRegistration(pendingVehId, reg, profileRef.name);
    const r = allRows.find((x) => x.id === pendingVehId);
    if (r) r.vehicle = saved;
    await writeAudit("Vehicle Updated", { incidentNumber: r?.incidentNumber, vehicle: saved });
    refreshSnapshot().catch(() => {});
    toast("ok", "Vehicle updated", `${r?.incidentNumber} → ${saved}`);
    bootstrap.Modal.getInstance(document.getElementById("vehicleModal")).hide();
    paint();
  } catch (err) {
    toast("err", "Update failed", err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-floppy-disk me-1"></i> Save Registration`;
    pendingVehId = null;
  }
}
