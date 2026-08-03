/**
 * capture.js — new patient transfer form.
 * Generates a unique incident number, wires facility autocomplete and the
 * district→station cascade, validates, then opens an Active journey.
 * ECC personnel can capture several patients back-to-back; the form resets
 * and issues a fresh incident number after each save.
 *
 * All free-text entry (facility names, vehicle registration, patient name,
 * diagnosis) is standardised to UPPERCASE — visually as the user types and
 * again at write time so storage is always uppercase.
 */

import { requireAuth, nextIncidentNumber, writeAudit, toast, fmtYMD, confirmDialog } from "./app.js";
import { renderShell } from "./layout.js";
import { getFacilities, getStations, getDistricts, getVehicles, attachAutocomplete, createPatient,
         findPatientByIncident, getActivePatients } from "./data-service.js";
import { refreshSnapshot } from "./metrics.js";
import { canonicalDistrict } from "./districts.js";

/** Normalise any entered string to trimmed UPPERCASE. */
const up = (s) => String(s ?? "").trim().toUpperCase();

/** Shape produced by nextIncidentNumber(), e.g. GS-20260802-000001. */
const INCIDENT_RE = /^GS-\d{8}-\d{6}$/;

/**
 * Look for an already-open journey that appears to be this same transfer:
 * same patient name, same referring facility, same date.
 *
 * Reads only the open journeys (a `closed == false` query), which is a small
 * set at any moment — not the whole register.
 *
 * @returns {Promise<object|null>} the existing journey, or null
 */
async function findOpenTwin(payload) {
  try {
    const open = await getActivePatients();
    return open.find((r) =>
      up(r.patientName) === payload.patientName &&
      up(r.referringFacility) === payload.referringFacility &&
      r.date === payload.date) || null;
  } catch {
    // A failed duplicate check must never block a capture — the patient comes
    // first, and a possible duplicate is a far smaller problem than a refused
    // registration.
    return null;
  }
}

