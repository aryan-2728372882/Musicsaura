// scripts/app.js - MusicsAura app shell
import { auth, onAuthStateChanged } from "./firebase-config.js";
import { player } from "./player.js";

/* DOM references */
const grid = document.getElementById("grid");
const searchGrid = document.getElementById("search-grid");
const searchInp = document.getElementById("search");
const profileBtn = document.getElementById("profile-btn");
const navAvatar = document.getElementById("nav-avatar");
const genreWrapper = document.getElementById("genre-wrapper");
const genreBtn = document.getElementById("genre-btn");
const genreMenu = document.getElementById("genre-menu");
const genreLabel = document.getElementById("genre-label");
const genreItems = document.querySelectorAll(".genre-item");

/* State */
const DEFAULT_GENRE = "hindi";
const GENRE_FILES = {
  hindi: "/jsons/hindi.json",
  punjabi: "/jsons/punjabi.json",
  haryanvi: "/jsons/haryanvi.json",
  bhojpuri: "/jsons/bhojpuri.json",
  "50s": "/jsons/50s.json",
  remix: "/jsons/remix.json"
};

let allSongs = [];
const songsByGenre = {};
const genreLoadPromises = new Map();
let activeGenre = DEFAULT_GENRE;
let searchDebounceTimer = null;

/* Initial UI */
grid.hidden = false;
searchGrid.hidden = true;

/* Theme */
function setTheme(dark) {
  document.body.classList.toggle("dark-theme", dark);
  document.body.classList.toggle("light-theme", !dark);
  localStorage.setItem("vt-theme", dark ? "dark" : "light");
}
if (localStorage.getItem("vt-theme") === "dark") setTheme(true);

/* Dropdown management */
function closeDropdown() {
  genreMenu.classList.remove("open");
  genreBtn.classList.remove("open");
  genreBtn.setAttribute("aria-expanded", "false");
  genreMenu.setAttribute("aria-hidden", "true");
}

function toggleDropdown() {
  const isOpen = genreMenu.classList.toggle("open");
  genreBtn.classList.toggle("open", isOpen);
  genreBtn.setAttribute("aria-expanded", String(isOpen));
  genreMenu.setAttribute("aria-hidden", String(!isOpen));
}

document.addEventListener("click", (e) => {
  if (!genreBtn.contains(e.target) && !genreMenu.contains(e.target)) {
    closeDropdown();
  }
});

genreBtn.onclick = toggleDropdown;

