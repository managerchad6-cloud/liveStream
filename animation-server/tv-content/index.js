// TV Content Service - manages playlist of images/videos for TV viewport

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { VideoDecoder, getVideoInfo } = require('./video-decoder');

const CONTENT_DIR = path.join(__dirname, 'content');
const PERSIST_PATH = path.join(__dirname, 'tv-playlist.json');

/**
 * TVContentService - manages a playlist of images/videos for the TV viewport
 */
class TVContentService {
  constructor(viewportWidth = 315, viewportHeight = 166, fps = 15) {
    this.viewportWidth = viewportWidth;
    this.viewportHeight = viewportHeight;
    this.fps = fps;

    this.playlist = [];          // Array of playlist items
    this.state = 'stopped';      // 'stopped' | 'playing' | 'paused'
    this.currentIndex = 0;       // Current playlist item index
    this.frameIndex = 0;         // Current frame within item
    this.currentFrameBuffer = null;  // Cached current frame
    this.hold = false;           // When true, don't auto-advance to next item
    this.volume = 0.5;           // TV audio volume (0-1)

    // Video audio mixing state
    this._audioByteOffset = 0;   // Current byte position in item's audio buffer
    this._audioItemId = null;    // ID of item whose audio we're tracking
    this._videoEndFired = false; // Prevent repeated onVideoEnd calls
    this.onVideoEnd = null;      // Set by VideoReactionSession to detect video completion

    // Ensure content directory exists
    if (!fs.existsSync(CONTENT_DIR)) {
      fs.mkdirSync(CONTENT_DIR, { recursive: true });
    }
  }

  /**
   * Add item to playlist
   * @param {Object} options - Item options
   * @param {string} options.type - 'image' or 'video'
   * @param {string} options.source - File path or URL
   * @param {number} [options.duration] - Duration in seconds (for images, default 10)
   * @param {string} [options.audioPath] - Path to extracted audio file (for videos)
   * @returns {Promise<Object>} - Added item
   */
  async addItem({ type, source, duration, audioPath, mediaId }) {
    const id = uuidv4();
    const item = {
      id,
      type,
      source,
      audioPath: audioPath || null,
      mediaId: mediaId || null,
      duration: duration || (type === 'image' ? 10 : null),
      frames: null,
      frameCount: 0,
      loaded: false,
      error: null
    };

    this.playlist.push(item);
    this._persist().catch(err => console.warn('[TVContent] persist error:', err.message));

    // Pre-load the item in background
    this._loadItem(item).catch(err => {
      console.error(`[TVContent] Failed to load item ${id}:`, err.message);
      item.error = err.message;
    });

    console.log(`[TVContent] Added ${type} item: ${id} (source: ${source}${audioPath ? ', with audio' : ''})`);
    return { id, type, source, duration: item.duration, audioPath: item.audioPath, mediaId: item.mediaId };
  }

  /**
   * Load item content (frames) into memory
   */
  async _loadItem(item) {
    if (item.loaded) return;

    try {
      if (item.type === 'video') {
        await this._loadVideo(item);
      } else {
        await this._loadImage(item);
      }
      item.loaded = true;
      console.log(`[TVContent] Loaded item ${item.id}: ${item.frameCount} frames`);
    } catch (err) {
      item.error = err.message;
      throw err;
    }
  }

  /**
   * Load video item
   */
  async _loadVideo(item) {
    const decoder = new VideoDecoder(item.source, this.fps, this.viewportWidth, this.viewportHeight);
    const result = await decoder.decode();

    item.frames = result.frames;
    item.frameCount = result.frameCount;
    item.duration = result.duration;
    item.decoder = decoder;
    item.audioBuffer = result.audioBuffer || null;
  }

