/**
 * seed-data.js
 * Static reference data for the G-Set Patient Registry.
 * Districts and EMS stations are defined here and pushed to Firestore
 * by the Superuser via the Admin > System Setup panel (see seed.js).
 */

export const DISTRICTS = [
  "City of Johannesburg",
  "City of Tshwane",
  "City of Ekurhuleni",
  "Sedibeng",
  "West Rand",
];

/**
 * EMS stations grouped by district, exactly as supplied in the brief.
 * `code` is a short stable identifier used for linking and reporting.
 */
export const EMS_STATIONS = [
  // City of Tshwane
  ["Prinshof EMS Station", "City of Tshwane"],
  ["Odi EMS Station", "City of Tshwane"],
  ["Temba EMS Station", "City of Tshwane"],
  ["Cullinan EMS Station", "City of Tshwane"],
  ["Ekangala EMS Station", "City of Tshwane"],
  ["Bronkhorstspruit EMS Station", "City of Tshwane"],
  ["Block JJ EMS Station", "City of Tshwane"],
  ["Laudium EMS Station", "City of Tshwane"],
  ["Mamelodi EMS Station", "City of Tshwane"],
  ["Kalafong EMS Station", "City of Tshwane"],
  ["DGMAH EMS Station", "City of Tshwane"],

  // City of Ekurhuleni
  ["Bertha Gxowa EMS Station", "City of Ekurhuleni"],
  ["Phillip Moyo EMS Station", "City of Ekurhuleni"],
  ["Daggafontein EMS Station", "City of Ekurhuleni"],
  ["Devon EMS Station", "City of Ekurhuleni"],
  ["Far East Rand EMS Station", "City of Ekurhuleni"],
  ["Goba EMS Station", "City of Ekurhuleni"],
  ["Itireleng EMS Station", "City of Ekurhuleni"],
  ["Nokuthela Ngwenya EMS Station", "City of Ekurhuleni"],
  ["Pholosong EMS Station", "City of Ekurhuleni"],
  ["Phola Park EMS Station", "City of Ekurhuleni"],
  ["Tambo Memorial EMS Station", "City of Ekurhuleni"],
  ["Tembisa EMS Station", "City of Ekurhuleni"],
  ["Thelle Mogoerane EMS Station", "City of Ekurhuleni"],
  ["Springs EMS Station", "City of Ekurhuleni"],
  ["Dunswart EMS Station", "City of Ekurhuleni"],

  // City of Johannesburg
  ["Edenvale EMS Station", "City of Johannesburg"],
  ["Discoveries EMS Station", "City of Johannesburg"],
  ["Chiawelo EMS Station", "City of Johannesburg"],
  ["Mofolo EMS Station", "City of Johannesburg"],
  ["Hillbrow EMS Station", "City of Johannesburg"],
  ["Imbalenhle EMS Station", "City of Johannesburg"],
  ["Lenasia EMS Station", "City of Johannesburg"],
  ["Lenasia South EMS Station", "City of Johannesburg"],
  ["Diepsloot EMS Station", "City of Johannesburg"],
  ["Tara EMS Station", "City of Johannesburg"],
  ["Midrand EMS Station", "City of Johannesburg"],
  ["Ebony EMS Station", "City of Johannesburg"],
  ["Orlando East EMS Station", "City of Johannesburg"],
  ["Tshepo Themba EMS Station", "City of Johannesburg"],
  ["BARA/ELDOS EMS Station", "City of Johannesburg"],
  ["Selby EMS Station", "City of Johannesburg"],
  ["Alex EMS Station", "City of Johannesburg"],
  ["Zola EMS Station", "City of Johannesburg"],

  // West Rand
  ["Dr. Yusuf Dadoo EMS Station", "West Rand"],
  ["Leratong EMS Station", "West Rand"],
  ["Bekkersdal EMS Station", "West Rand"],
  ["Carletonville EMS Station", "West Rand"],
  ["Fochville EMS Station", "West Rand"],
  ["Khutsong EMS Station", "West Rand"],
  ["Mohlakeng EMS Station", "West Rand"],
  ["Westonaria EMS Station", "West Rand"],
  ["Wedela EMS Station", "West Rand"],
  ["Sterkfontein EMS Station", "West Rand"],
  ["Magaliesburg EMS Station", "West Rand"],
  ["Muldersdrift EMS Station", "West Rand"],

  // Sedibeng
  ["Vanderbijlpark EMS Station", "Sedibeng"],
  ["Vereeniging EMS Station", "Sedibeng"],
  ["Heidelberg EMS Station", "Sedibeng"],
  ["Pontshong EMS Station", "Sedibeng"],
  ["Sebokeng EMS Station", "Sedibeng"],
  ["Evaton EMS Station", "Sedibeng"],
].map(([name, district]) => ({
  name,
  district,
  code: name.replace(/\s*EMS Station$/i, "").replace(/[^A-Za-z0-9]+/g, "_").toUpperCase(),
}));

/**
 * A small starter fleet of G-Set vehicle registrations so the app is usable
 * immediately after seeding. The Superuser can add more from the Admin panel.
 */
export const SAMPLE_VEHICLES = [
  { registration: "GS-001-GP", district: "City of Johannesburg", type: "Advanced Life Support" },
  { registration: "GS-002-GP", district: "City of Johannesburg", type: "Intermediate Life Support" },
  { registration: "GS-003-GP", district: "City of Tshwane", type: "Advanced Life Support" },
  { registration: "GS-004-GP", district: "City of Tshwane", type: "Basic Life Support" },
  { registration: "GS-005-GP", district: "City of Ekurhuleni", type: "Advanced Life Support" },
  { registration: "GS-006-GP", district: "City of Ekurhuleni", type: "Patient Transport" },
  { registration: "GS-007-GP", district: "West Rand", type: "Intermediate Life Support" },
  { registration: "GS-008-GP", district: "Sedibeng", type: "Advanced Life Support" },
];
