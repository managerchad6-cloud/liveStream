const axios = require('axios');
const FormData = require('form-data');
const voices = require('../../voices');

const BRIDGE_GATE_TIMEOUT_MS = 15_000;
const MAX_SEGMENT_RETRIES = 2;
const RETRY_DELAY_MS = 5_000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function estimateLineDurationMs(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  const minutes = words / 150;
  return Math.max(500, Math.round(minutes * 60 * 1000));
}

class SegmentRenderer {
  constructor({ pipelineStore, animationServerUrl, maxConcurrent = 3, eventEmitter }) {
    this.pipelineStore = pipelineStore;
    this.animationServerUrl = animationServerUrl || `http://127.0.0.1:${process.env.ANIMATION_PORT || 3003}`;
    this.maxConcurrent = maxConcurrent;
    this.eventEmitter = eventEmitter;
    this.activeRenders = 0;
    this.renderQueue = [];
    this.inFlight = new Set();
    // Ensures Phase 2 (audio push) happens in pipeline order,
    // even when Phase 1 (TTS) runs in parallel across multiple segments
    this.pushChain = Promise.resolve();
    // Pre-gates: a segment's Phase 2 waits for its gate to resolve before pushing audio
    this.preGates = new Map();
    // Ordered drain: segments wait here after TTS until it's their turn in pipeline order
    this.pendingPushes = new Map();   // segmentId → { audioItems, renderDurations, resolve, reject }
    this.activeTTS = new Set();       // segmentIds currently in Phase 1 (TTS)
    this._draining = false;
    // Safety valve: periodically check for stuck render queue items
    this._dequeueInterval = setInterval(() => {
      if (this.renderQueue.length > 0 && this.activeRenders < this.maxConcurrent) {
        console.warn(`[SegmentRenderer] Safety dequeue: ${this.renderQueue.length} queued, ${this.activeRenders} active`);
        this._dequeue();
      }
      // Also try draining if there are pending pushes
      if (this.pendingPushes.size > 0) {
        this._drainInPipelineOrder();
      }
    }, 5000);
  }

  /**
   * Add a pre-gate: target segment's Phase 2 will wait for gatePromise to settle
   * before pushing audio to the animation server.
   */
  addPreGate(segmentId, gatePromise) {
    // Wrap with timeout safety valve
    const timedGate = Promise.race([
      gatePromise.catch(() => {}),
      new Promise(resolve => setTimeout(resolve, BRIDGE_GATE_TIMEOUT_MS))
    ]);
    this.preGates.set(segmentId, timedGate);
  }

  async queueRender(segmentId) {
    if (this.activeRenders >= this.maxConcurrent) {
      return new Promise(resolve => {
        this.renderQueue.push({
          segmentId,
          run: () => resolve(this.renderSegment(segmentId))
        });
      });
    }
    return this.renderSegment(segmentId);
  }

  /**
   * Dequeue the next segment to render, picking by pipeline position.
   * The segment closest to needing playback renders first.
   */
  _dequeue() {
    if (this.renderQueue.length === 0) return;
    if (this.activeRenders >= this.maxConcurrent) return;

    // Pick the queued segment that appears earliest in the pipeline
    const allSegments = this.pipelineStore.getAllSegments();
    const pipelineIndex = new Map();
    allSegments.forEach((seg, idx) => pipelineIndex.set(seg.id, idx));

    let bestIdx = -1;
    let bestPipelinePos = Infinity;
    for (let i = 0; i < this.renderQueue.length; i++) {
      const pos = pipelineIndex.get(this.renderQueue[i].segmentId);
      if (pos !== undefined && pos < bestPipelinePos) {
        bestPipelinePos = pos;
        bestIdx = i;
      }
    }

    // Fallback: if none found in pipeline (edge case), take first in queue
    if (bestIdx === -1) bestIdx = 0;

    const [next] = this.renderQueue.splice(bestIdx, 1);
    if (next && next.run) next.run();
  }

  cancelQueuedSegmentsByType(type, { keep = 0 } = {}) {
    let kept = 0;
    const remaining = [];
    const cancelled = [];

    for (const item of this.renderQueue) {
      const seg = this.pipelineStore.getSegment(item.segmentId);
      if (seg && seg.type === type) {
        if (kept < keep) {
          remaining.push(item);
          kept += 1;
        } else {
          cancelled.push(item.segmentId);
        }
      } else if (seg) {
        remaining.push(item);
      }
    }

    this.renderQueue = remaining;
    return cancelled;
  }

