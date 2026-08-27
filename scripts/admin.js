// scripts/admin.js — MusicsAura 3.0 Studio Controller
import {
  auth, db, isAdmin, onAuthStateChanged, signOut,
  collection, query, orderBy, getDocs, addDoc, deleteDoc, doc, serverTimestamp
} from "./firebase-config.js";

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

      await addDoc(collection(db, "songs"), newSongData);

      showAlert(`✅ Added "${title}" to MusicsAura!`);
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
          plays: 0
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

// ─── LOAD & MANAGE SONGS TABLE ─────────────────────────────────────
async function loadUploadedSongs() {
  if (!songsTbody) return;
  if (songsLoading) songsLoading.style.display = "block";

  try {
    const q = query(collection(db, "songs"), orderBy("createdAt", "desc"));
    const snap = await getDocs(q);

    allUploadedSongs = [];
    snap.forEach((docSnap) => {
      allUploadedSongs.push({
        id: docSnap.id,
        ...docSnap.data()
      });
    });

    if (uploadedCountEl) uploadedCountEl.textContent = allUploadedSongs.length;
    if (songsCountBadge) songsCountBadge.textContent = `${allUploadedSongs.length} tracks`;

    renderSongsTable(allUploadedSongs);

  } catch (err) {
    console.error("Failed to load songs:", err);
    if (songsLoading) songsLoading.textContent = "Error loading songs: " + err.message;
  }
}

function renderSongsTable(songs) {
  if (!songsTbody) return;
  if (songsLoading) songsLoading.style.display = "none";

  if (!songs.length) {
    songsTbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--text-muted)">No studio songs found. Paste a link above to add one!</td></tr>`;
    return;
  }

  const frag = document.createDocumentFragment();

  songs.forEach((song) => {
    const tr = document.createElement("tr");
    const thumbUrl = song.thumbnail || "assets/logo.png";
    const dateStr = song.createdAt?.toDate ? song.createdAt.toDate().toLocaleDateString() : "Recent";

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
      <td><span class="genre-tag">${escapeHtml(song.genre || "Hindi")}</span></td>
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

  // Bind delete handlers
  songsTbody.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteSong(btn.dataset.id));
  });
}

async function deleteSong(songId) {
  const song = allUploadedSongs.find((s) => s.id === songId);
  if (!song) return;

  if (!confirm(`Are you sure you want to delete "${song.title}"?`)) {
    return;
  }

  try {
    await deleteDoc(doc(db, "songs", songId));
    showAlert(`Deleted "${song.title}"`);
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

// ─── EXPORT ALL SONGS TO JSON ──────────────────────────────────────
if (exportJsonBtn) {
  exportJsonBtn.addEventListener("click", () => {
    if (!allUploadedSongs.length) {
      alert("No studio songs to export.");
      return;
    }

    const cleanList = allUploadedSongs.map((s) => ({
      title: s.title || "",
      artist: s.artist || "",
      link: s.link || "",
      thumbnail: s.thumbnail || "",
      keywords: s.keywords || [],
      genre: s.genre || "Hindi"
    }));

    const blob = new Blob([JSON.stringify(cleanList, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `musicsaura_studio_export_${Date.now()}.json`;
    a.click();
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

    const frag = document.createDocumentFragment();

    snap.forEach((docSnap) => {
      const u = docSnap.data();
      totalUsers++;
      totalSongs += u.songsPlayed || 0;
      totalMins  += u.minutesListened || 0;

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

    if (usersLoading) usersLoading.style.display = "none";
    usersTbody.replaceChildren(frag);

    if (totalUsersEl) totalUsersEl.textContent = totalUsers.toLocaleString();
    if (totalSongsEl) totalSongsEl.textContent = totalSongs.toLocaleString();
    if (totalMinutesEl) totalMinutesEl.textContent = Math.round(totalMins).toLocaleString();

  } catch (err) {
    console.error("Failed to load users:", err);
    if (usersLoading) usersLoading.textContent = "Error loading users: " + err.message;
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

// ─── SYNC JSONS TO FIRESTORE ───
const syncJsonBtn = document.getElementById("sync-json-btn");
if (syncJsonBtn) {
  syncJsonBtn.addEventListener("click", async () => {
    if (!confirm("Do you want to sync all cleaned songs from hindi.json, punjabi.json, and haryanvi.json into Firestore? (Existing duplicate links will be skipped)")) {
      return;
    }

    syncJsonBtn.disabled = true;
    syncJsonBtn.textContent = "Syncing...";

    try {
      const genres = [
        { file: "jsons/hindi.json", genre: "Hindi" },
        { file: "jsons/punjabi.json", genre: "Punjabi" },
        { file: "jsons/haryanvi.json", genre: "Haryanvi" }
      ];

      // Fetch existing songs from Firestore to avoid duplicate links
      const existingSnap = await getDocs(collection(db, "songs"));
      const existingLinks = new Set();
      existingSnap.forEach(d => {
        const link = d.data().link;
        if (link) existingLinks.add(link);
      });

      let addedCount = 0;
      let skippedCount = 0;

      for (const item of genres) {
        try {
          const res = await fetch(item.file);
          if (!res.ok) continue;
          const songs = await res.json();

          for (const s of songs) {
            if (!s.title || !s.link) continue;
            if (existingLinks.has(s.link)) {
              skippedCount++;
              continue;
            }

            const keywords = Array.from(new Set([
              ...s.title.toLowerCase().split(/\s+/),
              ...(s.artist ? s.artist.toLowerCase().split(/[,&/ ]+/) : []),
              ...(Array.isArray(s.keywords) ? s.keywords.map(k => k.toLowerCase()) : []),
              item.genre.toLowerCase()
            ].filter(Boolean)));

            await addDoc(collection(db, "songs"), {
              title: s.title,
              artist: s.artist || "MusicsAura",
              genre: s.genre || item.genre,
              link: s.link,
              thumbnail: s.thumbnail || "",
              keywords,
              uploadedBy: currentAdminUser?.email || "admin@musicsaura.com",
              createdAt: serverTimestamp(),
              plays: 0
            });

            existingLinks.add(s.link);
            addedCount++;
            syncJsonBtn.textContent = `Syncing... (${addedCount} added)`;
          }
        } catch (e) {
          console.warn("Sync error for", item.genre, e);
        }
      }

      alert(`✅ Sync Complete!\n${addedCount} songs added to Firestore database.\n${skippedCount} duplicate songs skipped.`);
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
