// scripts/upload.js — MusicsAura 3.0 Creator Studio
import {
  db,
  collection, addDoc, getDocs, query, orderBy, limit, serverTimestamp
} from "./firebase-config.js";

// Folder URLs
const FILE_GARDEN_FOLDERS = {
  hindi:    "https://file.garden/aRgAQiYidD0tulQV/Hindi/",
  punjabi:  "https://file.garden/aRgAQiYidD0tulQV/Punjabi/",
  haryanvi: "https://file.garden/aRgAQiYidD0tulQV/Haryanvi/"
};

// DOM Elements
const uploadForm         = document.getElementById("creator-upload-form");
const audioUrlInput      = document.getElementById("creator-audio-url");
const quickFileDrop      = document.getElementById("quick-file-drop");
const quickAudioPicker   = document.getElementById("quick-audio-picker");

const coverUrlInput      = document.getElementById("creator-cover-url");
const coverPreviewImg    = document.getElementById("creator-cover-preview");
const autoFetchTag       = document.getElementById("auto-fetch-tag");
const manualFetchBtn     = document.getElementById("btn-manual-fetch");

const titleInput         = document.getElementById("creator-title");
const artistInput        = document.getElementById("creator-artist");
const genreSelect        = document.getElementById("creator-genre");
const uploaderNameInput  = document.getElementById("creator-uploader-name");
const submitBtn          = document.getElementById("btn-creator-submit");
const uploadAlert        = document.getElementById("upload-alert");

// Bulk Importer elements
const toggleBulkBtn      = document.getElementById("toggle-bulk-btn");
const bulkWrap           = document.getElementById("bulk-importer-wrap");
const bulkUrlsInput      = document.getElementById("bulk-urls");
const bulkGenreSelect    = document.getElementById("bulk-genre");
const submitBulkBtn      = document.getElementById("btn-submit-bulk");
const exportJsonBtn      = document.getElementById("btn-export-json");

const contribList        = document.getElementById("contrib-list");
const contribCount       = document.getElementById("contrib-count");

let autoFetchDebounce    = null;

