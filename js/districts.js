/**
 * districts.js — one canonical spelling for every Gauteng district.
 *
 * WHY THIS EXISTS
 * The same district was being stored in two different forms, so charts showed
 * "WEST RAND" and "West Rand" as separate slices of the same pie.
 *
 * The cause is the same one that produced the Null Island routes. On capture:
 *
 *     referringDistrict: up(ref?.district || "")     // UPPERCASE, or "" if
 *                                                    // the facility didn't match
 *     district:          $("district").value         // Title Case, from the
 *                                                    // districts reference list
 *
 * and every aggregation then reads `r.referringDistrict || r.district`. When
 * the facility resolved, the district arrived UPPERCASE. When it did not, the
 * empty string fell through to the Title Case value — so one unmatched facility
 * name split a district into two chart entries.
 *
 * Records already written cannot be corrected (clinical fields are frozen once
 * a journey closes), so normalisation happens at READ time. Every aggregation
 * must route district names through canonicalDistrict() before grouping.
 */

/** The five Gauteng health districts, spelled as the reference data spells them. */
export const DISTRICTS = [
  "City of Johannesburg",
  "City of Ekurhuleni",
  "City of Tshwane",
  "Sedibeng",
  "West Rand",
];

/** Reduce a name to a comparison key: letters and digits only, lower case. */
const key = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Known variants seen in captured data and in imported reference files,
 * mapped to their canonical form. Keys are already reduced by key().
 *
 * "westrand" covers both "WestRand" (as it arrived in the fleet CSV) and
 * "WEST RAND", since punctuation and spacing are stripped before lookup.
 */
const ALIASES = {
  cityofjohannesburg: "City of Johannesburg",
  johannesburg: "City of Johannesburg",
  joburg: "City of Johannesburg",
  jhb: "City of Johannesburg",
  coj: "City of Johannesburg",

  cityofekurhuleni: "City of Ekurhuleni",
  ekurhuleni: "City of Ekurhuleni",
  ekurhuleni2: "City of Ekurhuleni",
  ekhuruleni: "City of Ekurhuleni",   // common misspelling
  coe: "City of Ekurhuleni",

  cityoftshwane: "City of Tshwane",
  tshwane: "City of Tshwane",
  pretoria: "City of Tshwane",
  cot: "City of Tshwane",

  sedibeng: "Sedibeng",

  westrand: "West Rand",
  wr: "West Rand",
};

/* Every canonical name resolves to itself. */
for (const d of DISTRICTS) ALIASES[key(d)] = d;

/**
 * Canonical spelling for a district name.
 *
 * Unrecognised names are returned trimmed but otherwise unchanged rather than
 * being forced into a district they may not belong to — a wrong district is
 * worse than an odd-looking one, because nobody notices a wrong one.
 *
 * @param {string} name
 * @returns {string} canonical name, or "" when there is nothing to normalise
 */
export function canonicalDistrict(name) {
  const raw = String(name ?? "").trim();
  if (!raw) return "";
  return ALIASES[key(raw)] || raw;
}

/** True when the name maps onto one of the five recognised districts. */
export function isKnownDistrict(name) {
  return Boolean(ALIASES[key(name)]);
}

/**
 * The district a journey should be counted under: the referring facility's
 * district where known, otherwise the district chosen on the form. Both are
 * normalised, so the two storage forms collapse into one.
 */
export function rowDistrict(row) {
  return canonicalDistrict(row?.referringDistrict || row?.district || "");
}
