// scripts/app.js — MusicsAura 2025
import { auth, onAuthStateChanged } from "./firebase-config.js";
import { player } from "./player.js";

/* ── DOM ── */
const grid        = document.getElementById("grid");
const searchGrid  = document.getElementById("search-grid");
const searchInp   = document.getElementById("search");
const profileBtn  = document.getElementById("profile-btn");
const navAvatar   = document.getElementById("nav-avatar");

/* ── Genre pills (flat strip, no dropdown) ── */
const genreItems  = document.querySelectorAll(".genre-pill");

/* ── State ── */
const GENRE_FILES = {
  hindi:    "/jsons/hindi.json",
  punjabi:  "/jsons/punjabi.json",
  haryanvi: "/jsons/haryanvi.json",
  bhojpuri: "/jsons/bhojpuri.json",
  "50s":    "/jsons/50s.json",
  remix:    "/jsons/remix.json"
};
const DEFAULT_GENRE = "hindi";

let allSongs       = [];
const songsByGenre = {};
const loadPromises = new Map();
let activeGenre    = DEFAULT_GENRE;
let searchTimer    = null;

/* ── Init grids ── */
grid.hidden = false;
searchGrid.hidden = true;

/* ── Theme ── */
(function initTheme() {
  const saved = localStorage.getItem("vt-theme");
  document.body.classList.toggle("dark-theme", saved !== "light");
  document.body.classList.toggle("light-theme", saved === "light");
})();

/* ── HTML escape ── */
function esc(s) {
  return (s || "").toString().replace(/[&<>"'`]/g, c =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;","`":"&#96;" })[c]);
}

/* ── Normalize song ── */
function normalizeSong(song, genre) {
  let kw = song.keywords || [];
  if (typeof kw === "string") kw = kw.split(/[,;]/).map(x => x.trim());
  else if (Array.isArray(kw)) kw = kw.flatMap(k => typeof k === "string" ? k.split(/[,;]/).map(x => x.trim()) : []);
  else kw = [];

  const titleW  = song.title  ? song.title.split(/\s+/) : [];
  const artistW = song.artist ? song.artist.split(/[,&/]+|\s+/) : [];
  const keywords = Array.from(new Set([...kw, ...titleW, ...artistW].map(w => w.toLowerCase().trim()).filter(Boolean)));
  return {
    ...song,
    keywords,
    genre,
    _search: `${song.title || ""} ${song.artist || ""} ${keywords.join(" ")}`.toLowerCase()
  };
}

/* ── Load genre ── */
async function loadGenre(genre) {
  if (songsByGenre[genre]) return songsByGenre[genre];
  if (loadPromises.has(genre)) return loadPromises.get(genre);

  const file = GENRE_FILES[genre];
  if (!file) return [];

  const p = (async () => {
    try {
      const res = await fetch(file, { cache: "no-store" });
      if (!res.ok) return [];
      const data = await res.json();
      // Filter out blank entries
      const songs = data
        .filter(s => s.title && s.link)
        .map(s => normalizeSong(s, genre));
      songsByGenre[genre] = songs;
      allSongs.push(...songs);
      return songs;
    } catch (err) {
      console.error(`Failed to load ${file}:`, err);
      songsByGenre[genre] = [];
      return [];
    } finally {
      loadPromises.delete(genre);
    }
  })();

  loadPromises.set(genre, p);
  return p;
}

/* ── Create card ── */
function createCard(song, index) {
  const el = document.createElement("div");
  el.className = "song-card";
  el.dataset.index = String(index);
  el.innerHTML = `
    <div class="card-img-wrap">
      <img src="${esc(song.thumbnail || "")}" loading="lazy" alt="${esc(song.title || "")}" onerror="this.style.opacity=.3">
    </div>
    <div class="card-info">
      <div class="card-title">${esc(song.title || "")}</div>
      <div class="card-artist">${esc(song.artist || "")}</div>
    </div>`;
  return el;
}

