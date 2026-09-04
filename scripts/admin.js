// scripts/admin.js — MusicsAura 3.0 Studio Controller
import {
  auth, db, isAdmin, onAuthStateChanged, signOut,
  collection, query, orderBy, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, writeBatch
} from "./firebase-config.js";
import { commitSongsToGitHub, deleteSongFromGitHub } from "./github-sync.js";

// DOM elements
const totalUsersEl       = document.getElementById("total-users");
const totalSongsEl       = document.getElementById("total-songs");
const totalMinutesEl     = document.getElementById("total-minutes");
const uploadedCountEl    = document.getElementById("uploaded-songs-count");

// Single Upload form elements
const uploadForm         = document.getElementById("upload-song-form");
const customAudioUrl     = document.getElementById("custom-audio-url");
const songTitleInput     = document.getElementById("song-title");
const songArtistInput    = document.getElementById("song-artist");
const songGenreSelect    = document.getElementById("song-genre");
const customCoverUrl     = document.getElementById("custom-cover-url");
const songTagsInput      = document.getElementById("song-tags");
const coverPreviewImg    = document.getElementById("cover-preview-img");
const fetchStatusTag     = document.getElementById("fetch-status-tag");
const manualFetchBtn     = document.getElementById("btn-manual-fetch");
const submitUploadBtn    = document.getElementById("btn-submit-upload");
const uploadAlert        = document.getElementById("upload-alert");

// Bulk Importer elements
const toggleBulkBtn      = document.getElementById("toggle-bulk-btn");
const bulkWrap           = document.getElementById("bulk-importer-wrap");
const bulkUrlsInput      = document.getElementById("bulk-urls");
const bulkGenreSelect    = document.getElementById("bulk-genre");
const submitBulkBtn      = document.getElementById("btn-submit-bulk");

// Songs table elements
const songsTbody         = document.getElementById("songs-tbody");
const songsLoading       = document.getElementById("songs-loading");
const songsSearchInp     = document.getElementById("songs-search");
const songsCountBadge    = document.getElementById("songs-count-badge");
const exportJsonBtn      = document.getElementById("export-json-btn");

// Users table elements
const usersTbody         = document.getElementById("users-tbody");
const usersLoading       = document.getElementById("users-loading");

let allUploadedSongs     = [];
let currentAdminUser     = null;
let autoFetchDebounce    = null;

// ─── AUTH & SECURITY GATE ──────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.href = "auth.html";
    return;
  }
  if (!isAdmin(user.email)) {
    location.href = "user-dashboard.html";
    return;
  }

  currentAdminUser = user;
  initAdminDashboard();
});

function showAlert(msg, isError = false) {
  if (!uploadAlert) return;
  uploadAlert.textContent = msg;
  uploadAlert.className = `alert-box ${isError ? "alert-error" : "alert-success"} visible`;
  setTimeout(() => {
    uploadAlert.classList.remove("visible");
  }, 5000);
}

// ─── SMART URL PARSER ──────────────────────────────────────────────
function extractTitleFromUrl(url) {
  try {
    const clean = url.split("?")[0];
    const rawFilename = clean.substring(clean.lastIndexOf("/") + 1);
    const decoded = decodeURIComponent(rawFilename)
      .replace(/\.[^/.]+$/, "")         // remove file extension (.mp3, etc.)
      .replace(/^\d+[\s._-]+/, "")      // remove leading numbers like "01 - " or "01."
      .replace(/[_]/g, " ")             // replace underscores with spaces
      .replace(/\s+/g, " ")             // normalize multiple spaces
      .trim();
    return decoded || "Untitled Song";
  } catch {
    return "Untitled Song";
  }
}

function detectGenreFromUrl(url) {
  const lower = url.toLowerCase();
  if (lower.includes("/hindi/") || lower.includes("hindi")) return "hindi";
  if (lower.includes("/punjabi/") || lower.includes("punjabi")) return "punjabi";
  if (lower.includes("/haryanvi/") || lower.includes("haryanvi")) return "haryanvi";
  if (lower.includes("/bhojpuri/") || lower.includes("bhojpuri")) return "bhojpuri";
  if (lower.includes("/remix/") || lower.includes("remix")) return "remix";
  if (lower.includes("/50s/") || lower.includes("old") || lower.includes("50s")) return "50s";
  return null;
}

