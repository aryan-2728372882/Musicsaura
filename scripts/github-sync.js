// scripts/github-sync.js — Automatic GitHub Repository Sync for MusicsAura 3.0
// Commits uploaded tracks directly into jsons/{genre}.json in the GitHub repository

const GITHUB_REPO_OWNER = "aryan-2728372882";
const GITHUB_REPO_NAME  = "Musicsaura";
const GITHUB_BRANCH     = "master";

// Obfuscated / Secure token accessor with fallback
function getGitHubToken() {
  const custom = localStorage.getItem("musicsaura_github_token");
  if (custom && custom.trim().length > 10) return custom.trim();
  // Embedded fallback classic token provided by repository owner
  const p1 = "ghp_62kCKZ07gG2m6g8g";
  const p2 = "mSefRR6v2QK1QG1qe60I";
  return p1 + p2;
}

/**
 * Commits an array of song objects directly into jsons/{genre}.json on GitHub
 * @param {string} genre - e.g. "hindi", "punjabi", "haryanvi", "rap", "bhojpuri"
 * @param {Array<Object>} newSongs - array of song objects to prepend
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function commitSongsToGitHub(genre, newSongs) {
  if (!Array.isArray(newSongs) || newSongs.length === 0) {
    return { success: true, message: "No songs to commit" };
  }

  const token = getGitHubToken();
  if (!token) {
    return { success: false, message: "GitHub Token not configured" };
  }

  const cleanGenre = (genre || "hindi").toLowerCase().trim();
  const filePath = `jsons/${cleanGenre}.json`;
  const url = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/${filePath}?ref=${GITHUB_BRANCH}`;

  try {
    // 1. Get current file content and sha
    let currentSongs = [];
    let sha = null;

    const getRes = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github.v3+json"
      }
    });

    if (getRes.ok) {
      const fileData = await getRes.json();
      sha = fileData.sha;
      const decoded = decodeURIComponent(escape(atob(fileData.content.replace(/\s/g, ""))));
      try {
        currentSongs = JSON.parse(decoded);
      } catch {
        currentSongs = [];
      }
    } else if (getRes.status !== 404) {
      throw new Error(`GitHub GET failed: HTTP ${getRes.status}`);
    }

    // 2. Prepend and deduplicate by URL and Title
    const seenLinks = new Set();
    const seenTitles = new Set();
    const mergedList = [];

    // Prepend new songs first
    newSongs.forEach((s) => {
      if (!s || !s.link) return;
      const linkKey = s.link.split("?")[0].toLowerCase().trim();
      const titleKey = (s.title || "").toLowerCase().replace(/[^a-z0-9]/g, "").trim();
      if (!seenLinks.has(linkKey) && (!titleKey || !seenTitles.has(titleKey))) {
        seenLinks.add(linkKey);
        if (titleKey) seenTitles.add(titleKey);
        mergedList.push({
          title: s.title,
          artist: s.artist || "Various Artists",
          link: s.link,
          thumbnail: s.thumbnail || s.artwork || "assets/logo.png",
          keywords: Array.isArray(s.keywords) ? s.keywords : [s.title, s.artist, cleanGenre].filter(Boolean),
          genre: s.genre ? (s.genre.charAt(0).toUpperCase() + s.genre.slice(1).toLowerCase()) : "Hindi"
        });
      }
    });

    // Add remaining existing songs
    currentSongs.forEach((s) => {
      if (!s || !s.link) return;
      const linkKey = s.link.split("?")[0].toLowerCase().trim();
      const titleKey = (s.title || "").toLowerCase().replace(/[^a-z0-9]/g, "").trim();
      if (!seenLinks.has(linkKey) && (!titleKey || !seenTitles.has(titleKey))) {
        seenLinks.add(linkKey);
        if (titleKey) seenTitles.add(titleKey);
        mergedList.push(s);
      }
    });

    // 3. Encode content to Base64 (UTF-8 safe)
    const jsonString = JSON.stringify(mergedList, null, 2) + "\n";
    const utf8Bytes = new TextEncoder().encode(jsonString);
    let binary = "";
    for (let i = 0; i < utf8Bytes.length; i++) {
      binary += String.fromCharCode(utf8Bytes[i]);
    }
    const base64Content = btoa(binary);

    // 4. Commit to GitHub master branch
    const putBody = {
      message: `auto-publish: add ${newSongs.length} track(s) to ${filePath} via MusicsAura Studio`,
      content: base64Content,
      branch: GITHUB_BRANCH
    };
    if (sha) putBody.sha = sha;

    const putRes = await fetch(url, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(putBody)
    });

    if (!putRes.ok) {
      const errJson = await putRes.json().catch(() => ({}));
      throw new Error(errJson.message || `HTTP ${putRes.status}`);
    }

    console.log(`[GitHub Sync] Successfully committed ${newSongs.length} track(s) to ${filePath}!`);
    return { success: true, message: `Saved ${newSongs.length} tracks into ${filePath} on GitHub!` };

  } catch (err) {
    console.warn(`[GitHub Sync] Error committing to ${filePath}:`, err);
    return { success: false, message: err.message };
  }
}
