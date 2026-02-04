class BufferMonitor {
  constructor({ pipelineStore, fillerGenerator, eventEmitter, segmentRenderer, config }) {
    this.pipelineStore = pipelineStore;
    this.fillerGenerator = fillerGenerator;
    this.eventEmitter = eventEmitter;
    this.segmentRenderer = segmentRenderer;

    // Config with new defaults
    this.config = {
      minSegments: 2,            // Bare minimum segments
      targetSegments: 4,         // Healthy target
      minDurationSeconds: 20,    // Minimum buffer duration
      targetDurationSeconds: 60, // Healthy buffer duration (1 min)
      warningThresholdSeconds: 15,
      criticalThresholdSeconds: 5,
      maxFillersPerBatch: 2,
      maxFillersWhenPriority: 1,
      ...config
    };

    this.fillerEnabled = config?.enabled ?? false;
    this.timer = null;
    this.lastLevel = null;
    this.isGenerating = false; // Prevent concurrent generation batches
  }

  start(intervalMs = 1000) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this._tick().catch(err => {
        console.warn(`[BufferMonitor] Tick failed: ${err.message}`);
      });
    }, intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Get detailed buffer health metrics
   */
  getDetailedHealth() {
    const allSegments = this.pipelineStore.getAllSegments();

    // Ready segments (in queue, waiting to play)
    const ready = allSegments.filter(s => s.status === 'ready');
    // Forming segments (being rendered)
    const forming = allSegments.filter(s => s.status === 'forming');
    // Active = ready + forming (everything that will play)
    const active = [...ready, ...forming];

    // Duration calculations
    const readyDuration = ready.reduce((sum, s) => sum + (s.estimatedDuration || 0), 0);
    const formingDuration = forming.reduce((sum, s) => sum + (s.estimatedDuration || 0), 0);
    const totalDuration = readyDuration + formingDuration;

    // Content type breakdown
    const contentSegments = active.filter(s => s.type !== 'filler' && s.type !== 'transition');
    const fillerSegments = active.filter(s => s.type === 'filler');
    const prioritySegments = active.filter(s => s.type === 'chat-response' || s.metadata?.priority === 'high');

    const hasActiveContent = contentSegments.length > 0;
    const hasPriorityPending = prioritySegments.length > 0;

    return {
      readyCount: ready.length,
      formingCount: forming.length,
      totalCount: active.length,
      readyDuration,
      formingDuration,
      totalDuration,
      contentCount: contentSegments.length,
      fillerCount: fillerSegments.length,
      hasActiveContent,
      hasPriorityPending
    };
  }

  /**
   * Calculate how many fillers we need to reach healthy state
   */
  _calculateFillersNeeded(health) {
    const { totalCount, totalDuration, hasActiveContent, hasPriorityPending } = health;
    const {
      minSegments,
      targetSegments,
      minDurationSeconds,
      targetDurationSeconds,
      maxFillersPerBatch,
      maxFillersWhenPriority
    } = this.config;

    // Don't generate if no user content exists
    if (!hasActiveContent) return 0;

    // Calculate deficit by both count and duration
    const countDeficit = Math.max(0, minSegments - totalCount);
    const countTarget = Math.max(0, targetSegments - totalCount);

    // Estimate ~15s per filler segment
    const avgFillerDuration = 15;
    const durationDeficit = Math.max(0, Math.ceil((minDurationSeconds - totalDuration) / avgFillerDuration));
    const durationTarget = Math.max(0, Math.ceil((targetDurationSeconds - totalDuration) / avgFillerDuration));

    const priorityCap = Math.max(0, maxFillersWhenPriority || 0);
    const normalCap = Math.max(0, maxFillersPerBatch || 0);

    // If chat is pending, only refill to minimum and keep batches small
    if (hasPriorityPending) {
      if (totalCount < minSegments || totalDuration < minDurationSeconds) {
        return Math.min(Math.max(countDeficit, durationDeficit), priorityCap);
      }
      return 0;
    }

    // If we're below minimum, generate enough to reach target (not just minimum)
    if (totalCount < minSegments || totalDuration < minDurationSeconds) {
      // Generate enough to reach target, capped at reasonable batch size
      return Math.min(Math.max(countTarget, durationTarget), normalCap);
    }

    // If we're between min and target, generate 1-2 to keep buffer healthy
    if (totalCount < targetSegments || totalDuration < targetDurationSeconds) {
      return Math.min(Math.max(countTarget, durationTarget), Math.min(2, normalCap));
    }

    return 0;
  }

  async _tick() {
    const health = this.getDetailedHealth();
    const { totalDuration, totalCount, hasActiveContent } = health;

    const { warningThresholdSeconds, criticalThresholdSeconds, minSegments, minDurationSeconds } = this.config;

    // Determine health level based on both duration and count
    let level = 'green';
    if (totalDuration < criticalThresholdSeconds || totalCount < minSegments) {
      level = 'critical';
    } else if (totalDuration < warningThresholdSeconds) {
      level = 'red';
    } else if (totalDuration < minDurationSeconds) {
      level = 'yellow';
    }

    if (this.lastLevel !== level) {
      this.lastLevel = level;
      if (this.eventEmitter) {
        this.eventEmitter.broadcast('buffer:warning', {
          level,
          totalSeconds: totalDuration,
          totalCount,
          health
        });
      }
    }

    // Generate fillers if enabled and needed
    if (this.fillerEnabled && this.fillerGenerator && !this.isGenerating) {
      const fillersNeeded = this._calculateFillersNeeded(health);

      if (fillersNeeded > 0 && hasActiveContent) {
        this.isGenerating = true;
        try {
          await this._generateFillerBatch(fillersNeeded);
        } finally {
          this.isGenerating = false;
        }
      }
    }
  }

  /**
   * Generate multiple fillers and position them correctly in the pipeline
   */
  async _generateFillerBatch(count) {
    console.log(`[BufferMonitor] Generating ${count} filler(s)`);

    for (let i = 0; i < count; i++) {
      try {
        // Get recent context for continuity
        const allSegments = this.pipelineStore.getAllSegments();
        const recentContexts = allSegments
          .filter(s => s.exitContext && ['aired', 'ready', 'forming'].includes(s.status))
          .slice(-5)
          .map(s => s.exitContext);

        // Generate filler
        const segment = await this.fillerGenerator.generateFiller(recentContexts);

        // Position filler next to the last non-filler content or at the end
        await this._positionFillerInPipeline(segment.id);

        // Queue for rendering
        if (this.segmentRenderer) {
          this.segmentRenderer.queueRender(segment.id).catch(err => {
            console.warn(`[BufferMonitor] Filler render failed: ${err.message}`);
          });
        }

        if (this.eventEmitter) {
          this.eventEmitter.broadcast('pipeline:update', {
            segments: this.pipelineStore.getAllSegments(),
            bufferHealth: this.pipelineStore.getBufferHealth()
          });
        }
      } catch (err) {
        console.warn(`[BufferMonitor] Filler generation ${i + 1}/${count} failed: ${err.message}`);
      }
    }
  }

  /**
   * Position a filler segment next to the content it follows.
   * Fillers should chain together after their preceding content.
   */
  async _positionFillerInPipeline(fillerId) {
    const allSegments = this.pipelineStore.getAllSegments();
    const fillerIndex = allSegments.findIndex(s => s.id === fillerId);

    if (fillerIndex === -1) return;

    // Find the last content segment (non-filler, non-transition)
    let lastContentIndex = -1;
    for (let i = allSegments.length - 1; i >= 0; i--) {
      const seg = allSegments[i];
      if (seg.type !== 'filler' && seg.type !== 'transition' &&
          ['forming', 'ready'].includes(seg.status)) {
        lastContentIndex = i;
        break;
      }
    }

    // Find the last filler that's already chained after content
    let insertPosition = allSegments.length; // Default: end of pipeline

    if (lastContentIndex !== -1) {
      // Look for existing fillers after the last content
      let lastFillerAfterContent = lastContentIndex;
      for (let i = lastContentIndex + 1; i < allSegments.length; i++) {
        if (allSegments[i].type === 'filler' &&
            ['forming', 'ready'].includes(allSegments[i].status)) {
          lastFillerAfterContent = i;
        } else {
          break; // Stop at non-filler
        }
      }
      insertPosition = lastFillerAfterContent + 1;
    }

    // Only reposition if needed
    if (fillerIndex !== insertPosition && fillerIndex !== insertPosition - 1) {
      await this.pipelineStore.insertAt(fillerId, insertPosition);
    }
  }
}

module.exports = BufferMonitor;
