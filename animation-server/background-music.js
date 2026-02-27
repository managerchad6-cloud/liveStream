// Background music service — streams internet radio into a ring buffer
// Mixed into the HLS stream at low volume under character voices.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { FFMPEG_PATH } = require('./platform');

const PERSIST_PATH = path.join(__dirname, 'background-music.json');

// Minimum bytes to buffer before starting playback (2 seconds of 44100Hz stereo s16le).
// FFmpeg outputs in large bursts from its internal stdio buffer. Without pre-buffering,
// the ring buffer drains in ~200ms between bursts, causing audible dropouts.
const MIN_PREBUFFER_BYTES = 44100 * 2 * 2 * 2; // 352,800 bytes = 2 seconds

class BackgroundMusicService {
  constructor() {
    // Ring buffer: 44100 samples/s * 2 channels * 2 bytes * 10s
    this.BUFFER_CAPACITY = 44100 * 2 * 2 * 10; // 1,764,000 bytes
    this.ringBuffer = Buffer.alloc(this.BUFFER_CAPACITY, 0);
    this.writePos = 0;
    this.readPos = 0;
    this.bytesAvailable = 0;

    this.enabled = false;
    this.url = null;
    this.volume = 0.20; // 20% default

    this._ffmpegProcess = null;
    this._reconnectTimer = null;
    this._stopping = false;

    // Pre-buffer gate: we don't emit audio until the ring buffer has 2s of data.
    // isActive() stays false until the gate opens. On underrun, it closes again.
    this._prebuffering = true;
  }

  // Start (or switch) radio station
  start(url, volume) {
    if (url !== undefined) this.url = url;
    if (volume !== undefined) this.volume = Math.max(0, Math.min(1, Number(volume) || 0));

    this.enabled = true;
    this._stopping = false;

    // Kill existing decoder (station switch or restart)
    this._killDecoder();

    // Clear ring buffer and re-open pre-buffer gate
    this.writePos = 0;
    this.readPos = 0;
    this.bytesAvailable = 0;
    this.ringBuffer.fill(0);
    this._prebuffering = true;

    if (this.url) {
      this._spawnDecoder();
    }

    this._persist();
  }

