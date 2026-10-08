// scripts/user.js — MusicsAura 3.0 User Profile Controller
import {
  auth, db, provider,
  onAuthStateChanged, signOut, deleteUser, reauthenticateWithPopup,
  doc, getDoc, onSnapshot, updateDoc, deleteDoc
} from "./firebase-config.js";

const avatarEl       = document.getElementById("avatar");
const nameEl         = document.getElementById("display-name");
const emailEl        = document.getElementById("email");
const minutesEl      = document.getElementById("minutes");
const songsEl        = document.getElementById("songs");
const newNameEl      = document.getElementById("new-name");
const saveBtnEl      = document.getElementById("save-name");
const favoritesList  = document.getElementById("favorites-list");
const favCountEl     = document.getElementById("fav-count");
const logoutBtn      = document.getElementById("logout");
const deleteAccBtn   = document.getElementById("delete-account");

let unsubSnapshot = null;
let currentUid    = null;

function stopSync() {
  if (typeof unsubSnapshot === "function") {
    unsubSnapshot();
    unsubSnapshot = null;
  }
}

async function startSync(uid) {
  stopSync();
  currentUid = uid;
  try {
    // 0ms visual rendering from local cache
    const localStats = JSON.parse(localStorage.getItem("musicsaura_local_stats") || "{}");
    if (minutesEl && localStats.minutesListened) minutesEl.textContent = Math.round(localStats.minutesListened).toLocaleString();
    if (songsEl && localStats.songsPlayed) songsEl.textContent = (localStats.songsPlayed).toLocaleString();

    // One-shot fetch (1 read total on profile open instead of continuous streaming)
    const snap = await getDoc(doc(db, "users", uid));
    if (snap.exists()) {
      const d = snap.data();
      if (minutesEl) minutesEl.textContent = Math.round(d.minutesListened || 0).toLocaleString();
      if (songsEl) songsEl.textContent = (d.songsPlayed || 0).toLocaleString();
    }
  } catch (err) {
    console.warn("User stats load:", err);
  }
}

