const crypto = require('crypto');

class ChatIntakeAgent {
  constructor({ scriptGenerator, pipelineStore, segmentRenderer, eventEmitter }) {
    this.scriptGenerator = scriptGenerator;
    this.pipelineStore = pipelineStore;
    this.segmentRenderer = segmentRenderer;
    this.eventEmitter = eventEmitter;

    this.inbox = [];
    this.autoApprove = false;
  }

  start() {}
  stop() {}

  addMessage(username, text, response = null) {
    const card = {
      id: crypto.randomUUID(),
      username: username || 'anonymous',
      text: String(text || '').trim(),
      createdAt: new Date().toISOString()
    };

    // Attach pre-written response if provided (from router flow)
    if (response && response.speaker && response.text) {
      card.response = {
        speaker: response.speaker,
        text: response.text
      };
    }

    if (!card.text) return null;

    this.inbox.unshift(card);
    this.inbox = this.inbox.slice(0, 50);

    if (this.eventEmitter) {
      this.eventEmitter.broadcast('chat:new-card', card);
    }

    if (this.autoApprove) {
      this._autoQueue(card).catch(err => {
        console.warn(`[ChatIntake] Auto queue failed: ${err.message}`);
      });
    }

    return card;
  }

  async _autoQueue(card) {
    let segment;

    if (card.response) {
      // Pre-written response from router — create single-line segment directly
      const script = [{ speaker: card.response.speaker, text: card.response.text }];
      segment = await this.pipelineStore.createSegment({
        type: 'chat-response',
        seed: card.text.substring(0, 50),
        script,
        estimatedDuration: Math.max(1, Math.ceil(card.response.text.split(/\s+/).length / 150 * 60))
      });
    } else if (this.scriptGenerator) {
      // No pre-written response — expand via LLM
      segment = await this.scriptGenerator.expandChatMessage(card.text);
    }

    if (!segment) return;

    // Remove from inbox since it's been auto-queued
    this.removeCard(card.id);

    if (this.eventEmitter) {
      this.eventEmitter.broadcast('pipeline:update', {
        segments: this.pipelineStore.getAllSegments(),
        bufferHealth: this.pipelineStore.getBufferHealth()
      });
    }

    if (this.segmentRenderer) {
      this.segmentRenderer.queueRender(segment.id).catch(err => {
        console.warn(`[ChatIntake] Auto render failed: ${err.message}`);
      });
    }
  }

  getInbox() {
    return this.inbox.slice();
  }

  removeCard(id) {
    this.inbox = this.inbox.filter(c => c.id !== id);
  }

  clearInbox() {
    this.inbox = [];
  }

  getConfig() {
    return { autoApprove: this.autoApprove };
  }

  setAutoApprove(enabled) {
    this.autoApprove = Boolean(enabled);
  }

  setIntakeRate() {}
}

module.exports = ChatIntakeAgent;