  _spawnDecoder() {
    if (!this.url || !this.enabled) return;

    // NOTE: deliberately do NOT clear the ring buffer here.
    // On auto-reconnect, any buffered audio plays through the reconnect gap smoothly.
    // The _prebuffering flag stays in its current state too.

    const args = [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-i', this.url,
      '-f', 's16le',
      '-ar', '44100',
      '-ac', '2',
      'pipe:1'
    ];

    try {
      this._ffmpegProcess = spawn(FFMPEG_PATH, args, {
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      console.error('[BackgroundMusic] Failed to spawn FFmpeg:', err.message);
      this._scheduleReconnect();
      return;
    }

    this._ffmpegProcess.stdout.on('data', (chunk) => {
      this._writeToRingBuffer(chunk);
    });

    // Only log first connection confirmation
    let connected = false;
    this._ffmpegProcess.stderr.on('data', (data) => {
      if (!connected) {
        const msg = data.toString();
        if (msg.includes('Audio:') || msg.includes('Stream #')) {
          connected = true;
          console.log(`[BackgroundMusic] Connected to ${this.url}`);
        }
      }
    });

    this._ffmpegProcess.on('close', (code) => {
      this._ffmpegProcess = null;
      if (this.enabled && !this._stopping) {
        console.log(`[BackgroundMusic] Decoder closed (code ${code}), reconnecting in 2s...`);
        this._scheduleReconnect();
      }
    });

    this._ffmpegProcess.on('error', (err) => {
      console.error('[BackgroundMusic] FFmpeg error:', err.message);
      this._ffmpegProcess = null;
      if (this.enabled && !this._stopping) {
        this._scheduleReconnect();
      }
    });
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this.enabled && !this._stopping) {
        this._spawnDecoder();
      }
    }, 2000);
  }

  _killDecoder() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ffmpegProcess) {
      // Detach all listeners BEFORE killing so the async close/data events from
      // the dying process don't (a) write stale audio into the fresh ring buffer
      // and (b) overwrite this._ffmpegProcess = null, clobbering the new decoder.
      const proc = this._ffmpegProcess;
      this._ffmpegProcess = null;
      try { proc.stdout.removeAllListeners(); } catch (e) {}
      try { proc.stderr.removeAllListeners(); } catch (e) {}
      try { proc.removeAllListeners(); } catch (e) {}
      try { proc.kill('SIGTERM'); } catch (e) {}
    }
  }

  _writeToRingBuffer(chunk) {
    const len = chunk.length;

    // If buffer would overflow, drop oldest audio.
    // Align drop to 4 bytes to keep stereo Int16 sample boundaries intact.
    if (this.bytesAvailable + len > this.BUFFER_CAPACITY) {
      const rawDrop = this.bytesAvailable + len - this.BUFFER_CAPACITY;
      const drop = Math.min(this.bytesAvailable, (rawDrop + 3) & ~3);
      this.readPos = (this.readPos + drop) % this.BUFFER_CAPACITY;
      this.bytesAvailable -= drop;
    }

    // Write chunk with circular wrap-around
    const spaceToEnd = this.BUFFER_CAPACITY - this.writePos;
    if (len <= spaceToEnd) {
      chunk.copy(this.ringBuffer, this.writePos);
    } else {
      chunk.copy(this.ringBuffer, this.writePos, 0, spaceToEnd);
      chunk.copy(this.ringBuffer, 0, spaceToEnd);
    }

    this.writePos = (this.writePos + len) % this.BUFFER_CAPACITY;
    this.bytesAvailable += len;

    // Transition out of pre-buffering once we have enough data
    if (this._prebuffering && this.bytesAvailable >= MIN_PREBUFFER_BYTES) {
      this._prebuffering = false;
      console.log(`[BackgroundMusic] Pre-buffer ready (${(this.bytesAvailable / (44100 * 2 * 2)).toFixed(1)}s), starting playback`);
    }
  }

  // Hot path — called 30x/sec from frame loop.
  // Always returns a buffer of exactly numBytes (zeros if not ready).
  getChunk(numBytes) {
    // Align to 4-byte boundary (s16le stereo sample = 4 bytes)
    numBytes = numBytes & ~3;
    if (!numBytes) return Buffer.alloc(0);

    // Not ready: still pre-buffering, or disabled
    if (!this.enabled || this._prebuffering) {
      return Buffer.alloc(numBytes, 0);
    }

    // Normal case: enough data available
    if (this.bytesAvailable >= numBytes) {
      const out = Buffer.allocUnsafe(numBytes);
      const spaceToEnd = this.BUFFER_CAPACITY - this.readPos;
      if (numBytes <= spaceToEnd) {
        this.ringBuffer.copy(out, 0, this.readPos, this.readPos + numBytes);
      } else {
        this.ringBuffer.copy(out, 0, this.readPos, this.BUFFER_CAPACITY);
        this.ringBuffer.copy(out, spaceToEnd, 0, numBytes - spaceToEnd);
      }
      this.readPos = (this.readPos + numBytes) % this.BUFFER_CAPACITY;
      this.bytesAvailable -= numBytes;
      return out;
    }

    // Underrun: re-enter pre-buffering, return silence.
    // Discard the partial data so readPos stays aligned for the next fill.
    console.warn(`[BackgroundMusic] Underrun (${this.bytesAvailable} bytes remaining), re-buffering...`);
    this.bytesAvailable = 0;
    this.readPos = this.writePos;
    this._prebuffering = true;
    return Buffer.alloc(numBytes, 0);
  }

  stop() {
    this.enabled = false;
    this._stopping = true;
    this._killDecoder();

    this.writePos = 0;
    this.readPos = 0;
    this.bytesAvailable = 0;
    this.ringBuffer.fill(0);
    this._prebuffering = true;

    this._persist();
    console.log('[BackgroundMusic] Stopped');
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, Number(v) || 0));
    this._persist();
  }

  // Returns true when the pre-buffer is ready and music is flowing.
  // Caller (frame loop) uses this to decide whether to call getChunk().
  isActive() {
    return this.enabled && !this._prebuffering;
  }

  getStatus() {
    const bufferedSeconds = this.bytesAvailable / (44100 * 2 * 2);
    return {
      enabled: this.enabled,
      url: this.url,
      volume: this.volume,
      connected: this._ffmpegProcess !== null,
      bufferedSeconds: Math.round(bufferedSeconds * 10) / 10,
      prebuffering: this._prebuffering
    };
  }

  _persist() {
    const payload = JSON.stringify({
      enabled: this.enabled,
      url: this.url,
      volume: this.volume
    }, null, 2);
    const tmp = `${PERSIST_PATH}.tmp`;
    try {
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, PERSIST_PATH);
    } catch (e) {
      console.warn('[BackgroundMusic] Failed to persist state:', e.message);
    }
  }

  restore() {
    try {
      const raw = fs.readFileSync(PERSIST_PATH, 'utf8');
      const data = JSON.parse(raw);
      if (data.url) {
        this.url = data.url;
        this.volume = Math.max(0, Math.min(1, Number(data.volume) || 0.20));
        if (data.enabled) {
          console.log(`[BackgroundMusic] Restoring: ${this.url} @ ${Math.round(this.volume * 100)}%`);
          this.start();
        }
      }
    } catch (e) {
      // No saved state — start silent
    }
  }
}

module.exports = BackgroundMusicService;