function showAlert(msg, isError = false) {
  if (!uploadAlert) return;
  uploadAlert.textContent = msg;
  uploadAlert.className = `alert-box ${isError ? "alert-error" : "alert-success"} visible`;
  setTimeout(() => {
    uploadAlert.classList.remove("visible");
  }, 5000);
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
  const lower = url.toLowerCase();
  if (lower.includes("/hindi/") || lower.includes("hindi")) return "hindi";
  if (lower.includes("/punjabi/") || lower.includes("punjabi")) return "punjabi";
  if (lower.includes("/haryanvi/") || lower.includes("haryanvi")) return "haryanvi";
  return "hindi";
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

// DOM Elements
const btnSelectAudioFile = document.getElementById("btn-select-audio-file");
const selectedFileLabel  = document.getElementById("selected-file-label");

// ─── SELECT MP3 FILE BUTTON & PICKER ──────────────────────────────
if (btnSelectAudioFile && quickAudioPicker) {
  btnSelectAudioFile.addEventListener("click", () => quickAudioPicker.click());

  quickAudioPicker.addEventListener("change", () => {
    if (quickAudioPicker.files && quickAudioPicker.files[0]) {
      handleAudioSelection(quickAudioPicker.files[0]);
    }
  });
}

function handleAudioSelection(file) {
  if (selectedFileLabel) {
    selectedFileLabel.innerHTML = `✅ <strong style="color:var(--cyan)">${escapeHtml(file.name)}</strong> (${(file.size / (1024 * 1024)).toFixed(1)} MB)`;
  }

  const cleanTitle = cleanFilenameToTitle(file.name);
  titleInput.value = cleanTitle;

  const currentGenre = genreSelect.value || "hindi";
  const baseFolder = FILE_GARDEN_FOLDERS[currentGenre] || FILE_GARDEN_FOLDERS.hindi;
  const encodedName = encodeURIComponent(file.name);

  // Auto-generate the File Garden stream URL
  audioUrlInput.value = `${baseFolder}${encodedName}`;

  triggerAutoFetch(cleanTitle);
}

// ─── URL INPUT LISTENERS ───────────────────────────────────────────
if (audioUrlInput) {
  audioUrlInput.addEventListener("input", () => {
    const url = audioUrlInput.value.trim();
    if (!url) return;

    // Auto extract title
    const cleanTitle = cleanFilenameToTitle(url);
    if (cleanTitle) {
      titleInput.value = cleanTitle;
    }

    // Auto detect genre
    const detectedGenre = detectGenreFromUrl(url);
    if (detectedGenre && genreSelect) {
      genreSelect.value = detectedGenre;
      updateFolderLink(detectedGenre);
    }

    clearTimeout(autoFetchDebounce);
    autoFetchDebounce = setTimeout(() => {
      triggerAutoFetch(cleanTitle);
    }, 350);
  });
}

const dynamicFolderLink = document.getElementById("dynamic-folder-link");
function updateFolderLink(genre) {
  const g = (genre || "hindi").toLowerCase();
  const folderUrl = FILE_GARDEN_FOLDERS[g] || FILE_GARDEN_FOLDERS.hindi;
  if (dynamicFolderLink) {
    dynamicFolderLink.href = folderUrl;
    const name = g.charAt(0).toUpperCase() + g.slice(1);
    dynamicFolderLink.innerHTML = `<span class="material-icons" style="font-size:0.95rem">open_in_new</span> Open ${name} File Garden Folder`;
  }
}

if (genreSelect) {
  genreSelect.addEventListener("change", () => updateFolderLink(genreSelect.value));
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

// ─── SINGLE FORM SUBMIT (SAVED TO FIRESTORE) ───────────────────────
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

      // Save document to Firestore 'songs' collection (Free metadata tier)
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
      } catch {}

      showAlert(`🎉 "${title}" published successfully! It's now live for everyone in MusicsAura.`);
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

// ─── BULK MULTI-LINK IMPORTER ──────────────────────────────────────
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

    try {
      const promises = urls.map(async (url) => {
        const title = cleanFilenameToTitle(url);
        const genre = detectGenreFromUrl(url) || defaultGenre;

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

        await addDoc(collection(db, "songs"), {
          title,
          artist,
          genre,
          link: url,
          thumbnail: artwork,
          keywords,
          uploadedBy: "Community",
          createdAt: serverTimestamp(),
          plays: 0
        });
        successCount++;
      });

      await Promise.all(promises);
      showAlert(`🎉 Successfully imported ${successCount} File Garden tracks with artwork!`);
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
    const q = query(collection(db, "songs"), orderBy("createdAt", "desc"), limit(20));
    const snap = await getDocs(q);

    if (contribCount) contribCount.textContent = `${snap.size} tracks`;

    if (snap.empty) {
      contribList.innerHTML = `<div class="state-msg">No community tracks uploaded yet. Paste a File Garden link above to add one!</div>`;
      return;
    }

    const frag = document.createDocumentFragment();

    snap.forEach((docSnap) => {
      const song = docSnap.data();
      const item = document.createElement("div");
      item.className = "fav-item";
      const thumb = song.thumbnail || "assets/logo.png";

      item.innerHTML = `
        <img src="${thumb}" alt="" class="fav-thumb" onerror="this.src='assets/logo.png'">
        <div class="fav-info">
          <div class="fav-title">${escapeHtml(song.title)}</div>
          <div class="fav-artist">${escapeHtml(song.artist || "Unknown")} • <span style="color:var(--violet-light)">${escapeHtml(song.genre?.toUpperCase())}</span> • <span style="color:var(--text-muted)">by ${escapeHtml(song.uploadedBy || "Community")}</span></div>
        </div>
        <a href="${song.link}" target="_blank" rel="noopener" class="action-btn" title="Stream link">
          <span class="material-icons">open_in_new</span>
        </a>
      `;
      frag.appendChild(item);
    });

    contribList.replaceChildren(frag);

  } catch (err) {
    console.error("Community loads:", err);
    if (contribList) contribList.innerHTML = `<div class="state-msg">Could not load list: ${err.message}</div>`;
  }
}

function escapeHtml(str) {
  return (str || "").toString().replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[m]);
}

loadCommunityUploads();
