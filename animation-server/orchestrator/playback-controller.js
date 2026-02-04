/**
 * PlaybackController - Event-driven segment lifecycle manager
 *
 * No polling. The animation server calls setOnAir() and segmentDone()
 * directly when audio starts/finishes for each segment.
 */
class PlaybackController {
  constructor({ pipelineStore, eventEmitter }) {
    this.pipelineStore = pipelineStore;
    this.eventEmitter = eventEmitter;

    this.isPlaying = false;
    this.isPaused = false;
    this.currentSegmentId = null;
    this.broadcastInterval = null;
    // Segments whose audio finished before they became 'ready' (edge case)
    this.pendingDone = new Set();
  }

  start() {
    this.isPaused = false;
    if (this.isPlaying) return this.getStatus();
    this.isPlaying = true;
    this._startPeriodicBroadcast();
    console.log('[PlaybackController] Started');
    return this.getStatus();
  }

  pause() {
    this.isPaused = true;
    return this.getStatus();
  }

  stop() {
    this.isPlaying = false;
    this.isPaused = false;
    this.currentSegmentId = null;
    this.pendingDone.clear();
    this._stopPeriodicBroadcast();
    return this.getStatus();
  }

  getStatus() {
    return {
      isPlaying: this.isPlaying,
      isPaused: this.isPaused,
      currentSegmentId: this.currentSegmentId
    };
  }

  /**
   * Called by the animation server when a segment's audio starts playing.
   * This is the authoritative signal - no guessing or polling.
   */
  setOnAir(segmentId) {
    if (this.currentSegmentId !== segmentId) {
      this.currentSegmentId = segmentId;
      console.log(`[PlaybackController] On-air: ${segmentId}`);
      this._broadcastUpdate();
    }
  }

  /**
   * Called by the animation server when ALL audio for a segment has finished.
   * Transitions the segment to 'aired' and clears the on-air state.
   */
  async segmentDone(segmentId) {
    console.log(`[PlaybackController] Audio complete: ${segmentId}`);

    // Transition to aired
    try {
      const segment = this.pipelineStore.getSegment(segmentId);
      if (segment && segment.status === 'ready') {
        await this.pipelineStore.transitionStatus(segmentId, 'aired');
        console.log(`[PlaybackController] ${segmentId} → aired`);
      } else if (segment && segment.status === 'forming') {
        // Audio finished before rendering complete - defer transition
        console.log(`[PlaybackController] ${segmentId} still forming, deferring transition`);
        this.pendingDone.add(segmentId);
      }
    } catch (err) {
      console.warn(`[PlaybackController] Failed to archive ${segmentId}: ${err.message}`);
    }

    // Clear on-air if this was the current segment
    if (this.currentSegmentId === segmentId) {
      this.currentSegmentId = null;
    }

    this._broadcastUpdate();
  }

  /**
   * Check if any deferred segments have become 'ready' and can now be transitioned.
   */
  _checkPendingDone() {
    if (this.pendingDone.size === 0) return;

    for (const segId of this.pendingDone) {
      const seg = this.pipelineStore.getSegment(segId);
      if (!seg || seg.status === 'aired' || seg.status === 'deleted') {
        this.pendingDone.delete(segId);
      } else if (seg.status === 'ready') {
        this.pendingDone.delete(segId);
        this.pipelineStore.transitionStatus(segId, 'aired').then(() => {
          console.log(`[PlaybackController] ${segId} → aired (deferred)`);
          this._broadcastUpdate();
        }).catch(err => {
          console.warn(`[PlaybackController] Deferred archive failed: ${err.message}`);
        });
      }
    }
  }

  _startPeriodicBroadcast() {
    if (this.broadcastInterval) return;
    this.broadcastInterval = setInterval(() => {
      this._checkPendingDone();
      this._broadcastUpdate();
    }, 500);
  }

  _stopPeriodicBroadcast() {
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }
  }

  _broadcastUpdate() {
    if (this.eventEmitter) {
      this.eventEmitter.broadcast('pipeline:update', {
        segments: this.pipelineStore.getAllSegments(),
        bufferHealth: this.pipelineStore.getBufferHealth(),
        currentSegmentId: this.currentSegmentId,
        playbackStatus: this.getStatus()
      });
    }
  }
}

module.exports = PlaybackController;
