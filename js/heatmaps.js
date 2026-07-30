function draw() {

  const set = filtered();

  let points = [];
  let caption = "";

  if (layer === "pickup") {

    points = set
      .filter(r =>
        r.referringLat != null &&
        r.referringLng != null
      )
      .map(r => ({
        lat: Number(r.referringLat),
        lng: Number(r.referringLng),
        weight: 1,
        label: r.referringFacility
      }));

    caption = "Patient pickup density (Referring Facilities)";

  }

  else if (layer === "receiving") {

    points = set
      .filter(r =>
        r.receivingLat != null &&
        r.receivingLng != null
      )
      .map(r => ({
        lat: Number(r.receivingLat),
        lng: Number(r.receivingLng),
        weight: 1,
        label: r.receivingFacility
      }));

    caption = "Receiving Facility Density";

  }

  else {

    const dist = document.getElementById("fDistrict").value;

    points = facilities
      .filter(f =>
        f.lat != null &&
        f.lng != null &&
        (!dist || f.district === dist)
      )
      .map(f => ({
        lat: Number(f.lat),
        lng: Number(f.lng),
        weight: 0.5,
        label: f.name
      }));

    caption = "Healthcare Facility Density";

  }

  console.log("Heatmap points:", points);

  // Remove previous heat layer
  if (heat) {
    map.removeLayer(heat);
  }

  // Remove old markers
  map.eachLayer(layer => {
    if (layer instanceof L.CircleMarker) {
      map.removeLayer(layer);
    }
  });

  // Draw visible markers
  points.forEach(p => {

    L.circleMarker([p.lat, p.lng], {
      radius: 8,
      color: "#ff6b1a",
      fillColor: "#ffb347",
      fillOpacity: 0.95,
      weight: 2
    })
    .bindPopup(p.label)
    .addTo(map);

  });

  // Draw heatmap
  heat = L.heatLayer(

    points.map(p => [p.lat, p.lng, p.weight]),

    {
      radius: 45,
      blur: 35,
      maxZoom: 16,
      minOpacity: 0.6,
      max: 1,
      gradient: {
        0.1: "#00e5ff",
        0.3: "#00ff88",
        0.5: "#ffff00",
        0.7: "#ff9900",
        1.0: "#ff0000"
      }
    }

  ).addTo(map);

  if (points.length > 0) {

    const bounds = L.latLngBounds(
      points.map(p => [p.lat, p.lng])
    );

    map.fitBounds(bounds, {
      padding: [60, 60]
    });

  }

  document.getElementById("mapCaption").textContent = caption;
  document.getElementById("pointCount").textContent =
    `${points.length} locations`;

}S