/* Utilities */
function escapeHtml(str) {
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
    "`": "&#96;"
  };
  return (str || "").toString().replace(/[&<>"'`]/g, (c) => map[c]);
}

function normalizeKeywords(song) {
  let keywords = song.keywords || [];

  if (typeof keywords === "string") {
    keywords = keywords.split(/[,;]/).map((x) => x.trim());
  } else if (Array.isArray(keywords)) {
    keywords = keywords.flatMap((k) =>
      typeof k === "string" ? k.split(/[,;]/).map((x) => x.trim()) : []
    );
  } else {
    keywords = [];
  }

  const titleWords = song.title ? song.title.split(/\s+/) : [];
  const artistWords = song.artist ? song.artist.split(/[,&/]+|\s+/) : [];

  return Array.from(
    new Set(
      [...keywords, ...titleWords, ...artistWords]
        .map((w) => w.toLowerCase().trim())
        .filter(Boolean)
    )
  );
}

function normalizeSong(song, genre) {
  const keywords = normalizeKeywords(song);
  const title = song.title || "";
  const artist = song.artist || "";
  const searchText = `${title} ${artist} ${keywords.join(" ")}`.toLowerCase();

  return {
    ...song,
    keywords,
    playCount: song.playCount || 0,
    genre,
    _searchText: searchText
  };
}

async function loadGenre(genre) {
  if (songsByGenre[genre]) return songsByGenre[genre];

  if (genreLoadPromises.has(genre)) {
    return genreLoadPromises.get(genre);
  }

  const file = GENRE_FILES[genre];
  if (!file) return [];

  const loadPromise = (async () => {
    try {
      const res = await fetch(file, { cache: "no-store" });
      if (!res.ok) return [];

      const data = await res.json();
      const normalized = data.map((song) => normalizeSong(song, genre));
      songsByGenre[genre] = normalized;
      allSongs.push(...normalized);
      return normalized;
    } catch (err) {
      console.error(`Failed to load ${file}:`, err);
      songsByGenre[genre] = [];
      return [];
    } finally {
      genreLoadPromises.delete(genre);
    }
  })();

  genreLoadPromises.set(genre, loadPromise);
  return loadPromise;
}

function createCard(song, index) {
  const el = document.createElement("div");
  el.className = "song-card";
  el.dataset.index = String(index);
  el.innerHTML = `
    <img src="${song.thumbnail || ""}" loading="lazy" alt="${escapeHtml(song.title || "")}" onerror="this.style.opacity=.4">
    <p>${escapeHtml(song.title || "")}</p>
    <p>${escapeHtml(song.artist || "")}</p>
  `;
  return el;
}

function bindContainerSongs(container, songs) {
  container._songs = songs;
}

function setupClickHandler(container) {
  if (container._clickHandler) return;

  const handler = (e) => {
    const card = e.target.closest(".song-card");
    if (!card) return;

    const songs = container._songs || [];
    const index = Number.parseInt(card.dataset.index || "-1", 10);
    if (!Number.isInteger(index) || index < 0 || !songs[index]) return;

    player.setPlaylist(songs, index);
    player.playSong(songs[index]);
  };

  container.addEventListener("click", handler);
  container._clickHandler = handler;
}

function renderSongList(container, songs, emptyMessage = null) {
  const fragment = document.createDocumentFragment();

  if (!songs.length && emptyMessage) {
    const empty = document.createElement("p");
    empty.style.cssText = "text-align:center;padding:3rem;color:#999;";
    empty.textContent = emptyMessage;
    fragment.appendChild(empty);
  } else {
    for (let i = 0; i < songs.length; i += 1) {
      fragment.appendChild(createCard(songs[i], i));
    }
  }

  container.replaceChildren(fragment);
  bindContainerSongs(container, songs);
}

function renderGenre(genre) {
  activeGenre = genre;
  grid.hidden = false;
  searchGrid.hidden = true;
  genreWrapper.style.display = "";

  const songs = songsByGenre[genre] || [];
  renderSongList(grid, songs);
}

function searchSongs(query) {
  const q = (query || "").trim().toLowerCase();

  if (!q) {
    searchGrid.hidden = true;
    grid.hidden = false;
    searchInp.value = "";
    genreWrapper.style.display = "";
    return;
  }

  const matches = allSongs.filter((song) => song._searchText.includes(q));
  renderSongList(searchGrid, matches, "No songs found");

  grid.hidden = true;
  searchGrid.hidden = false;
  genreWrapper.style.display = "none";
}

async function selectGenre(item) {
  const genre = item.dataset.genre;
  if (!genre) return;

  genreItems.forEach((i) => i.classList.remove("active"));
  item.classList.add("active");
  genreLabel.textContent = item.textContent;
  closeDropdown();

  if (!songsByGenre[genre]) {
    grid.hidden = false;
    searchGrid.hidden = true;
    genreWrapper.style.display = "";
    grid.innerHTML = '<p style="text-align:center;padding:3rem;color:#999;">Loading songs...</p>';
    await loadGenre(genre);
  }

  renderGenre(genre);
}

genreItems.forEach((item) => {
  item.onclick = () => {
    selectGenre(item).catch((err) => {
      console.error("Genre select failed:", err);
    });
  };
});

/* Search */
searchInp.addEventListener("input", (e) => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchSongs(e.target.value);
  }, 180);
});

searchInp.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    clearTimeout(searchDebounceTimer);
    searchSongs(searchInp.value);
  }
  if (e.key === "Escape") {
    clearTimeout(searchDebounceTimer);
    searchInp.value = "";
    searchSongs("");
  }
});

/* Auth */
onAuthStateChanged(auth, (user) => {
  if (!user) {
    location.href = "auth.html";
    return;
  }

  if (user.photoURL) {
    navAvatar.src = user.photoURL;
  } else {
    const initial = (user.email?.[0] || "U").toUpperCase();
    navAvatar.src = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='56'%3E%3Ccircle cx='28' cy='28' r='28' fill='%234a90e2'/%3E%3Ctext x='50%25' y='50%25' font-size='24' fill='white' text-anchor='middle' dy='.35em'%3E${initial}%3C/text%3E%3C/svg%3E`;
  }
});

/* Init */
(async () => {
  try {
    setupClickHandler(grid);
    setupClickHandler(searchGrid);

    grid.innerHTML = '<p style="text-align:center;padding:3rem;color:#999;">Loading songs...</p>';

    await loadGenre(DEFAULT_GENRE);
    renderGenre(DEFAULT_GENRE);

    // Load remaining genres in background for smoother first interaction.
    const remainingGenres = Object.keys(GENRE_FILES).filter((genre) => genre !== DEFAULT_GENRE);
    Promise.allSettled(remainingGenres.map((genre) => loadGenre(genre))).catch(() => {});

    if (songsByGenre[DEFAULT_GENRE]?.[0]?.thumbnail) {
      const img = new Image();
      img.decoding = "async";
      img.src = songsByGenre[DEFAULT_GENRE][0].thumbnail;
    }
  } catch (err) {
    console.error("Failed to initialize:", err);
    grid.innerHTML = '<p style="text-align:center;padding:3rem;color:#f44;">Failed to load songs. Please refresh.</p>';
  }
})();
