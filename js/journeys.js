/**
 * journeys.js — browse active and closed journeys, search across every field,
 * and close an active journey by capturing its delivery time. Closing writes
 * the delivery timestamp, flips status to Closed and permanently locks the
 * record. Only roles with the closeJourney capability see the close action.
 */

import { requireAuth, can, applyCapVisibility, fmtStamp, esc, toast, writeAudit } from "./app.js";
import { renderShell } from "./layout.js";
import { getAllPatients, closeJourney } from "./data-service.js";
import { refreshSnapshot } from "./metrics.js";

let table, allRows = [], currentTab = "active", canClose = false, profileRef;

(async () => {
  const { profile } = await requireAuth("viewDashboard");
  profileRef = profile;
  canClose = can(profile, "closeJourney");
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

  // Wire close action (event delegation on the table body).
  document.querySelector("#journeyTable tbody").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-close]");
    if (btn) openCloseModal(btn.dataset.close);
  });

  document.getElementById("confirmClose").addEventListener("click", doClose);

  paint();
})();

function paint() {
  const rows = allRows.filter((r) => (currentTab === "active" ? !r.closed : r.closed));
  table.clear();
  rows.forEach((r) => {
    const status = r.closed
      ? `<span class="status-pill status-closed">Closed</span>`
      : `<span class="status-pill status-active">Active</span>`;
    const action = (!r.closed && canClose)
      ? `<button class="btn btn-ems btn-sm" data-close="${r.id}"><i class="fa-solid fa-lock me-1"></i>Close</button>`
      : r.closed
        ? `<span class="text-faint" title="Delivered ${fmtStamp(r.timeDelivered)}"><i class="fa-solid fa-lock"></i></span>`
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
}

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
