// VideoReactionSession
// Execution engine for a planned video reaction.
// Activated by the intro segment's on-air event, fires beat timers, handles video end + wrap-up.

'use strict';

const fs = require('fs');
const EventEmitter = require('events');
const axios = require('axios');
const FormData = require('form-data');

// Padding added after the last line of a beat before the video resumes.
const RESUME_PADDING_MS = 1000;

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
    this._beatIndex = 0;
    this._resumeTimer = null;
  }

  /**
   * Called when the intro segment goes on-air.
   * Immediately shows video frame 0 (paused) so the TV screen is visible during
   * the intro. The playback controller fires startTV() when the intro audio ends.
   */
  activate() {
    if (this.state !== 'idle') return;
    this.state = 'active';

    console.log('[VideoSession] Activated — showing video frame 0, waiting for intro to finish');

    this.tvService.onVideoEnd = () => this._handleVideoEnd();

    // Show first frame of the video while characters introduce it.
    // play() + pause() synchronously — no tick() fires between them, so frameIndex stays at 0.
    this.tvService.play();
    this.tvService.pause();

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
    this.tvService.clear();
    this.state = 'done';
    console.log('[VideoSession] Cancelled');
    this.emit('done');
  }

  // ── TV start + sequential beat chaining ──────────────────────────────────────

  /** Called by the orchestrator when the intro segment's audio finishes. */
  startTV() {
    if (this.state !== 'active') return;
    console.log('[VideoSession] Intro done — TV starting, arming beat 0 timer');
    this.tvService.play();
    this._armNextBeat(0);
  }

  /**
   * Arm the timer for beat at beatIndex.
   * Each timer is relative to the current video position (i.e. from the last resume point),
   * NOT from the original activate() T0. This eliminates cumulative drift.
   *
   * Beat 0: delay = beat[0].pause_at          (from video start)
   * Beat N: delay = beat[N].pause_at - beat[N-1].pause_at  (from previous resume)
   */
  _armNextBeat(beatIndex) {
    if (beatIndex >= this.plan.beats.length) return;

    const beat = this.plan.beats[beatIndex];
    const prevPauseAt = beatIndex === 0 ? 0 : this.plan.beats[beatIndex - 1].pause_at;
    const delay = Math.max(0, (beat.pause_at - prevPauseAt) * 1000);

    console.log(`[VideoSession] Beat ${beatIndex + 1} timer: ${(delay / 1000).toFixed(1)}s from now (video pos ~${beat.pause_at.toFixed(1)}s)`);
    const timer = setTimeout(() => this._fireBeat(beatIndex), delay);
    this._beatTimers.push(timer);
  }

  // ── Beat execution ────────────────────────────────────────────────────────────

  async _fireBeat(beatIndex) {
    if (this.state !== 'active') return;
    const beat = this.plan.beats[beatIndex];
    this._beatIndex = beatIndex + 1;

    console.log(`[VideoSession] Beat ${beatIndex + 1}/${this.plan.beats.length} — pausing at ${beat.pause_at.toFixed(1)}s`);

    this.tvService.pause();

    for (const line of beat.lines) {
      if (this.state !== 'active') return;
      if (!line.audioBuffer) {
        console.warn(`[VideoSession] Beat ${beatIndex + 1}: no audio for "${line.text.slice(0, 40)}", skipping`);
        continue;
      }
      const duration = await this._submitAudio(line.audioBuffer, line.speaker, line.text).catch(err => {
        console.error(`[VideoSession] Submit failed: ${err.message}`);
        return 0;
      });
      if (duration > 0) {
        // Wait for this line to finish playing before submitting the next.
        // +100ms buffer gives handleAudioComplete time to fire (frame loop runs at 30fps = 33ms max lag).
        await new Promise(resolve => setTimeout(resolve, duration * 1000 + 100));
      }
    }

    if (this.state !== 'active') return;
    // All lines have played. Resume video after padding.
    this._resumeTimer = setTimeout(() => this._resumeVideo(beat.pause_at, beatIndex), RESUME_PADDING_MS);
  }

  _resumeVideo(seekPosition, beatIndex) {
    if (this.state !== 'active') return;
    console.log(`[VideoSession] Resuming video at ${seekPosition.toFixed(1)}s`);
    // Seek back to the exact pause point so any compositing lag doesn't cause drift.
    this.tvService.seekToTime(seekPosition);
    this.tvService.play();
    // Chain: arm the next beat timer relative to this resume point.
    this._armNextBeat(beatIndex + 1);
  }

  // ── Video end + wrap-up ───────────────────────────────────────────────────────

  _handleVideoEnd() {
    if (this.state !== 'active') return;
    this.state = 'winding-down';
    this._clearTimers();

    console.log('[VideoSession] Video ended — starting wrap-up');

    this.tvService.setHold(true);

    const wrapup = this.plan.wrapup;

    const submit = async () => {
      for (const line of wrapup.lines) {
        if (!line.audioBuffer) continue;
        await this._submitAudio(line.audioBuffer, line.speaker, line.text).catch(err => {
          console.error(`[VideoSession] Wrap-up submit failed: ${err.message}`);
        });
      }
    };

    submit().catch(err => console.error('[VideoSession] Wrap-up error:', err.message));

    const exitDelay = Math.max(5000, (wrapup.estimatedDuration + 4) * 1000);
    setTimeout(() => this._exit(), exitDelay);
  }

  _exit() {
    if (this.state === 'done') return;
    this.state = 'done';
    this.tvService.onVideoEnd = null;

    // Clear TV so the video doesn't linger or replay after the session.
    try { this.tvService.clear(); } catch (err) {
      console.warn('[VideoSession] TV clear failed:', err.message);
    }

    // Delete the downloaded temp video file to free disk space.
    if (this.plan.tempVideoPath) {
      try { fs.unlinkSync(this.plan.tempVideoPath); } catch {}
    }

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

    const response = await axios.post(`${this.animationServerUrl}/render`, form, {
      headers: form.getHeaders(),
      timeout: 15000
    });
    // Return the exact duration measured by the animation server (FFmpeg PCM decode).
    return response.data?.duration ?? 0;
  }

  _clearTimers() {
    for (const t of this._beatTimers) clearTimeout(t);
    this._beatTimers = [];
    if (this._resumeTimer) { clearTimeout(this._resumeTimer); this._resumeTimer = null; }
  }
}

module.exports = VideoReactionSession;
