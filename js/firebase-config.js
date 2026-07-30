/**
 * firebase-config.js
 * -------------------------------------------------------------------------
 * Central Firebase initialisation for the G-Set Patient Registry.
 *
 * >>> BEFORE DEPLOYING <<<
 * Replace the placeholder values in `firebaseConfig` with the values from your
 * own Firebase project (Project settings > General > Your apps > Web app).
 * Everything else in the codebase imports the initialised services from here.
 *
 * This project uses the Firebase v10+ modular SDK loaded over CDN, so there is
 * no build step and it runs directly from GitHub Pages.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
//import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

// ---------------------------------------------------------------------------
// 1. Paste your Firebase web config below.
// ---------------------------------------------------------------------------
export const firebaseConfig = {
  apiKey: "AIzaSyC2LhmZV5_R08OOFqXEYlsHh6FGGAovORQ",
  authDomain: "g-set-registry.firebaseapp.com",
  projectId: "g-set-registry",
  storageBucket: "g-set-registry.firebasestorage.app",
  messagingSenderId: "69522527412",
  appId: "1:69522527412:web:451f39e97cfdbd3d3373e1",
};

// The Superuser email. Only this account may bootstrap and manage users.
// The password is NEVER stored in code — create it in the Firebase console.
export const SUPERUSER_EMAIL = "Mrraphiri@outlook.com";

// ---------------------------------------------------------------------------
// 2. Initialise services (imported everywhere else in the app).
// ---------------------------------------------------------------------------
const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
//export const storage = getStorage(app);
export { serverTimestamp };

/**
 * Firestore collection names, centralised so a rename never breaks a query.
 */
export const COL = {
  users: "users",
  patients: "patients",
  facilities: "facilities",
  stations: "emsStations",
  districts: "districts",
  vehicles: "vehicles",
  audit: "auditLogs",
  counters: "counters",
  meta: "meta",
};

/**
 * Role constants and a simple capability matrix. The UI reads this to show or
 * hide controls; Firestore security rules enforce the same rules server-side.
 */
export const ROLES = {
  SUPERUSER: "Superuser",
  ECC: "ECC Personnel",
  SUBDISTRICT: "Sub-District Manager",
  DISTRICT: "District Manager",
  EXECUTIVE: "EMS Executive",
};

export const ROLE_LIST = Object.values(ROLES);

/** Capabilities keyed by role. Kept in sync with firestore.rules. */
export const CAPS = {
  [ROLES.SUPERUSER]: {
    manageUsers: true, capturePatient: true, closeJourney: true,
    manageFacilities: true, manageVehicles: true, viewAudit: true,
    exportReports: true, viewDashboard: true, viewHeatmaps: true, adminSetup: true,
  },
  [ROLES.ECC]: {
    manageUsers: false, capturePatient: true, closeJourney: true,
    manageFacilities: false, manageVehicles: false, viewAudit: false,
    exportReports: false, viewDashboard: true, viewHeatmaps: true, adminSetup: false,
  },
  [ROLES.SUBDISTRICT]: {
    manageUsers: false, capturePatient: false, closeJourney: false,
    manageFacilities: false, manageVehicles: false, viewAudit: false,
    exportReports: true, viewDashboard: true, viewHeatmaps: true, adminSetup: false,
  },
  [ROLES.DISTRICT]: {
    manageUsers: false, capturePatient: false, closeJourney: false,
    manageFacilities: false, manageVehicles: false, viewAudit: false,
    exportReports: true, viewDashboard: true, viewHeatmaps: true, adminSetup: false,
  },
  [ROLES.EXECUTIVE]: {
    manageUsers: false, capturePatient: false, closeJourney: false,
    manageFacilities: false, manageVehicles: false, viewAudit: false,
    exportReports: true, viewDashboard: true, viewHeatmaps: true, adminSetup: false,
  },
};