// ─── METADATA & COVER ART SEARCH ENGINE (ITUNES API) ───────────────
async function fetchOnlineMetadata(songQuery) {
  if (!songQuery || songQuery.trim().length < 2) return null;
  const cleanTerm = songQuery.trim();

  try {
    const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(cleanTerm)}&entity=song&limit=1`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.results && data.results.length > 0) {
      const match = data.results[0];
      // Convert 100x100 thumbnail to 600x600 HD artwork
      const hdArtwork = match.artworkUrl100
        ? match.artworkUrl100.replace("100x100bb", "600x600bb")
        : "";
      return {
        title: match.trackName || cleanTerm,
        artist: match.artistName || "Various Artists",
        artwork: hdArtwork,
        genre: match.primaryGenreName || ""
      };
    }
  } catch (err) {
    console.warn("Metadata search:", err);
  }
  return null;
}

async function handleAutoFetch(title) {
  if (!title) return;
  if (fetchStatusTag) fetchStatusTag.style.display = "inline";

  const meta = await fetchOnlineMetadata(title);
  if (fetchStatusTag) fetchStatusTag.style.display = "none";

  if (meta) {
    if (meta.artist && (!songArtistInput.value || songArtistInput.value === "Various Artists")) {
      songArtistInput.value = meta.artist;
    }
    if (meta.artwork) {
      customCoverUrl.value = meta.artwork;
      if (coverPreviewImg) coverPreviewImg.src = meta.artwork;
    }
  }
}

// URL input change listener
if (customAudioUrl) {
  customAudioUrl.addEventListener("input", () => {
    const url = customAudioUrl.value.trim();
    if (!url) return;

    // 1. Auto extract title
    const extractedTitle = extractTitleFromUrl(url);
    if (extractedTitle) {
      songTitleInput.value = extractedTitle;
    }

    // 2. Auto detect genre
    const detectedGenre = detectGenreFromUrl(url);
    if (detectedGenre && songGenreSelect) {
      songGenreSelect.value = detectedGenre;
    }

    // 3. Trigger debounce metadata & artwork search
    clearTimeout(autoFetchDebounce);
    autoFetchDebounce = setTimeout(() => {
      handleAutoFetch(extractedTitle);
    }, 400);
  });
}

// Manual fetch button
if (manualFetchBtn) {
  manualFetchBtn.addEventListener("click", () => {
    const title = songTitleInput.value.trim() || extractTitleFromUrl(customAudioUrl.value.trim());
    if (title) handleAutoFetch(title);
  });
}

// Cover URL preview listener
if (customCoverUrl) {
  customCoverUrl.addEventListener("input", () => {
    const url = customCoverUrl.value.trim();
    if (coverPreviewImg) {
      coverPreviewImg.src = url || "assets/logo.png";
    }
  });
}

// ─── TOGGLE BULK IMPORTER ───
if (toggleBulkBtn && bulkWrap) {
  toggleBulkBtn.addEventListener("click", () => {
    const isHidden = bulkWrap.style.display === "none";
    bulkWrap.style.display = isHidden ? "block" : "none";
    toggleBulkBtn.classList.toggle("active", isHidden);
  });
}

// ─── SINGLE SONG SUBMIT ────────────────────────────────────────────
if (uploadForm) {
  uploadForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const audioUrl = customAudioUrl.value.trim();
    const title    = songTitleInput.value.trim();
    const artist   = songArtistInput.value.trim() || "Various Artists";
    const genre    = songGenreSelect.value;
    const coverUrl = customCoverUrl ? customCoverUrl.value.trim() : "";
    const tagsRaw  = songTagsInput.value.trim();

    if (!audioUrl) {
      showAlert("Please enter an audio stream URL", true);
      return;
    }
    if (!title) {
      showAlert("Please enter a song title", true);
      return;
    }

    const keywords = Array.from(
      new Set([
        ...title.toLowerCase().split(/\s+/),
        ...artist.toLowerCase().split(/[,&/ ]+/),
        ...(tagsRaw ? tagsRaw.toLowerCase().split(/[,; ]+/) : []),
        genre.toLowerCase()
      ].filter(Boolean))
    );

    submitUploadBtn.disabled = true;
    submitUploadBtn.textContent = "Publishing...";

    try {
      const newSongData = {
        title,
        artist,
        genre,
        link: audioUrl,
        thumbnail: coverUrl || "",
        keywords,
        uploadedBy: currentAdminUser.email,
        createdAt: serverTimestamp(),
        plays: 0
      };

      await addDoc(collection(db, "songs"), { ...newSongData, catalogManaged: true });

      // AUTO GITHUB SYNC: Commit to jsons/{genre}.json in GitHub repository
      try {
        commitSongsToGitHub(genre, [{
          title,
          artist,
          genre,
          link: audioUrl,
          thumbnail: coverUrl || "assets/logo.png"
        }]).then((res) => {
          if (res && res.success) {
            console.log(`[GitHub Auto-Commit] "${title}" committed to jsons/${genre.toLowerCase()}.json!`);
          }
        });
      } catch {}

      showAlert(`✅ Added "${title}" to MusicsAura and synced to GitHub!`);
      uploadForm.reset();
      if (coverPreviewImg) coverPreviewImg.src = "assets/logo.png";
      loadUploadedSongs();

    } catch (err) {
      console.error("Add song error:", err);
      showAlert(`Error: ${err.message || "Failed to add song"}`, true);
    } finally {
      submitUploadBtn.disabled = false;
      submitUploadBtn.textContent = "Add Song to MusicsAura";
    }
  });
}

// ─── BULK MULTI-LINK IMPORTER WITH AUTO-FETCH ──────────────────────
if (submitBulkBtn && bulkUrlsInput) {
  submitBulkBtn.addEventListener("click", async () => {
    const rawText = bulkUrlsInput.value.trim();
    if (!rawText) {
      showAlert("Please paste at least one audio URL", true);
      return;
    }

    const urls = rawText
      .split("\n")
      .map((u) => u.trim())
      .filter((u) => u.startsWith("http://") || u.startsWith("https://"));

    if (!urls.length) {
      showAlert("No valid URLs found in the text box", true);
      return;
    }

    const defaultGenre = bulkGenreSelect.value;
    submitBulkBtn.disabled = true;
    submitBulkBtn.textContent = `Auto-fetching & importing ${urls.length} tracks...`;

    let successCount = 0;

    try {
      const promises = urls.map(async (url) => {
        const title = extractTitleFromUrl(url);
        const genre = detectGenreFromUrl(url) || defaultGenre;

        // Auto-fetch metadata & HD artwork for each track
        let artist = "Various Artists";
        let artwork = "";
        try {
          const meta = await fetchOnlineMetadata(title);
          if (meta) {
            if (meta.artist) artist = meta.artist;
            if (meta.artwork) artwork = meta.artwork;
          }
        } catch {}

        const keywords = Array.from(
          new Set([...title.toLowerCase().split(/\s+/), ...artist.toLowerCase().split(/[,&/ ]+/), genre.toLowerCase()].filter(Boolean))
        );

        await addDoc(collection(db, "songs"), {
          title,
          artist,
          genre,
          link: url,
          thumbnail: artwork || "",
          keywords,
          uploadedBy: currentAdminUser.email,
          createdAt: serverTimestamp(),
          plays: 0,
          catalogManaged: true
        });
        successCount++;
      });

      await Promise.all(promises);
      showAlert(`🎉 Successfully imported ${successCount} songs with auto-fetched artwork!`);
      bulkUrlsInput.value = "";
      loadUploadedSongs();

    } catch (err) {
      console.error("Bulk import error:", err);
      showAlert(`Imported ${successCount} songs. Error: ${err.message}`, true);
    } finally {
      submitBulkBtn.disabled = false;
      submitBulkBtn.textContent = "Import & Auto-Fetch All Tracks";
    }
  });
}

// ─── LOAD & MANAGE COMPLETE STUDIO CATALOG (JSONs + FIRESTORE + LOCAL) ─
async function loadUploadedSongs() {
  if (!songsTbody) return;
  if (songsLoading) songsLoading.style.display = "block";

  try {
    const songMap = new Map();

    // 1. Load static JSON catalogs
    const genres = [
      { file: "jsons/hindi.json", genre: "Hindi" },
      { file: "jsons/punjabi.json", genre: "Punjabi" },
      { file: "jsons/haryanvi.json", genre: "Haryanvi" },
      { file: "jsons/rap.json", genre: "Rap" },
      { file: "jsons/bhojpuri.json", genre: "Bhojpuri" }
    ];

    await Promise.all(
      genres.map(async (g) => {
        try {
          const res = await fetch(g.file);
          if (res.ok) {
            const list = await res.json();
            list.forEach((s) => {
              if (s && s.link) {
                const key = s.link.split("?")[0].toLowerCase().trim();
                songMap.set(key, { ...s, genre: s.genre || g.genre, source: "json" });
              }
            });
          }
        } catch {}
      })
    );

    // 2. Load Firestore songs (only recent 25 to save read quota)
    try {
      const q = query(collection(db, "songs"), orderBy("createdAt", "desc"), limit(25));
      const snap = await getDocs(q);
      snap.forEach((docSnap) => {
        const data = docSnap.data();
        if (data && data.link) {
          const key = data.link.split("?")[0].toLowerCase().trim();
          songMap.set(key, { id: docSnap.id, ...data, source: "firestore" });
        }
      });
    } catch (e) {
      console.warn("Firestore fetch notice:", e);
    }

    // 3. Load local uploads buffer
    try {
      const local = JSON.parse(localStorage.getItem("musicsaura_local_uploads") || "[]");
      local.forEach((s) => {
        if (s && s.link) {
          const key = s.link.split("?")[0].toLowerCase().trim();
          if (!songMap.has(key)) {
            songMap.set(key, { ...s, source: "local" });
          }
        }
      });
    } catch {}

    allUploadedSongs = Array.from(songMap.values());

    if (uploadedCountEl) uploadedCountEl.textContent = allUploadedSongs.length;
    if (songsCountBadge) songsCountBadge.textContent = `${allUploadedSongs.length} tracks`;

    renderSongsTable(allUploadedSongs);

  } catch (err) {
    console.error("Failed to load studio catalogue:", err);
    if (songsLoading) songsLoading.textContent = "Error loading catalogue: " + err.message;
  }
}

let songDisplayLimit      = 10;
let userDisplayLimit      = 10;
let currentDisplayedSongs = [];
let allLoadedUsers        = [];

const songsPaginationBar  = document.getElementById("songs-pagination-bar");
const songsPaginationInfo = document.getElementById("songs-pagination-info");
const btnMoreSongs        = document.getElementById("btn-more-songs");
const btnAllSongs         = document.getElementById("btn-all-songs");

const usersPaginationBar  = document.getElementById("users-pagination-bar");
const usersPaginationInfo = document.getElementById("users-pagination-info");
const btnMoreUsers        = document.getElementById("btn-more-users");
const btnAllUsers         = document.getElementById("btn-all-users");

if (btnMoreSongs) {
  btnMoreSongs.addEventListener("click", () => {
    songDisplayLimit += 10;
    renderSongsTable(currentDisplayedSongs);
  });
}

if (btnAllSongs) {
  btnAllSongs.addEventListener("click", () => {
    songDisplayLimit = Math.max(allUploadedSongs.length, 10);
    renderSongsTable(currentDisplayedSongs);
  });
}

if (btnMoreUsers) {
  btnMoreUsers.addEventListener("click", () => {
    userDisplayLimit += 10;
    renderUsersTable();
  });
}

if (btnAllUsers) {
  btnAllUsers.addEventListener("click", () => {
    userDisplayLimit = Math.max(allLoadedUsers.length, 10);
    renderUsersTable();
  });
}

function renderSongsTable(songs) {
  if (!songsTbody) return;
  if (songsLoading) songsLoading.style.display = "none";
  currentDisplayedSongs = songs || [];

  if (!songs.length) {
    songsTbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--text-muted)">No studio songs found. Paste a link above to add one!</td></tr>`;
    if (songsPaginationBar) songsPaginationBar.style.display = "none";
    return;
  }

  const visibleSongs = songs.slice(0, songDisplayLimit);
  const frag = document.createDocumentFragment();

  visibleSongs.forEach((song) => {
    const tr = document.createElement("tr");
    const thumbUrl = song.thumbnail || "assets/logo.png";
    const dateStr = song.createdAt?.toDate ? song.createdAt.toDate().toLocaleDateString() : "Recent";
    const genreLower = (song.genre || "hindi").toLowerCase();

    tr.innerHTML = `
      <td>
        <div class="table-song-cell">
          <img src="${thumbUrl}" alt="" class="table-song-thumb" onerror="this.src='assets/logo.png'">
          <div class="table-song-meta">
            <div class="table-song-title">${escapeHtml(song.title)}</div>
            <div class="table-song-artist">${escapeHtml(song.artist || "Unknown")}</div>
          </div>
        </div>
      </td>
      <td>
        <select class="admin-genre-select" data-id="${song.id || ""}" data-link="${escapeHtml(song.link || "")}" title="Change Music Section">
          <option value="Hindi" ${genreLower === "hindi" ? "selected" : ""}>Hindi Hits</option>
          <option value="Punjabi" ${genreLower === "punjabi" ? "selected" : ""}>Punjabi Vibes</option>
          <option value="Haryanvi" ${genreLower === "haryanvi" ? "selected" : ""}>Haryanvi Swag</option>
          <option value="Rap" ${genreLower === "rap" ? "selected" : ""}>Desi Rap</option>
          <option value="Bhojpuri" ${genreLower === "bhojpuri" ? "selected" : ""}>Bhojpuri Hits</option>
        </select>
      </td>
      <td>${dateStr}</td>
      <td>
        <a href="${song.link}" target="_blank" rel="noopener" class="action-btn" title="Direct Audio Stream">
          <span class="material-icons">open_in_new</span>
        </a>
      </td>
      <td>
        <button class="action-btn delete-btn" data-id="${song.id}" title="Delete Song">
          <span class="material-icons">delete_outline</span>
        </button>
      </td>
    `;
    frag.appendChild(tr);
  });

  songsTbody.replaceChildren(frag);

  // Update pagination info & controls
  if (songsPaginationBar) {
    songsPaginationBar.style.display = "flex";
  }
  if (songsPaginationInfo) {
    songsPaginationInfo.textContent = `Showing top ${Math.min(songDisplayLimit, songs.length)} of ${songs.length} releases`;
  }
  if (btnMoreSongs) {
    btnMoreSongs.style.display = songDisplayLimit >= songs.length ? "none" : "inline-flex";
  }
  if (btnAllSongs) {
    btnAllSongs.style.display = songDisplayLimit >= songs.length ? "none" : "inline-flex";
  }

  // Bind genre changer handlers
  songsTbody.querySelectorAll(".admin-genre-select").forEach((select) => {
    select.addEventListener("change", (e) => {
      const newGenre = e.target.value;
      const songId = select.dataset.id;
      const songLink = select.dataset.link;
      updateSongGenre(songId, songLink, newGenre);
    });
  });

  // Bind delete handlers
  songsTbody.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteSong(btn.dataset.id));
  });
}