/* ── Render song list ── */
function renderSongList(container, songs, empty = null) {
  const frag = document.createDocumentFragment();
  if (!songs.length && empty) {
    const p = document.createElement("p");
    p.className = "state-msg";
    p.textContent = empty;
    frag.appendChild(p);
  } else {
    songs.forEach((song, i) => frag.appendChild(createCard(song, i)));
  }
  container.replaceChildren(frag);
  container._songs = songs;
}

/* ── Genre select ── */
async function selectGenre(genre) {
  activeGenre = genre;

  genreItems.forEach(pill => {
    pill.classList.toggle("active", pill.dataset.genre === genre);
  });

  grid.hidden = false;
  searchGrid.hidden = true;
  searchInp.value = "";

  if (!songsByGenre[genre]) {
    grid.innerHTML = '<p class="state-msg">Loading…</p>';
    await loadGenre(genre);
  }
  renderGenre(genre);
}

function renderGenre(genre) {
  const songs = songsByGenre[genre] || [];
  renderSongList(grid, songs);
}

/* ── Search ── */
function searchSongs(q) {
  q = (q || "").trim().toLowerCase();
  if (!q) {
    searchGrid.hidden = true;
    grid.hidden = false;
    return;
  }
  const matches = allSongs.filter(s => s._search.includes(q));
  renderSongList(searchGrid, matches, "No songs found");
  grid.hidden = true;
  searchGrid.hidden = false;
}

/* ── Click delegation ── */
function setupClickHandler(container) {
  if (container._bound) return;
  container._bound = true;
  container.addEventListener("click", e => {
    const card = e.target.closest(".song-card");
    if (!card) return;
    const songs = container._songs || [];
    const idx   = parseInt(card.dataset.index || "-1", 10);
    if (idx < 0 || !songs[idx]) return;
    player.setPlaylist(songs, idx);
    player.playSong(songs[idx]);
  });
}

/* ── Genre pills events ── */
genreItems.forEach(pill => {
  pill.addEventListener("click", () => selectGenre(pill.dataset.genre));
});

/* ── Search events ── */
searchInp.addEventListener("input", e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => searchSongs(e.target.value), 180);
});
searchInp.addEventListener("keydown", e => {
  if (e.key === "Enter")  { clearTimeout(searchTimer); searchSongs(searchInp.value); }
  if (e.key === "Escape") { clearTimeout(searchTimer); searchInp.value = ""; searchSongs(""); }
});

/* ── Auth ── */
onAuthStateChanged(auth, user => {
  if (!user) { location.href = "auth.html"; return; }
  navAvatar.src = user.photoURL || fallbackAvatar(user.email);
});

function fallbackAvatar(email) {
  const i = (email?.[0] || "U").toUpperCase();
  return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='56'%3E%3Ccircle cx='28' cy='28' r='28' fill='%238a5cf6'/%3E%3Ctext x='50%25' y='50%25' font-size='26' fill='white' text-anchor='middle' dy='.35em'%3E${i}%3C/text%3E%3C/svg%3E`;
}

/* ── Init ── */
(async () => {
  try {
    setupClickHandler(grid);
    setupClickHandler(searchGrid);

    grid.innerHTML = '<p class="state-msg">Loading songs…</p>';
    await loadGenre(DEFAULT_GENRE);
    renderGenre(DEFAULT_GENRE);

    // Set active pill
    genreItems.forEach(p => p.classList.toggle("active", p.dataset.genre === DEFAULT_GENRE));

    // Background load remaining genres
    const rest = Object.keys(GENRE_FILES).filter(g => g !== DEFAULT_GENRE);
    Promise.allSettled(rest.map(g => loadGenre(g)));

    // Preconnect first thumbnail
    const first = songsByGenre[DEFAULT_GENRE]?.[0];
    if (first?.thumbnail) { const img = new Image(); img.decoding = "async"; img.src = first.thumbnail; }

  } catch (err) {
    console.error("Init failed:", err);
    grid.innerHTML = '<p class="state-msg" style="color:#f43f5e">Failed to load songs. Refresh the page.</p>';
  }
})();
