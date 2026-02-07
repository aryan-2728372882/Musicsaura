// scripts/play-state-manager.js — Preserve playback state (PWA + Firebase Integration)
// Uses localStorage for persistence across app restarts, compatible with Firebase real-time updates
export const playStateManager = {
  saveState(currentSong, isPlaying, currentTime, playlist, currentIndex) {
    const state = {
      song: currentSong,
      isPlaying,
      currentTime,
      playlist,
      currentIndex,
      timestamp: Date.now()
    };
    
    // Use localStorage for persistence across sessions (PWA support)
    try {
      localStorage.setItem('playback-state', JSON.stringify(state));
      // Also use sessionStorage for quick access during current session
      sessionStorage.setItem('playback-state', JSON.stringify(state));
    } catch (e) {
      console.warn('Storage error:', e);
    }
  },

  getState() {
    // Try sessionStorage first (faster for current session)
    let state = sessionStorage.getItem('playback-state');
    if (state) return JSON.parse(state);
    
    // Fall back to localStorage for PWA app restart
    state = localStorage.getItem('playback-state');
    return state ? JSON.parse(state) : null;
  },

  clearState() {
    sessionStorage.removeItem('playback-state');
    localStorage.removeItem('playback-state');
  },

  // Sync playback stats with Firebase in real-time (separate from playback state)
  async syncPlaybackStats(minutesListened, songsPlayed) {
    try {
      const storedStats = localStorage.getItem('playback-stats');
      const stats = storedStats ? JSON.parse(storedStats) : { minutes: 0, songs: 0 };
      
      // Only update if there's actual new data
      if (minutesListened > 0 || songsPlayed > 0) {
        stats.minutes += minutesListened;
        stats.songs += songsPlayed;
        stats.lastSynced = Date.now();
        
        localStorage.setItem('playback-stats', JSON.stringify(stats));
      }
      return stats;
    } catch (e) {
      console.warn('Stats sync error:', e);
    }
  },

  getPlaybackStats() {
    try {
      const stats = localStorage.getItem('playback-stats');
      return stats ? JSON.parse(stats) : { minutes: 0, songs: 0, lastSynced: 0 };
    } catch (e) {
      return { minutes: 0, songs: 0, lastSynced: 0 };
    }
  }
};
