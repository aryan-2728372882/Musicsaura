// scripts/upload.js — MusicsAura 3.0 Creator Studio & Batch Auto-Publisher
// Duplicate Prevention Engine + Multi-MP3 Auto-Publisher (1 to 40+ Files)

import {
  db,
  collection, addDoc, getDocs, query, orderBy, limit, serverTimestamp,
  doc, deleteDoc, updateDoc, writeBatch
} from "./firebase-config.js";
import { commitSongsToGitHub, deleteSongFromGitHub } from "./github-sync.js";

// Folder Base URLs for File Garden
const FILE_GARDEN_FOLDERS = {
  hindi:    "https://file.garden/aRgAQiYidD0tulQV/Hindi/",
  punjabi:  "https://file.garden/aRgAQiYidD0tulQV/Punjabi/",
  haryanvi: "https://file.garden/aRgAQiYidD0tulQV/Haryanvi/",
  rap:      "https://file.garden/apMS6Fbun9GoGp1g/Rap/",
  bhojpuri: "https://file.garden/apMS6Fbun9GoGp1g/Bhojpuri/"
};

const GENRE_JSON_FILES = {
  hindi:    "jsons/hindi.json",
  punjabi:  "jsons/punjabi.json",
  haryanvi: "jsons/haryanvi.json",
  rap:      "jsons/rap.json",
  bhojpuri: "jsons/bhojpuri.json"
};

// DOM Elements
const uploadForm            = document.getElementById("creator-upload-form");
const audioUrlInput         = document.getElementById("creator-audio-url");
const quickAudioPicker      = document.getElementById("quick-audio-picker");
const btnSelectAudioFile    = document.getElementById("btn-select-audio-file");
const selectedFileLabel     = document.getElementById("selected-file-label");
const dynamicFolderLink     = document.getElementById("dynamic-folder-link");

const coverUrlInput         = document.getElementById("creator-cover-url");
const coverPreviewImg       = document.getElementById("creator-cover-preview");
const autoFetchTag          = document.getElementById("auto-fetch-tag");
const manualFetchBtn        = document.getElementById("btn-manual-fetch");

const titleInput            = document.getElementById("creator-title");
const artistInput           = document.getElementById("creator-artist");
const genreSelect           = document.getElementById("creator-genre");
const uploaderNameInput     = document.getElementById("creator-uploader-name");
const submitBtn             = document.getElementById("btn-creator-submit");
const uploadAlert           = document.getElementById("upload-alert");

// Batch Multi-Track Queue DOM Elements
const batchQueueContainer   = document.getElementById("batch-queue-container");
const batchQueueTitle       = document.getElementById("batch-queue-title");
const batchQueueSubtitle    = document.getElementById("batch-queue-subtitle");
const batchSetAllGenre      = document.getElementById("batch-set-all-genre");
const btnClearBatch         = document.getElementById("btn-clear-batch");
const batchProgressWrap     = document.getElementById("batch-progress-wrap");
const batchProgressText     = document.getElementById("batch-progress-text");
const batchProgressPct      = document.getElementById("batch-progress-pct");
const batchProgressFill     = document.getElementById("batch-progress-fill");
const batchTrackList        = document.getElementById("batch-track-list");
const batchReadyCount       = document.getElementById("batch-ready-count");
const batchDupCount         = document.getElementById("batch-dup-count");
const btnPublishBatch       = document.getElementById("btn-publish-batch");
const btnPublishBatchText   = document.getElementById("btn-publish-batch-text");

// Bulk Importer elements
const toggleBulkBtn         = document.getElementById("toggle-bulk-btn");
const bulkWrap              = document.getElementById("bulk-importer-wrap");
const bulkUrlsInput         = document.getElementById("bulk-urls");
const bulkGenreSelect       = document.getElementById("bulk-genre");
const submitBulkBtn         = document.getElementById("btn-submit-bulk");
const exportJsonBtn         = document.getElementById("btn-export-json");

const contribList           = document.getElementById("contrib-list");
const contribCount          = document.getElementById("contrib-count");

let autoFetchDebounce       = null;
let batchTracks             = []; // Array of { file, title, artist, artwork, genre, streamUrl, isDuplicate, dupReason }

// ─── DUPLICATE DETECTION REGISTRY ──────────────────────────────────
const existingLinks         = new Set();
const existingTitles        = new Set();

