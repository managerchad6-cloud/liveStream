const crypto = require('crypto');

const DEFAULT_MODEL = process.env.SCRIPT_MODEL || process.env.EXPRESSION_MODEL || 'gpt-4o-mini';

function parseJson(content) {
  if (!content) return null;
  const clean = String(content).replace(/```json|```/gi, '').trim();
  try { return JSON.parse(clean); } catch (e) {}
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch (e) {}
  }
  return null;
}

class ChatIntakeAgent {
  constructor({ openai, scriptGenerator, pipelineStore, segmentRenderer, eventEmitter }) {
    this.openai = openai;
    this.scriptGenerator = scriptGenerator;
    this.pipelineStore = pipelineStore;
    this.segmentRenderer = segmentRenderer;
    this.eventEmitter = eventEmitter;

    this.messageWindow = [];
    this.inbox = [];
    this.intakeRate = 1;
    this.autoApprove = false;
    this.lastIntakeTime = 0;
    this.timer = null;
  }

  start(intervalMs = 1000) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.processIntake().catch(err => {
        console.warn(`[ChatIntake] Intake failed: ${err.message}`);
      });
    }, intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  addMessage(username, text, timestamp = Date.now()) {
    this.messageWindow.push({ username, text, timestamp });
    if (this.messageWindow.length > 50) {
      this.messageWindow = this.messageWindow.slice(-50);
    }
  }

  getInbox() {
    return this.inbox.slice();
  }

  getConfig() {
    return {
      intakeRate: this.intakeRate,
      autoApprove: this.autoApprove
    };
  }

  setIntakeRate(rate) {
    const value = Number(rate);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error('Invalid intake rate');
    }
    this.intakeRate = value;
  }

  setAutoApprove(enabled) {
    this.autoApprove = Boolean(enabled);
  }

  async processIntake() {
    if (!this.openai) return null;
    const now = Date.now();
    const minInterval = 60_000 / Math.max(1, this.intakeRate);
    if (now - this.lastIntakeTime < minInterval) return null;

    if (this.messageWindow.length === 0) return null;

    const prompt = `Select the most entertaining/interesting message from this chat window.
Prefer: open-ended questions, controversial takes, funny comments.
Avoid: yes/no questions, repeated topics, toxic content.

Messages:
${this.messageWindow.map(m => `- ${m.username}: ${m.text}`).join('\n')}

Output JSON: { "selected": { "username": "...", "text": "..." }, "reason": "..." }`;

    const completion = await this.openai.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        { role: 'system', content: 'You select a single chat message and return only JSON.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.4
    });

    const content = completion.choices?.[0]?.message?.content || '';
    const parsed = parseJson(content);
    if (!parsed || !parsed.selected || !parsed.selected.text) {
      throw new Error('Failed to parse intake JSON');
    }

    const card = {
      id: crypto.randomUUID(),
      username: parsed.selected.username || 'unknown',
      text: parsed.selected.text,
      reason: parsed.reason || null,
      createdAt: new Date().toISOString()
    };

    this.inbox.unshift(card);
    this.inbox = this.inbox.slice(0, 50);
    this.lastIntakeTime = now;

    if (this.eventEmitter) {
      this.eventEmitter.broadcast('chat:new-card', card);
    }

    if (this.autoApprove && this.scriptGenerator) {
      const segment = await this.scriptGenerator.expandChatMessage(card.text, {});
      await this.pipelineStore.transitionStatus(segment.id, 'forming');
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

    return card;
  }
}

module.exports = ChatIntakeAgent;