async function updateSongGenre(songId, songLink, newGenre) {
  try {
    if (songId && !songId.startsWith("json_") && !songId.startsWith("local_")) {
      await updateDoc(doc(db, "songs", songId), {
        genre: newGenre.toLowerCase()
      });
    }

    const target = allUploadedSongs.find((s) => s.id === songId || s.link === songLink);
    if (target) {
      target.genre = newGenre;
    }

    // Also update in local storage uploads buffer if present
    try {
      const local = JSON.parse(localStorage.getItem("musicsaura_local_uploads") || "[]");
      const match = local.find((s) => s.link === songLink || s.id === songId);
      if (match) {
        match.genre = newGenre.toLowerCase();
        localStorage.setItem("musicsaura_local_uploads", JSON.stringify(local));
      }
    } catch {}

    alert(`✅ Changed section to "${newGenre}" for song.`);
  } catch (err) {
    console.error("Genre update error:", err);
    alert(`Failed to update section: ${err.message}`);
  }
}

async function deleteSong(songId) {
  const song = allUploadedSongs.find((s) => s.id === songId);
  if (!song) return;

  if (!confirm(`Are you sure you want to permanently delete "${song.title}" from MusicsAura and Firestore?`)) {
    return;
  }

  try {
    // 1. Delete from Firestore 'songs' collection
    await deleteDoc(doc(db, "songs", songId));

    // AUTO GITHUB DELETE: Remove from jsons/{genre}.json in GitHub repository
    try {
      deleteSongFromGitHub(song.genre, song.link, song.title);
    } catch {}

    // 2. Add to 'deleted_songs' collection so it stays deleted across all users and caches
    if (song.link) {
      try {
        await addDoc(collection(db, "deleted_songs"), {
          link: song.link,
          title: song.title || "Deleted Song",
          deletedAt: serverTimestamp()
        });
      } catch (e) {
        console.warn("Blacklist notice:", e);
      }
    }

    // 3. Clean from local storage buffers
    try {
      const local = JSON.parse(localStorage.getItem("musicsaura_local_uploads") || "[]");
      const filtered = local.filter((s) => (s.id !== songId && s.link !== song.link));
      localStorage.setItem("musicsaura_local_uploads", JSON.stringify(filtered));
    } catch {}

    showAlert(`🗑️ Deleted "${song.title}" from MusicsAura, Firestore & GitHub!`);
    loadUploadedSongs();
  } catch (err) {
    console.error("Delete failed:", err);
    showAlert("Failed to delete: " + err.message, true);
  }
}

