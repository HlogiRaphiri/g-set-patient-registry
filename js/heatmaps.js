/**
 * heatmaps.js — geospatial activity heatmaps over Gauteng.
 * Renders the shared shell, clones the page template, builds a Leaflet map with
 * a heat layer + circle markers, and lets the user switch between patient
 * pickup density (referring facilities), receiving-facility density, and raw
 * healthcare-facility density, filtered by district and date range.
 */

import { requireAuth, esc } from "./app.js";
import { renderShell } from "./layout.js";
import { getFacilities, getAllPatients } from "./data-service.js";

// Gauteng centre + sensible default zoom.
const GAUTENG = [-26.15, 28.05];

let map, heat;
let layer = "pickup";
let patients = [];
let facilities = [];

(async () => {
  const { profile } = await requireAuth("viewHeatmaps");
  await renderShell("heatmaps", profile);

  // Inject the page template into the shell's content area.
  const content = document.getElementById("pageContent");
  content.appendChild(document.getElementById("pageTpl").content.cloneNode(true));

  // Build the map (base tiles must be added here — draw() only manages overlays).
  const mapEl = document.getElementById("map");
  // Defensive height fallback in case the .leaflet-map CSS rule didn't apply.
  if (mapEl.getBoundingClientRect().height < 50) mapEl.style.height = "68vh";

  map = L.map(mapEl, { zoomControl: true }).setView(GAUTENG, 9);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap &copy; CARTO",
    maxZoom: 19,
  }).addTo(map);
  map.invalidateSize();

  // Load reference + patient data.
  [facilities, patients] = await Promise.all([getFacilities(), getAllPatients()]);

  // Populate the district filter from whatever districts we actually have data for.
  const districts = [...new Set([
    ...facilities.map((f) => f.district),
    ...patients.map((p) => p.district),
  ].filter(Boolean))].sort();
  const sel = document.getElementById("fDistrict");
  districts.forEach((d) => {
    const o = document.createElement("option");
    o.value = d;
    o.textContent = d;
    sel.appendChild(o);
  });

  // Layer toggle buttons.
  document.querySelectorAll("#layerToggle [data-layer]").forEach((btn) =>
    btn.addEventListener("click", () => {
      layer = btn.dataset.layer;
      document.querySelectorAll("#layerToggle [data-layer]").forEach((b) => {
        const on = b === btn;
        b.classList.toggle("active", on);
        b.classList.toggle("btn-ems", on);
        b.classList.toggle("btn-ghost", !on);
      });
      draw();
    }));

  // Apply filters.
  document.getElementById("applyBtn").addEventListener("click", draw);

  draw();
})();

/** Patients matching the current district + date-range filters. */
function filtered() {
  const dist = document.getElementById("fDistrict").value;
  const fromV = document.getElementById("fFrom").value;
  const toV = document.getElementById("fTo").value;
  const from = fromV ? new Date(fromV + "T00:00:00") : null;
  const to = toV ? new Date(toV + "T23:59:59") : null;

  return patients.filter((r) => {
    if (dist && r.district !== dist) return false;
    if (from || to) {
      const created = r.createdAt?.toDate
        ? r.createdAt.toDate()
        : r.createdAt?.seconds
          ? new Date(r.createdAt.seconds * 1000)
          : null;
      if (from && created && created < from) return false;
      if (to && created && created > to) return false;
    }
    return true;
  });
}

function draw() {
  const set = filtered();

  let points = [];
  let caption = "";

  if (layer === "pickup") {
    points = set
      .filter((r) => r.referringLat != null && r.referringLng != null)
      .map((r) => ({ lat: Number(r.referringLat), lng: Number(r.referringLng), weight: 1, label: r.referringFacility }));
    caption = "Patient pickup density (Referring Facilities)";
  } else if (layer === "receiving") {
    points = set
      .filter((r) => r.receivingLat != null && r.receivingLng != null)
      .map((r) => ({ lat: Number(r.receivingLat), lng: Number(r.receivingLng), weight: 1, label: r.receivingFacility }));
    caption = "Receiving Facility Density";
  } else {
    const dist = document.getElementById("fDistrict").value;
    points = facilities
      .filter((f) => f.lat != null && f.lng != null && (!dist || f.district === dist))
      .map((f) => ({ lat: Number(f.lat), lng: Number(f.lng), weight: 0.5, label: f.name }));
    caption = "Healthcare Facility Density";
  }

  // Clear previous overlays.
  if (heat) map.removeLayer(heat);
  map.eachLayer((lyr) => {
    if (lyr instanceof L.CircleMarker) map.removeLayer(lyr);
  });

  // Visible markers.
  points.forEach((p) => {
    L.circleMarker([p.lat, p.lng], {
      radius: 8,
      color: "#ff6b1a",
      fillColor: "#ffb347",
      fillOpacity: 0.95,
      weight: 2,
    })
      .bindPopup(p.label || "")
      .addTo(map);
  });

  // Heat layer.
  heat = L.heatLayer(
    points.map((p) => [p.lat, p.lng, p.weight]),
    {
      radius: 45,
      blur: 35,
      maxZoom: 16,
      minOpacity: 0.6,
      max: 1,
      gradient: { 0.1: "#00e5ff", 0.3: "#00ff88", 0.5: "#ffff00", 0.7: "#ff9900", 1.0: "#ff0000" },
    }
  ).addTo(map);

  if (points.length > 0) {
    map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng])), { padding: [60, 60] });
  }

  document.getElementById("mapCaption").textContent = caption;
  document.getElementById("pointCount").textContent = `${points.length} locations`;

  renderDistrictCards(points);
}

/** Small per-district tally cards under the map. */
function renderDistrictCards(points) {
  const host = document.getElementById("districtCards");
  if (!host) return;

  const counts = {};
  const source = layer === "density" ? facilities : filtered();
  source.forEach((r) => {
    const d = r.district || "Unknown";
    counts[d] = (counts[d] || 0) + 1;
  });

  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  host.innerHTML = entries
    .map(
      ([district, n]) => `
      <div class="col-md-3 col-sm-6">
        <div class="glass panel h-100">
          <div class="text-faint" style="font-size:.78rem">${esc(district)}</div>
          <div class="mono" style="font-size:1.4rem">${n}</div>
        </div>
      </div>`
    )
    .join("");
}