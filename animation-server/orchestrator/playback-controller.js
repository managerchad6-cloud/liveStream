/**
 * PlaybackController - Event-driven segment lifecycle manager
 *
 * No polling. The animation server calls setOnAir() and segmentDone()
 * directly when audio starts/finishes for each segment.
 */
class PlaybackController {
  constructor({ pipelineStore, eventEmitter, scriptGenerator, segmentRenderer }) {
    this.pipelineStore = pipelineStore;
    this.eventEmitter = eventEmitter;
    this.scriptGenerator = scriptGenerator;
    this.segmentRenderer = segmentRenderer;

    this.isPlaying = false;
    this.isPaused = false;
    this.currentSegmentId = null;
    this.broadcastInterval = null;
    // Segments whose audio finished before they became 'ready' (edge case)
    this.pendingDone = new Set();
    // Prevent duplicate expand generation per on-air segment
    this.pendingExpand = new Set();
    // Expand chain tracking: { rootSegmentId, maxExpands, airedCount }
    this.expandChain = null;
    // Registered on-air hooks: Array<(segmentId, segment) => void>
    this._onAirHooks = [];
    // Registered segment-done hooks: Array<(segmentId) => void>
    this._segmentDoneHooks = [];
  }

  /**
   * Register a callback fired when any segment goes on-air.
   * @param {Function} fn - (segmentId: string, segment: Object) => void
   */
  registerOnAirHook(fn) {
    this._onAirHooks.push(fn);
  }

  /**
   * Register a callback fired when a segment's audio finishes.
   * @param {Function} fn - (segmentId: string) => void
   */
  registerSegmentDoneHook(fn) {
    this._segmentDoneHooks.push(fn);
  }

  removeSegmentDoneHook(fn) {
    this._segmentDoneHooks = this._segmentDoneHooks.filter(h => h !== fn);
  }