if (songsSearchInp) {
  songsSearchInp.addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) {
      renderSongsTable(allUploadedSongs);
      return;
    }
    const filtered = allUploadedSongs.filter((s) =>
      (s.title || "").toLowerCase().includes(q) ||
      (s.artist || "").toLowerCase().includes(q) ||
      (s.genre || "").toLowerCase().includes(q)
    );
    renderSongsTable(filtered);
  });
}

// ─── EXPORT ALL SONGS TO JSON (PER-GENRE + MASTER) ─────────────────
if (exportJsonBtn) {
  exportJsonBtn.addEventListener("click", () => {
    if (!allUploadedSongs.length) {
      alert("No studio songs to export.");
      return;
    }

    const genres = ["hindi", "punjabi", "haryanvi", "rap", "bhojpuri"];
    let exportedTotal = 0;

    genres.forEach((g, idx) => {
      const list = allUploadedSongs
        .filter((s) => (s.genre || "hindi").toLowerCase() === g)
        .map((s) => ({
          title: s.title || "",
          artist: s.artist || "Various Artists",
          link: s.link || "",
          thumbnail: s.thumbnail || "assets/logo.png",
          genre: g.charAt(0).toUpperCase() + g.slice(1),
          keywords: Array.isArray(s.keywords) ? s.keywords : []
        }));

      if (list.length > 0) {
        setTimeout(() => {
          const blob = new Blob([JSON.stringify(list, null, 2)], { type: "application/json" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `${g}.json`;
          a.click();
        }, idx * 250);
        exportedTotal++;
      }
    });

    showAlert(`💾 Exporting updated JSON files for your jsons/ folder!`);
  });
}

// ─── LOAD USERS AND METRICS ────────────────────────────────────────
async function loadUsersAndMetrics() {
  if (!usersTbody) return;
  if (usersLoading) usersLoading.style.display = "block";

  try {
    const q = query(collection(db, "users"), orderBy("songsPlayed", "desc"));
    const snap = await getDocs(q);

    let totalUsers = 0;
    let totalSongs = 0;
    let totalMins = 0;

    allLoadedUsers = [];

    snap.forEach((docSnap) => {
      const u = docSnap.data();
      totalUsers++;
      totalSongs += u.songsPlayed || 0;
      totalMins  += u.minutesListened || 0;
      allLoadedUsers.push(u);
    });

    if (totalUsersEl) totalUsersEl.textContent = totalUsers.toLocaleString();
    if (totalSongsEl) totalSongsEl.textContent = totalSongs.toLocaleString();
    if (totalMinutesEl) totalMinutesEl.textContent = Math.round(totalMins).toLocaleString();

    renderUsersTable();

  } catch (err) {
    console.error("Failed to load users:", err);
    if (usersLoading) usersLoading.textContent = "Error loading users: " + err.message;
  }
}

function renderUsersTable() {
  if (!usersTbody) return;
  if (usersLoading) usersLoading.style.display = "none";

  if (!allLoadedUsers.length) {
    usersTbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--text-muted)">No registered listeners found.</td></tr>`;
    if (usersPaginationBar) usersPaginationBar.style.display = "none";
    return;
  }

  const visibleUsers = allLoadedUsers.slice(0, userDisplayLimit);
  const frag = document.createDocumentFragment();

  visibleUsers.forEach((u) => {
    const lastPlayed = u.lastPlayed?.toDate ? u.lastPlayed.toDate().toLocaleString() : "Never";
    const joinedDate = u.createdAt?.toDate ? u.createdAt.toDate().toLocaleDateString() : "—";
    const avatarUrl  = u.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(u.displayName || "U")}&background=8a5cf6&color=fff&size=80`;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <div class="user-row">
          <img class="user-avatar" src="${avatarUrl}" alt="" onerror="this.src='assets/logo.png'">
          <div>
            <div class="user-name-cell">${escapeHtml(u.displayName || "User")}</div>
            <div class="user-email-cell">${escapeHtml(u.email || "")}</div>
          </div>
        </div>
      </td>
      <td><strong>${Math.round(u.minutesListened || 0).toLocaleString()} min</strong></td>
      <td>${(u.songsPlayed || 0).toLocaleString()}</td>
      <td class="hide-mobile">${lastPlayed}</td>
      <td class="hide-mobile">${joinedDate}</td>
    `;
    frag.appendChild(tr);
  });

  usersTbody.replaceChildren(frag);

  if (usersPaginationBar) {
    usersPaginationBar.style.display = "flex";
  }
  if (usersPaginationInfo) {
    usersPaginationInfo.textContent = `Showing top ${Math.min(userDisplayLimit, allLoadedUsers.length)} of ${allLoadedUsers.length} listeners`;
  }
  if (btnMoreUsers) {
    btnMoreUsers.style.display = userDisplayLimit >= allLoadedUsers.length ? "none" : "inline-flex";
  }
  if (btnAllUsers) {
    btnAllUsers.style.display = userDisplayLimit >= allLoadedUsers.length ? "none" : "inline-flex";
  }
}

