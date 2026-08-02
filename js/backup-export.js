/**
 * backup-export.js — off-platform backup for the G-Set Patient Registry.
 *
 * WHY THIS EXISTS
 * Firestore scheduled backups and point-in-time recovery are Blaze-plan
 * features. On the Spark plan there is no server-side recovery path at all: a
 * mistaken bulk delete, a faulty import script or a bad security-rules publish
 * cannot be rolled back. For a live provincial health register that is the
 * single largest risk carried by the platform.
 *
 * Until the project moves to Blaze, this module lets a Superuser pull a
 * complete, timestamped JSON copy of every collection and save it off-platform.
 *
 * COST WARNING
 * An export reads every document it copies, and Firestore bills per document
 * read (Spark allows 50,000 per day). Run it OUTSIDE peak shift hours and no
 * more than once a day. estimateReads() below reports the cost before you
 * commit to it.
 *
 * POPIA
 * The export contains full patient records. The resulting file is a health
 * record under the National Health Act and personal information under POPIA.
 * Store it encrypted, on departmental storage, with access restricted to
 * personnel who already have Superuser rights to the register. Do not place it
 * in personal cloud storage, personal email or an unencrypted USB drive.
 */

import { db, COL, ROLES } from "./firebase-config.js";
import { collection, getDocs, getCountFromServer } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/** Collections included in a full backup, in restore order. */
const BACKUP_COLLECTIONS = [
  COL.districts,
  COL.stations,
  COL.facilities,
  COL.vehicles,
  COL.users,
  COL.patients,
  COL.counters,
  COL.meta,
  COL.audit,
];

/** Firestore Timestamps and other SDK types must be flattened before JSON. */
function plain(value) {
  if (value === null || value === undefined) return value;
  if (typeof value?.toDate === "function") {
    return { __type: "timestamp", iso: value.toDate().toISOString() };
  }
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = plain(v);
    return out;
  }
  return value;
}

/**
 * Count documents without reading them. getCountFromServer bills one read per
 * batch of 1,000 rather than one per document, so checking the cost is cheap.
 * @returns {Promise<{counts: Record<string, number>, total: number}>}
 */
export async function estimateReads() {
  const counts = {};
  let total = 0;
  for (const name of BACKUP_COLLECTIONS) {
    try {
      const snap = await getCountFromServer(collection(db, name));
      counts[name] = snap.data().count;
      total += counts[name];
    } catch {
      counts[name] = null; // no permission, or collection absent
    }
  }
  return { counts, total };
}

/**
 * Read every collection into a single backup object.
 * @param {(msg: string) => void} [onProgress]
 */
export async function buildBackup(onProgress = () => {}) {
  const collections = {};
  let documentCount = 0;

  for (const name of BACKUP_COLLECTIONS) {
    onProgress(`Reading ${name}…`);
    try {
      const snap = await getDocs(collection(db, name));
      collections[name] = snap.docs.map((d) => ({ id: d.id, data: plain(d.data()) }));
      documentCount += snap.size;
    } catch (err) {
      // A collection the current role cannot read must be recorded as a gap,
      // never silently omitted — a backup with an invisible hole is worse than
      // no backup, because it will be trusted.
      collections[name] = { __error: String(err?.code || err?.message || err) };
    }
  }

  return {
    meta: {
      system: "G-Set Patient Registry",
      exportedAt: new Date().toISOString(),
      exportedAtSAST: new Date().toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" }),
      schemaVersion: 1,
      documentCount,
      collections: BACKUP_COLLECTIONS,
      note: "Contains patient-identifying data. Handle as a health record under POPIA and the National Health Act.",
    },
    collections,
  };
}

/** Trigger a browser download of the backup as JSON. */
export function downloadBackup(backup) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `gset-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Full flow: confirm the read cost, export, download.
 * Gate this behind a Superuser check in the calling code.
 *
 * @param {(msg: string) => void} [onProgress]
 * @param {(question: string) => Promise<boolean>|boolean} [confirmFn]
 */
export async function runBackup(onProgress = () => {}, confirmFn = window.confirm) {
  onProgress("Counting records…");
  const { counts, total } = await estimateReads();

  const lines = Object.entries(counts)
    .map(([k, v]) => `  ${k}: ${v === null ? "no access" : v.toLocaleString("en-ZA")}`)
    .join("\n");

  const ok = await confirmFn(
    `Full backup will read ${total.toLocaleString("en-ZA")} documents.\n\n${lines}\n\n` +
    `The Spark plan allows 50,000 reads per day. Continue?`
  );
  if (!ok) { onProgress("Backup cancelled."); return null; }

  const backup = await buildBackup(onProgress);
  downloadBackup(backup);
  onProgress(`Backup complete — ${backup.meta.documentCount.toLocaleString("en-ZA")} documents exported.`);
  return backup;
}

/** Convenience guard for the admin panel. */
export const canBackup = (profile) => profile?.role === (ROLES?.SUPERUSER ?? "Superuser");