  /**
   * Phase 1: TTS all script lines, returns { audioItems, errors, renderDurations }
   */
  async _ttsSegment(segmentId) {
    const segment = this.pipelineStore.getSegment(segmentId);
    if (!segment) throw new Error(`Segment not found: ${segmentId}`);

    const errors = [];
    const renderDurations = [];
    const audioItems = [];

    for (let i = 0; i < segment.script.length; i++) {
      const line = segment.script[i];
      const speaker = String(line.speaker || '').toLowerCase();
      const voiceConfig = voices[speaker];

      if (!voiceConfig) {
        const errMsg = `Unknown speaker: ${speaker}`;
        console.warn(`[SegmentRenderer] ${errMsg}`);
        errors.push({ lineIndex: i, error: errMsg });
        renderDurations.push(0);
        continue;
      }

      let success = false;
      let lastError = null;
      let audioBuffer = null;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const ttsText = line.text
            .replace(/\$VVC/gi, 'VVC')
            .replace(/pump\.fun/gi, 'pump fun');

          const ttsResponse = await axios.post(
            `https://api.elevenlabs.io/v1/text-to-speech/${voiceConfig.elevenLabsVoiceId}`,
            {
              text: ttsText,
              model_id: voiceConfig.ttsModel || process.env.AUTO_TTS_MODEL || 'eleven_v3',
              voice_settings: voiceConfig.voiceSettings,
              ...(voiceConfig.speed != null && { speed: voiceConfig.speed })
            },
            {
              headers: {
                'Accept': 'audio/mpeg',
                'Content-Type': 'application/json',
                'xi-api-key': process.env.ELEVENLABS_API_KEY
              },
              responseType: 'arraybuffer',
              timeout: 30000
            }
          );

          audioBuffer = Buffer.from(ttsResponse.data);
          success = true;
          break;
        } catch (err) {
          let detail = err.message;
          if (err.response && err.response.data) {
            try {
              const body = Buffer.isBuffer(err.response.data)
                ? JSON.parse(err.response.data.toString())
                : err.response.data;
              detail = body?.detail?.message || body?.detail || body?.message || JSON.stringify(body);
            } catch (_) {}
            detail = `${err.response.status}: ${detail}`;
          }
          lastError = new Error(detail);
          console.warn(`[SegmentRenderer] line ${i} TTS attempt ${attempt} failed: ${detail}`);
          if (attempt < 3) await sleep(2000);
        }
      }

      if (success && audioBuffer) {
        audioItems.push({ speaker, text: line.text, audioBuffer });
        renderDurations.push(estimateLineDurationMs(line.text));
      } else {
        const errMsg = lastError ? lastError.message : 'Unknown error';
        errors.push({ lineIndex: i, error: errMsg });
        renderDurations.push(0);
      }

