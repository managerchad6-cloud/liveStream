// TV Content Service - manages playlist of images/videos for TV viewport

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { VideoDecoder, getVideoInfo } = require('./video-decoder');

const CONTENT_DIR = path.join(__dirname, 'content');

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
  }

  /**
   * Load image item - creates frames for the duration
   */
  async _loadImage(item) {
    // Read and resize image to viewport
    let imageBuffer;

    if (item.source.startsWith('http://') || item.source.startsWith('https://')) {
      // Fetch from URL
      const response = await fetch(item.source);
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      imageBuffer = Buffer.from(arrayBuffer);
    } else {
      // Read from file
      imageBuffer = fs.readFileSync(item.source);
    }

    // Resize to viewport with padding to maintain aspect ratio
    const resizedBuffer = await sharp(imageBuffer)
      .resize(this.viewportWidth, this.viewportHeight, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 1 }
      })
      .png()
      .toBuffer();

    // Calculate frame count based on duration
    const frameCount = Math.ceil(item.duration * this.fps);

    // Store single frame (will be repeated)
    item.frames = [resizedBuffer];
    item.frameCount = frameCount;
    item.isStaticImage = true;
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
    // Clean up all decoders
    for (const item of this.playlist) {
      if (item.decoder) {
        item.decoder.close();
      }
    }

    this.playlist = [];
    this.currentIndex = 0;
    this.frameIndex = 0;
    this.currentFrameBuffer = null;
    this.state = 'stopped';
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
    console.log(`[TVContent] Playing from index ${this.currentIndex}, frame ${this.frameIndex}`);
    return true;
  }

  /**
   * Pause playback
   */
  pause() {
    this.state = 'paused';
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
    console.log('[TVContent] Stopped');
    return true;
  }

  /**
   * Skip to next item in playlist
   */
  next() {
    if (this.playlist.length === 0) return false;

    this.currentIndex = (this.currentIndex + 1) % this.playlist.length;
    this.frameIndex = 0;
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

    // For static images, always return the single frame
    if (item.isStaticImage) {
      return item.frames[0];
    }

    // For video, get frame at current index
    const frameIdx = Math.min(this.frameIndex, item.frames.length - 1);
    return item.frames[frameIdx] || null;
  }

  /**
   * Set hold mode (prevents auto-advance to next item)
   */
  setHold(enabled) {
    this.hold = !!enabled;
    console.log(`[TVContent] Hold mode: ${this.hold ? 'ON' : 'OFF'}`);
    return this.hold;
  }

  /**
   * Set volume (0-1)
   */
  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume));
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
}

module.exports = TVContentService;
