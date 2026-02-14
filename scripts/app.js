// scripts/app.js — MusicsAura 2025 - OPTIMIZED
import { auth, onAuthStateChanged } from "./firebase-config.js";
import { player } from "./player.js";

/* DOM references - cached once */
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
let all = [];
let genres = {};
let activeGenre = "hindi";
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

/* Click outside to close */
document.addEventListener("click", (e) => {
  if (!genreBtn.contains(e.target) && !genreMenu.contains(e.target)) {
    closeDropdown();
  }
});

genreBtn.onclick = toggleDropdown;

/* Genre selection */
genreItems.forEach(item => {
  item.onclick = () => {
    const genre = item.dataset.genre;
    genreItems.forEach(i => i.classList.remove("active"));
    item.classList.add("active");
    genreLabel.textContent = item.textContent;
    closeDropdown();
    render(genre);
  };
});

/* Optimized JSON loader */
async function load(file) {
  try {
    const res = await fetch(file, { cache: 'force-cache' }); // Use browser cache
    if (!res.ok) return [];
    
    const data = await res.json();
    const genre = file.split("/").pop().replace(".json", "").toLowerCase();
    
    // Process songs efficiently
    const normalized = data.map(song => {
      // Normalize keywords
      let keywords = song.keywords || [];
      
      if (typeof keywords === "string") {
        keywords = keywords.split(/[,;]/).map(x => x.trim());
      } else if (Array.isArray(keywords)) {
        keywords = keywords.flatMap(k => 
          typeof k === "string" ? k.split(/[,;]/).map(x => x.trim()) : []
        );
      } else {
        keywords = [];
      }

      // Add title and artist words for better search
      const titleWords = song.title ? song.title.split(/\s+/) : [];
      const artistWords = song.artist ? song.artist.split(/[,&\/]+|\s+/) : [];
      
      // Deduplicate and normalize
      const allKeywords = new Set([
        ...keywords,
        ...titleWords,
        ...artistWords
      ].map(w => w.toLowerCase().trim()).filter(Boolean));

      return {
        ...song,
        keywords: Array.from(allKeywords),
        playCount: song.playCount || 0,
        genre
      };
    });

    genres[genre] = normalized;
    all.push(...normalized);
    
    return normalized;
  } catch (err) {
    console.error(`Failed to load ${file}:`, err);
    return [];
  }
}

/* Efficient card creation with event delegation */
function createCard(song) {
  const el = document.createElement("div");
  el.className = "song-card";
  el.dataset.songId = `${song.genre}-${song.title}`;
  
  el.innerHTML = `
    <img src="${song.thumbnail || ''}" loading="lazy" alt="${escapeHtml(song.title || '')}" onerror="this.style.opacity=.4">
    <p>${escapeHtml(song.title || '')}</p>
    <p>${escapeHtml(song.artist || '')}</p>
  `;
  
  return el;
}

/* Render genre grid with fragment for better performance */
function render(genre) {
  activeGenre = genre;
  grid.hidden = false;
  searchGrid.hidden = true;
  genreWrapper.style.display = '';
  
  const songList = genres[genre] || [];
  
  // Use DocumentFragment for batch DOM insertion
  const fragment = document.createDocumentFragment();
  songList.forEach(song => fragment.appendChild(createCard(song)));
  
  grid.innerHTML = "";
  grid.appendChild(fragment);
  
  // Set up click delegation
  setupClickHandler(grid, songList);
}

/* Event delegation for better performance */
function setupClickHandler(container, songList) {
  const existingHandler = container._clickHandler;
  if (existingHandler) {
    container.removeEventListener('click', existingHandler);
  }
  
  const handler = (e) => {
    const card = e.target.closest('.song-card');
    if (!card) return;
    
    const index = Array.from(container.children).indexOf(card);
    if (index !== -1 && songList[index]) {
      player.setPlaylist(songList, index);
      player.playSong(songList[index]);
    }
  };
  
  container.addEventListener('click', handler);
  container._clickHandler = handler;
}

/* Optimized search with debouncing */
function doSearch(query) {
  const q = (query || "").trim().toLowerCase();
  
  if (!q) {
    searchGrid.hidden = true;
    grid.hidden = false;
    searchInp.value = "";
    genreWrapper.style.display = '';
    return;
  }

  // Filter with early exit optimization
  const matches = all.filter(song => {
    const title = (song.title || "").toLowerCase();
    const artist = (song.artist || "").toLowerCase();
    
    // Check title/artist first (most common matches)
    if (title.includes(q) || artist.includes(q)) return true;
    
    // Then check keywords
    return (song.keywords || []).some(kw => kw.includes(q));
  });

  // Render results
  const fragment = document.createDocumentFragment();
  
  if (matches.length === 0) {
    const noResults = document.createElement('p');
    noResults.style.cssText = 'text-align:center;padding:3rem;color:#999;';
    noResults.textContent = 'No songs found';
    fragment.appendChild(noResults);
  } else {
    matches.forEach(song => fragment.appendChild(createCard(song)));
  }
  
  searchGrid.innerHTML = "";
  searchGrid.appendChild(fragment);
  
  // Set up click delegation for search results
  if (matches.length > 0) {
    setupClickHandler(searchGrid, matches);
  }
  
  grid.hidden = true;
  searchGrid.hidden = false;
  genreWrapper.style.display = 'none';
}

/* Debounced search input */
searchInp.addEventListener("input", (e) => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    doSearch(e.target.value);
  }, 200); // 200ms debounce
});

searchInp.addEventListener("keydown", (e) => { 
  if (e.key === "Enter") {
    clearTimeout(searchDebounceTimer);
    doSearch(searchInp.value);
  }
  if (e.key === "Escape") {
    clearTimeout(searchDebounceTimer);
    searchInp.value = "";
    doSearch("");
  }
});

/* Auth with optimized avatar */
onAuthStateChanged(auth, user => {
  if (!user) return (location.href = "auth.html");
  
  if (user.photoURL) {
    navAvatar.src = user.photoURL;
  } else {
    const initial = (user.email?.[0] || "U").toUpperCase();
    navAvatar.src = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='56'%3E%3Ccircle cx='28' cy='28' r='28' fill='%234a90e2'/%3E%3Ctext x='50%25' y='50%25' font-size='24' fill='white' text-anchor='middle' dy='.35em'%3E${initial}%3C/text%3E%3C/svg%3E`;
  }
});

/* HTML escape utility */
function escapeHtml(str) { 
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '`': '&#96;'
  };
  return (str || '').toString().replace(/[&<>"'`]/g, c => map[c]); 
}

/* Initialize - Parallel loading with visual feedback */
(async () => {
  try {
    // Show loading state
    grid.innerHTML = '<p style="text-align:center;padding:3rem;color:#999;">Loading songs...</p>';
    
    // Load all genres in parallel
    await Promise.all([
      load("/jsons/hindi.json"),
      load("/jsons/punjabi.json"),
      load("/jsons/haryanvi.json"),
      load("/jsons/bhojpuri.json"),
      load("/jsons/50s.json"),
      load("/jsons/remix.json")
    ]);
    
    // Render default genre
    render("hindi");
    
    // Preload first song's thumbnail for instant playback
    if (genres.hindi?.[0]?.thumbnail) {
      const img = new Image();
      img.src = genres.hindi[0].thumbnail;
    }
    
  } catch (err) {
    console.error('Failed to initialize:', err);
    grid.innerHTML = '<p style="text-align:center;padding:3rem;color:#f44;">Failed to load songs. Please refresh.</p>';
  }
})();