// ─── FAVORITES MANAGEMENT ──────────────────────────────────────────
function loadFavorites() {
  if (!favoritesList) return;

  try {
    const raw = localStorage.getItem("musicsaura_favorites") || "[]";
    const favs = JSON.parse(raw);

    if (favCountEl) favCountEl.textContent = `${favs.length} songs`;

    if (!favs.length) {
      favoritesList.innerHTML = `<div class="empty-state">No favorite songs yet. Click the heart icon on any track to add it here!</div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    favs.forEach((song, idx) => {
      const item = document.createElement("div");
      item.className = "fav-item";
      const thumb = song.thumbnail || "assets/logo.png";

      item.innerHTML = `
        <img src="${thumb}" alt="" class="fav-thumb" onerror="this.src='assets/logo.png'">
        <div class="fav-info">
          <div class="fav-title">${escapeHtml(song.title)}</div>
          <div class="fav-artist">${escapeHtml(song.artist || "Unknown")}</div>
        </div>
        <button class="action-btn remove-fav-btn" data-index="${idx}" title="Remove from favorites">
          <span class="material-icons">favorite</span>
        </button>
      `;
      frag.appendChild(item);
    });

    favoritesList.replaceChildren(frag);

    favoritesList.querySelectorAll(".remove-fav-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const index = parseInt(btn.dataset.index, 10);
        removeFavorite(index);
      });
    });

  } catch (err) {
    console.error("Error reading favorites:", err);
  }
}

function removeFavorite(index) {
  try {
    const raw = localStorage.getItem("musicsaura_favorites") || "[]";
    const favs = JSON.parse(raw);
    favs.splice(index, 1);
    localStorage.setItem("musicsaura_favorites", JSON.stringify(favs));
    loadFavorites();
  } catch (e) {
    console.error(e);
  }
}

function escapeHtml(str) {
  return (str || "").toString().replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[m]);
}

// ─── DYNAMIC NAME AVATAR GENERATOR ─────────────────────────────────
export function generateNameAvatar(nameOrEmail, size = 100) {
  const text = (nameOrEmail || "Listener").trim();
  const clean = text.replace(/@.*$/, "").trim();
  const parts = clean.split(/[\s._-]+/).filter(Boolean);
  let initials = "U";
  if (parts.length >= 2) {
    initials = (parts[0][0] + parts[1][0]).toUpperCase();
  } else if (parts.length === 1 && parts[0].length > 0) {
    initials = parts[0].slice(0, Math.min(2, parts[0].length)).toUpperCase();
  }

  const palettes = [
    ["#8a5cf6", "#6366f1"],
    ["#ec4899", "#8b5cf6"],
    ["#3b82f6", "#06b6d4"],
    ["#10b981", "#3b82f6"],
    ["#f59e0b", "#ef4444"],
    ["#8b5cf6", "#d946ef"],
    ["#06b6d4", "#3b82f6"]
  ];
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = text.charCodeAt(i) + ((hash << 5) - hash);
  const [col1, col2] = palettes[Math.abs(hash) % palettes.length];
  const fontSize = Math.round(size * 0.42);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${col1}"/><stop offset="100%" stop-color="${col2}"/></linearGradient></defs>` +
    `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="url(#g)"/>` +
    `<text x="50%" y="50%" font-size="${fontSize}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-weight="700" fill="#ffffff" text-anchor="middle" dominant-baseline="central">${initials}</text>` +
    `</svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// ─── AUTH SYNC ─────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.href = "auth.html";
    return;
  }

  const displayName = user.displayName || "";
  const email = user.email || "";
  const nameAvatar = generateNameAvatar(displayName || email, 100);

  if (nameEl) nameEl.textContent = displayName || email?.split("@")[0] || "MusicsAura Listener";
  if (emailEl) emailEl.textContent = email;
  if (newNameEl) newNameEl.value = displayName;

  if (avatarEl) {
    avatarEl.referrerPolicy = "no-referrer";
    avatarEl.onerror = () => {
      avatarEl.onerror = null;
      avatarEl.src = nameAvatar;
    };
    avatarEl.src = user.photoURL || nameAvatar;
  }

  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (snap.exists()) {
      const d = snap.data();
      if (minutesEl) minutesEl.textContent = Math.round(d.minutesListened || 0).toLocaleString();
      if (songsEl) songsEl.textContent = (d.songsPlayed || 0).toLocaleString();

      const bestPhoto = user.photoURL || d.photoURL;
      if (bestPhoto && avatarEl && avatarEl.src !== bestPhoto) {
        avatarEl.src = bestPhoto;
      }

      // Keep Firestore user doc photo in sync with Google Auth
      if (user.photoURL && (!d.photoURL || d.photoURL !== user.photoURL)) {
        updateDoc(doc(db, "users", user.uid), { photoURL: user.photoURL }).catch(() => {});
      }
    }
  } catch {}

  startSync(user.uid);
  loadFavorites();
});

// Update Profile Display Name
if (saveBtnEl) {
  saveBtnEl.addEventListener("click", async () => {
    const user = auth.currentUser;
    if (!user) return;
    const name = newNameEl.value.trim();
    if (!name) {
      alert("Please enter a valid display name.");
      return;
    }

    saveBtnEl.disabled = true;
    saveBtnEl.textContent = "Saving...";

    try {
      await updateDoc(doc(db, "users", user.uid), { displayName: name });
      if (nameEl) nameEl.textContent = name;
      saveBtnEl.textContent = "Saved!";
      setTimeout(() => {
        saveBtnEl.disabled = false;
        saveBtnEl.textContent = "Save Changes";
      }, 2000);
    } catch (err) {
      alert("Error updating profile: " + err.message);
      saveBtnEl.disabled = false;
      saveBtnEl.textContent = "Save Changes";
    }
  });
}

// Delete Account Handler
if (deleteAccBtn) {
  deleteAccBtn.addEventListener("click", async () => {
    if (!confirm("Are you sure you want to permanently delete your MusicsAura account? All saved stats will be deleted.")) {
      return;
    }

    const user = auth.currentUser;
    if (!user) return;

    try {
      await reauthenticateWithPopup(user, provider);
      await deleteDoc(doc(db, "users", user.uid));
      await deleteUser(user);
      location.href = "auth.html";
    } catch (err) {
      alert("Could not delete account: " + err.message);
    }
  });
}

// Logout Handler
if (logoutBtn) {
  logoutBtn.addEventListener("click", () => {
    signOut(auth).then(() => { location.href = "auth.html"; });
  });
}

// Visibility change cleanup
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopSync();
  } else if (currentUid) {
    startSync(currentUid);
  }
});
