function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function estimateLineDurationMs(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  const minutes = words / 150;
  return Math.max(500, Math.round(minutes * 60 * 1000));
}

class PlaybackController {
  constructor({ pipelineStore, tvLayerManager, segmentRenderer, animationServerUrl, eventEmitter }) {
    this.pipelineStore = pipelineStore;
    this.tvLayerManager = tvLayerManager;
    this.segmentRenderer = segmentRenderer;
    this.animationServerUrl = animationServerUrl || `http://127.0.0.1:${process.env.ANIMATION_PORT || 3003}`;
    this.eventEmitter = eventEmitter;

    this.isPlaying = false;
    this.currentSegmentId = null;
    this.currentLineIndex = 0;
    this.waitingForRender = false;
    this.pendingTimeouts = [];
  }

  async start() {
    if (this.isPlaying) return this.getStatus();
    this.isPlaying = true;
    this._loop();
    return this.getStatus();
  }

  async stop() {
    this.isPlaying = false;
    this.currentSegmentId = null;
    this.currentLineIndex = 0;
    this.waitingForRender = false;
    this._clearScheduledCues();
    return this.getStatus();
  }

  getStatus() {
    return {
      isPlaying: this.isPlaying,
      currentSegmentId: this.currentSegmentId,
      currentLineIndex: this.currentLineIndex,
      waitingForRender: this.waitingForRender
    };
  }

  async _loop() {
    while (this.isPlaying) {
      const played = await this.playNextSegment();
      if (!played) {
        await sleep(1000);
      }
    }
  }

  async playNextSegment() {
    const segments = this.pipelineStore.getAllSegments();
    let segment = segments.find(s => s.status === 'pre-air');
    if (!segment) {
      segment = segments.find(s => s.status === 'ready');
      if (segment) {
        await this.pipelineStore.transitionStatus(segment.id, 'pre-air');
      }
    }

    if (!segment) return false;

    await this.pipelineStore.transitionStatus(segment.id, 'on-air');
    if (this.eventEmitter) {
      this.eventEmitter.broadcast('pipeline:update', {
        segments: this.pipelineStore.getAllSegments(),
        bufferHealth: this.pipelineStore.getBufferHealth()
      });
    }
    this.currentSegmentId = segment.id;
    this.currentLineIndex = 0;

    this._scheduleCues(segment);
    if (this.segmentRenderer && this.segmentRenderer.estimateSegmentDurationMs) {
      await sleep(this.segmentRenderer.estimateSegmentDurationMs(segment));
    } else {
      await this._waitForPlaybackIdle();
    }

    await this.pipelineStore.transitionStatus(segment.id, 'aired');
    if (this.eventEmitter) {
      this.eventEmitter.broadcast('pipeline:update', {
        segments: this.pipelineStore.getAllSegments(),
        bufferHealth: this.pipelineStore.getBufferHealth()
      });
    }

    this.currentSegmentId = null;
    this.currentLineIndex = 0;
    this._clearScheduledCues();

    return true;
  }

  _scheduleCues(segment) {
    this._clearScheduledCues();
    if (!segment || !Array.isArray(segment.script)) return;

    let cumulativeMs = 0;
    segment.script.forEach((line, index) => {
      const cues = Array.isArray(line.cues) ? line.cues : [];
      if (cues.length > 0) {
        const timeoutId = setTimeout(() => {
          this.currentLineIndex = index;
          this._fireCues(cues).catch(err => {
            console.warn(`[PlaybackController] Cue error: ${err.message}`);
          });
        }, cumulativeMs);
        this.pendingTimeouts.push(timeoutId);
      }
      cumulativeMs += estimateLineDurationMs(line.text || '');
    });
  }

  _clearScheduledCues() {
    for (const timeoutId of this.pendingTimeouts) {
      clearTimeout(timeoutId);
    }
    this.pendingTimeouts = [];
  }

  async _fireCues(cues) {
    for (const cue of cues) {
      if (!cue || !cue.type) continue;

      if (cue.type === 'tv:show') {
        if (this.tvLayerManager && cue.target) {
          await this.tvLayerManager.pushOverride(cue.target);
        }
      } else if (cue.type === 'tv:release') {
        if (this.tvLayerManager) {
          await this.tvLayerManager.releaseOverride();
        }
      } else if (cue.type === 'lighting:hue') {
        const hue = Number(cue.target);
        if (Number.isFinite(hue)) {
          await fetch(`${this.animationServerUrl}/lighting/hue`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hue })
          });
        }
      }
    }
  }

  async _waitForPlaybackIdle() {
    while (this.isPlaying) {
      try {
        const res = await fetch(`${this.animationServerUrl}/stream-info`);
        if (!res.ok) {
          await sleep(500);
          continue;
        }
        const data = await res.json();
        const isPlaying = Boolean(data?.state?.isPlaying);
        if (!isPlaying) return;
      } catch (err) {
        console.warn(`[PlaybackController] stream-info failed: ${err.message}`);
      }
      await sleep(500);
    }
  }
}

module.exports = PlaybackController;