/** Normalise a station/district name for tolerant matching. */
const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** Force an input to display and hold uppercase text as the user types. */
function bindUppercase(input) {
  if (!input) return;
  input.style.textTransform = "uppercase"; // instant visual feedback (also covers autocomplete picks)
  input.addEventListener("input", () => {
    const start = input.selectionStart, end = input.selectionEnd;
    const upper = input.value.toUpperCase();
    if (upper !== input.value) {
      input.value = upper;
      try { input.setSelectionRange(start, end); } catch (_) {}
    }
  });
}

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

  // Vehicle autocomplete — suggestions only. Manual entry of any G-Set
  // registration is fully supported; the user is not limited to preset vehicles.
  attachAutocomplete($("vehicle"), vehicles, {
    toText: (v) => v.registration,
    toSub: (v) => [v.station, v.district].filter(Boolean).join(" · "),
    // Station-first, then same-district, then everyone else — nothing is blocked.
    rank: (v) => {
      const selD = norm($("district").value);
      const selS = norm($("station").value);
      if (!selD && !selS) return 0;
      if (selS && norm(v.station) && norm(v.station) === selS) return 3;
      if (selD && norm(v.district) && norm(v.district) === selD) return 2;
      return 0;
    },
  });

  // Standardise all free-text fields to uppercase.
  ["referringFacility", "receivingFacility", "vehicle", "patientName", "diagnosis"].forEach((id) => bindUppercase($(id)));

  // Issue an incident number for the chosen date. Guarded so overlapping calls
  // (e.g. rapid date changes) can't stack up and hammer a rate-limited backend.
  let issuing = false;
  const issueIncident = async () => {
    if (issuing) return;
    issuing = true;
    $("incidentNumber").value = "generating…";
    const d = new Date($("incidentDate").value || Date.now());
    try {
      $("incidentNumber").value = await nextIncidentNumber(d);
    } catch (e) {
      $("incidentNumber").value = "";
      if (e && e.code === "resource-exhausted") {
        toast("err", "Daily quota reached", "The Firestore free-tier limit has been hit. Numbering resumes after the daily reset (00:00 US Pacific), or upgrade the project to Blaze.");
      } else {
        toast("err", "Couldn’t generate number", "Check your connection and Firestore rules.");
      }
    } finally {
      issuing = false;
    }
  };
  await issueIncident();
  $("incidentDate").addEventListener("change", issueIncident);

  // Look up a facility by name, case-insensitively, so uppercase entry still
  // resolves the stored (mixed-case) facility to pull its coordinates/district.
  const facilityByName = (name) => {
    const key = String(name ?? "").trim().toLowerCase();
    if (!key) return null;
    return facilities.find((f) => String(f.name ?? "").toLowerCase() === key) || null;
  };

  /* ------------------------------------------------- unmatched facilities */
  /**
   * Facility names are typed free-hand, so an entry that does not match the
   * reference list exactly used to be saved with null coordinates — and null
   * coerces to 0, which put the journey at 0°N 0°E on the live map.
   *
   * This does NOT guess a replacement. An earlier token-matching version
   * offered "Dr Yusuf Dadoo Gateway Clinic" for a typed hospital name, and
   * "Chris Hani Hospital" for Chris Hani Baragwanath — a different hospital
   * entirely. Silently relocating a patient transfer to the wrong facility is
   * far worse than leaving it off the map, so the operator is shown the closest
   * entries and decides.
   */
  const tokens = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const STOPWORDS = new Set(["hospital", "clinic", "chc", "centre", "center", "satellite", "gateway", "dr", "st", "the"]);

  /** Up to three reference names sharing a distinctive word with what was typed. */
  function shortlist(name) {
    const key = tokens(name).filter((t) => !STOPWORDS.has(t));
    if (!key.length) return [];
    return facilities
      .map((f) => {
        const have = tokens(f.name).filter((t) => !STOPWORDS.has(t));
        return { name: f.name, shared: key.filter((t) => have.includes(t)).length };
      })
      .filter((x) => x.shared > 0)
      .sort((a, b) => b.shared - a.shared)
      .slice(0, 3)
      .map((x) => x.name);
  }

  /**
   * Resolve one facility field, warning the operator when it cannot be matched.
   * @returns {Promise<{facility: object|null, cancelled: boolean}>}
   */
  async function resolveFacility(label, typedName) {
    const exact = facilityByName(typedName);
    if (exact) return { facility: exact, cancelled: false };

    const near = shortlist(typedName);
    const suggestion = near.length
      ? ` The closest entries are: ${near.join(", ")}.`
      : "";

    const proceed = await confirmDialog({
      title: `${label} not in the list`,
      body: `“${up(typedName)}” does not match any facility on record, so no location can be saved and this journey will not appear on the route map.${suggestion} Correct the name, or save it as typed.`,
      confirmText: "Save as typed",
    });
    return { facility: null, cancelled: !proceed };
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!form.checkValidity()) { form.reportValidity(); return; }

    const btn = $("saveBtn");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Saving…`;

    const refName = $("referringFacility").value.trim();
    const recName = $("receivingFacility").value.trim();

    // Resolve both facilities before building the payload. Either prompt may
    // cancel the save, so this happens before anything is written.
    const refRes = await resolveFacility("Referring facility", refName);
    if (refRes.cancelled) { btn.disabled = false; btn.innerHTML = `<i class="fa-solid fa-plus me-1"></i> Open Journey`; return; }
    const recRes = await resolveFacility("Receiving facility", recName);
    if (recRes.cancelled) { btn.disabled = false; btn.innerHTML = `<i class="fa-solid fa-plus me-1"></i> Open Journey`; return; }

    const ref = refRes.facility;
    const rec = recRes.facility;

    const payload = {
      incidentNumber: $("incidentNumber").value,
      date: $("incidentDate").value,
      referringFacility: up(refName),
      // Canonical spelling, NOT uppercase. Uppercasing here is what split each
      // district into two chart entries, because the form's district field
      // stores the Title Case reference spelling.
      referringDistrict: canonicalDistrict(ref?.district || ""),
      referringLat: ref?.lat ?? null, referringLng: ref?.lng ?? null,
      receivingFacility: up(recName),
      receivingLat: rec?.lat ?? null, receivingLng: rec?.lng ?? null,
      district: canonicalDistrict($("district").value),
      station: $("station").value,
      vehicle: up($("vehicle").value),
      patientName: up($("patientName").value),
      age: Number($("age").value),
      gender: $("gender").value,
      diagnosis: up($("diagnosis").value),
      capturedByUid: user.uid,
      capturedByName: profile.name,
    };

    try {
      // ---- Guard 1: the incident number must be real -------------------
      // Yesterday's fault left this field empty when generation failed, and an
      // empty or placeholder number would have been saved as-is. A record with
      // no usable identifier cannot be found, audited or reconciled later, so
      // refuse the save and try to issue a fresh number instead.
      if (!INCIDENT_RE.test(payload.incidentNumber)) {
        toast("err", "No incident number", "The number could not be generated. Retrying now — save again once it appears.");
        await issueIncident();
        return;
      }

      // ---- Guard 2: that number must not already be in use --------------
      // Numbering is transactional so collisions should be impossible, but this
      // costs a single read and is the difference between catching a numbering
      // fault on the spot and discovering it in a monthly reconciliation.
      const clash = await findPatientByIncident(payload.incidentNumber);
      if (clash) {
        toast("err", "Incident number already used", `${payload.incidentNumber} belongs to ${clash.patientName || "an existing record"}. A new number is being issued.`);
        await issueIncident();
        return;
      }

      // ---- Guard 3: the same transfer may already be open ---------------
      // Two ECC operators taking the same call produces two live journeys for
      // one patient, which double-counts every downstream figure. This is a
      // warning, not a block: genuine repeat transfers of the same patient on
      // the same day do happen.
      const twin = await findOpenTwin(payload);
      if (twin) {
        const proceed = await confirmDialog({
          title: "Possible duplicate",
          body: `${twin.incidentNumber} is already open for ${twin.patientName} from ${twin.referringFacility}, captured by ${twin.capturedByName || "another operator"}. Open a second journey anyway?`,
          confirmText: "Yes, open anyway",
        });
        if (!proceed) return;
      }

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