function escapeHtml(str) {
  return (str || "").toString().replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[m]);
}

function initAdminDashboard() {
  loadUploadedSongs();
  loadUsersAndMetrics();
}

// ─── DUPLICATES AUDIT MODAL CONTROLLER ─────────────────────────────
const duplicatesModal     = document.getElementById("duplicates-modal");
const dupModalTitle       = document.getElementById("dup-modal-title");
const closeDupModalBtn     = document.getElementById("close-dup-modal-btn");
const btnCloseDupModal    = document.getElementById("btn-close-dup-modal");
const dupSummaryText      = document.getElementById("dup-summary-text");
const dupListContainer    = document.getElementById("dup-list-container");
const btnPurgeAllDups     = document.getElementById("btn-purge-all-dups");
const btnScanDuplicates   = document.getElementById("btn-scan-duplicates");

let currentDuplicateDocs  = []; // Array of Firestore docs flagged as duplicate copies

function openDuplicatesReport(title, summaryHtml, listItems, allowPurge = false) {
  if (!duplicatesModal) return;

  if (dupModalTitle) dupModalTitle.textContent = title;
  if (dupSummaryText) dupSummaryText.innerHTML = summaryHtml;

  if (dupListContainer) {
    dupListContainer.innerHTML = "";

    if (!listItems.length) {
      dupListContainer.innerHTML = `<div class="state-msg">✅ No duplicate tracks found in this scan! Your catalogue is 100% clean.</div>`;
    } else {
      const frag = document.createDocumentFragment();

      listItems.forEach((item) => {
        const row = document.createElement("div");
        row.className = "fav-item";
        row.style.cssText = "display:flex;gap:10px;align-items:center;background:var(--surface-raised);border:1px solid var(--border);border-radius:var(--radius-md);padding:0.6rem 0.8rem";

        const thumb = item.thumbnail || "assets/logo.png";

        row.innerHTML = `
          <img src="${thumb}" alt="" style="width:44px;height:44px;border-radius:var(--radius-sm);object-fit:cover;flex-shrink:0" onerror="this.src='assets/logo.png'">
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:0.88rem;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(item.title)}</div>
            <div style="font-size:0.78rem;color:var(--text-secondary)">
              ${escapeHtml(item.artist || "Unknown")} &bull; <span style="color:var(--cyan);font-weight:600">${escapeHtml((item.genre || "").toUpperCase())}</span>
              &bull; <span style="color:var(--rose);font-weight:600">${escapeHtml(item.reason || "Duplicate copy")}</span>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            ${item.docId ? `
              <button class="action-btn btn-delete-dup" style="color:var(--rose)" title="Delete this duplicate copy from Firestore">
                <span class="material-icons" style="font-size:1.1rem">delete</span>
              </button>
            ` : `
              <span class="genre-tag" style="background:rgba(234,179,8,0.15);color:var(--gold);border-color:rgba(234,179,8,0.3);font-size:0.72rem">Skipped</span>
            `}
          </div>
        `;

        if (item.docId) {
          const delBtn = row.querySelector(".btn-delete-dup");
          delBtn.addEventListener("click", async () => {
            if (!confirm(`Delete duplicate copy of "${item.title}" from database?`)) return;
            try {
              await deleteDoc(doc(db, "songs", item.docId));
              row.remove();
              showAlert(`🗑️ Deleted duplicate "${item.title}"`);
              loadUploadedSongs();
            } catch (err) {
              alert("Could not delete: " + err.message);
            }
          });
        }

        frag.appendChild(row);
      });

      dupListContainer.appendChild(frag);
    }
  }

  if (btnPurgeAllDups) {
    btnPurgeAllDups.style.display = (allowPurge && currentDuplicateDocs.length > 0) ? "inline-flex" : "none";
  }

  duplicatesModal.classList.add("open");
}