  /**
   * Load image item - creates frames for the duration.
   * Portrait images (height > width) get a looping pan animation:
   *   [contain view, 2s] → [cover view panning top→bottom, 3s] → repeat
   */
  async _loadImage(item) {
    // Read source into buffer
    let imageBuffer;
    if (item.source.startsWith('http://') || item.source.startsWith('https://')) {
      const response = await fetch(item.source);
      if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
      imageBuffer = Buffer.from(await response.arrayBuffer());
    } else {
      imageBuffer = fs.readFileSync(item.source);
    }

    const frameCount = Math.ceil(item.duration * this.fps);
    const meta = await sharp(imageBuffer).metadata();
    const isPortrait = meta.height > meta.width;

    // ── Landscape / square: static contain frame ──────────────────────────
    if (!isPortrait) {
      const resizedBuffer = await sharp(imageBuffer)
        .resize(this.viewportWidth, this.viewportHeight, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 1 }
        })
        .png()
        .toBuffer();
      item.frames = [resizedBuffer];
      item.frameCount = frameCount;
      item.isStaticImage = true;
      return;
    }

    // ── Portrait: contain → cover pan animation ───────────────────────────
    const CONTAIN_FRAMES = Math.round(5 * this.fps); // 5 s static contain view
    // Pan speed: constant pixels-per-second regardless of image height.
    // Taller images take proportionally longer — same visual reading speed throughout.
    const PAN_SPEED_PPS = 20; // viewport-scale px/s — adjust for faster/slower reading

    // Cover-scaled dimensions
    const coverH = Math.round(meta.height * (this.viewportWidth / meta.width));
    const panRange = coverH - this.viewportHeight;

    // If the cover image doesn't extend beyond the viewport, fall back to static contain
    if (panRange <= 0) {
      const fallback = await sharp(imageBuffer)
        .resize(this.viewportWidth, this.viewportHeight, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 1 }
        })
        .png()
        .toBuffer();
      item.frames = [fallback];
      item.frameCount = frameCount;
      item.isStaticImage = true;
      return;
    }

    const PAN_FRAMES = Math.max(2, Math.round(panRange * this.fps / PAN_SPEED_PPS));

    // Pre-scale to cover width — one Sharp op shared across all pan frames
    const coverBuffer = await sharp(imageBuffer)
      .resize(this.viewportWidth, coverH, { fit: 'fill' })
      .png()
      .toBuffer();

    // Contain frame (letterboxed full image)
    const containFrame = await sharp(imageBuffer)
      .resize(this.viewportWidth, this.viewportHeight, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 1 }
      })
      .png()
      .toBuffer();

    // Render the very first pan frame (top of image) synchronously so the item
    // can be marked loaded and start showing immediately — remaining frames load
    // in the background and are appended as they complete.
    const firstPanFrame = await sharp(coverBuffer)
      .extract({ left: 0, top: 0, width: this.viewportWidth, height: this.viewportHeight })
      .png()
      .toBuffer();

    item.frames = [firstPanFrame];
    item.frameCount = frameCount; // updated once fully loaded
    item.isStaticImage = false;
    item.isPanImage = true;
    item.panFramesReady = false;

    // Background: generate remaining pan frames then contain frames
    const vw = this.viewportWidth;
    const vh = this.viewportHeight;
    const fps = this.fps;
    ;(async () => {
      try {
        for (let i = 1; i < PAN_FRAMES; i++) {
          const yOffset = Math.round((i / (PAN_FRAMES - 1)) * panRange);
          const frame = await sharp(coverBuffer)
            .extract({ left: 0, top: yOffset, width: vw, height: vh })
            .png()
            .toBuffer();
          item.frames.push(frame);
        }
        for (let i = 0; i < CONTAIN_FRAMES; i++) {
          item.frames.push(containFrame);
        }
        const cycleLength = item.frames.length; // PAN_FRAMES + CONTAIN_FRAMES
        item.frameCount = Math.max(cycleLength, Math.ceil(frameCount / cycleLength) * cycleLength);
        item.panFramesReady = true;
      } catch (err) {
        console.warn('[TVContent] Portrait pan generation error:', err.message);
        item.panFramesReady = true; // unblock getCurrentFrame even on error
      }
    })();
  }

  /**
   * Remove item from playlist by ID
   */
  removeItem(id) {
    const index = this.playlist.findIndex(item => item.id === id);
    if (index === -1) {
      return false;
    }

    const item = this.playlist[index];

    // Clean up decoder if it exists
    if (item.decoder) {
      item.decoder.close();
    }

    // Free decoded frame buffers to release memory immediately
    if (item.frames) {
      item.frames = null;
    }
    if (item.audioBuffer) {
      item.audioBuffer = null;
    }

    this.playlist.splice(index, 1);

    // Adjust current index if needed
    if (this.currentIndex >= this.playlist.length) {
      this.currentIndex = Math.max(0, this.playlist.length - 1);
      this.frameIndex = 0;
    } else if (index < this.currentIndex) {
      this.currentIndex--;
    } else if (index === this.currentIndex) {
      this.frameIndex = 0;
    }

    this._persist().catch(err => console.warn('[TVContent] persist error:', err.message));
    console.log(`[TVContent] Removed item: ${id}`);
    return true;
  }

  /**
   * Get playlist info
   */
  getPlaylist() {
    return this.playlist.map(item => ({
      id: item.id,
      type: item.type,
      source: item.source,
      audioPath: item.audioPath,
      mediaId: item.mediaId || null,
      duration: item.duration,
      frameCount: item.frameCount,
      loaded: item.loaded,
      error: item.error
    }));
  }

  /**
   * Clear entire playlist
   */
  clear() {
    // Clean up all decoders and free frame buffers
    for (const item of this.playlist) {
      if (item.decoder) item.decoder.close();
      if (item.frames) item.frames = null;
      if (item.audioBuffer) item.audioBuffer = null;
    }

    this.playlist = [];
    this.currentIndex = 0;
    this.frameIndex = 0;
    this.currentFrameBuffer = null;
    this.state = 'stopped';
    this._audioByteOffset = 0;
    this._audioItemId = null;
    this._videoEndFired = false;
    this.onVideoEnd = null;
    this._persist().catch(err => console.warn('[TVContent] persist error:', err.message));
    console.log('[TVContent] Playlist cleared');
  }

  /**
   * Start playback
   */
  play() {
    if (this.playlist.length === 0) {
      console.log('[TVContent] Cannot play: playlist empty');
      return false;
    }
    this.state = 'playing';
    this._persist().catch(err => console.warn('[TVContent] persist error:', err.message));
    console.log(`[TVContent] Playing from index ${this.currentIndex}, frame ${this.frameIndex}`);
    return true;
  }

  /**
   * Pause playback
   */
  pause() {
    this.state = 'paused';
    this._persist().catch(err => console.warn('[TVContent] persist error:', err.message));
    console.log('[TVContent] Paused');
    return true;
  }

  /**
   * Stop playback and reset to beginning
   */
  stop() {
    this.state = 'stopped';
    this.currentIndex = 0;
    this.frameIndex = 0;
    this.currentFrameBuffer = null;
    this._audioByteOffset = 0;
    this._audioItemId = null;
    this._videoEndFired = false;
    this._persist().catch(err => console.warn('[TVContent] persist error:', err.message));
    console.log('[TVContent] Stopped');
    return true;
  }

  /**
   * Seek to a specific time position within the current item.
   * Resets audio offset to match so audio stays in sync with video.
   * @param {number} seconds - Target position in seconds
   */
  seekToTime(seconds) {
    const item = this.playlist[this.currentIndex];
    if (!item) return;
    this.frameIndex = Math.max(0, Math.floor(seconds * this.fps));
    // Reset audio to matching byte offset: samples = seconds * 44100, stereo s16le = 4 bytes/sample
    this._audioByteOffset = Math.floor(seconds * 44100) * 4;
    this._audioItemId = item.id;
    this._videoEndFired = false;
    console.log(`[TVContent] Seeked to ${seconds.toFixed(2)}s (frame ${this.frameIndex})`);
  }

  /**
   * Get the next audio chunk for the current stream frame.
   * Returns a raw s16le stereo Buffer, or null when TV has no audio / is not playing.
   * Advances internal byte offset each call — call once per stream frame.
   * @param {number} bytesNeeded - Bytes to return (samplesPerFrame * channels * 2)
   * @returns {Buffer|null}
   */
  getAudioChunk(bytesNeeded) {
    if (this.state !== 'playing' || this.playlist.length === 0) return null;

    const item = this.playlist[this.currentIndex];
    if (!item || !item.loaded || !item.audioBuffer) return null;

    // Reset tracking if item changed
    if (this._audioItemId !== item.id) {
      this._audioByteOffset = 0;
      this._audioItemId = item.id;
    }

    if (this._audioByteOffset >= item.audioBuffer.length) return null;

    const end = Math.min(this._audioByteOffset + bytesNeeded, item.audioBuffer.length);
    const chunk = item.audioBuffer.subarray(this._audioByteOffset, end);
    this._audioByteOffset = end;

    // Pad with silence if we hit end mid-frame
    if (chunk.length < bytesNeeded) {
      const padded = Buffer.alloc(bytesNeeded, 0);
      chunk.copy(padded);
      return padded;
    }

    return chunk;
  }

  /**
   * Skip to next item in playlist
   */
  next() {
    if (this.playlist.length === 0) return false;

    this.currentIndex = (this.currentIndex + 1) % this.playlist.length;
    this.frameIndex = 0;
    this._persist().catch(err => console.warn('[TVContent] persist error:', err.message));
    console.log(`[TVContent] Next: now at index ${this.currentIndex}`);
    return true;
  }

  /**
   * Go to previous item in playlist
   */
  prev() {
    if (this.playlist.length === 0) return false;

    this.currentIndex = (this.currentIndex - 1 + this.playlist.length) % this.playlist.length;
    this.frameIndex = 0;
    this._persist().catch(err => console.warn('[TVContent] persist error:', err.message));
    console.log(`[TVContent] Prev: now at index ${this.currentIndex}`);
    return true;
  }

  /**
   * Advance one frame (called each render tick)
   * Auto-advances to next playlist item when current item ends
   */
  tick() {
    if (this.state !== 'playing' || this.playlist.length === 0) {
      return;
    }

    const item = this.playlist[this.currentIndex];
    if (!item || !item.loaded) {
      return;
    }

    // Advance frame
    this.frameIndex++;

    // Check if we've reached end of current item
    if (this.frameIndex >= item.frameCount) {
      if (this.hold) {
        // Hold mode: loop current item
        this.frameIndex = 0;
      } else if (this.onVideoEnd && !this._videoEndFired) {
        // Video reaction mode: pause on last frame and notify session
        this._videoEndFired = true;
        this.state = 'paused';
        console.log('[TVContent] Video ended — notifying session');
        this.onVideoEnd();
      } else {
        // Auto-advance to next item
        this.frameIndex = 0;
        this.currentIndex = (this.currentIndex + 1) % this.playlist.length;
        console.log(`[TVContent] Auto-advance to item ${this.currentIndex}`);
      }
    }
  }

  /**
   * Get current frame buffer for compositing
   * @returns {Buffer|null} - PNG buffer scaled to viewport size
   */
  async getCurrentFrame() {
    if (this.state === 'stopped' || this.playlist.length === 0) {
      return null;
    }

    const item = this.playlist[this.currentIndex];
    if (!item || !item.loaded || !item.frames) {
      return null;
    }

    // Static images: always return the single frame
    if (item.isStaticImage) {
      return item.frames[0];
    }

    // Portrait pan animation
    if (item.isPanImage) {
      if (!item.panFramesReady) {
        // Still generating: clamp to latest available frame so the pan plays
        // in real-time as frames arrive — no waiting, no visual jump
        return item.frames[Math.min(this.frameIndex, item.frames.length - 1)] || null;
      }
      // Fully loaded: loop the complete cycle
      return item.frames[this.frameIndex % item.frames.length] || null;
    }

    // Video: get frame at current index
    const frameIdx = Math.min(this.frameIndex, item.frames.length - 1);
    return item.frames[frameIdx] || null;
  }

  /**
   * Set hold mode (prevents auto-advance to next item)
   */
  setHold(enabled) {
    this.hold = !!enabled;
    this._persist().catch(err => console.warn('[TVContent] persist error:', err.message));
    console.log(`[TVContent] Hold mode: ${this.hold ? 'ON' : 'OFF'}`);
    return this.hold;
  }

  /**
   * Set volume (0-1)
   */
  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume));
    this._persist().catch(err => console.warn('[TVContent] persist error:', err.message));
    console.log(`[TVContent] Volume: ${Math.round(this.volume * 100)}%`);
    return this.volume;
  }

  /**
   * Get volume
   */
  getVolume() {
    return this.volume;
  }

  /**
   * Get current playback status
   */
  getStatus() {
    const currentItem = this.playlist[this.currentIndex];
    return {
      state: this.state,
      currentIndex: this.currentIndex,
      frameIndex: this.frameIndex,
      playlistLength: this.playlist.length,
      hold: this.hold,
      volume: this.volume,
      currentItem: currentItem ? {
        id: currentItem.id,
        type: currentItem.type,
        source: currentItem.source,
        audioPath: currentItem.audioPath,
        mediaId: currentItem.mediaId || null,
        duration: currentItem.duration,
        frameCount: currentItem.frameCount,
        loaded: currentItem.loaded
      } : null
    };
  }

  /**
   * Set viewport dimensions (in case they need to be updated)
   */
  setViewportSize(width, height) {
    this.viewportWidth = width;
    this.viewportHeight = height;
    // Note: existing loaded content won't be resized
    console.log(`[TVContent] Viewport size set to ${width}x${height}`);
  }

  /**
   * Atomically persist playlist state to disk
   */
  async _persist() {
    const data = {
      playlist: this.playlist.map(item => ({
        id: item.id,
        type: item.type,
        mediaId: item.mediaId || null,
        source: item.source,
        duration: item.duration,
        audioPath: item.audioPath || null
      })),
      currentIndex: this.currentIndex,
      hold: this.hold,
      volume: this.volume,
      state: this.state
    };
    const tmpPath = `${PERSIST_PATH}.tmp`;
    try {
      await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
      await fs.promises.rename(tmpPath, PERSIST_PATH);
    } catch (err) {
      console.warn('[TVContent] Failed to persist playlist:', err.message);
    }
  }

  /**
   * Restore playlist from disk after server restart
   * @param {Function} getPathFn - (mediaId) => absolutePath, resolves paths via media library
   */
  async restore(getPathFn) {
    try {
      const raw = await fs.promises.readFile(PERSIST_PATH, 'utf8');
      const data = JSON.parse(raw);

      if (!data || !Array.isArray(data.playlist) || data.playlist.length === 0) return;

      const wasPlaying = data.state === 'playing';
      this.hold = !!data.hold;
      this.volume = typeof data.volume === 'number' ? data.volume : 0.5;

      let restored = 0;
      for (const entry of data.playlist) {
        // Prefer resolving via media library (handles file moves)
        let source = entry.source;
        if (entry.mediaId && getPathFn) {
          const resolved = getPathFn(entry.mediaId);
          if (resolved) source = resolved;
        }

        // Skip missing files
        if (!source || (!source.startsWith('http://') && !source.startsWith('https://') && !fs.existsSync(source))) {
          console.warn(`[TVContent] Restore: skipping missing file: ${source}`);
          continue;
        }

        await this.addItem({
          type: entry.type,
          source,
          duration: entry.duration,
          audioPath: entry.audioPath || null,
          mediaId: entry.mediaId || null
        });
        restored++;
      }

      // Restore position
      if (typeof data.currentIndex === 'number' && data.currentIndex < this.playlist.length) {
        this.currentIndex = data.currentIndex;
      }

      // Resume playback if it was playing before restart
      if (wasPlaying && this.playlist.length > 0) {
        this.play();
      }

      console.log(`[TVContent] Restored ${restored}/${data.playlist.length} items (state: ${this.state})`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn('[TVContent] Restore failed:', err.message);
      }
    }
  }
}

module.exports = TVContentService;
