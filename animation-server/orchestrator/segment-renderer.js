const voices = require('../../voices');

const AUTO_TTS_MODEL = process.env.AUTO_TTS_MODEL || 'eleven_turbo_v2';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function estimateLineDurationMs(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  const minutes = words / 150;
  return Math.max(500, Math.round(minutes * 60 * 1000));
}

class SegmentRenderer {
  constructor({ pipelineStore, animationServerUrl, maxConcurrent = 2, eventEmitter }) {
    this.pipelineStore = pipelineStore;
    this.animationServerUrl = animationServerUrl || `http://127.0.0.1:${process.env.ANIMATION_PORT || 3003}`;
    this.maxConcurrent = maxConcurrent;
    this.eventEmitter = eventEmitter;
    this.activeRenders = 0;
    this.renderQueue = [];
  }

  async queueRender(segmentId) {
    if (this.activeRenders >= this.maxConcurrent) {
      return new Promise(resolve => {
        this.renderQueue.push(() => resolve(this.renderSegment(segmentId)));
      });
    }
    return this.renderSegment(segmentId);
  }

  _dequeue() {
    if (this.renderQueue.length === 0) return;
    if (this.activeRenders >= this.maxConcurrent) return;
    const next = this.renderQueue.shift();
    if (next) next();
  }

  async renderSegment(segmentId) {
    const segment = this.pipelineStore.getSegment(segmentId);
    if (!segment) throw new Error(`Segment not found: ${segmentId}`);
    if (!Array.isArray(segment.script) || segment.script.length === 0) {
      throw new Error('Segment has no script');
    }

    if (!ELEVENLABS_API_KEY) {
      throw new Error('ELEVENLABS_API_KEY not configured');
    }

    if (segment.status === 'draft') {
      await this.pipelineStore.transitionStatus(segmentId, 'forming');
    } else if (segment.status !== 'forming') {
      throw new Error(`Segment must be in draft/forming to render (current: ${segment.status})`);
    }

    this.activeRenders += 1;
    const errors = [];

    try {
      for (let i = 0; i < segment.script.length; i++) {
        const line = segment.script[i];
        const speaker = String(line.speaker || '').toLowerCase();
        const voiceConfig = voices[speaker];

        if (!voiceConfig) {
          const errMsg = `Unknown speaker: ${speaker}`;
          console.warn(`[SegmentRenderer] ${errMsg}`);
          errors.push({ lineIndex: i, error: errMsg });
          continue;
        }

        let success = false;
        let lastError = null;

        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const ttsResponse = await fetch(
              `https://api.elevenlabs.io/v1/text-to-speech/${voiceConfig.elevenLabsVoiceId}`,
              {
                method: 'POST',
                headers: {
                  'Accept': 'audio/mpeg',
                  'Content-Type': 'application/json',
                  'xi-api-key': ELEVENLABS_API_KEY
                },
                body: JSON.stringify({
                  text: line.text,
                  model_id: AUTO_TTS_MODEL,
                  voice_settings: voiceConfig.voiceSettings
                })
              }
            );

            if (!ttsResponse.ok) {
              throw new Error(`ElevenLabs TTS failed: ${ttsResponse.status} ${ttsResponse.statusText}`);
            }

            const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer());
            const form = new FormData();
            form.append('audio', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'audio.mp3');
            form.append('character', speaker);
            form.append('message', line.text);
            form.append('mode', 'router');

            const renderResponse = await fetch(`${this.animationServerUrl}/render`, {
              method: 'POST',
              body: form
            });

            if (!renderResponse.ok) {
              throw new Error(`Render failed: ${renderResponse.status} ${renderResponse.statusText}`);
            }

            success = true;
            break;
          } catch (err) {
            lastError = err;
            console.warn(`[SegmentRenderer] line ${i} attempt ${attempt} failed: ${err.message}`);
            await sleep(1000);
          }
        }

        if (!success) {
          const errMsg = lastError ? lastError.message : 'Unknown error';
          errors.push({ lineIndex: i, error: errMsg });
        }

        const progress = (i + 1) / segment.script.length;
        await this.pipelineStore.updateSegment(segmentId, {
          renderProgress: progress,
          metadata: this._mergeMetadata(segment, { renderErrors: errors })
        });
        if (this.eventEmitter) {
          this.eventEmitter.broadcast('segment:progress', { id: segmentId, progress });
        }
      }

      await this.pipelineStore.transitionStatus(segmentId, 'ready');
      if (this.eventEmitter) {
        this.eventEmitter.broadcast('pipeline:update', {
          segments: this.pipelineStore.getAllSegments(),
          bufferHealth: this.pipelineStore.getBufferHealth()
        });
      }
      console.log(`[SegmentRenderer] Segment ${segmentId} rendered (${segment.script.length} lines)`);
    } finally {
      this.activeRenders = Math.max(0, this.activeRenders - 1);
      this._dequeue();
    }

    return this.pipelineStore.getSegment(segmentId);
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
    let total = 0;
    for (const line of segment.script) {
      total += estimateLineDurationMs(line.text || '');
    }
    return total;
  }
}

module.exports = SegmentRenderer;