function normalizeKey(str) {
  return (str || "")
    .toLowerCase()
    .replace(/\.(mp3|webm|m4a|wav|ogg)$/i, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function normalizeUrlKey(url) {
  if (!url) return "";
  try {
    const clean = decodeURIComponent(url.split("?")[0].toLowerCase().trim())
      .replace(/\.(mp3|webm|m4a|wav|ogg)$/i, "")
      .replace(/[^a-z0-9]/g, "");
    return clean;
  } catch {
    return (url || "").toLowerCase().replace(/[^a-z0-9]/g, "").trim();
  }
}

async function loadExistingRegistry() {
  try {
    // 1. Load static JSON catalogues
    await Promise.all(
      Object.entries(GENRE_JSON_FILES).map(async ([genre, path]) => {
        try {
          const res = await fetch(path);
          if (res.ok) {
            const data = await res.json();
            data.forEach((s) => {
              if (s.link) existingLinks.add(normalizeUrlKey(s.link));
              if (s.title) existingTitles.add(normalizeKey(s.title));
            });
          }
        } catch {}
      })
    );

    // 2. Load recent Firestore published songs (only top 15 to minimize read quota)
    try {
      const snap = await getDocs(query(collection(db, "songs"), orderBy("createdAt", "desc"), limit(15)));
      snap.forEach((docSnap) => {
        const s = docSnap.data();
        if (s.link) existingLinks.add(normalizeUrlKey(s.link));
        if (s.title) existingTitles.add(normalizeKey(s.title));
      });
    } catch {}

    // 3. Load local uploads buffer
    try {
      const local = JSON.parse(localStorage.getItem("musicsaura_local_uploads") || "[]");
      local.forEach((s) => {
        if (s.link) existingLinks.add(normalizeUrlKey(s.link));
        if (s.title) existingTitles.add(normalizeKey(s.title));
      });
    } catch {}

  } catch (err) {
    console.warn("Registry load error:", err);
  }
}

function checkIsDuplicate(title, link) {
  const linkKey = normalizeUrlKey(link);
  if (linkKey && existingLinks.has(linkKey)) {
    return { isDuplicate: true, reason: "Same audio link already exists in library" };
  }

  const titleKey = normalizeKey(title);
  if (titleKey && existingTitles.has(titleKey)) {
    return { isDuplicate: true, reason: "Track with matching title already exists" };
  }

  return { isDuplicate: false, reason: "" };
}

function registerNewSong(title, link) {
  if (link) existingLinks.add(normalizeUrlKey(link));
  if (title) existingTitles.add(normalizeKey(title));
}

// ─── SMART TITLE EXTRACTOR ─────────────────────────────────────────
function cleanFilenameToTitle(urlOrFilename) {
  try {
    const clean = urlOrFilename.split("?")[0];
    const rawName = clean.substring(clean.lastIndexOf("/") + 1);
    const decoded = decodeURIComponent(rawName)
      .replace(/\.[^/.]+$/, "")            // remove extension (.mp3)
      .replace(/^\d+[\s._-]+/, "")         // remove track numbers like "01 - "
      .replace(/[\[\(].*?[\]\)]/g, "")     // remove brackets like (320kbps)
      .replace(/[_]/g, " ")                // replace underscores
      .replace(/\s+/g, " ")                // normalize spaces
      .trim();
    return decoded || "Untitled Track";
  } catch {
    return "Untitled Track";
  }
}

function detectGenreFromUrl(url) {
  if (!url) return null;
  const lower = url.toLowerCase();
  if (lower.includes("/rap/") || lower.includes("rap")) return "rap";
  if (lower.includes("/bhojpuri/") || lower.includes("bhojpuri")) return "bhojpuri";
  if (lower.includes("/haryanvi/") || lower.includes("haryanvi")) return "haryanvi";
  if (lower.includes("/punjabi/") || lower.includes("punjabi")) return "punjabi";
  if (lower.includes("/hindi/") || lower.includes("hindi")) return "hindi";
  return null;
}

// ─── ITUNES METADATA & HD ARTWORK FETCHER ──────────────────────────
async function fetchOnlineMetadata(queryText) {
  if (!queryText || queryText.trim().length < 2) return null;
  const cleanTerm = queryText.trim();

  try {
    const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(cleanTerm)}&entity=song&limit=1`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.results && data.results.length > 0) {
      const match = data.results[0];
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

function showAlert(msg, isError = false) {
  if (!uploadAlert) return;
  uploadAlert.textContent = msg;
  uploadAlert.className = `alert-box ${isError ? "alert-error" : "alert-success"} visible`;
  setTimeout(() => {
    uploadAlert.classList.remove("visible");
  }, 6000);
}

function updateFolderLink(genre) {
  const g = (genre || "hindi").toLowerCase();
  const folderUrl = FILE_GARDEN_FOLDERS[g] || FILE_GARDEN_FOLDERS.hindi;
  if (dynamicFolderLink) {
    dynamicFolderLink.href = folderUrl;
    const name = g.charAt(0).toUpperCase() + g.slice(1);
    dynamicFolderLink.innerHTML = `<span class="material-icons" style="font-size:0.95rem">open_in_new</span> Open ${name} File Garden Folder`;
  }
}

// ─── MULTI-FILE SELECTION & BATCH PROCESSOR ────────────────────────
if (btnSelectAudioFile && quickAudioPicker) {
  btnSelectAudioFile.addEventListener("click", () => quickAudioPicker.click());

  quickAudioPicker.addEventListener("change", async () => {
    const files = Array.from(quickAudioPicker.files || []);
    if (!files.length) return;

    if (files.length === 1) {
      // Single file workflow
      handleSingleAudioSelection(files[0]);
      if (batchQueueContainer) batchQueueContainer.style.display = "none";
    } else {
      // Multi-file batch workflow (2 to 40+ files)
      handleBatchAudioSelection(files);
    }
  });
}

function handleSingleAudioSelection(file) {
  if (selectedFileLabel) {
    selectedFileLabel.innerHTML = `✅ <strong style="color:var(--cyan)">${escapeHtml(file.name)}</strong> (${(file.size / (1024 * 1024)).toFixed(1)} MB)`;
  }

  const cleanTitle = cleanFilenameToTitle(file.name);
  titleInput.value = cleanTitle;

  const currentGenre = (genreSelect ? genreSelect.value : "hindi").toLowerCase();
  const baseFolder = FILE_GARDEN_FOLDERS[currentGenre] || FILE_GARDEN_FOLDERS.hindi;
  const encodedName = encodeURIComponent(file.name);
  const streamUrl = `${baseFolder}${encodedName}`;

  audioUrlInput.value = streamUrl;

  // Duplicate Check
  const dup = checkIsDuplicate(cleanTitle, streamUrl);
  if (dup.isDuplicate) {
    showAlert(`⚠️ Warning: "${cleanTitle}" appears to already exist in MusicsAura (${dup.reason})`, true);
  }

  triggerAutoFetch(cleanTitle);
}

async function triggerAutoFetch(title) {
  if (!title) return;
  if (autoFetchTag) autoFetchTag.style.display = "inline";

  const meta = await fetchOnlineMetadata(title);
  if (autoFetchTag) autoFetchTag.style.display = "none";

  if (meta) {
    if (meta.artist && (!artistInput.value || artistInput.value === "Various Artists")) {
      artistInput.value = meta.artist;
    }
    if (meta.artwork) {
      coverUrlInput.value = meta.artwork;
      if (coverPreviewImg) coverPreviewImg.src = meta.artwork;
    }
  }
}

// ─── BATCH QUEUE PROCESSING (UP TO 40+ FILES) ─────────────────────
async function handleBatchAudioSelection(files) {
  if (selectedFileLabel) {
    selectedFileLabel.innerHTML = `📦 <strong style="color:var(--cyan)">${files.length} MP3 files selected</strong> for batch upload`;
  }

  if (batchQueueContainer) batchQueueContainer.style.display = "block";
  if (batchQueueTitle) batchQueueTitle.textContent = `Batch Queue (${files.length} Tracks Selected)`;
  if (batchProgressWrap) batchProgressWrap.style.display = "block";

  const defaultGenre = (genreSelect ? genreSelect.value : "hindi").toLowerCase();

  // Initialize batch structure
  batchTracks = files.map((file, idx) => {
    const title = cleanFilenameToTitle(file.name);
    const genre = defaultGenre;
    const baseFolder = FILE_GARDEN_FOLDERS[genre] || FILE_GARDEN_FOLDERS.hindi;
    const streamUrl = `${baseFolder}${encodeURIComponent(file.name)}`;
    const dup = checkIsDuplicate(title, streamUrl);

    return {
      id: "batch_" + idx + "_" + Date.now(),
      file,
      title,
      artist: "Various Artists",
      artwork: "assets/logo.png",
      genre,
      streamUrl,
      isDuplicate: dup.isDuplicate,
      dupReason: dup.reason,
      status: "pending" // 'pending' | 'fetching' | 'ready' | 'uploaded' | 'error'
    };
  });

  renderBatchTrackList();

  // Concurrent Auto-Fetch Worker (5 Parallel Workers for speed)
  const CONCURRENCY = 5;
  let completed = 0;

  async function worker(track) {
    track.status = "fetching";
    renderBatchTrackItemStatus(track);

    try {
      const meta = await fetchOnlineMetadata(track.title);
      if (meta) {
        if (meta.artist) track.artist = meta.artist;
        if (meta.artwork) track.artwork = meta.artwork;
      }
    } catch {}

    track.status = track.isDuplicate ? "duplicate" : "ready";
    completed++;

    const pct = Math.round((completed / batchTracks.length) * 100);
    if (batchProgressPct) batchProgressPct.textContent = `${pct}%`;
    if (batchProgressFill) batchProgressFill.style.width = `${pct}%`;
    if (batchProgressText) batchProgressText.textContent = `✨ Auto-fetched metadata & artwork: ${completed} of ${batchTracks.length} tracks`;

    renderBatchTrackItemStatus(track);
  }

  // Run pool
  const queue = [...batchTracks];
  const activeWorkers = [];

  for (let i = 0; i < CONCURRENCY && queue.length > 0; i++) {
    activeWorkers.push(
      (async function runNext() {
        while (queue.length > 0) {
          const track = queue.shift();
          await worker(track);
        }
      })()
    );
  }

  await Promise.all(activeWorkers);

  if (batchProgressText) batchProgressText.textContent = `✨ Metadata auto-fetch complete! Ready to publish.`;
  setTimeout(() => {
    if (batchProgressWrap) batchProgressWrap.style.display = "none";
  }, 1800);

  updateBatchSummaryCounts();
}

function renderBatchTrackList() {
  if (!batchTrackList) return;
  batchTrackList.innerHTML = "";

  batchTracks.forEach((track, index) => {
    const item = document.createElement("div");
    item.className = "batch-track-item";
    item.id = `track-item-${track.id}`;
    item.style.cssText = `
      display: flex; gap: 12px; align-items: center; background: var(--surface-card);
      border: 1px solid ${track.isDuplicate ? "rgba(244,63,94,0.4)" : "var(--border)"};
      border-radius: var(--radius-md); padding: 0.75rem; flex-wrap: wrap;
    `;

    item.innerHTML = `
      <div style="width:52px;height:52px;border-radius:var(--radius-sm);overflow:hidden;background:var(--surface-raised);flex-shrink:0;border:1px solid var(--border-strong)">
        <img id="img-${track.id}" src="${track.artwork}" alt="" style="width:100%;height:100%;object-fit:cover" onerror="this.src='assets/logo.png'">
      </div>

      <div style="flex:1;min-width:180px;display:flex;flex-direction:column;gap:4px">
        <input type="text" class="form-input track-title-inp" value="${escapeHtml(track.title)}" style="padding:0.4rem 0.6rem;font-size:0.86rem;font-weight:600" title="Song Title">
        <input type="text" class="form-input track-artist-inp" value="${escapeHtml(track.artist)}" style="padding:0.35rem 0.6rem;font-size:0.8rem;color:var(--text-secondary)" title="Artist">
      </div>

      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <select class="form-select track-genre-sel" style="padding:0.4rem 0.6rem;font-size:0.8rem;min-width:95px">
          <option value="hindi" ${track.genre === "hindi" ? "selected" : ""}>Hindi</option>
          <option value="punjabi" ${track.genre === "punjabi" ? "selected" : ""}>Punjabi</option>
          <option value="haryanvi" ${track.genre === "haryanvi" ? "selected" : ""}>Haryanvi</option>
          <option value="rap" ${track.genre === "rap" ? "selected" : ""}>Rap</option>
          <option value="bhojpuri" ${track.genre === "bhojpuri" ? "selected" : ""}>Bhojpuri</option>
        </select>

        <span id="badge-${track.id}" class="genre-tag" style="${track.isDuplicate ? "background:rgba(244,63,94,0.15);color:var(--rose);border-color:rgba(244,63,94,0.3)" : "background:rgba(16,185,129,0.15);color:var(--emerald);border-color:rgba(16,185,129,0.3)"}">
          ${track.isDuplicate ? "⚠️ Duplicate" : "✅ Ready"}
        </span>

        <button type="button" class="action-btn btn-remove-track" title="Remove from batch" style="color:var(--text-muted)">
          <span class="material-icons" style="font-size:1.1rem">close</span>
        </button>
      </div>
    `;

    // Title edit listener
    const titleInp = item.querySelector(".track-title-inp");
    titleInp.addEventListener("input", (e) => {
      track.title = e.target.value.trim();
      const dup = checkIsDuplicate(track.title, track.streamUrl);
      track.isDuplicate = dup.isDuplicate;
      track.dupReason = dup.reason;
      renderBatchTrackItemStatus(track);
      updateBatchSummaryCounts();
    });

    // Artist edit listener
    const artistInp = item.querySelector(".track-artist-inp");
    artistInp.addEventListener("input", (e) => {
      track.artist = e.target.value.trim();
    });

    // Genre change listener
    const genreSel = item.querySelector(".track-genre-sel");
    genreSel.addEventListener("change", (e) => {
      track.genre = e.target.value;
      const baseFolder = FILE_GARDEN_FOLDERS[track.genre] || FILE_GARDEN_FOLDERS.hindi;
      track.streamUrl = `${baseFolder}${encodeURIComponent(track.file.name)}`;
      const dup = checkIsDuplicate(track.title, track.streamUrl);
      track.isDuplicate = dup.isDuplicate;
      track.dupReason = dup.reason;
      renderBatchTrackItemStatus(track);
      updateBatchSummaryCounts();
    });

    // Remove from batch
    const removeBtn = item.querySelector(".btn-remove-track");
    removeBtn.addEventListener("click", () => {
      batchTracks = batchTracks.filter((t) => t.id !== track.id);
      renderBatchTrackList();
      updateBatchSummaryCounts();
      if (!batchTracks.length && batchQueueContainer) {
        batchQueueContainer.style.display = "none";
      }
    });

    batchTrackList.appendChild(item);
  });

  updateBatchSummaryCounts();
}

function renderBatchTrackItemStatus(track) {
  const item = document.getElementById(`track-item-${track.id}`);
  if (!item) return;

  const img = document.getElementById(`img-${track.id}`);
  if (img && track.artwork) img.src = track.artwork;

  const artistInp = item.querySelector(".track-artist-inp");
  if (artistInp && track.artist) artistInp.value = track.artist;

  const badge = document.getElementById(`badge-${track.id}`);
  if (badge) {
    if (track.status === "fetching") {
      badge.style.cssText = "background:rgba(34,211,238,0.15);color:var(--cyan);border-color:rgba(34,211,238,0.3)";
      badge.innerHTML = `<span class="material-icons" style="font-size:0.85rem;vertical-align:middle;animation:spin 1s linear infinite">refresh</span> Fetching...`;
    } else if (track.isDuplicate) {
      badge.style.cssText = "background:rgba(244,63,94,0.15);color:var(--rose);border-color:rgba(244,63,94,0.3)";
      badge.textContent = "⚠️ Duplicate";
      item.style.borderColor = "rgba(244,63,94,0.4)";
    } else if (track.status === "uploaded") {
      badge.style.cssText = "background:rgba(138,92,246,0.2);color:var(--violet-light);border-color:rgba(138,92,246,0.4)";
      badge.textContent = "🎉 Published";
      item.style.borderColor = "rgba(138,92,246,0.3)";
    } else {
      badge.style.cssText = "background:rgba(16,185,129,0.15);color:var(--emerald);border-color:rgba(16,185,129,0.3)";
      badge.textContent = "✅ Ready";
      item.style.borderColor = "var(--border)";
    }
  }
}

function updateBatchSummaryCounts() {
  const duplicates = batchTracks.filter((t) => t.isDuplicate);
  const ready = batchTracks.filter((t) => !t.isDuplicate && t.status !== "uploaded");

  if (batchReadyCount) batchReadyCount.textContent = ready.length;
  if (batchDupCount) batchDupCount.textContent = duplicates.length;

  if (btnPublishBatchText) {
    btnPublishBatchText.textContent = ready.length > 0
      ? `Publish ${ready.length} Non-Duplicate Tracks`
      : `No New Tracks to Publish (${duplicates.length} Duplicates)`;
  }
  if (btnPublishBatch) {
    btnPublishBatch.disabled = ready.length === 0;
  }
}

// ─── SET ALL GENRE FOR BATCH ───────────────────────────────────────
if (batchSetAllGenre) {
  batchSetAllGenre.addEventListener("change", () => {
    const g = batchSetAllGenre.value;
    if (!g) return;

    batchTracks.forEach((track) => {
      track.genre = g;
      const baseFolder = FILE_GARDEN_FOLDERS[g] || FILE_GARDEN_FOLDERS.hindi;
      track.streamUrl = `${baseFolder}${encodeURIComponent(track.file.name)}`;
      const dup = checkIsDuplicate(track.title, track.streamUrl);
      track.isDuplicate = dup.isDuplicate;
      track.dupReason = dup.reason;
    });

    renderBatchTrackList();
  });
}

if (btnClearBatch) {
  btnClearBatch.addEventListener("click", () => {
    batchTracks = [];
    if (batchTrackList) batchTrackList.innerHTML = "";
    if (batchQueueContainer) batchQueueContainer.style.display = "none";
    if (selectedFileLabel) selectedFileLabel.textContent = "No files chosen yet";
  });
}

// ─── PUBLISH BATCH TRACKS TO FIRESTORE ─────────────────────────────
if (btnPublishBatch) {
  btnPublishBatch.addEventListener("click", async () => {
    const publishable = batchTracks.filter((t) => !t.isDuplicate && t.status !== "uploaded");
    if (!publishable.length) {
      showAlert("No non-duplicate tracks to publish", true);
      return;
    }

    btnPublishBatch.disabled = true;
    if (batchProgressWrap) batchProgressWrap.style.display = "block";

    let publishedCount = 0;
    const uploaderName = (uploaderNameInput ? uploaderNameInput.value.trim() : "") || "Community Member";
    const localSavedSongs = [];

    // Process in atomic batches of 100
    const BATCH_SIZE = 100;
    for (let b = 0; b < publishable.length; b += BATCH_SIZE) {
      const chunk = publishable.slice(b, b + BATCH_SIZE);
      const batch = writeBatch(db);

      chunk.forEach((track, idx) => {
        const i = b + idx;
        const pct = Math.round(((i + 1) / publishable.length) * 100);
        if (batchProgressPct) batchProgressPct.textContent = `${pct}%`;
        if (batchProgressFill) batchProgressFill.style.width = `${pct}%`;
        if (batchProgressText) batchProgressText.textContent = `🚀 Publishing "${track.title}" (${i + 1}/${publishable.length})...`;

        const keywords = Array.from(
          new Set([
            ...track.title.toLowerCase().split(/\s+/),
            ...track.artist.toLowerCase().split(/[,&/ ]+/),
            track.genre.toLowerCase(),
            uploaderName.toLowerCase()
          ].filter(Boolean))
        );

        const songData = {
          title: track.title,
          artist: track.artist || "Various Artists",
          genre: track.genre.toLowerCase(),
          link: track.streamUrl,
          thumbnail: track.artwork || "assets/logo.png",
          keywords,
          uploadedBy: uploaderName,
          createdAt: serverTimestamp(),
          plays: 0
        };

        const docRef = doc(collection(db, "songs"));
        batch.set(docRef, songData);

        localSavedSongs.push({
          id: docRef.id,
          ...songData,
          _timestamp: Date.now()
        });

        registerNewSong(track.title, track.streamUrl);
        track.status = "uploaded";
        renderBatchTrackItemStatus(track);
      });

      try {
        await batch.commit();
        publishedCount += chunk.length;
      } catch (err) {
        console.error("Batch commit error:", err);
      }
    }

    // Save to local storage buffer & invalidate cache so index.html immediately displays all songs
    try {
      const existingLocal = JSON.parse(localStorage.getItem("musicsaura_local_uploads") || "[]");
      const combined = [...localSavedSongs, ...existingLocal];
      localStorage.setItem("musicsaura_local_uploads", JSON.stringify(combined.slice(0, 150)));
      localStorage.removeItem("musicsaura_firestore_cache_time"); // force instant refresh on main page
    } catch {}

    // AUTOMATIC GITHUB REPOSITORY SYNC: Group by genre and auto-commit to jsons/{genre}.json
    try {
      const byGenre = {};
      publishable.forEach((t) => {
        const g = (t.genre || "hindi").toLowerCase();
        if (!byGenre[g]) byGenre[g] = [];
        byGenre[g].push({
          title: t.title,
          artist: t.artist || "Various Artists",
          link: t.streamUrl,
          thumbnail: t.artwork || "assets/logo.png",
          genre: t.genre
        });
      });

      for (const [g, tracks] of Object.entries(byGenre)) {
        try {
          const res = await commitSongsToGitHub(g, tracks);
          if (res && res.success) {
            console.log(`[GitHub Auto-Commit] ${tracks.length} track(s) saved to jsons/${g}.json on GitHub!`);
          }
        } catch (e) {
          console.warn("[GitHub Auto-Commit] Notice:", e);
        }
      }
    } catch (e) {
      console.warn("[GitHub Auto-Commit] Notice:", e);
    }

    showAlert(`🎉 Batch complete! Successfully published ${publishedCount} tracks to MusicsAura and synced to GitHub!`);
    loadCommunityUploads();
    updateBatchSummaryCounts();

    setTimeout(() => {
      if (batchProgressWrap) batchProgressWrap.style.display = "none";
    }, 2000);
  });
}

// ─── URL INPUT LISTENERS FOR SINGLE FORM ───────────────────────────
if (audioUrlInput) {
  audioUrlInput.addEventListener("input", () => {
    const url = audioUrlInput.value.trim();
    if (!url) return;

    const cleanTitle = cleanFilenameToTitle(url);
    if (cleanTitle) {
      titleInput.value = cleanTitle;
    }

    const detectedGenre = detectGenreFromUrl(url);
    if (detectedGenre && genreSelect && genreSelect.value !== detectedGenre) {
      genreSelect.value = detectedGenre;
      updateFolderLink(detectedGenre);
    }

    const dup = checkIsDuplicate(cleanTitle, url);
    if (dup.isDuplicate) {
      showAlert(`⚠️ Notice: "${cleanTitle}" already exists in library (${dup.reason})`, true);
    }

    clearTimeout(autoFetchDebounce);
    autoFetchDebounce = setTimeout(() => {
      triggerAutoFetch(cleanTitle);
    }, 350);
  });
}

if (genreSelect) {
  genreSelect.addEventListener("change", () => {
    const chosenGenre = genreSelect.value;
    updateFolderLink(chosenGenre);

    if (audioUrlInput && audioUrlInput.value) {
      const currentUrl = audioUrlInput.value.trim();
      const filename = currentUrl.substring(currentUrl.lastIndexOf("/") + 1);
      if (filename && (currentUrl.includes("file.garden") || !currentUrl.startsWith("http"))) {
        const baseFolder = FILE_GARDEN_FOLDERS[chosenGenre] || FILE_GARDEN_FOLDERS.hindi;
        audioUrlInput.value = `${baseFolder}${filename}`;
      }
    }
  });
}

if (manualFetchBtn) {
  manualFetchBtn.addEventListener("click", () => {
    const title = titleInput.value.trim() || cleanFilenameToTitle(audioUrlInput.value.trim());
    if (title) triggerAutoFetch(title);
  });
}

if (coverUrlInput && coverPreviewImg) {
  coverUrlInput.addEventListener("input", () => {
    const url = coverUrlInput.value.trim();
    coverPreviewImg.src = url || "assets/logo.png";
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

// ─── SINGLE FORM SUBMIT (WITH DUPLICATE BLOCKING) ──────────────────
if (uploadForm) {
  uploadForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const audioUrl     = audioUrlInput.value.trim();
    const title        = titleInput.value.trim();
    const artist       = artistInput.value.trim() || "Various Artists";
    const genre        = genreSelect.value;
    const coverUrl     = coverUrlInput ? coverUrlInput.value.trim() : "";
    const uploaderName = uploaderNameInput.value.trim() || "Community Member";

    if (!audioUrl) {
      showAlert("Please enter a File Garden or MP3 link", true);
      return;
    }
    if (!title) {
      showAlert("Please enter a track title", true);
      return;
    }

    // Strict Duplicate Blocking
    const dup = checkIsDuplicate(title, audioUrl);
    if (dup.isDuplicate) {
      showAlert(`🚫 Duplicate Blocked: "${title}" is already in the MusicsAura catalogue! (${dup.reason})`, true);
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Publishing track...";

    try {
      const keywords = Array.from(
        new Set([
          ...title.toLowerCase().split(/\s+/),
          ...artist.toLowerCase().split(/[,&/ ]+/),
          genre.toLowerCase(),
          uploaderName.toLowerCase()
        ].filter(Boolean))
      );

      await addDoc(collection(db, "songs"), {
        title,
        artist,
        genre: genre.toLowerCase(),
        link: audioUrl,
        thumbnail: coverUrl || "assets/logo.png",
        keywords,
        uploadedBy: uploaderName,
        createdAt: serverTimestamp(),
        plays: 0
      });

      registerNewSong(title, audioUrl);

      // Save local backup buffer for instant 0ms appearance
      try {
        const localUpload = {
          id: "local_" + Date.now(),
          title,
          artist,
          genre: genre.toLowerCase(),
          link: audioUrl,
          thumbnail: coverUrl || "assets/logo.png",
          keywords,
          uploadedBy: uploaderName,
          createdAt: Date.now(),
          plays: 0
        };
        const existingLocal = JSON.parse(localStorage.getItem("musicsaura_local_uploads") || "[]");
        existingLocal.unshift(localUpload);
        localStorage.setItem("musicsaura_local_uploads", JSON.stringify(existingLocal.slice(0, 100)));
        localStorage.removeItem("musicsaura_firestore_cache_time");
      } catch {}

      // AUTO GITHUB COMMIT: Automatically commit track to jsons/{genre}.json on GitHub
      try {
        commitSongsToGitHub(genre, [{
          title,
          artist,
          genre,
          link: audioUrl,
          thumbnail: coverUrl || "assets/logo.png"
        }]).then((res) => {
          if (res && res.success) {
            console.log(`[GitHub Auto-Commit] "${title}" committed directly into jsons/${genre.toLowerCase()}.json!`);
          }
        });
      } catch {}

      showAlert(`🎉 "${title}" published successfully and synced to GitHub! It's now live for everyone.`);
      uploadForm.reset();
      if (coverPreviewImg) coverPreviewImg.src = "assets/logo.png";
      loadCommunityUploads();

    } catch (err) {
      console.error("Creator upload error:", err);
      showAlert(`Error: ${err.message || "Failed to publish track"}`, true);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Publish Song to MusicsAura";
    }
  });
}

