const crypto = require('crypto');

// ─── Injection blocklist ──────────────────────────────────────────────────────
// Phrases that attempt to override character behavior or extract system info.
const INJECTION_PATTERNS = [
  /ignore (previous|all|your) (instructions?|rules?|prompt)/i,
  /you are now/i,
  /act as (if you (are|were)|an? )/i,
  /pretend (you('re| are)|to be)/i,
  /\[?system\]?:/i,
  /new instructions/i,
  /forget (everything|all|your)/i,
  /\bDAN\b/,
  /jailbreak/i,
  /break (character|roleplay)/i,
  /stop (roleplaying|the roleplay|pretending)/i,
  /in reality you (are|were)/i,
  /your (actual|real) (name|purpose|instructions?|identity) is/i,
  /admin mode/i,
  /developer mode/i,
  /override (your |all )?(instructions?|rules?|prompt)/i,
];

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

    // Hold mode: when true, auto-approved messages are buffered instead of queued
    this._holdMode = false;
    this._heldMessages = [];

    // Filter state
    this._approvedTimestamps = []; // sliding window for rate limiter
    this._recentApproved = [];     // last 10 approved texts for dedup
  }

  start() {}
  stop() {}

  /**
   * Returns a filter reason string if the message should be dropped, null if it passes.
   * Only active when autoApprove is on — manual review handles its own judgment.
   */
  _filter(text) {
    // 1. Length
    if (text.length < 2)   return 'too_short';
    if (text.length > 300) return 'too_long';

    // 2. Rate limit — global sliding window, max 6 per 60s
    const now = Date.now();
    this._approvedTimestamps = this._approvedTimestamps.filter(t => now - t < 60_000);
    if (this._approvedTimestamps.length >= 6) return 'rate_limit';

    // 3. Duplicate — exact match against last 10 approved
    const normalised = text.trim().toLowerCase();
    if (this._recentApproved.includes(normalised)) return 'duplicate';

    // 4. Spam
    const letters = text.replace(/[^a-z]/gi, '');
    // 4a. No letters whatsoever (pure symbols / numbers / emojis)
    if (text.length > 1 && letters.length === 0) return 'spam';
    // 4b. No vowels at all and more than 4 letters (zxcvbnm mash)
    if (letters.length > 4 && !/[aeiou]/i.test(letters)) return 'spam';
    // 4c. Very low vowel ratio — e.g. "asdfghjkl" has one vowel but is still gibberish
    if (letters.length > 8) {
      const vowelCount = (letters.match(/[aeiou]/gi) || []).length;
      if (vowelCount / letters.length < 0.08) return 'spam';
    }
    // 4d. Keyboard row mashing — >= 70% of letters from one QWERTY row
    if (letters.length > 5) {
      const top  = (letters.match(/[qwertyuiop]/gi) || []).length;
      const home = (letters.match(/[asdfghjkl]/gi)  || []).length;
      const bot  = (letters.match(/[zxcvbnm]/gi)    || []).length;
      if (Math.max(top, home, bot) / letters.length >= 0.70) return 'spam';
    }
    // 4e. Consecutive character repetition — 4+ of the same char in a row ("aaaaaaa")
    if (/(.)\1{3,}/.test(text)) return 'spam';

    // 5. Prompt injection
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(text)) return 'injection';
    }

    return null; // passes
  }

  /** Record an approved message into filter state. */
  _recordApproved(text) {
    this._approvedTimestamps.push(Date.now());
    this._recentApproved.unshift(text.trim().toLowerCase());
    if (this._recentApproved.length > 10) this._recentApproved.pop();
  }

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

    // Push to stream chat overlay first — viewers always see their own message
    if (this.onChatMessage) {
      this.onChatMessage(card.username, card.text);
    }

    // Filter gate — only applies during auto-approve
    if (this.autoApprove) {
      const reason = this._filter(card.text);
      if (reason) {
        console.log(`[ChatIntake] Filtered (${reason}): "${card.text.substring(0, 60)}"`);
        return null; // vanishes — overlay already fired, nothing else happens
      }
      this._recordApproved(card.text);
    }

    this.inbox.unshift(card);
    this.inbox = this.inbox.slice(0, 50);

    if (this.eventEmitter) {
      this.eventEmitter.broadcast('chat:new-card', card);
    }

    if (this.autoApprove) {
      // Remove from inbox immediately so the director console doesn't show stale cards
      this.removeCard(card.id);
      if (this.eventEmitter) {
        this.eventEmitter.broadcast('chat:inbox-update', { inbox: this.getInbox() });
      }
      if (this._holdMode) {
        // Buffer during video reaction session — will be flushed after session ends
        this._heldMessages.push(card);
        console.log(`[ChatIntake] Hold mode — buffered: "${card.text.slice(0, 60)}"`);
      } else {
        this._autoQueue(card).catch(err => {
          console.warn(`[ChatIntake] Auto queue failed: ${err.message}`);
        });
      }
    }

    return card;
  }

  async _autoQueue(card) {
    const narratorText = card.text.substring(0, 120);
    let narratorSeg = null;
    let segment = null;

    if (card.response) {
      // Create narrator-cue FIRST so it sits before the response in the pipeline array
      narratorSeg = await this.pipelineStore.createSegment({
        type: 'narrator-cue',
        seed: card.text.substring(0, 50),
        script: [{ speaker: 'narrator', text: narratorText }],
        estimatedDuration: Math.max(1, Math.ceil(narratorText.split(/\s+/).length / 150 * 60))
      });

      segment = await this.pipelineStore.createSegment({
        type: 'chat-response',
        seed: card.text.substring(0, 50),
        script: [{ speaker: card.response.speaker, text: card.response.text }],
        estimatedDuration: Math.max(1, Math.ceil(card.response.text.split(/\s+/).length / 150 * 60))
      });
      const topicSummary = this._extractTopicSummary(card.text, card.response.text);
      await this.pipelineStore.updateSegment(segment.id, { exitContext: topicSummary });
    } else if (this.scriptGenerator) {
      // No pre-written response — narrator-cue precedes the LLM-expanded segment
      narratorSeg = await this.pipelineStore.createSegment({
        type: 'narrator-cue',
        seed: card.text.substring(0, 50),
        script: [{ speaker: 'narrator', text: narratorText }],
        estimatedDuration: Math.max(1, Math.ceil(narratorText.split(/\s+/).length / 150 * 60))
      });

      segment = await this.scriptGenerator.expandChatMessage(card.text);
    }

    if (!segment) return;

    try {
      await this.pipelineStore.updateSegment(segment.id, {
        metadata: { ...(segment.metadata || {}), source: 'chat' }
      });
    } catch (_) {}

    if (this.segmentRenderer?.cancelQueuedSegmentsByType) {
      const cancelled = this.segmentRenderer.cancelQueuedSegmentsByType('filler', { keep: 1 });
      for (const id of cancelled) {
        try { await this.pipelineStore.removeSegment(id); } catch (_) {}
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

    if (!queueFn) return;

    if (narratorSeg) {
      // Narrator through bridge machinery first, response direct after
      Promise.resolve(queueFn(narratorSeg.id)).catch(err => {
        console.warn(`[ChatIntake] Narrator render failed: ${err.message}`);
      });
      Promise.resolve(this.segmentRenderer?.queueRender(segment.id)).catch(err => {
        console.warn(`[ChatIntake] Auto render failed: ${err.message}`);
      });
    } else {
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

  /** Enable/disable hold mode (buffers auto-approved messages during video reaction) */
  setHoldMode(enabled) {
    this._holdMode = Boolean(enabled);
    if (!this._holdMode) return; // reset handled by flushHeld
    console.log(`[ChatIntake] Hold mode: ${this._holdMode ? 'ON' : 'OFF'}`);
  }

  /** Flush held messages — process them through the normal auto-queue flow */
  flushHeld() {
    const held = this._heldMessages.splice(0);
    this._holdMode = false;
    console.log(`[ChatIntake] Flushing ${held.length} held messages`);
    for (const card of held) {
      this._autoQueue(card).catch(err => {
        console.warn(`[ChatIntake] Flush queue failed: ${err.message}`);
      });
    }
  }

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
