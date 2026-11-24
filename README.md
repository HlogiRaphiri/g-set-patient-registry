# G-Set Patient Registry

**Gauteng Emergency Medical Services — Patient Transfer Registry**

A production-oriented, fully responsive web application for capturing and tracking
inter-facility patient transfers across Gauteng. It runs entirely on **free**
infrastructure: static files on **GitHub Pages** with **Firebase (Spark free
plan)** as the backend. No servers, no paid APIs, no subscriptions.

---

## 1. What's in the box

```
g-set/
├── index.html            # Login (no public sign-up)
├── home.html             # Welcome screen: greeting, live clock, weather, 3D tiles
├── capture.html          # Patient capture (dispatch-style form)
├── journeys.html         # Active / closed journeys, search, close-and-lock
├── dashboard.html        # KPIs + 11 charts + filters + recent table
├── heatmaps.html         # Leaflet/OSM pickup, receiving & density heatmaps
├── reports.html          # CSV / Excel / PDF / Print exports
├── admin.html            # Users, facilities, vehicles, audit, system setup
│
├── css/
│   └── styles.css        # Dark-navy CAD design system (glassmorphism, EMS orange)
├── js/
│   ├── firebase-config.js  # <-- PASTE YOUR FIREBASE CONFIG HERE
│   ├── app.js              # Auth guard, clock, weather, toasts, audit, incident IDs
│   ├── layout.js           # Shared sidebar + topbar shell
│   ├── data-service.js     # Cached Firestore loaders, patient CRUD, autocomplete
│   ├── stats.js            # Pure analytics functions
│   ├── seed.js             # Reference-data + facilities import
│   ├── login.js  home.js  capture.js  journeys.js
│   ├── dashboard.js  heatmaps.js  reports.js  admin.js
│   └── data/
│       └── seed-data.js    # Districts, all EMS stations, starter vehicles
├── data/
│   └── facilities.json     # 466 Gauteng facilities (normalised from the CSV)
├── assets/logo.png         # G-Set crest
│
├── firestore.rules         # Role-based security + journey locking
├── storage.rules
├── firebase.json           # Deploy config for the Firebase CLI
├── firestore.indexes.json
└── .nojekyll               # Lets GitHub Pages serve js/ folders untouched
```

## 2. Technology (all free)

GitHub Pages · Firebase Authentication · Firestore · Firebase Storage · HTML5 ·
CSS3 · JavaScript ES6 modules · Bootstrap 5 · Chart.js · Leaflet.js +
OpenStreetMap + Leaflet.heat · DataTables · SheetJS · jsPDF · Font Awesome ·
GSAP · Open-Meteo (no API key). Everything loads from CDNs, so there is **no
build step**.

---

## 3. Firebase setup (once)

1. Create a project at <https://console.firebase.google.com> (Spark / free plan).
2. **Authentication → Sign-in method →** enable **Email/Password**.
3. **Firestore Database →** create database in **Production mode** (region:
   `europe-west` or nearest).
4. **Project settings → General → Your apps →** add a **Web app** and copy the
   config object.
5. Paste it into `js/firebase-config.js`, replacing the `firebaseConfig`
   placeholders.

### Create the Superuser (no passwords in code)

The Superuser email is fixed to **`Mrraphiri@outlook.com`**. Create the account
manually so no password ever lives in the repo:

1. **Authentication → Users → Add user →** enter `Mrraphiri@outlook.com` and a
   strong password. Copy the generated **User UID**.
2. **Firestore → Start collection `users` →** add a document whose **ID is that
   UID**, with fields:

   | field    | value                    |
   |----------|--------------------------|
   | name     | `System Administrator`   |
   | email    | `Mrraphiri@outlook.com`  |
   | role     | `Superuser`              |
   | district | `` (empty)               |
   | disabled | `false` (boolean)        |

That's the only account you create by hand. Every other user is created from
**Admin → Users** inside the app.

### Deploy the security rules

Either paste `firestore.rules` / `storage.rules` into the console
(**Firestore → Rules**, **Storage → Rules**), or use the CLI:

```bash
npm i -g firebase-tools
firebase login
firebase use --add            # pick your project
firebase deploy --only firestore:rules,storage:rules,firestore:indexes
```

### Seed the reference data

Sign in as the Superuser → **Admin → System Setup → Run Import**. This writes the
5 districts, all EMS stations, starter vehicles and the **466 facilities** into
Firestore (idempotent — safe to re-run).

---

## 4. Deploy to GitHub Pages

1. Create a repository and push these files to the `main` branch.
   ```bash
   git init && git add . && git commit -m "G-Set Patient Registry"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
2. **Repo → Settings → Pages →** Source = `Deploy from a branch`, Branch =
   `main` / `/ (root)` → Save.
3. Add your Pages domain to **Firebase → Authentication → Settings → Authorized
   domains** (e.g. `<you>.github.io`).
4. Open `https://<you>.github.io/<repo>/` and sign in.