// ─── BULK MULTI-LINK IMPORTER (WITH DUPLICATE SKIPPING) ────────────
if (submitBulkBtn && bulkUrlsInput) {
  submitBulkBtn.addEventListener("click", async () => {
    const rawText = bulkUrlsInput.value.trim();
    if (!rawText) {
      showAlert("Please paste at least one File Garden link", true);
      return;
    }

    const urls = rawText
      .split("\n")
      .map((u) => u.trim())
      .filter((u) => u.startsWith("http://") || u.startsWith("https://"));

    if (!urls.length) {
      showAlert("No valid URLs found in the box", true);
      return;
    }

    const defaultGenre = bulkGenreSelect.value;
    submitBulkBtn.disabled = true;
    submitBulkBtn.textContent = `Auto-fetching & importing ${urls.length} tracks...`;

    let successCount = 0;
    let skippedDuplicates = 0;
    const importedTracks = [];

    try {
      for (const url of urls) {
        const title = cleanFilenameToTitle(url);
        const genre = detectGenreFromUrl(url) || defaultGenre;

        // Check duplicate
        const dup = checkIsDuplicate(title, url);
        if (dup.isDuplicate) {
          skippedDuplicates++;
          continue;
        }

        let artist = "Various Artists";
        let artwork = "assets/logo.png";

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

        const songData = {
          title,
          artist,
          genre: genre.toLowerCase(),
          link: url,
          thumbnail: artwork,
          keywords,
          uploadedBy: "Community",
          createdAt: serverTimestamp(),
          plays: 0
        };

        await addDoc(collection(db, "songs"), songData);

        importedTracks.push(songData);
        registerNewSong(title, url);
        successCount++;
      }

      // AUTO GITHUB SYNC: Commit to jsons/{genre}.json in GitHub repository
      try {
        const byGenre = {};
        importedTracks.forEach((t) => {
          const g = (t.genre || "hindi").toLowerCase();
          if (!byGenre[g]) byGenre[g] = [];
          byGenre[g].push(t);
        });
        for (const [g, tracks] of Object.entries(byGenre)) {
          await commitSongsToGitHub(g, tracks);
        }
      } catch (e) {
        console.warn("[GitHub Auto-Commit] Bulk notice:", e);
      }

      showAlert(`🎉 Successfully imported ${successCount} tracks and synced to GitHub! (${skippedDuplicates} duplicates skipped).`);
      bulkUrlsInput.value = "";
      loadCommunityUploads();

    } catch (err) {
      console.error("Bulk import error:", err);
      showAlert(`Imported ${successCount} songs. Error: ${err.message}`, true);
    } finally {
      submitBulkBtn.disabled = false;
      submitBulkBtn.textContent = "Import & Auto-Fetch All Tracks";
    }
  });
}

