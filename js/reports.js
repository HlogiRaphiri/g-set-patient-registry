/**
 * reports.js — filterable patient register with CSV, Excel, PDF and Print
 * exports. Exports respect the active filters and are audit-logged.
 */

import { requireAuth, fmtStamp, esc, toast, writeAudit } from "./app.js";
import { renderShell } from "./layout.js";
import { getAllPatients, getDistricts, getStations } from "./data-service.js";
import { applyFilters } from "./stats.js";

let table, allRows = [];
const COLS = ["incidentNumber", "date", "patientName", "age", "gender", "district", "station", "vehicle", "referringFacility", "receivingFacility", "diagnosis", "status"];
const HEAD = ["Incident", "Date", "Patient", "Age", "Gender", "District", "Station", "Vehicle", "Referring", "Receiving", "Diagnosis", "Status", "Delivered"];

(async () => {
  const { profile } = await requireAuth("exportReports");
  await renderShell("reports", profile);
  document.getElementById("pageContent").appendChild(document.getElementById("pageTpl").content.cloneNode(true));

  const [rows, districts, stations] = await Promise.all([getAllPatients(), getDistricts(), getStations()]);
  allRows = rows;

  fill("fDistrict", districts.map((d) => d.name).sort());
  fill("fStation", stations.map((s) => s.name).sort());

  table = $("#repTable").DataTable({ pageLength: 25, order: [[1, "desc"]], language: { search: "", searchPlaceholder: "Filter…" } });

  document.getElementById("applyBtn").addEventListener("click", render);
  document.getElementById("exCsv").addEventListener("click", exportCsv);
  document.getElementById("exXlsx").addEventListener("click", exportXlsx);
  document.getElementById("exPdf").addEventListener("click", exportPdf);
  document.getElementById("exPrint").addEventListener("click", doPrint);

  render();
})();

function fill(id, values) {
  const sel = document.getElementById(id);
  values.forEach((v) => { const o = document.createElement("option"); o.textContent = v; sel.appendChild(o); });
}

function currentFilters() {
  return {
    from: val("fFrom"), to: val("fTo"), district: val("fDistrict"),
    station: val("fStation"), status: val("fStatus"), diagnosis: val("fDiag"),
  };
  function val(id) { return document.getElementById(id).value; }
}

function currentRows() { return applyFilters(allRows, currentFilters()); }

function render() {
  const rows = currentRows();
  table.clear();
  rows.forEach((r) => table.row.add([
    `<span class="mono text-ems">${esc(r.incidentNumber)}</span>`,
    esc(r.date || ""), esc(r.patientName || ""), r.age ?? "", esc(r.gender || ""),
    esc(r.district || ""), esc(r.station || ""), `<span class="mono">${esc(r.vehicle || "")}</span>`,
    esc(r.referringFacility || ""), esc(r.receivingFacility || ""), esc(r.diagnosis || ""),
    `<span class="status-pill ${r.closed ? "status-closed" : "status-active"}">${r.closed ? "Closed" : "Active"}</span>`,
    r.closed ? fmtStamp(r.timeDelivered) : "—",
  ]));
  table.draw();
}

/** Build a plain 2D array (header + rows) for export. */
function matrix() {
  const rows = currentRows();
  const body = rows.map((r) => [
    r.incidentNumber, r.date, r.patientName, r.age, r.gender, r.district, r.station,
    r.vehicle, r.referringFacility, r.receivingFacility, r.diagnosis,
    r.closed ? "Closed" : "Active", r.closed ? fmtStamp(r.timeDelivered) : "",
  ]);
  return { head: HEAD, body, count: rows.length };
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

function exportCsv() {
  const { head, body, count } = matrix();
  const csv = [head, ...body].map((row) => row.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  download(new Blob([csv], { type: "text/csv" }), `g-set-report-${stamp()}.csv`);
  writeAudit("Report Exported", { format: "CSV", records: count });
  toast("ok", "CSV exported", `${count} records.`);
}

function exportXlsx() {
  const { head, body, count } = matrix();
  const ws = XLSX.utils.aoa_to_sheet([head, ...body]);
  ws["!cols"] = head.map(() => ({ wch: 18 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Transfers");
  XLSX.writeFile(wb, `g-set-report-${stamp()}.xlsx`);
  writeAudit("Report Exported", { format: "Excel", records: count });
  toast("ok", "Excel exported", `${count} records.`);
}

function exportPdf() {
  const { head, body, count } = matrix();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  doc.setFontSize(15); doc.setTextColor("#ff6b1a");
  doc.text("G-Set Patient Transfer Report", 40, 36);
  doc.setFontSize(9); doc.setTextColor("#444");
  doc.text(`Generated ${new Date().toLocaleString("en-ZA")} · ${count} records · Gauteng EMS`, 40, 52);
  doc.autoTable({
    head: [head], body, startY: 66, styles: { fontSize: 7, cellPadding: 3 },
    headStyles: { fillColor: [255, 107, 26], textColor: 255 }, alternateRowStyles: { fillColor: [245, 247, 252] },
    margin: { left: 40, right: 40 },
  });
  doc.save(`g-set-report-${stamp()}.pdf`);
  writeAudit("Report Exported", { format: "PDF", records: count });
  toast("ok", "PDF exported", `${count} records.`);
}

function doPrint() {
  const { count } = matrix();
  const hdr = document.getElementById("reportHeader");
  hdr.classList.remove("d-none");
  document.getElementById("reportMeta").textContent = `Generated ${new Date().toLocaleString("en-ZA")} · ${count} records`;
  writeAudit("Report Exported", { format: "Print", records: count });
  setTimeout(() => { window.print(); hdr.classList.add("d-none"); }, 100);
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
