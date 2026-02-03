function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class BufferMonitor {
  constructor({ pipelineStore, fillerGenerator, eventEmitter, segmentRenderer, config }) {
    this.pipelineStore = pipelineStore;
    this.fillerGenerator = fillerGenerator;
    this.eventEmitter = eventEmitter;
    this.segmentRenderer = segmentRenderer;
    this.config = config || {
      warningThresholdSeconds: 15,
      criticalThresholdSeconds: 5
    };
    this.fillerEnabled = config?.enabled ?? true;
    this.timer = null;
    this.lastLevel = null;
    this.lastFillerAt = 0;
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

  async _tick() {
    const health = this.pipelineStore.getBufferHealth();
    const totalSeconds = health.totalSeconds || 0;

    const warning = this.config.warningThresholdSeconds ?? 15;
    const critical = this.config.criticalThresholdSeconds ?? 5;

    let level = 'green';
    if (totalSeconds < critical) level = 'critical';
    else if (totalSeconds < warning) level = 'red';
    else if (totalSeconds < 30) level = 'yellow';

    if (this.lastLevel !== level) {
      this.lastLevel = level;
      if (this.eventEmitter) {
        this.eventEmitter.broadcast('buffer:warning', { level, totalSeconds });
      }
    }

    if (level === 'critical' && this.fillerEnabled && this.fillerGenerator) {
      const now = Date.now();
      if (now - this.lastFillerAt > 30_000) {
        this.lastFillerAt = now;
        await this._generateFiller();
      }
    }
  }

  async _generateFiller() {
    const recent = this.pipelineStore.getAllSegments()
      .filter(s => s.exitContext)
      .slice(-5)
      .map(s => s.exitContext);

    const segment = await this.fillerGenerator.generateFiller(recent);
    await this.pipelineStore.transitionStatus(segment.id, 'forming');

    if (this.segmentRenderer) {
      this.segmentRenderer.queueRender(segment.id).catch(err => {
        console.warn(`[BufferMonitor] Filler render failed: ${err.message}`);
      });
    }
  }
}

module.exports = BufferMonitor;