// ─── 1-CLICK EXPORT JSON ───────────────────────────────────────────
if (exportJsonBtn) {
  exportJsonBtn.addEventListener("click", async () => {
    try {
      const q = query(collection(db, "songs"), orderBy("createdAt", "desc"));
      const snap = await getDocs(q);
      const list = [];
      snap.forEach((d) => list.push(d.data()));

      const blob = new Blob([JSON.stringify(list, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `musicsaura_catalogue_backup.json`;
      a.click();
      showAlert("💾 Downloaded updated catalogue JSON!");
    } catch (e) {
      showAlert("Export error: " + e.message, true);
    }
  });
}

// ─── RECENT COMMUNITY UPLOADS LIST ─────────────────────────────────
async function loadCommunityUploads() {
  if (!contribList) return;

  try {
    const q = query(collection(db, "songs"), orderBy("createdAt", "desc"), limit(15));
    const snap = await getDocs(q);

    if (contribCount) contribCount.textContent = `${snap.size} tracks`;

    if (snap.empty) {
      contribList.innerHTML = `<div class="state-msg">No community tracks uploaded yet. Paste a File Garden link above to add one!</div>`;
      return;
    }

    const frag = document.createDocumentFragment();

    snap.forEach((docSnap) => {
      const song = docSnap.data();
      const songId = docSnap.id;
      const item = document.createElement("div");
      item.className = "fav-item";
      item.dataset.id = songId;
      const thumb = song.thumbnail || "assets/logo.png";

      item.innerHTML = `
        <img src="${thumb}" alt="" class="fav-thumb" onerror="this.src='assets/logo.png'">
        <div class="fav-info">
          <div class="fav-title">${escapeHtml(song.title)}</div>
          <div class="fav-artist">${escapeHtml(song.artist || "Unknown")} • <span class="genre-badge" style="color:var(--cyan);font-weight:600">${escapeHtml(song.genre?.toUpperCase())}</span> • <span style="color:var(--text-muted)">by ${escapeHtml(song.uploadedBy || "Community")}</span></div>
        </div>
        <div style="display:flex;align-items:center;gap:4px">
          <button class="action-btn btn-edit-song" title="Edit Metadata & Artwork" style="color:var(--cyan)">
            <span class="material-icons" style="font-size:1.1rem">edit</span>
          </button>
          <button class="action-btn btn-change-genre" title="Change Genre" style="color:var(--violet-light)">
            <span class="material-icons" style="font-size:1.1rem">swap_horiz</span>
          </button>
          <a href="${song.link}" target="_blank" rel="noopener" class="action-btn" title="Stream link">
            <span class="material-icons" style="font-size:1.1rem">open_in_new</span>
          </a>
          <button class="action-btn btn-delete-song" title="Delete Song" style="color:var(--rose)">
            <span class="material-icons" style="font-size:1.1rem">delete</span>
          </button>
        </div>
      `;

      // ── Edit Track Action ──
      const editBtn = item.querySelector(".btn-edit-song");
      if (editBtn) {
        editBtn.addEventListener("click", () => {
          openEditModal(songId, song);
        });
      }

      // ── Change Genre Action ──
      const genreBtn = item.querySelector(".btn-change-genre");
      if (genreBtn) {
        genreBtn.addEventListener("click", async () => {
          const currentG = (song.genre || "hindi").toLowerCase();
          const genreOrder = ["hindi", "punjabi", "haryanvi", "rap", "bhojpuri"];
          const currentIdx = genreOrder.indexOf(currentG);
          const targetG = genreOrder[(currentIdx + 1) % genreOrder.length];
          if (!confirm(`Change genre of "${song.title}" from ${currentG.toUpperCase()} to ${targetG.toUpperCase()}?`)) return;

          try {
            await updateDoc(doc(db, "songs", songId), { genre: targetG });
            showAlert(`✅ Changed "${song.title}" genre to ${targetG.toUpperCase()}`);
            loadCommunityUploads();
          } catch (err) {
            showAlert("Error updating genre: " + err.message, true);
          }
        });
      }

      // ── Delete Song Action ──
      const delBtn = item.querySelector(".btn-delete-song");
      if (delBtn) {
        delBtn.addEventListener("click", async () => {
          if (!confirm(`Are you sure you want to permanently delete "${song.title}" from MusicsAura?`)) return;

          try {
            await deleteDoc(doc(db, "songs", songId));

            // AUTO GITHUB DELETE: Remove from jsons/{genre}.json in GitHub repository
            try {
              deleteSongFromGitHub(song.genre, song.link, song.title);
            } catch {}

            // Clean from local uploads buffer
            try {
              const local = JSON.parse(localStorage.getItem("musicsaura_local_uploads") || "[]");
              const filtered = local.filter((s) => (s.id !== songId && s.link !== song.link));
              localStorage.setItem("musicsaura_local_uploads", JSON.stringify(filtered));
            } catch {}

            showAlert(`🗑️ Deleted "${song.title}" from MusicsAura and GitHub!`);
            loadCommunityUploads();
          } catch (err) {
            showAlert("Could not delete track: " + err.message, true);
          }
        });
      }

      frag.appendChild(item);
    });

    contribList.replaceChildren(frag);

  } catch (err) {
    console.error("Community loads:", err);
    if (contribList) contribList.innerHTML = `<div class="state-msg">Could not load list: ${err.message}</div>`;
  }
}

// ─── EDIT MODAL CONTROLLER ─────────────────────────────────────────
const editSongModal       = document.getElementById("edit-song-modal");
const editSongForm        = document.getElementById("edit-song-form");
const editSongId          = document.getElementById("edit-song-id");
const editCoverPreview    = document.getElementById("edit-cover-preview");
const editCoverUrl        = document.getElementById("edit-cover-url");
const btnEditAutoFetch    = document.getElementById("btn-edit-autofetch");
const editTitle           = document.getElementById("edit-title");
const editArtist          = document.getElementById("edit-artist");
const editGenre           = document.getElementById("edit-genre");
const closeEditModalBtn   = document.getElementById("close-edit-modal-btn");
const btnCancelEdit       = document.getElementById("btn-cancel-edit");

let activeEditingSong     = null;

function openEditModal(songId, song) {
  if (!editSongModal) return;
  activeEditingSong = song;

  if (editSongId) editSongId.value = songId;
  if (editTitle) editTitle.value = song.title || "";
  if (editArtist) editArtist.value = song.artist || "";
  if (editGenre) editGenre.value = (song.genre || "hindi").toLowerCase();
  if (editCoverUrl) editCoverUrl.value = song.thumbnail || "";
  if (editCoverPreview) editCoverPreview.src = song.thumbnail || "assets/logo.png";

  editSongModal.classList.add("open");
}

function closeEditModal() {
  if (editSongModal) editSongModal.classList.remove("open");
  activeEditingSong = null;
}

if (closeEditModalBtn) closeEditModalBtn.addEventListener("click", closeEditModal);
if (btnCancelEdit) btnCancelEdit.addEventListener("click", closeEditModal);

if (editSongModal) {
  editSongModal.addEventListener("click", (e) => {
    if (e.target === editSongModal) closeEditModal();
  });
}

// Live preview when typing/pasting custom cover URL
if (editCoverUrl && editCoverPreview) {
  editCoverUrl.addEventListener("input", () => {
    const val = editCoverUrl.value.trim();
    editCoverPreview.src = val || "assets/logo.png";
  });
}

// 1-Click Auto-fetch artwork inside edit modal
if (btnEditAutoFetch) {
  btnEditAutoFetch.addEventListener("click", async () => {
    const queryTerm = editTitle.value.trim();
    if (!queryTerm) {
      alert("Please enter a song title first to search artwork");
      return;
    }

    btnEditAutoFetch.innerHTML = `<span class="material-icons" style="font-size:1rem;animation:spin 1s linear infinite">refresh</span>`;

    try {
      const meta = await fetchOnlineMetadata(queryTerm);
      if (meta) {
        if (meta.artwork) {
          editCoverUrl.value = meta.artwork;
          editCoverPreview.src = meta.artwork;
        }
        if (meta.artist && (!editArtist.value || editArtist.value === "Various Artists")) {
          editArtist.value = meta.artist;
        }
        showAlert("✨ Artwork auto-found from Apple Music/iTunes!");
      } else {
        alert("No artwork found online for this title. You can paste any image link directly into the box!");
      }
    } catch {
      alert("Error searching artwork. Paste any image URL directly!");
    } finally {
      btnEditAutoFetch.innerHTML = `<span class="material-icons" style="font-size:1rem">auto_awesome</span>`;
    }
  });
}

// Submit edited changes
if (editSongForm) {
  editSongForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const songId = editSongId.value;
    const title = editTitle.value.trim();
    const artist = editArtist.value.trim() || "Various Artists";
    const genre = editGenre.value.toLowerCase();
    const thumbnail = editCoverUrl.value.trim() || "assets/logo.png";

    if (!songId || !title) {
      alert("Please provide a title");
      return;
    }

    const saveBtn = document.getElementById("btn-save-edit");
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving...";
    }

    try {
      const keywords = Array.from(
        new Set([
          ...title.toLowerCase().split(/\s+/),
          ...artist.toLowerCase().split(/[,&/ ]+/),
          genre.toLowerCase()
        ].filter(Boolean))
      );

      // Update Firestore document
      await updateDoc(doc(db, "songs", songId), {
        title,
        artist,
        genre,
        thumbnail,
        keywords
      });

      // Update local storage buffer
      try {
        const local = JSON.parse(localStorage.getItem("musicsaura_local_uploads") || "[]");
        const found = local.find((s) => s.id === songId || s.link === activeEditingSong?.link);
        if (found) {
          found.title = title;
          found.artist = artist;
          found.genre = genre;
          found.thumbnail = thumbnail;
          found.keywords = keywords;
          localStorage.setItem("musicsaura_local_uploads", JSON.stringify(local));
        }
      } catch {}

      // Update duplicate registry
      registerNewSong(title, activeEditingSong?.link);

      showAlert(`🎉 Updated "${title}" details & artwork successfully!`);
      closeEditModal();
      loadCommunityUploads();

    } catch (err) {
      console.error("Update song error:", err);
      showAlert("Error updating song: " + err.message, true);
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = `<span class="material-icons" style="font-size:1.1rem;vertical-align:middle;margin-right:4px">save</span> Save Changes`;
      }
    }
  });
}

function escapeHtml(str) {
  return (str || "").toString().replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[m]);
}

// ─── INITIALIZATION ────────────────────────────────────────────────
(async () => {
  await loadExistingRegistry();
  loadCommunityUploads();
})();