function closeDuplicatesModal() {
  if (duplicatesModal) duplicatesModal.classList.remove("open");
  currentDuplicateDocs = [];
}

if (closeDupModalBtn) closeDupModalBtn.addEventListener("click", closeDuplicatesModal);
if (btnCloseDupModal) btnCloseDupModal.addEventListener("click", closeDuplicatesModal);

if (duplicatesModal) {
  duplicatesModal.addEventListener("click", (e) => {
    if (e.target === duplicatesModal) closeDuplicatesModal();
  });
}

// Purge all duplicate copies in 1 click
if (btnPurgeAllDups) {
  btnPurgeAllDups.addEventListener("click", async () => {
    if (!currentDuplicateDocs.length) return;
    if (!confirm(`Are you sure you want to permanently delete all ${currentDuplicateDocs.length} duplicate copies from Firestore? (1 original copy of each song will remain)`)) return;

    btnPurgeAllDups.disabled = true;
    btnPurgeAllDups.textContent = "Purging duplicates...";

    let deleted = 0;
    try {
      for (const item of currentDuplicateDocs) {
        if (item.docId) {
          await deleteDoc(doc(db, "songs", item.docId));
          deleted++;
        }
      }
      showAlert(`🎉 Successfully purged ${deleted} duplicate songs from Firestore!`);
      closeDuplicatesModal();
      loadUploadedSongs();
    } catch (err) {
      alert("Purge error: " + err.message);
    } finally {
      btnPurgeAllDups.disabled = false;
      btnPurgeAllDups.innerHTML = `<span class="material-icons" style="font-size:1.1rem;vertical-align:middle;margin-right:4px">delete_forever</span> Remove All Duplicate Copies`;
    }
  });
}

