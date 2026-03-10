// VideoReactionSession
// Execution engine for a planned video reaction.
// Activated by the intro segment's on-air event, fires beat timers, handles video end + wrap-up.

const EventEmitter = require('events');
const axios = require('axios');
const FormData = require('form-data');

class VideoReactionSession extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {Object} opts.plan            - SessionPlan from VideoReactionPlanner
   * @param {string} opts.animationServerUrl
   * @param {Object} opts.tvService       - TVContentService instance
   * @param {Object} opts.playbackController
   */
  constructor({ plan, animationServerUrl, tvService, playbackController }) {
    super();
    this.plan = plan;
    this.animationServerUrl = animationServerUrl;
    this.tvService = tvService;
    this.playbackController = playbackController;

    // 'idle' → 'active' → 'winding-down' → 'done'
    this.state = 'idle';
    this._beatTimers = [];
    this._beatIndex = 0;      // Track which beat we're at for status reporting
    this._resumeTimer = null;
  }

  /**
   * Called when the intro segment goes on-air.
   * Starts the TV video and arms all beat timers.
   */
  activate() {
    if (this.state !== 'idle') return;
    this.state = 'active';

    console.log(`[VideoSession] Activated — ${this.plan.beats.length} beats scheduled`);

    // Register video-end callback on TV service
    this.tvService.onVideoEnd = () => this._handleVideoEnd();

    // Start the video
    this.tvService.play();

    // Arm beat timers (all relative to video start = now)
    for (let i = 0; i < this.plan.beats.length; i++) {
      const beat = this.plan.beats[i];
      const delay = Math.max(0, beat.pause_at * 1000);
      const timer = setTimeout(() => this._fireBeat(i), delay);
      this._beatTimers.push(timer);
    }

    this.emit('activated');
  }

  /** Status snapshot for the API */
  getStatus() {
    return {
      state: this.state,
      title: this.plan.title,
      totalBeats: this.plan.beats.length,
      currentBeat: this._beatIndex,
      videoDuration: this.plan.videoDuration
    };
  }

  /** Cancel the session mid-flight */
  cancel() {
    this._clearTimers();
    this.tvService.onVideoEnd = null;
    this.tvService.pause();
    this.tvService.setHold(false);
    this.state = 'done';
    console.log('[VideoSession] Cancelled');
    this.emit('done');
  }

  // ── Beat execution ────────────────────────────────────────────────────────────

  async _fireBeat(beatIndex) {
    if (this.state !== 'active') return;
    const beat = this.plan.beats[beatIndex];
    this._beatIndex = beatIndex + 1;

    console.log(`[VideoSession] Beat ${beatIndex + 1}/${this.plan.beats.length} — pausing at ${beat.pause_at.toFixed(1)}s`);

    // Pause the video
    this.tvService.pause();

    // Submit each beat line to /render in sequence (they queue and play in order)
    for (const line of beat.lines) {
      if (!line.audioBuffer) {
        console.warn(`[VideoSession] Beat ${beatIndex + 1}: no audio buffer for "${line.text.slice(0, 40)}", skipping`);
        continue;
      }
      await this._submitAudio(line.audioBuffer, line.speaker, line.text).catch(err => {
        console.error(`[VideoSession] Submit failed: ${err.message}`);
      });
    }

    // Schedule video resume after all characters finish speaking
    const pauseDurationMs = (beat.resume_at - beat.pause_at) * 1000;
    this._resumeTimer = setTimeout(() => this._resumeVideo(beat.pause_at), pauseDurationMs);
  }

  _resumeVideo(seekPosition) {
    if (this.state !== 'active') return;
    console.log(`[VideoSession] Resuming video at ${seekPosition.toFixed(1)}s`);
    // Seek to exact pause point (corrects any drift from HLS latency)
    this.tvService.seekToTime(seekPosition);
    this.tvService.play();
  }

  // ── Video end + wrap-up ───────────────────────────────────────────────────────

  _handleVideoEnd() {
    if (this.state !== 'active') return;
    this.state = 'winding-down';
    this._clearTimers();

    console.log('[VideoSession] Video ended — starting wrap-up');

    // Hold TV on last frame
    this.tvService.setHold(true);

    // Submit wrap-up lines
    const wrapup = this.plan.wrapup;
    let totalDuration = 0;

    const submit = async () => {
      for (const line of wrapup.lines) {
        if (!line.audioBuffer) continue;
        await this._submitAudio(line.audioBuffer, line.speaker, line.text).catch(err => {
          console.error(`[VideoSession] Wrap-up submit failed: ${err.message}`);
        });
        totalDuration += line.estimatedDuration;
      }
    };

    submit().catch(err => console.error('[VideoSession] Wrap-up error:', err.message));

    // Exit after wrap-up plays + generous padding
    const exitDelay = Math.max(5000, (wrapup.estimatedDuration + 4) * 1000);
    setTimeout(() => this._exit(), exitDelay);
  }

  _exit() {
    if (this.state === 'done') return;
    this.state = 'done';
    this.tvService.onVideoEnd = null;
    console.log('[VideoSession] Session complete');
    this.emit('done');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  async _submitAudio(audioBuffer, character, text) {
    const form = new FormData();
    form.append('audio', audioBuffer, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
    form.append('character', character);
    form.append('message', text);
    form.append('mode', 'direct');
    form.append('segmentType', 'video-reaction');

    await axios.post(`${this.animationServerUrl}/render`, form, {
      headers: form.getHeaders(),
      timeout: 15000
    });
  }

  _clearTimers() {
    for (const t of this._beatTimers) clearTimeout(t);
    this._beatTimers = [];
    if (this._resumeTimer) { clearTimeout(this._resumeTimer); this._resumeTimer = null; }
  }
}

module.exports = VideoReactionSession;