  start() {
    if (this.isPaused) {
      console.log('[PlaybackController] Resuming from pause');
      console.trace('[PlaybackController] start() caller');
    }
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
   *
   * IMPORTANT: Expand generation happens HERE (when segment starts) so the next
   * expand is ready by the time the current segment finishes - prevents silence gaps.
   */
  setOnAir(segmentId) {
    if (this.currentSegmentId !== segmentId) {
      const previousSegmentId = this.currentSegmentId;  // Save before updating
      this.currentSegmentId = segmentId;
      const seg = this.pipelineStore.getSegment(segmentId);
      console.log(`[PlaybackController] On-air: ${segmentId.slice(0,8)} type=${seg?.type || '?'} hasNarratorPair=${seg?.metadata?.hasNarratorPair || false}`);
      this._broadcastUpdate();

      // Fire registered on-air hooks (e.g. TV media cue)
      if (this._onAirHooks.length > 0) {
        const segment = this.pipelineStore.getSegment(segmentId);
        for (const hook of this._onAirHooks) {
          try { hook(segmentId, segment); } catch (err) {
            console.warn(`[PlaybackController] On-air hook error: ${err.message}`);
          }
        }
      }

      // Trigger expand generation immediately when segment starts playing
      // This ensures the next expand is rendered and ready before this segment finishes
      console.log(`[PlaybackController] Attempting expand generation for on-air segment ${segmentId}`);
      this._maybeGenerateExpand(segmentId, previousSegmentId).catch(err => {
        console.warn(`[PlaybackController] On-air expand failed: ${err.message}`);
      });
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

    // Fire segment-done hooks (e.g. video reaction intro completion)
    for (const hook of this._segmentDoneHooks) {
      try { hook(segmentId); } catch (err) {
        console.warn(`[PlaybackController] Segment-done hook error: ${err.message}`);
      }
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

  _isExpandSegment(segment) {
    return Boolean(segment && segment.metadata && segment.metadata.continuity === 'expand');
  }

  _pipelineHasOnlyOnAir(segmentId, previousSegmentId) {
    // Check if the pipeline will be empty after this segment finishes.
    // When setOnAir() is called, the previous segment might still be in 'ready'
    // status (race condition before segmentDone() is called), so we need to
    // exclude it from the count.
    const ready = this.pipelineStore.getReadyQueue();

    // Count ALL other ready segments (expand or not), excluding only this segment
    // and the previous one that's transitioning to 'aired'
    const otherSegments = ready.filter(s =>
      s.id !== segmentId &&
      s.id !== previousSegmentId
    );

    console.log(`[PlaybackController] Other segments in queue: ${otherSegments.length} (${otherSegments.map(s => `${s.type}:${s.id.slice(0,8)}`).join(', ')})`);

    // Generate expand ONLY if pipeline will be completely empty after this segment
    return otherSegments.length === 0;
  }

  _hasRealRendering() {
    if (!this.pipelineStore.getFormingSegments) return false;
    const forming = this.pipelineStore.getFormingSegments();
    return forming.some(seg => !this._isExpandSegment(seg));
  }

  _hasExpandFor(segmentId) {
    return this.pipelineStore.getAllSegments().some(seg =>
      this._isExpandSegment(seg) && seg.metadata?.expandFrom === segmentId
    );
  }

  async _maybeGenerateExpand(segmentId, previousSegmentId = null) {
    console.log(`[PlaybackController] _maybeGenerateExpand called for ${segmentId} (prev: ${previousSegmentId?.slice(0,8) || 'none'})`);

    if (this.isPaused) {
      console.log(`[PlaybackController] Paused — skipping expand generation`);
      return;
    }

    if (!this.pipelineStore || !this.scriptGenerator || !this.segmentRenderer) {
      console.log(`[PlaybackController] Missing dependencies (store/generator/renderer)`);
      return;
    }

    if (this.pendingExpand.has(segmentId)) {
      console.log(`[PlaybackController] Expand already pending for ${segmentId}`);
      return;
    }

    const sourceSegment = this.pipelineStore.getSegment(segmentId);
    if (!sourceSegment) {
      console.log(`[PlaybackController] Source segment ${segmentId} not found`);
      return;
    }

    // Count words in the source segment's script (excluding narrator lines)
    const sourceWordCount = Array.isArray(sourceSegment.script)
      ? sourceSegment.script
          .filter(l => l.speaker !== 'narrator')
          .reduce((acc, l) => acc + (l.text || '').split(/\s+/).filter(Boolean).length, 0)
      : 0;

    // Track expand chain: human-input segments start a new chain, expands continue it
    const humanInputTypes = ['chat-response', 'auto-convo', 'custom-script'];
    const isHumanInput = humanInputTypes.includes(sourceSegment.type);
    const isExpand = this._isExpandSegment(sourceSegment);

    // chat-response segments paired with a narrator-cue should NOT spawn an expand —
    // the viewer hasn't even heard the response yet (HLS delay). Expanding immediately
    // creates a confusing 3rd on-air event right after the narrator+response pair.
    if (isHumanInput && sourceSegment.type === 'chat-response' && sourceSegment.metadata?.hasNarratorPair) {
      console.log(`[PlaybackController] Skipping expand for narrator-paired chat-response ${segmentId.slice(0,8)}`);
      this.expandChain = null;
      return;
    }

    if (isHumanInput) {
      // Compute maxExpands deterministically from source word count — no LLM dependency.
      // For chat-response: word count determines the budget.
      // For seeds/scripts: default to 5 (LLM will still influence via prompt guidance).
      // Probabilistic: 50% → 0, 30% → 1, 20% → 2
      // Word count can only reduce the cap, never increase it:
      // long response (>20w) caps at 0, medium (10-20w) caps at 1, short (<10w) unrestricted
      const r = Math.random();
      const rolled = r < 0.5 ? 0 : r < 0.8 ? 1 : 2;
      const wordCap = sourceWordCount > 20 ? 0 : sourceWordCount >= 10 ? 1 : 2;
      const chainMax = Math.min(rolled, wordCap);
      this.expandChain = { rootSegmentId: segmentId, maxExpands: chainMax, airedCount: 0 };
      console.log(`[PlaybackController] New expand chain from ${sourceSegment.type} ${segmentId.slice(0,8)} — maxExpands=${chainMax} (sourceWords=${sourceWordCount})`);
    } else if (isExpand && this.expandChain) {
      // Count this aired expand
      this.expandChain.airedCount += 1;

      // Check if chain is exhausted
      if (this.expandChain.airedCount >= this.expandChain.maxExpands) {
        console.log(`[PlaybackController] Expand chain exhausted (${this.expandChain.airedCount}/${this.expandChain.maxExpands}) — going silent`);
        this.expandChain = null;
        return;
      }

      console.log(`[PlaybackController] Expand ${this.expandChain.airedCount}/${this.expandChain.maxExpands} aired`);
    } else if (isExpand && !this.expandChain) {
      // Orphaned expand (chain was reset by new human input) — don't continue
      console.log(`[PlaybackController] Orphaned expand ${segmentId.slice(0,8)} — no active chain`);
      return;
    } else if (!isExpand && !isHumanInput) {
      // Non-human, non-expand segment (bridge, filler, transition) — don't expand
      return;
    }

    // Continuity decisions are strictly ON-AIR-driven and only when pipeline is empty.
    // Generate expand when this segment starts playing AND nothing else is in pipeline.
    // This ensures the next expand is ready by the time this segment finishes (no silence gaps).

    const hasOnlyOnAir = this._pipelineHasOnlyOnAir(segmentId, previousSegmentId);
    console.log(`[PlaybackController] Pipeline has only on-air? ${hasOnlyOnAir}`);
    if (!hasOnlyOnAir) {
      const allSegments = this.pipelineStore.getAllSegments();
      const ready = allSegments.filter(s => s.status === 'ready');
      console.log(`[PlaybackController] Ready segments: ${ready.length} (${ready.map(s => s.id.slice(0,8)).join(', ')})`);
      return;
    }

    const hasRealRendering = this._hasRealRendering();
    console.log(`[PlaybackController] Has real rendering? ${hasRealRendering}`);
    if (hasRealRendering) {
      const forming = this.pipelineStore.getFormingSegments();
      const nonExpand = forming.filter(seg => !this._isExpandSegment(seg));
      console.log(`[PlaybackController] Non-expand forming segments: ${nonExpand.length} (${nonExpand.map(s => s.type).join(', ')})`);
      return;
    }

    const hasExpand = this._hasExpandFor(segmentId);
    console.log(`[PlaybackController] Already has expand for ${segmentId}? ${hasExpand}`);
    if (hasExpand) return;

    // Determine expand options
    const isFirstExpand = isHumanInput; // first expand comes right after human input
    let wrapUp = false;
    if (this.expandChain && this.expandChain.maxExpands >= 2) {
      // wrapUp only makes sense for multi-expand chains (single-expand is just a reaction, not a conclusion)
      wrapUp = (this.expandChain.airedCount + 1) >= this.expandChain.maxExpands;
    }

    console.log(`[PlaybackController] Generating expand for ${segmentId.slice(0,8)} (first=${isFirstExpand}, wrapUp=${wrapUp}, sourceWords=${sourceWordCount})`);
    this.pendingExpand.add(segmentId);
    try {
      const segment = await this.scriptGenerator.expandConversation({ isFirstExpand, wrapUp, sourceType: sourceSegment.type, sourceWordCount });
      if (!segment) {
        console.log(`[PlaybackController] Expand generation returned null`);
        this.pendingExpand.delete(segmentId);
        return;
      }

      console.log(`[PlaybackController] Expand generated: ${segment.id}`);

      await this.pipelineStore.updateSegment(segment.id, {
        metadata: { ...(segment.metadata || {}), continuity: 'expand', expandFrom: segmentId, expandChainRoot: this.expandChain?.rootSegmentId || segmentId, wrapUp: wrapUp || false }
      });

      this.segmentRenderer.queueRender(segment.id).catch(err => {
        console.warn(`[PlaybackController] Expand render failed: ${err.message}`);
      });

      console.log(`[PlaybackController] Expand ${segment.id.slice(0,8)} queued for rendering${wrapUp ? ' [WRAP-UP — chain closing]' : ''}`);
      this._broadcastUpdate();
    } finally {
      this.pendingExpand.delete(segmentId);
    }
  }
}

module.exports = PlaybackController;
