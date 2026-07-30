/**
 * login.js — authentication only. There is deliberately no account-creation
 * path anywhere in the app; only the Superuser provisions users.
 */

import { auth, db, COL } from "./firebase-config.js";
import {
  signInWithEmailAndPassword, onAuthStateChanged,
  sendPasswordResetEmail, setPersistence, browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, addDoc, collection, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const form = document.getElementById("loginForm");
const emailEl = document.getElementById("email");
const pwEl = document.getElementById("password");
const errEl = document.getElementById("loginError");
const btn = document.getElementById("loginBtn");

// If a disabled account tried to sign in, surface it.
if (new URLSearchParams(location.search).get("disabled")) {
  errEl.textContent = "This account has been disabled. Contact your administrator.";
}

// Already signed in? Skip straight to the app.
onAuthStateChanged(auth, async (user) => {
  if (user) {
    const snap = await getDoc(doc(db, COL.users, user.uid));
    if (snap.exists() && !snap.data().disabled) location.replace("home.html");
  }
});

// Show / hide password.
document.getElementById("pwToggle").addEventListener("click", () => {
  const show = pwEl.type === "password";
  pwEl.type = show ? "text" : "password";
  document.querySelector("#pwToggle i").className = show ? "fa-solid fa-eye-slash" : "fa-solid fa-eye";
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errEl.textContent = "";
  const email = emailEl.value.trim();
  const pw = pwEl.value;
  if (!email || !pw) { errEl.textContent = "Enter your email and password."; return; }

  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Signing in…`;

  try {
    await setPersistence(auth, browserLocalPersistence);
    const cred = await signInWithEmailAndPassword(auth, email, pw);

    // Verify a profile exists and the account isn’t disabled.
    const snap = await getDoc(doc(db, COL.users, cred.user.uid));
    if (!snap.exists()) {
      errEl.textContent = "No profile is linked to this account. Contact your administrator.";
      await auth.signOut();
      resetBtn();
      return;
    }
    if (snap.data().disabled) {
      errEl.textContent = "This account has been disabled.";
      await auth.signOut();
      resetBtn();
      return;
    }

    // Best-effort login audit (rules permit self-authored login records).
    try {
      await addDoc(collection(db, COL.audit), {
        action: "Login", details: {}, actorUid: cred.user.uid,
        actorName: snap.data().name, actorEmail: email, actorRole: snap.data().role,
        at: serverTimestamp(),
      });
    } catch (_) {}

    location.replace("home.html");
  } catch (err) {
    errEl.textContent = friendly(err.code);
    resetBtn();
  }
});

document.getElementById("forgotLink").addEventListener("click", async (e) => {
  e.preventDefault();
  const email = emailEl.value.trim();
  if (!email) { errEl.textContent = "Enter your email above first, then click Forgot password."; return; }
  try {
    await sendPasswordResetEmail(auth, email);
    errEl.className = "text-success mb-2";
    errEl.style.minHeight = "1.1em";
    errEl.textContent = "If that email is registered, a reset link is on its way.";
  } catch (err) {
    errEl.className = "text-danger mb-2";
    errEl.textContent = friendly(err.code);
  }
});

function resetBtn() {
  btn.disabled = false;
  btn.innerHTML = `<i class="fa-solid fa-right-to-bracket me-1"></i> Sign in`;
}

function friendly(code) {
  switch (code) {
    case "auth/invalid-email": return "That email address doesn’t look right.";
    case "auth/user-disabled": return "This account has been disabled.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential": return "Incorrect email or password.";
    case "auth/too-many-requests": return "Too many attempts. Try again in a few minutes.";
    case "auth/network-request-failed": return "Network error. Check your connection.";
    default: return "Sign-in failed. Please try again.";
  }
}