      const progress = (i + 1) / segment.script.length * 0.5;
      await this.pipelineStore.updateSegment(segmentId, {
        renderProgress: progress,
        renderDurations,
        metadata: this._mergeMetadata(segment, { renderErrors: errors.length > 0 ? errors : undefined })
      });
      if (this.eventEmitter) {
        this.eventEmitter.broadcast('segment:progress', { id: segmentId, progress });
      }
    }

    return { audioItems, errors, renderDurations };
  }

  /**
   * Phase 2: Push audio items to animation server /render endpoint
   */
  async _pushAudioItems(segmentId, audioItems, renderDurations) {
    const segment = this.pipelineStore.getSegment(segmentId);
    const segmentType = segment?.type || 'auto-convo';
    const isPriority = segment && (segment.type === 'chat-response' || segment.metadata?.priority === 'high');

    // Transition to 'ready' BEFORE pushing audio
    await this.pipelineStore.transitionStatus(segmentId, 'ready');
    if (this.eventEmitter) {
      this.eventEmitter.broadcast('pipeline:update', {
        segments: this.pipelineStore.getAllSegments(),
        bufferHealth: this.pipelineStore.getBufferHealth()
      });
    }

    for (let i = 0; i < audioItems.length; i++) {
      const item = audioItems[i];
      const form = new FormData();
      form.append('audio', item.audioBuffer, {
        filename: 'audio.mp3',
        contentType: 'audio/mpeg'
      });
      form.append('character', item.speaker);
      // Send the actual line text so expression/caption system works for all segment types
      form.append('message', item.text);
      form.append('mode', 'router');
      form.append('segmentId', segmentId);
      form.append('lineIndex', String(i));
      form.append('segmentType', segmentType);
      form.append('priority', isPriority ? 'high' : 'normal');

      const renderResult = await axios.post(
        `${this.animationServerUrl}/render`,
        form,
        { headers: form.getHeaders() }
      );

      if (renderResult.data && renderResult.data.duration) {
        renderDurations[i] = renderResult.data.duration * 1000;
      }

      const progress = 0.5 + ((i + 1) / audioItems.length * 0.5);
      await this.pipelineStore.updateSegment(segmentId, {
        renderProgress: progress,
        renderDurations
      });
      if (this.eventEmitter) {
        this.eventEmitter.broadcast('segment:progress', { id: segmentId, progress });
      }
    }
  }

  async renderSegment(segmentId) {
    const segment = this.pipelineStore.getSegment(segmentId);
    if (!segment) throw new Error(`Segment not found: ${segmentId}`);
    if (!Array.isArray(segment.script) || segment.script.length === 0) {
      throw new Error('Segment has no script');
    }

    if (!process.env.ELEVENLABS_API_KEY) {
      throw new Error('process.env.ELEVENLABS_API_KEY not configured');
    }

    if (segment.status !== 'forming') {
      throw new Error(`Segment must be in forming status to render (current: ${segment.status})`);
    }

    // Increment BEFORE any async work so the finally decrement always pairs correctly
    this.activeRenders += 1;
    this.inFlight.add(segmentId);
    this.activeTTS.add(segmentId);

    try {
      await this.pipelineStore.updateSegment(segmentId, {
        metadata: this._mergeMetadata(segment, { renderStartedAt: Date.now() })
      });
      // Phase 1: TTS all lines
      const { audioItems, renderDurations } = await this._ttsSegment(segmentId);

      if (audioItems.length === 0) {
        throw new Error('No audio generated for any line');
      }

      // Phase 2: Store result and drain in pipeline order
      await new Promise((resolve, reject) => {
        this.pendingPushes.set(segmentId, { audioItems, renderDurations, resolve, reject });
        this.activeTTS.delete(segmentId);
        this._drainInPipelineOrder();
      });

      console.log(`[SegmentRenderer] Segment ${segmentId} rendered (${audioItems.length} lines)`);
    } catch (err) {
      console.error(`[SegmentRenderer] Segment ${segmentId} failed: ${err.message}`);
      // Clean up pendingPushes if segment failed before drain could process it
      const pending = this.pendingPushes.get(segmentId);
      if (pending) {
        this.pendingPushes.delete(segmentId);
        pending.reject(err);
      }

      const seg = this.pipelineStore.getSegment(segmentId);
      const retryCount = seg?.metadata?.retryCount || 0;

      if (seg && retryCount < MAX_SEGMENT_RETRIES) {
        // Retry: reset to forming so it can be re-rendered after a delay
        console.warn(`[SegmentRenderer] Scheduling retry ${retryCount + 1}/${MAX_SEGMENT_RETRIES} for segment ${segmentId}`);
        try {
          await this.pipelineStore.updateSegment(segmentId, {
            renderProgress: 0,
            metadata: this._mergeMetadata(seg, {
              renderError: err.message,
              retryCount: retryCount + 1,
              lastRetryAt: Date.now()
            })
          });
        } catch (_) {}

        // Schedule retry after delay — don't block current flow
        setTimeout(() => {
          const check = this.pipelineStore.getSegment(segmentId);
          if (check && check.status === 'forming') {
            console.log(`[SegmentRenderer] Retrying segment ${segmentId} (attempt ${retryCount + 2})`);
            this.queueRender(segmentId).catch(retryErr => {
              console.error(`[SegmentRenderer] Retry failed for ${segmentId}: ${retryErr.message}`);
            });
          }
        }, RETRY_DELAY_MS * (retryCount + 1));

        if (this.eventEmitter) {
          this.eventEmitter.broadcast('pipeline:update', {
            segments: this.pipelineStore.getAllSegments(),
            bufferHealth: this.pipelineStore.getBufferHealth()
          });
        }
      } else if (seg) {
        // Exhausted retries — mark as permanently failed but keep in pipeline
        // so the drain can skip it (renderProgress: -1)
        console.error(`[SegmentRenderer] Segment ${segmentId} failed after ${retryCount + 1} attempts, marking failed`);
        try {
          await this.pipelineStore.updateSegment(segmentId, {
            renderProgress: -1,
            metadata: this._mergeMetadata(seg, {
              renderError: err.message,
              renderFailedAt: Date.now(),
              retryCount: retryCount + 1
            })
          });
        } catch (_) {}
        if (this.eventEmitter) {
          this.eventEmitter.broadcast('pipeline:update', {
            segments: this.pipelineStore.getAllSegments(),
            bufferHealth: this.pipelineStore.getBufferHealth()
          });
        }
      }
      throw err;
    } finally {
      this.activeRenders = Math.max(0, this.activeRenders - 1);
      this.inFlight.delete(segmentId);
      this.activeTTS.delete(segmentId);
      // A failed/finished segment may unblock the next one in pipeline order
      this._drainInPipelineOrder();
      this._dequeue();
    }

    return this.pipelineStore.getSegment(segmentId);
  }

  /**
   * Drain pendingPushes in pipeline order. Only pushes the next segment if it's
   * the earliest one in the pipeline that hasn't pushed yet. Waits if an earlier
   * segment is still TTS-ing.
   */
  _drainInPipelineOrder() {
    if (this._draining) return;
    this._draining = true;

    this.pushChain = this.pushChain.catch(() => {}).then(async () => {
      while (this.pendingPushes.size > 0) {
        const nextId = this._getNextPipelineSegment();
        if (!nextId) break; // next-in-order is still TTS-ing, wait

        const { audioItems, renderDurations, resolve, reject } = this.pendingPushes.get(nextId);
        this.pendingPushes.delete(nextId);

        try {
          const gate = this.preGates.get(nextId);
          if (gate) { this.preGates.delete(nextId); await gate; }
          await this._pushAudioItems(nextId, audioItems, renderDurations);
          resolve();
        } catch (err) {
          reject(err);
        }
      }
      this._draining = false;
    });
  }

  /**
   * Returns the segmentId that should push next based on pipeline order,
   * or null if we must wait (an earlier segment hasn't pushed yet).
   *
   * Blocks on ANY forming segment that hasn't failed — whether it's in
   * activeTTS, the renderQueue, or anywhere else.  Only skips forming
   * segments that already failed (renderProgress === -1).
   */
  _getNextPipelineSegment() {
    const allSegments = this.pipelineStore.getAllSegments();

    for (const seg of allSegments) {
      // Completed TTS and waiting to push — this is the one
      if (this.pendingPushes.has(seg.id)) return seg.id;

      // Any forming segment that hasn't failed blocks later pushes.
      // This covers: renderQueue (waiting for slot), activeTTS (mid-TTS),
      // and any other forming state we don't explicitly track.
      if (seg.status === 'forming' && seg.renderProgress !== -1) return null;
    }

    // Fallback: pending segments not in pipeline (edge case), push first available
    if (this.pendingPushes.size > 0) {
      return this.pendingPushes.keys().next().value;
    }
    return null;
  }

  /**
   * Render a bridge segment and resolve the gate for the target segment.
   * If anything fails, the gate resolves anyway so the target is never blocked.
   */
  async renderAndPushBridge(bridgeId, targetSegmentId) {
    let resolveGate;
    const gatePromise = new Promise(resolve => { resolveGate = resolve; });
    this.addPreGate(targetSegmentId, gatePromise);

    try {
      await this.renderSegment(bridgeId);
      resolveGate();
    } catch (err) {
      console.warn(`[SegmentRenderer] Bridge ${bridgeId} failed, unblocking target ${targetSegmentId}: ${err.message}`);
      // Discard failed bridge
      try {
        const seg = this.pipelineStore.getSegment(bridgeId);
        if (seg && seg.status === 'forming') {
          await this.pipelineStore.removeSegment(bridgeId);
        }
      } catch (_) {}
      resolveGate();
    }
  }

  async renderBridge(segmentId) {
    return this.renderSegment(segmentId);
  }

  _mergeMetadata(segment, updates) {
    const current = (segment && segment.metadata) ? segment.metadata : {};
    return { ...current, ...updates };
  }

  estimateSegmentDurationMs(segment) {
    if (!segment || !Array.isArray(segment.script)) return 0;
    if (Array.isArray(segment.renderDurations) && segment.renderDurations.length > 0) {
      return segment.renderDurations.reduce((sum, d) => sum + d, 0);
    }
    let total = 0;
    for (const line of segment.script) {
      total += estimateLineDurationMs(line.text || '');
    }
    return total;
  }
}

module.exports = SegmentRenderer;
