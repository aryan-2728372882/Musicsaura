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

function startSync(uid) {
  stopSync();
  currentUid = uid;
  unsubSnapshot = onSnapshot(doc(db, "users", uid), (snap) => {
    if (!snap.exists()) return;
    const d = snap.data();
    if (minutesEl) minutesEl.textContent = Math.round(d.minutesListened || 0).toLocaleString();
    if (songsEl) songsEl.textContent = (d.songsPlayed || 0).toLocaleString();
  }, (err) => console.error("Snapshot error:", err));
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

// ─── AUTH SYNC ─────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.href = "auth.html";
    return;
  }

  const initial = (user.displayName?.[0] || user.email?.[0] || "U").toUpperCase();
  const fallback = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Ccircle cx='50' cy='50' r='50' fill='%238a5cf6'/%3E%3Ctext x='50%25' y='50%25' font-size='38' fill='white' text-anchor='middle' dy='.35em'%3E${initial}%3C/text%3E%3C/svg%3E`;

  if (avatarEl) avatarEl.src = user.photoURL || fallback;
  if (nameEl) nameEl.textContent = user.displayName || "MusicsAura Listener";
  if (emailEl) emailEl.textContent = user.email || "";
  if (newNameEl) newNameEl.value = user.displayName || "";

  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (snap.exists()) {
      const d = snap.data();
      if (minutesEl) minutesEl.textContent = Math.round(d.minutesListened || 0).toLocaleString();
      if (songsEl) songsEl.textContent = (d.songsPlayed || 0).toLocaleString();
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
