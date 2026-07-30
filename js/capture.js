/**
 * capture.js — new patient transfer form.
 * Generates a unique incident number, wires facility autocomplete and the
 * district→station cascade, validates, then opens an Active journey.
 * ECC personnel can capture several patients back-to-back; the form resets
 * and issues a fresh incident number after each save.
 */

import { requireAuth, nextIncidentNumber, writeAudit, toast, fmtYMD } from "./app.js";
import { renderShell } from "./layout.js";
import { getFacilities, getStations, getDistricts, getVehicles, attachAutocomplete, createPatient } from "./data-service.js";
import { refreshSnapshot } from "./metrics.js";

(async () => {
  const { user, profile } = await requireAuth("capturePatient");
  await renderShell("capture", profile);

  const content = document.getElementById("pageContent");
  content.appendChild(document.getElementById("pageTpl").content.cloneNode(true));

  const $ = (id) => document.getElementById(id);
  const form = $("captureForm");

  // Default date = today; captured-by = current user.
  $("incidentDate").value = new Date().toISOString().slice(0, 10);
  $("capturedBy").value = profile.name;

  // Reference data.
  const [facilities, stations, districts, vehicles] = await Promise.all([
    getFacilities(), getStations(), getDistricts(), getVehicles(),
  ]);

  // Districts dropdown.
  const dSel = $("district");
  districts.map((d) => d.name).sort().forEach((name) => {
    const o = document.createElement("option"); o.value = name; o.textContent = name; dSel.appendChild(o);
  });

  // District → station cascade.
  const sSel = $("station");
  dSel.addEventListener("change", () => {
    const list = stations.filter((s) => s.district === dSel.value).map((s) => s.name).sort();
    sSel.innerHTML = list.length
      ? `<option value="">Select station…</option>` + list.map((n) => `<option>${n}</option>`).join("")
      : `<option value="">No stations for this district</option>`;
  });

  // Facility autocompletes (both referring and receiving).
  const facOpts = {
    toText: (f) => f.name,
    toSub: (f) => `${f.type} · ${f.district}`,
  };
  attachAutocomplete($("referringFacility"), facilities, facOpts);
  attachAutocomplete($("receivingFacility"), facilities, facOpts);

  // Vehicle autocomplete.
  attachAutocomplete($("vehicle"), vehicles, {
    toText: (v) => v.registration,
    toSub: (v) => `${v.type} · ${v.district}`,
  });

  // Issue an incident number for the chosen date.
  const issueIncident = async () => {
    $("incidentNumber").value = "generating…";
    const d = new Date($("incidentDate").value || Date.now());
    try {
      $("incidentNumber").value = await nextIncidentNumber(d);
    } catch (e) {
      $("incidentNumber").value = "";
      toast("err", "Couldn’t generate number", "Check your connection and Firestore rules.");
    }
  };
  await issueIncident();
  $("incidentDate").addEventListener("change", issueIncident);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!form.checkValidity()) { form.reportValidity(); return; }

    const btn = $("saveBtn");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Saving…`;

    const facility = (name) => facilities.find((f) => f.name === name) || null;
    const ref = facility($("referringFacility").value.trim());
    const rec = facility($("receivingFacility").value.trim());

    const payload = {
      incidentNumber: $("incidentNumber").value,
      date: $("incidentDate").value,
      referringFacility: $("referringFacility").value.trim(),
      referringDistrict: ref?.district || "",
      referringLat: ref?.lat || null, referringLng: ref?.lng || null,
      receivingFacility: $("receivingFacility").value.trim(),
      receivingLat: rec?.lat || null, receivingLng: rec?.lng || null,
      district: $("district").value,
      station: $("station").value,
      vehicle: $("vehicle").value.trim(),
      patientName: $("patientName").value.trim(),
      age: Number($("age").value),
      gender: $("gender").value,
      diagnosis: $("diagnosis").value.trim(),
      capturedByUid: user.uid,
      capturedByName: profile.name,
    };

    try {
      await createPatient(payload);
      await writeAudit("Patient Created", { incidentNumber: payload.incidentNumber, patient: payload.patientName });
      refreshSnapshot().catch(() => {});
      toast("ok", "Journey opened", `${payload.incidentNumber} is now Active.`);
      // Reset for the next capture and issue a fresh number.
      form.reset();
      $("incidentDate").value = new Date().toISOString().slice(0, 10);
      $("capturedBy").value = profile.name;
      sSel.innerHTML = `<option value="">Select district first…</option>`;
      await issueIncident();
    } catch (err) {
      console.error(err);
      toast("err", "Save failed", err.message || "Please try again.");
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<i class="fa-solid fa-plus me-1"></i> Open Journey`;
    }
  });
})();
