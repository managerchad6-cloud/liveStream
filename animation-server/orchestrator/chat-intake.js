const crypto = require('crypto');

class ChatIntakeAgent {
  constructor({ scriptGenerator, pipelineStore, segmentRenderer, eventEmitter }) {
    this.scriptGenerator = scriptGenerator;
    this.pipelineStore = pipelineStore;
    this.segmentRenderer = segmentRenderer;
    this.eventEmitter = eventEmitter;

    this.inbox = [];
    this.autoApprove = false;
    this.chatTransitions = [
      'Alright, let\'s check the chat.',
      'Let\'s see what the chat says.',
      'Quick chat check.',
      'Okay, chat time.'
    ];
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
      const transition = this._pickChatTransition(card.response.speaker);
      const script = [
        transition,
        { speaker: card.response.speaker, text: card.response.text }
      ].filter(Boolean);
      const totalText = script.map(line => line.text).join(' ');
      segment = await this.pipelineStore.createSegment({
        type: 'chat-response',
        seed: card.text.substring(0, 50),
        script,
        estimatedDuration: Math.max(1, Math.ceil(totalText.split(/\s+/).length / 150 * 60))
      });
    } else if (this.scriptGenerator) {
      // No pre-written response — expand via LLM
      segment = await this.scriptGenerator.expandChatMessage(card.text);
    }

    if (!segment) return;

    // Mark as high priority
    try {
      await this.pipelineStore.updateSegment(segment.id, {
        metadata: { ...(segment.metadata || {}), priority: 'high', source: 'chat' }
      });
    } catch (_) {}

    // Move chat responses right after the on-air segment (without splitting transitions)
    if (this.pipelineStore.prioritizeSegment) {
      try {
        await this.pipelineStore.prioritizeSegment(segment.id, {
          afterOnAir: true,
          avoidTransitionSplit: true
        });
      } catch (_) {}
    }

    // Cancel queued filler renders beyond 1 to avoid wasting credits
    if (this.segmentRenderer?.cancelQueuedSegmentsByType) {
      const cancelled = this.segmentRenderer.cancelQueuedSegmentsByType('filler', { keep: 1 });
      for (const id of cancelled) {
        try {
          await this.pipelineStore.removeSegment(id);
        } catch (_) {}
      }
    }

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

  _pickChatTransition(speaker) {
    const text = this.chatTransitions[Math.floor(Math.random() * this.chatTransitions.length)];
    if (!text) return null;
    return {
      speaker: String(speaker || 'chad').toLowerCase(),
      text
    };
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
