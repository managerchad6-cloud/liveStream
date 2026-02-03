const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VALID_TRANSITIONS = {
  'draft': ['forming', 'deleted'],
  'forming': ['ready', 'draft'],
  'ready': ['pre-air', 'draft'],
  'pre-air': ['on-air', 'ready'],
  'on-air': ['aired']
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

    console.log(`[PipelineStore] Initialized with ${this.segments.length} segments`);
  }

  async _persist() {
    const payload = JSON.stringify(this.segments, null, 2);
    const tmpPath = `${this.filePath}.tmp`;
    await fs.promises.writeFile(tmpPath, payload, 'utf8');
    await fs.promises.rename(tmpPath, this.filePath);
  }

  async createSegment({ type, seed, mediaRefs, script, estimatedDuration, tvCues, lightingCues } = {}) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const segment = {
      id,
      status: 'draft',
      type: type || 'auto-convo',
      seed: seed || null,
      mediaRefs: mediaRefs || [],
      script: script || null,
      estimatedDuration: estimatedDuration || 0,
      tvCues: tvCues || [],
      lightingCues: lightingCues || [],
      tvDefaultAfter: null,
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

  async transitionStatus(id, newStatus) {
    const segment = this.getSegment(id);
    if (!segment) {
      throw new Error(`Segment not found: ${id}`);
    }

    const allowed = VALID_TRANSITIONS[segment.status];
    if (!allowed || !allowed.includes(newStatus)) {
      throw new Error(`Invalid transition: ${segment.status} → ${newStatus}`);
    }

    segment.status = newStatus;
    segment.updatedAt = new Date().toISOString();

    if (newStatus === 'deleted') {
      const index = this.segments.indexOf(segment);
      if (index !== -1) this.segments.splice(index, 1);
    }

    await this._persist();

    console.log(`[PipelineStore] Segment ${id}: ${segment.status} → ${newStatus}`);
    return segment;
  }

  async updateSegment(id, updates) {
    const segment = this.getSegment(id);
    if (!segment) {
      throw new Error(`Segment not found: ${id}`);
    }

    const allowedFields = [
      'seed', 'mediaRefs', 'script', 'estimatedDuration',
      'tvCues', 'lightingCues', 'tvDefaultAfter',
      'renderProgress', 'exitContext', 'metadata'
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

    if (segment.status !== 'draft' && segment.status !== 'aired') {
      throw new Error(`Can only remove draft or aired segments (current: ${segment.status})`);
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
    let preAirCount = 0;

    for (const s of this.segments) {
      if (s.status === 'ready') {
        readyCount++;
        totalSeconds += s.estimatedDuration || 0;
      } else if (s.status === 'pre-air') {
        preAirCount++;
        totalSeconds += s.estimatedDuration || 0;
      }
    }

    return { totalSeconds, readyCount, preAirCount };
  }

  getOnAirSegment() {
    return this.segments.find(s => s.status === 'on-air') || null;
  }

  getQueue() {
    return this.segments.filter(s => s.status === 'ready' || s.status === 'pre-air');
  }
}

module.exports = PipelineStore;
