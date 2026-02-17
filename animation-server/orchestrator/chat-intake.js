const crypto = require('crypto');

class ChatIntakeAgent {
  constructor({ scriptGenerator, pipelineStore, segmentRenderer, eventEmitter, onChatMessage }) {
    this.scriptGenerator = scriptGenerator;
    this.pipelineStore = pipelineStore;
    this.segmentRenderer = segmentRenderer;
    this.eventEmitter = eventEmitter;
    this.onChatMessage = onChatMessage || null; // Callback for chat overlay: (username, text) => void

    this.inbox = [];
    this.autoApprove = false;
    this.queueSegmentWithBridge = null;
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

    // Push to stream chat overlay (fires regardless of auto-approve)
    if (this.onChatMessage) {
      this.onChatMessage(card.username, card.text);
    }

    if (this.eventEmitter) {
      this.eventEmitter.broadcast('chat:new-card', card);
    }

    if (this.autoApprove) {
      // Remove from inbox immediately so the director console doesn't show stale cards
      this.removeCard(card.id);
      if (this.eventEmitter) {
        this.eventEmitter.broadcast('chat:inbox-update', { inbox: this.getInbox() });
      }
      this._autoQueue(card).catch(err => {
        console.warn(`[ChatIntake] Auto queue failed: ${err.message}`);
      });
    }

    return card;
  }

  async _autoQueue(card) {
    let segment;

    // Narrator line reads the viewer's message before the character responds
    const narratorLine = { speaker: 'narrator', text: card.text };

    if (card.response) {
      // Pre-written response from router — prepend narrator + response
      const script = [narratorLine, { speaker: card.response.speaker, text: card.response.text }];
      segment = await this.pipelineStore.createSegment({
        type: 'chat-response',
        seed: card.text.substring(0, 50),
        script,
        estimatedDuration: Math.max(1, Math.ceil(card.response.text.split(/\s+/).length / 150 * 60) + 3)
      });
      // Generate a proper topic summary as exitContext (not a transcript)
      // Extract the topic/theme from the interaction for continuity
      const topicSummary = this._extractTopicSummary(card.text, card.response.text);
      await this.pipelineStore.updateSegment(segment.id, {
        exitContext: topicSummary
      });
    } else if (this.scriptGenerator) {
      // No pre-written response — expand via LLM, then prepend narrator
      segment = await this.scriptGenerator.expandChatMessage(card.text);
      if (segment && Array.isArray(segment.script)) {
        segment.script.unshift(narratorLine);
        await this.pipelineStore.updateSegment(segment.id, { script: segment.script });
      }
    }

    if (!segment) return;

    // Mark as chat source (keep metadata but don't prioritize in queue)
    try {
      await this.pipelineStore.updateSegment(segment.id, {
        metadata: { ...(segment.metadata || {}), source: 'chat' }
      });
    } catch (_) {}

    // Chat messages now queue in arrival order (no prioritization)

    // Cancel queued filler renders beyond 1 to avoid wasting credits
    if (this.segmentRenderer?.cancelQueuedSegmentsByType) {
      const cancelled = this.segmentRenderer.cancelQueuedSegmentsByType('filler', { keep: 1 });
      for (const id of cancelled) {
        try {
          await this.pipelineStore.removeSegment(id);
        } catch (_) {}
      }
    }

    if (this.eventEmitter) {
      this.eventEmitter.broadcast('pipeline:update', {
        segments: this.pipelineStore.getAllSegments(),
        bufferHealth: this.pipelineStore.getBufferHealth()
      });
    }

    const queueFn = this.queueSegmentWithBridge
      ? this.queueSegmentWithBridge
      : (id => this.segmentRenderer?.queueRender(id));

    if (queueFn) {
      Promise.resolve(queueFn(segment.id)).catch(err => {
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

  /**
   * Extract a topic summary from viewer message and response (not a transcript).
   * Generates simple topic descriptions like "discussed gaming habits" instead of
   * "Viewer said X and Y replied" to prevent old topics from resurfacing.
   */
  _extractTopicSummary(viewerMessage, responseText) {
    const msg = String(viewerMessage || '').toLowerCase().trim();
    const resp = String(responseText || '').toLowerCase().trim();

    // Greeting patterns → generic greeting topic
    if (msg.match(/^(hi|hello|hey|sup|yo|what'?s up)/)) {
      return 'casual greeting exchange';
    }

    // Love/affection → relationship topic
    if (msg.match(/love you|you'?re (my|the) (best|role model|favorite)/i)) {
      return 'viewer expressed affection or admiration';
    }

    // Questions about lifestyle/habits
    if (msg.match(/do you|are you|what do you|where do you|how do you/)) {
      if (resp.match(/party|parties|club|social/)) return 'discussed social life and going out';
      if (resp.match(/game|gaming|anime|screen/)) return 'discussed hobbies and entertainment';
      if (resp.match(/girl|relationship|date/)) return 'discussed dating and relationships';
      return 'viewer asked about lifestyle';
    }

    // Insults/criticism
    if (msg.match(/loser|lame|suck|stupid|dumb|pathetic/)) {
      return 'viewer made critical comment';
    }

    // Crypto/money topics
    if (msg.match(/pump|token|wallet|rug|dev|crypto|coin/)) {
      return 'discussed cryptocurrency and trading';
    }

    // Default: extract key nouns/topics if present
    const topics = [];
    if (msg.match(/party|parties|club/)) topics.push('parties');
    if (msg.match(/game|gaming/)) topics.push('gaming');
    if (msg.match(/anime/)) topics.push('anime');
    if (msg.match(/tattoo/)) topics.push('tattoos');
    if (msg.match(/girlfriend|relationship/)) topics.push('relationships');

    if (topics.length > 0) {
      return `discussed ${topics.join(' and ')}`;
    }

    // Fallback: generic interaction
    return 'viewer interaction';
  }
}

module.exports = ChatIntakeAgent;
