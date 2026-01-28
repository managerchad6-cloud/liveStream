// Synchronized audio-video playback with real-time lip sync
// This module manages frame-by-frame audio analysis during playback

const RealtimeLipSync = require('./realtime-lipsync');
const { decodeAudio } = require('./audio-decoder');

class SyncedPlayback {
  constructor(sampleRate = 16000, fps = 30) {
    this.sampleRate = sampleRate;
    this.fps = fps;
    this.samplesPerFrame = Math.floor(sampleRate / fps);

    this.lipSync = new RealtimeLipSync(sampleRate, fps);

    // Current playback state
    this.audioSamples = null;
    this.totalFrames = 0;
    this.currentFrame = 0;
    this.isPlaying = false;
    this.character = null;

    // Callbacks
    this.onPhoneme = null; // Called each frame with current phoneme
    this.onComplete = null; // Called when playback finishes
  }

  /**
   * Load audio and prepare for synchronized playback
   * @param {string} audioPath - Path to audio file
   * @param {string} character - 'chad' or 'virgin'
   */
  async load(audioPath, character) {
    console.log(`[SyncedPlayback] Loading: ${audioPath}`);

    const { samples, duration } = await decodeAudio(audioPath, this.sampleRate);

    this.audioSamples = samples;
    this.totalFrames = Math.ceil(samples.length / this.samplesPerFrame);
    this.character = character;
    this.currentFrame = 0;
    this.isPlaying = false;

    // Calibrate analyzer on this audio
    this.lipSync.calibrate(samples);
    this.lipSync.reset();

    console.log(`[SyncedPlayback] Loaded: ${duration.toFixed(2)}s, ${this.totalFrames} frames`);

    return { duration, totalFrames: this.totalFrames };
  }

  /**
   * Load pre-decoded samples and prepare for synchronized playback
   * @param {Float32Array} samples
   * @param {number} duration
   * @param {string} character
   */
  loadSamples(samples, duration, character) {
    this.audioSamples = samples;
    this.totalFrames = Math.ceil(samples.length / this.samplesPerFrame);
    this.character = character;
    this.currentFrame = 0;
    this.isPlaying = false;

    this.lipSync.calibrate(samples);
    this.lipSync.reset();

    console.log(`[SyncedPlayback] Loaded samples: ${duration.toFixed(2)}s, ${this.totalFrames} frames`);
    return { duration, totalFrames: this.totalFrames };
  }

  /**
   * Start playback
   */
  start() {
    if (!this.audioSamples) {
      throw new Error('No audio loaded');
    }
    this.isPlaying = true;
    this.currentFrame = 0;
    this.lipSync.reset();
    console.log(`[SyncedPlayback] Started: ${this.character}`);
  }

  /**
   * Get the phoneme for the current frame and advance
   * Call this once per frame from the render loop
   * @returns {{phoneme: string, character: string, progress: number, done: boolean}}
   */
  tick() {
    if (!this.isPlaying || !this.audioSamples) {
      return { phoneme: 'A', character: null, progress: 0, done: true };
    }

    // Check if we've finished
    if (this.currentFrame >= this.totalFrames) {
      this.isPlaying = false;
      if (this.onComplete) this.onComplete();
      return { phoneme: 'A', character: this.character, progress: 1, done: true };
    }

    // Extract current audio chunk
    const start = this.currentFrame * this.samplesPerFrame;
    const end = Math.min(start + this.samplesPerFrame, this.audioSamples.length);
    const chunk = this.audioSamples.slice(start, end);

    // Analyze THIS chunk - real-time, no pre-calculation
    const phoneme = this.lipSync.analyzeChunk(chunk);

    // Calculate progress
    const progress = this.currentFrame / this.totalFrames;

    // Notify callback
    if (this.onPhoneme) {
      this.onPhoneme(phoneme, this.character, this.currentFrame);
    }

    // Advance frame
    this.currentFrame++;

    return {
      phoneme,
      character: this.character,
      frame: this.currentFrame - 1,
      progress,
      done: false
    };
  }

  /**
   * Get the current audio chunk as PCM data
   * Useful if you want to mux audio into the video stream
   * @param {number} frameIndex - Frame number
   * @returns {Float32Array} Audio samples for this frame
   */
  getAudioChunk(frameIndex) {
    if (!this.audioSamples) return new Float32Array(0);

    const start = frameIndex * this.samplesPerFrame;
    const end = Math.min(start + this.samplesPerFrame, this.audioSamples.length);

    return this.audioSamples.slice(start, end);
  }

  /**
   * Seek to a specific frame
   */
  seek(frame) {
    this.currentFrame = Math.max(0, Math.min(frame, this.totalFrames));
    this.lipSync.reset();
  }

  /**
   * Stop playback
   */
  stop() {
    this.isPlaying = false;
    this.currentFrame = 0;
    this.lipSync.reset();
    console.log('[SyncedPlayback] Stopped');
  }

  /**
   * Get current state
   */
  getState() {
    return {
      isPlaying: this.isPlaying,
      character: this.character,
      currentFrame: this.currentFrame,
      totalFrames: this.totalFrames,
      progress: this.totalFrames > 0 ? this.currentFrame / this.totalFrames : 0
    };
  }

  /**
   * Get the phoneme for a specific frame (used by synced stream mode)
   * This doesn't advance state - just returns the phoneme for that frame
   * @param {number} frameIndex - The frame number to get phoneme for
   * @returns {string} Phoneme code (A-H)
   */
  getPhonemeAtFrame(frameIndex) {
    if (!this.audioSamples || frameIndex < 0 || frameIndex >= this.totalFrames) {
      return 'A';
    }

    // Extract the audio chunk for this frame
    const start = frameIndex * this.samplesPerFrame;
    const end = Math.min(start + this.samplesPerFrame, this.audioSamples.length);
    const chunk = this.audioSamples.slice(start, end);

    // Analyze this chunk
    return this.lipSync.analyzeChunk(chunk);
  }
}

module.exports = SyncedPlayback;