// ─── 1-CLICK DUPLICATE SCANNER (SCANS DATABASE FOR DUPLICATES) ─────
if (btnScanDuplicates) {
  btnScanDuplicates.addEventListener("click", async () => {
    btnScanDuplicates.disabled = true;
    btnScanDuplicates.innerHTML = `<span class="material-icons" style="font-size:1rem;animation:spin 1s linear infinite">refresh</span> Scanning...`;

    try {
      const snap = await getDocs(collection(db, "songs"));
      const songs = [];
      snap.forEach((d) => songs.push({ docId: d.id, ...d.data() }));

      const seenLinks = new Map();
      const seenTitles = new Map();
      const duplicateList = [];
      currentDuplicateDocs = [];

      songs.forEach((s) => {
        const cleanLink = decodeURIComponent((s.link || "").split("?")[0].toLowerCase().trim())
          .replace(/\.(mp3|webm|m4a|wav|ogg)$/i, "")
          .replace(/[^a-z0-9]/g, "");
        const cleanTitle = (s.title || "").toLowerCase().replace(/\.(mp3|webm|m4a)$/i, "").replace(/[^a-z0-9]/g, "").trim();

        let isDup = false;
        let reason = "";

        if (cleanLink && seenLinks.has(cleanLink)) {
          isDup = true;
          reason = `Identical stream URL with "${seenLinks.get(cleanLink).title}"`;
        } else if (cleanTitle && seenTitles.has(cleanTitle)) {
          isDup = true;
          reason = `Matching title with "${seenTitles.get(cleanTitle).title}"`;
        }

        if (isDup) {
          const item = { ...s, reason };
          duplicateList.push(item);
          currentDuplicateDocs.push(item);
        } else {
          if (cleanLink) seenLinks.set(cleanLink, s);
          if (cleanTitle) seenTitles.set(cleanTitle, s);
        }
      });

      const summary = duplicateList.length > 0
        ? `Found <strong>${duplicateList.length} duplicate songs</strong> in Firestore. You can review them below and remove duplicates individually or purge all duplicate copies.`
        : `All <strong>${songs.length} tracks</strong> in the Firestore database are unique. Zero duplicates found!`;

      openDuplicatesReport("🔍 Database Duplicate Audit", summary, duplicateList, true);

    } catch (err) {
      alert("Error scanning duplicates: " + err.message);
    } finally {
      btnScanDuplicates.disabled = false;
      btnScanDuplicates.innerHTML = `<span class="material-icons" style="font-size:1rem;vertical-align:middle;margin-right:2px">find_replace</span> Duplicate Finder`;
    }
  });
}

