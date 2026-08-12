/**
 * support-chat.js — short-lived support channel between ECC personnel and the
 * system administrator.
 *
 * WHAT "EPHEMERAL" MEANS HERE — read this before relying on it.
 * Messages ARE written to Firestore. There is no way to relay a message between
 * two browsers on a static site without something in the middle holding it.
 * What this module guarantees instead is that messages are short-lived:
 *
 *   - Every message carries an `expiresAt` stamp (default 2 hours).
 *   - Security rules refuse to return an expired message, so it becomes
 *     unreadable at the deadline whether or not it has been deleted yet.
 *   - Both participants purge expired messages whenever they open the panel,
 *     so documents are removed in normal use.
 *
 * A message may therefore sit on disk for a short period after expiry, and any
 * backup taken in that window will contain it. Do not describe this channel to
 * staff as "not recorded" — describe it as "cleared automatically after two
 * hours". Those are different promises and only the second one is true.
 *
 * POPIA
 * The channel is for operational support, not clinical discussion. sanitise()
 * blocks South African ID numbers and incident numbers outright, because those
 * identify a patient directly. It cannot detect a name typed in prose — that
 * relies on the on-screen warning and on user training.
 *
 * READ COST
 * One listener per participant, scoped to a single thread and capped at
 * MAX_HISTORY. Firestore bills a read when a message arrives, not per second,
 * so an idle panel costs nothing. The administrator's inbox listens to small
 * summary documents rather than to every message in every thread.
 */

import { db, ROLES } from "./firebase-config.js";
import {
  collection, doc, addDoc, deleteDoc, setDoc, getDocs,
  query, where, orderBy, limit, onSnapshot, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const THREADS = "supportThreads";
const MESSAGES = "messages";

const TTL_MINUTES = 120;      // how long a message remains readable
const MAX_HISTORY = 60;       // messages held in a thread view
const MAX_LENGTH = 600;       // per message

/* ------------------------------------------------------- content guard */

/**
 * Reject content that identifies a patient.
 *
 * Deliberately conservative: it is better to block a legitimate message and
 * make the operator rephrase than to let an ID number into a channel that
 * carries no audit trail.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
export function sanitise(text) {
  const t = String(text ?? "").trim();
  if (!t) return { ok: false, reason: "Nothing to send." };
  if (t.length > MAX_LENGTH) return { ok: false, reason: `Keep it under ${MAX_LENGTH} characters.` };

  // SA ID number: 13 digits, optionally spaced or hyphenated.
  if (/(?:\D|^)(\d[\s-]?){13}(?:\D|$)/.test(t)) {
    return { ok: false, reason: "That looks like an ID number. This channel must not carry patient-identifying information." };
  }
  // Incident number ties directly to one patient record.
  if (/GS-\d{8}-\d{6}/i.test(t)) {
    return { ok: false, reason: "Incident numbers identify a patient. Describe the problem without it, or raise it through the journeys page." };
  }
  return { ok: true };
}

/* ------------------------------------------------------------ plumbing */

const threadRef = (uid) => doc(db, THREADS, uid);
const msgsRef = (uid) => collection(db, THREADS, uid, MESSAGES);

const expiryStamp = () => new Date(Date.now() + TTL_MINUTES * 60000);

/** True when a message is past its readable life. */
const isExpired = (m) => {
  const exp = m?.expiresAt?.toDate ? m.expiresAt.toDate() : m?.expiresAt ? new Date(m.expiresAt) : null;
  return exp ? exp.getTime() <= Date.now() : false;
};

/**
 * Delete expired messages in a thread. Called on open by whichever participant
 * happens to be looking.
 *
 * Failures are ignored: expired messages are already unreadable under the
 * security rules, so a failed purge is untidy rather than a disclosure.
 */
export async function purgeExpired(uid) {
  try {
    const snap = await getDocs(query(msgsRef(uid), where("expiresAt", "<=", new Date())));
    await Promise.all(snap.docs.map((d) => deleteDoc(d.ref).catch(() => {})));
    return snap.size;
  } catch {
    return 0;
  }
}

/**
 * Send a message. Rejects patient-identifying content before it reaches
 * Firestore.
 *
 * @param {string} threadUid  the ECC user's uid — the thread is always keyed to
 *                            the requester, so the administrator replies into
 *                            the same thread rather than opening a new one
 * @param {object} profile    sender profile
 * @param {string} text
 */
export async function sendMessage(threadUid, profile, text) {
  const check = sanitise(text);
  if (!check.ok) throw new Error(check.reason);

  await addDoc(msgsRef(threadUid), {
    body: String(text).trim(),
    fromUid: profile?.uid || window.__gset?.user?.uid || "",
    fromName: profile?.name || "Unknown",
    fromRole: profile?.role || "",
    createdAt: serverTimestamp(),
    expiresAt: expiryStamp(),
  });

  // Thread summary: lets the administrator see who needs attention without a
  // listener on every thread. Carries no message content.
  await setDoc(threadRef(threadUid), {
    uid: threadUid,
    lastFrom: profile?.name || "Unknown",
    lastRole: profile?.role || "",
    lastAt: serverTimestamp(),
    expiresAt: expiryStamp(),
  }, { merge: true });
}

/**
 * Subscribe to a thread.
 * @returns {() => void} unsubscribe
 */
export function subscribeThread(threadUid, onMessages, onError) {
  const q = query(msgsRef(threadUid), orderBy("createdAt", "desc"), limit(MAX_HISTORY));
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((m) => !isExpired(m))          // hide the moment it expires,
        .reverse();                            // even before the purge runs
      onMessages(rows);
    },
    (err) => { if (onError) onError(err); }
  );
}

/** Administrator inbox: threads with recent activity, newest first. */
export function subscribeThreads(onThreads, onError) {
  const q = query(collection(db, THREADS), orderBy("lastAt", "desc"), limit(25));
  return onSnapshot(
    q,
    (snap) => onThreads(snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => !isExpired(t))),
    (err) => { if (onError) onError(err); }
  );
}

export const isAdmin = (profile) => profile?.role === (ROLES?.SUPERUSER ?? "Superuser");
export const chatConfig = { TTL_MINUTES, MAX_LENGTH, MAX_HISTORY };
