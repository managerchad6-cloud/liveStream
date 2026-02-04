const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Simplified: forming → ready (pipeline queue) → aired (archive)
// The rightmost 'ready' segment is currently on-air
const VALID_TRANSITIONS = {
  'forming': ['ready', 'deleted'],
  'ready': ['aired', 'deleted'],
  'aired': ['deleted']
};

class PipelineStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'pipeline.json');
    this.segments = [];
  }

  async init() {
    fs.mkdirSync(this.dataDir, { recursive: true });

    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.segments = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn('[PipelineStore] Failed to load, starting fresh:', err.message);
      }
      this.segments = [];
    }

    // Mark stale 'forming' segments from previous sessions (they'll never render)
    const staleForming = this.segments.filter(s => s.status === 'forming');
    if (staleForming.length > 0) {
      for (const seg of staleForming) {
        seg.renderProgress = -1;
        seg.metadata = { ...seg.metadata, renderError: 'Server restarted during render', renderFailedAt: Date.now() };
      }
      await this._persist();
      console.log(`[PipelineStore] Marked ${staleForming.length} stale forming segments as failed`);
    }

    console.log(`[PipelineStore] Initialized with ${this.segments.length} segments`);
  }

  async _persist() {
    const payload = JSON.stringify(this.segments, null, 2);
    const tmpPath = `${this.filePath}.tmp`;
    await fs.promises.writeFile(tmpPath, payload, 'utf8');
    await fs.promises.rename(tmpPath, this.filePath);
  }

  async createSegment({ type, seed, script, estimatedDuration } = {}) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const segment = {
      id,
      status: 'forming',
      type: type || 'auto-convo',
      seed: seed || null,
      script: script || null,
      estimatedDuration: estimatedDuration || 0,
      renderProgress: 0,
      exitContext: null,
      metadata: {},
      createdAt: now,
      updatedAt: now
    };

    this.segments.push(segment);
    await this._persist();

    console.log(`[PipelineStore] Created segment ${id} (${type || 'auto-convo'})`);
    return segment;
  }

  getSegment(id) {
    return this.segments.find(s => s.id === id) || null;
  }

  getAllSegments() {
    return this.segments.slice();
  }

  getSegmentIndex(id) {
    return this.segments.findIndex(s => s.id === id);
  }

  _findPriorityInsertIndex({ afterOnAir = true, avoidTransitionSplit = true } = {}) {
    let insertIndex = 0;

    if (afterOnAir) {
      const onAir = this.getOnAirSegment();
      if (onAir) {
        const onAirIndex = this.getSegmentIndex(onAir.id);
        if (onAirIndex !== -1) {
          insertIndex = onAirIndex + 1;
        }
      }
    }

    if (!avoidTransitionSplit) return Math.min(insertIndex, this.segments.length);

    // Avoid inserting between a transition and its target (keep them adjacent)
    while (insertIndex > 0 && insertIndex < this.segments.length) {
      const prev = this.segments[insertIndex - 1];
      const next = this.segments[insertIndex];
      if (prev && prev.type === 'transition' && prev.metadata?.bridgeFor === next?.id) {
        insertIndex += 1;
        continue;
      }
      break;
    }

    return Math.min(insertIndex, this.segments.length);
  }

  async prioritizeSegment(id, options = {}) {
    const index = this._findPriorityInsertIndex(options);
    return this.insertAt(id, index);
  }

  async transitionStatus(id, newStatus) {
    const segment = this.getSegment(id);
    if (!segment) {
      throw new Error(`Segment not found: ${id}`);
    }

    const oldStatus = segment.status;
    const allowed = VALID_TRANSITIONS[oldStatus];
    if (!allowed || !allowed.includes(newStatus)) {
      throw new Error(`Invalid transition: ${oldStatus} → ${newStatus}`);
    }

    segment.status = newStatus;
    segment.updatedAt = new Date().toISOString();

    if (newStatus === 'deleted') {
      const index = this.segments.indexOf(segment);
      if (index !== -1) this.segments.splice(index, 1);
    }

    await this._persist();

    console.log(`[PipelineStore] Segment ${id}: ${oldStatus} → ${newStatus}`);
    return segment;
  }

  async updateSegment(id, updates) {
    const segment = this.getSegment(id);
    if (!segment) {
      throw new Error(`Segment not found: ${id}`);
    }

    const allowedFields = [
      'seed', 'script', 'estimatedDuration',
      'renderProgress', 'renderDurations', 'exitContext', 'metadata'
    ];

    for (const key of allowedFields) {
      if (key in updates) {
        segment[key] = updates[key];
      }
    }

    segment.updatedAt = new Date().toISOString();
    await this._persist();

    return segment;
  }

  async insertAt(id, index) {
    const currentIndex = this.segments.findIndex(s => s.id === id);
    if (currentIndex === -1) {
      throw new Error(`Segment not found: ${id}`);
    }

    const [segment] = this.segments.splice(currentIndex, 1);
    const clampedIndex = Math.max(0, Math.min(index, this.segments.length));
    this.segments.splice(clampedIndex, 0, segment);

    await this._persist();
    return this.segments;
  }

  async reorder(orderedIds) {
    const idSet = new Set(orderedIds);
    const reordered = [];

    for (const id of orderedIds) {
      const segment = this.segments.find(s => s.id === id);
      if (segment) {
        reordered.push(segment);
      }
    }

    // Append any segments not in the ordered list (preserve them at the end)
    for (const segment of this.segments) {
      if (!idSet.has(segment.id)) {
        reordered.push(segment);
      }
    }

    this.segments = reordered;
    await this._persist();

    return this.segments;
  }

  async removeSegment(id) {
    const segment = this.getSegment(id);
    if (!segment) {
      throw new Error(`Segment not found: ${id}`);
    }

    const index = this.segments.indexOf(segment);
    if (index !== -1) this.segments.splice(index, 1);

    await this._persist();

    console.log(`[PipelineStore] Removed segment ${id}`);
    return true;
  }

  getBufferHealth() {
    let totalSeconds = 0;
    let readyCount = 0;

    for (const s of this.segments) {
      if (s.status === 'ready') {
        readyCount++;
        totalSeconds += s.estimatedDuration || 0;
      }
    }

    return { totalSeconds, readyCount };
  }

  // The "on-air" segment is the OLDEST ready segment (first in array = rightmost in UI)
  // This is the one currently playing
  getOnAirSegment() {
    const ready = this.segments.filter(s => s.status === 'ready');
    return ready.length > 0 ? ready[0] : null;
  }

  // Get ready segments in queue order (oldest first = rightmost in UI)
  getReadyQueue() {
    return this.segments.filter(s => s.status === 'ready');
  }

  // Get forming segments
  getFormingSegments() {
    return this.segments.filter(s => s.status === 'forming');
  }

  getQueue() {
    return this.segments.filter(s => s.status === 'ready');
  }
}

module.exports = PipelineStore;