// ─── 1-CLICK FIX .WEBM / FILE GARDEN STREAM URLS ───────────────────
const btnFixWebmUrls = document.getElementById("btn-fix-webm-urls");
if (btnFixWebmUrls) {
  btnFixWebmUrls.addEventListener("click", async () => {
    if (!confirm("This will scan all songs in Firestore and remove '.webm' from stream links to match your updated File Garden audio files. Proceed?")) {
      return;
    }

    btnFixWebmUrls.disabled = true;
    btnFixWebmUrls.innerHTML = `<span class="material-icons" style="font-size:1rem;animation:spin 1s linear infinite">refresh</span> Fixing...`;

    try {
      const snap = await getDocs(collection(db, "songs"));
      let fixedCount = 0;

      for (const docSnap of snap.docs) {
        const data = docSnap.data();
        let link = data.link || "";

        if (link.includes(".webm") || link.includes("%2Ewebm")) {
          const newLink = link
            .replace(/\.webm(?=[\?&#]|$)/gi, "")
            .replace(/%2Ewebm(?=[\?&#]|$)/gi, "");

          if (newLink !== link) {
            await updateDoc(doc(db, "songs", docSnap.id), { link: newLink });
            fixedCount++;
          }
        }
      }

      // Also clean in localStorage
      try {
        const local = JSON.parse(localStorage.getItem("musicsaura_local_uploads") || "[]");
        let localChanged = false;
        local.forEach((s) => {
          if (s.link && (s.link.includes(".webm") || s.link.includes("%2Ewebm"))) {
            s.link = s.link
              .replace(/\.webm(?=[\?&#]|$)/gi, "")
              .replace(/%2Ewebm(?=[\?&#]|$)/gi, "");
            localChanged = true;
          }
        });
        if (localChanged) {
          localStorage.setItem("musicsaura_local_uploads", JSON.stringify(local));
        }
      } catch {}

      showAlert(`🎉 Fixed ${fixedCount} songs! All .webm extensions removed from Firestore.`);
      loadUploadedSongs();

    } catch (err) {
      alert("Error fixing URLs: " + err.message);
    } finally {
      btnFixWebmUrls.disabled = false;
      btnFixWebmUrls.innerHTML = `<span class="material-icons" style="font-size:1rem;vertical-align:middle;margin-right:2px">build</span> Fix .webm URLs`;
    }
  });
}

// ─── SYNC JSONS TO FIRESTORE (WITH DUPLICATE REPORT) ──────────────
const syncJsonBtn = document.getElementById("sync-json-btn");
if (syncJsonBtn) {
  syncJsonBtn.addEventListener("click", async () => {
    if (!confirm("Do you want to sync all cleaned songs from hindi.json, punjabi.json, haryanvi.json, rap.json, and bhojpuri.json into Firestore? (Any duplicate songs will be identified and reported)")) {
      return;
    }

    syncJsonBtn.disabled = true;
    syncJsonBtn.textContent = "Syncing...";

    try {
      const genres = [
        { file: "jsons/hindi.json", genre: "Hindi" },
        { file: "jsons/punjabi.json", genre: "Punjabi" },
        { file: "jsons/haryanvi.json", genre: "Haryanvi" },
        { file: "jsons/rap.json", genre: "Rap" },
        { file: "jsons/bhojpuri.json", genre: "Bhojpuri" }
      ];

      // Fetch existing songs from Firestore to avoid duplicate links
      const existingSnap = await getDocs(collection(db, "songs"));
      const existingLinks = new Map();
      const existingTitles = new Map();

      existingSnap.forEach((d) => {
        const data = d.data();
        const cleanLink = (data.link || "").split("?")[0].toLowerCase().trim();
        const cleanTitle = (data.title || "").toLowerCase().replace(/[^a-z0-9]/g, "").trim();
        if (cleanLink) existingLinks.set(cleanLink, data.title);
        if (cleanTitle) existingTitles.set(cleanTitle, data.title);
      });

      let addedCount = 0;
      const skippedDuplicates = [];
      const pendingToAdd = [];

      for (const item of genres) {
        try {
          const res = await fetch(item.file);
          if (!res.ok) continue;
          const songs = await res.json();

          for (const s of songs) {
            if (!s.title || !s.link) continue;

            const cleanLink = s.link.split("?")[0].toLowerCase().trim();
            const cleanTitle = s.title.toLowerCase().replace(/[^a-z0-9]/g, "").trim();

            if (existingLinks.has(cleanLink)) {
              skippedDuplicates.push({
                title: s.title,
                artist: s.artist || "Unknown",
                genre: item.genre,
                thumbnail: s.thumbnail || "assets/logo.png",
                reason: `Link already exists in Firestore (as "${existingLinks.get(cleanLink)}")`
              });
              continue;
            }

            if (existingTitles.has(cleanTitle)) {
              skippedDuplicates.push({
                title: s.title,
                artist: s.artist || "Unknown",
                genre: item.genre,
                thumbnail: s.thumbnail || "assets/logo.png",
                reason: `Title already exists in Firestore (as "${existingTitles.get(cleanTitle)}")`
              });
              continue;
            }

            const keywords = Array.from(new Set([
              ...s.title.toLowerCase().split(/\s+/),
              ...(s.artist ? s.artist.toLowerCase().split(/[,&/ ]+/) : []),
              ...(Array.isArray(s.keywords) ? s.keywords.map(k => k.toLowerCase()) : []),
              item.genre.toLowerCase()
            ].filter(Boolean)));

            pendingToAdd.push({
              title: s.title,
              artist: s.artist || "MusicsAura",
              genre: (s.genre || item.genre).toLowerCase(),
              link: s.link,
              thumbnail: s.thumbnail || "",
              keywords,
              uploadedBy: currentAdminUser?.email || "admin@musicsaura.com",
              createdAt: serverTimestamp(),
              plays: 0
            });

            existingLinks.set(cleanLink, s.title);
            existingTitles.set(cleanTitle, s.title);
          }
        } catch (e) {
          console.warn("Sync error for", item.genre, e);
        }
      }

      // Also gather any local uploads
      try {
        const local = JSON.parse(localStorage.getItem("musicsaura_local_uploads") || "[]");
        for (const s of local) {
          if (!s.title || !s.link) continue;
          const cleanLink = s.link.split("?")[0].toLowerCase().trim();
          const cleanTitle = s.title.toLowerCase().replace(/[^a-z0-9]/g, "").trim();

          if (existingLinks.has(cleanLink) || existingTitles.has(cleanTitle)) continue;

          pendingToAdd.push({
            title: s.title,
            artist: s.artist || "MusicsAura",
            genre: (s.genre || "Hindi").toLowerCase(),
            link: s.link,
            thumbnail: s.thumbnail || "assets/logo.png",
            keywords: Array.from(new Set([
              ...s.title.toLowerCase().split(/\s+/),
              ...(s.artist ? s.artist.toLowerCase().split(/[,&/ ]+/) : [])
            ].filter(Boolean))),
            uploadedBy: currentAdminUser?.email || "admin@musicsaura.com",
            createdAt: serverTimestamp(),
            plays: 0
          });

          existingLinks.set(cleanLink, s.title);
          existingTitles.set(cleanTitle, s.title);
        }
      } catch (e) {
        console.warn("Local uploads sync notice:", e);
      }

      // Commit pending additions in atomic batches of 100 to prevent quota spikes
      const BATCH_SIZE = 100;
      for (let i = 0; i < pendingToAdd.length; i += BATCH_SIZE) {
        const chunk = pendingToAdd.slice(i, i + BATCH_SIZE);
        const batch = writeBatch(db);
        chunk.forEach((songData) => {
          const docRef = doc(collection(db, "songs"));
          batch.set(docRef, songData);
        });
        await batch.commit();
        addedCount += chunk.length;
        syncJsonBtn.textContent = `Syncing... (${addedCount}/${pendingToAdd.length})`;
      }

      const summaryHtml = `
        <strong>Sync Finished!</strong> Added <strong>${addedCount} new songs</strong> to Firestore.<br>
        ${skippedDuplicates.length > 0
          ? `Detected and skipped <strong>${skippedDuplicates.length} duplicate tracks</strong>. See below for the exact track names:`
          : `All songs were unique. Zero duplicates encountered.`}
      `;

      openDuplicatesReport("📥 Sync & Duplicate Report", summaryHtml, skippedDuplicates, false);
      loadUploadedSongs();

    } catch (err) {
      alert("Sync failed: " + err.message);
    } finally {
      syncJsonBtn.disabled = false;
      syncJsonBtn.innerHTML = '<span class="material-icons" style="font-size:1rem;vertical-align:middle;margin-right:2px">cloud_upload</span>Sync JSONs &rarr; Firestore';
    }
  });
}

// Logout handler
const logoutBtn = document.getElementById("logout");
if (logoutBtn) {
  logoutBtn.onclick = () => signOut(auth).then(() => { location.href = "auth.html"; });
}