> The `.nojekyll` file is required so GitHub Pages serves the `js/` module
> folders without Jekyll processing.

---

## 5. Roles & permissions

| Capability            | Superuser | ECC | Sub-District | District | Executive |
|-----------------------|:--------:|:---:|:------------:|:--------:|:---------:|
| Capture patients      | ✅ | ✅ | — | — | — |
| Close journeys        | ✅ | ✅ | — | — | — |
| Dashboard & heatmaps  | ✅ | ✅ | ✅ | ✅ | ✅ |
| Export reports        | ✅ | — | ✅ | ✅ | ✅ |
| Manage users          | ✅ | — | — | — | — |
| Manage facilities/vehicles | ✅ | — | — | — | — |
| View audit logs       | ✅ | — | — | — | — |

Roles are enforced twice: the UI hides controls a role can't use, and
`firestore.rules` blocks the same operations server-side.

---

## 6. Firestore schema

**`users/{uid}`** — `name, email, role, district, disabled, createdAt`

**`patients/{autoId}`**
```
incidentNumber   "GS-20260729-000001"   // unique, sequential, date-based
date, referringFacility, referringDistrict, referringLat, referringLng,
receivingFacility, receivingLat, receivingLng,
district, station, vehicle,
patientName, age, gender, diagnosis,
status            "Active" | "Closed",
closed            boolean,               // true == permanently locked
capturedByUid, capturedByName, createdAt,
timeDelivered, closedBy, closedAt        // set only on close
```

**`facilities/{id}`** — `name, district, type, lat, lng, keywords`
**`emsStations/{id}`** — `name, district, code`
**`districts/{id}`** — `name`
**`vehicles/{id}`** — `registration, district, type`
**`counters/incident-YYYYMMDD`** — `value, ymd` (drives incident numbering)
**`counters/stats-*`** — running totals behind the public dashboard
(`stats-all`, `stats-routes`, `stats-day-YYYY-MM-DD`, `stats-shift-<date>-day|night`).
Updated in the same atomic batch as every capture, close and vehicle correction;
see `js/registry-stats.js`.
**`auditLogs/{autoId}`** — `action, details, actorUid, actorName, actorEmail, actorRole, at`

### Incident numbers

Generated in a Firestore **transaction** against a per-day counter document, so
concurrent captures can never collide or duplicate. Format:
`GS-<YYYYMMDD>-<000001>`.

### Journey locking

A journey is created with `closed:false`. Closing captures `timeDelivered`,
sets `closed:true` / `status:"Closed"`. The security rule only allows an update
that transitions `closed` from `false`→`true`; any attempt to edit a closed
record (or re-open one) is rejected.

---

## 7. Notes on the free tier

- **User creation** uses a *secondary* Firebase app instance in the browser, so
  provisioning a new account never signs the Superuser out. This avoids the
  Admin SDK, which would require the paid Blaze plan.
- **Disabling a user** sets a `disabled` flag that the auth guard enforces on
  every page load (the user is signed out immediately). To also disable the
  account at the Firebase Auth level, toggle it in **Authentication → Users**.
- **Password resets** use Firebase's built-in `sendPasswordResetEmail`.
- **Read budget (50,000/day).** No page reads the whole register on open:
  - The public snapshot is rebuilt from the `counters/stats-*` running totals
    plus the open journeys (~35 + open reads), at most once per 30 minutes per
    browser.
  - The journey reminder uses a count query (1 read) at most every 5 minutes.
  - Journeys loads every open journey plus the newest 300; "Load older journeys"
    pages further back.
  - Dashboard, Heatmaps and Reports open on the last 7 days (about 1,400 reads
    each). Widening the dates loads more, and ranges over 5,000 records ask first.
- **Statistics rebuild.** After first deploying the running totals, or if
  **Admin → System Setup → Check Statistics** reports a mismatch, run
  **Rebuild Statistics** at a quiet hour. It reads every patient record once.
  Until the first rebuild, the public snapshot is left as it was.
- **Index exemptions.** `firestore.indexes.json` exempts the counter maps from
  indexing (keeps the large `stats-routes` document under Firestore's 40,000
  index-entry limit). Deploy it with
  `firebase deploy --only firestore:indexes`.

---

## 8. Audit trail

Every meaningful action is logged: Login, Logout, Patient Created, Patient
Closed, Report Exported, User Created, Password Reset, Facility Added, Vehicle
Added, User Enabled/Disabled, System Seeded. Logs are append-only and readable
only by the Superuser (**Admin → Audit Logs**).

---

## 9. Sample data for testing

After seeding, sign in as an ECC user and capture a few transfers, or add test
records directly in Firestore under `patients` following the schema above. The
dashboard, heatmaps and reports populate automatically.

---

*Built for Gauteng EMS. Deployable entirely on GitHub Pages + Firebase free tier.*
