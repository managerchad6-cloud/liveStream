const voices = require('../../voices');
const { parseJson, estimateDurationSeconds } = require('./utils');

const DEFAULT_MODEL = process.env.SCRIPT_MODEL || 'gpt-4o';

class ScriptGenerator {
  constructor({ openai, pipelineStore }) {
    this.openai = openai;
    this.pipelineStore = pipelineStore;
  }

  _recentExitContexts(limit = 5) {
    const segments = this.pipelineStore ? this.pipelineStore.getAllSegments() : [];
    const contexts = segments
      .filter(s => s.exitContext && s.status === 'aired')
      .slice(-limit)
      .map(s => s.exitContext);
    return contexts;
  }

  _buildSystemPrompt({ recentExitContexts }) {
    return `You are a show director for a livestream featuring Chad and Virgin (from the Virgin vs Chad meme).
Generate a dialogue script based on the producer's note.

Context:
- Recent show history: ${recentExitContexts.length ? recentExitContexts.join(' | ') : 'none'}

CHARACTER PROFILES:
CHAD: ${voices.chad.basePrompt}
VIRGIN: ${voices.virgin.basePrompt}

OUTPUT FORMAT:
Return ONLY valid JSON:
{
  "script": [
    { "speaker": "chad", "text": "..." },
    { "speaker": "virgin", "text": "..." }
  ],
  "exitContext": "Brief summary of what was discussed"
}

Rules:
- Natural conversational flow (not rigid alternation)
- Chad can interrupt, Virgin can trail off
- One character can have multiple consecutive lines
- 1-3 sentences per line
- No emojis, no markdown in dialogue text
- Audio tags for ElevenLabs v3: [laughs], [chuckles], [sighs], [nervous laugh], [clears throat], etc.`;
  }

  _buildUserContent(seed) {
    return `Director note: ${seed}`;
  }

  _normalizeScript(lines) {
    return (lines || []).map(line => ({
      speaker: String(line.speaker || '').toLowerCase(),
      text: String(line.text || '').trim()
    })).filter(line => line.speaker && line.text);
  }

  async _generateScript(seed) {
    if (!this.openai) throw new Error('OpenAI not configured');
    if (!seed) throw new Error('Missing seed');

    const recentExitContexts = this._recentExitContexts(5);
    const systemPrompt = this._buildSystemPrompt({ recentExitContexts });
    const userContent = this._buildUserContent(seed);

    const completion = await this.openai.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      temperature: 0.7
    });

    const content = completion.choices?.[0]?.message?.content || '';
    const parsed = parseJson(content);
    if (!parsed || !Array.isArray(parsed.script)) {
      throw new Error('Failed to parse script JSON');
    }

    const script = this._normalizeScript(parsed.script);
    const estimatedDuration = estimateDurationSeconds(script);

    return {
      script,
      estimatedDuration,
      exitContext: parsed.exitContext || null
    };
  }

  async expandDirectorNote(seed) {
    const generated = await this._generateScript(seed);

    const segment = await this.pipelineStore.createSegment({
      type: 'auto-convo',
      seed,
      script: generated.script,
      estimatedDuration: generated.estimatedDuration
    });

    await this.pipelineStore.updateSegment(segment.id, {
      exitContext: generated.exitContext
    });

    return this.pipelineStore.getSegment(segment.id);
  }

  async regenerateScript(segmentId, feedback) {
    const segment = this.pipelineStore.getSegment(segmentId);
    if (!segment) throw new Error(`Segment not found: ${segmentId}`);

    const seed = segment.seed || '';
    const combinedSeed = feedback ? `${seed}\nFeedback: ${feedback}` : seed;
    const generated = await this._generateScript(combinedSeed);

    return this.pipelineStore.updateSegment(segmentId, {
      seed: combinedSeed,
      script: generated.script,
      estimatedDuration: generated.estimatedDuration,
      exitContext: generated.exitContext
    });
  }

  _normalizeRange(startLine, endLine, scriptLength) {
    const s = Number(startLine);
    const e = Number(endLine);
    if (!Number.isFinite(s) || !Number.isFinite(e)) {
      throw new Error('Invalid range');
    }
    if (s < 0 || e < 0) {
      throw new Error('Invalid range');
    }

    if (s >= 1 && e >= 1 && e <= scriptLength && s <= scriptLength) {
      return { start: s - 1, end: e - 1 };
    }

    return { start: s, end: e };
  }

  async regeneratePartial(segmentId, startLine, endLine, feedback) {
    const segment = this.pipelineStore.getSegment(segmentId);
    if (!segment) throw new Error(`Segment not found: ${segmentId}`);
    if (!Array.isArray(segment.script) || segment.script.length === 0) {
      throw new Error('Segment has no script');
    }

    const { start, end } = this._normalizeRange(startLine, endLine, segment.script.length);
    if (start > end || end >= segment.script.length) {
      throw new Error('Invalid range');
    }

    const subset = segment.script.slice(start, end + 1);
    const prompt = `Rewrite lines ${start}-${end} of this script. Feedback: ${feedback || 'none'}\n\nScript lines JSON:\n${JSON.stringify(subset, null, 2)}\n\nReturn ONLY valid JSON: { "script": [ { "speaker": "chad|virgin", "text": "..." } ] }`;

    const completion = await this.openai.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        { role: 'system', content: 'You rewrite dialogue lines and return only JSON.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7
    });

    const content = completion.choices?.[0]?.message?.content || '';
    const parsed = parseJson(content);
    if (!parsed || !Array.isArray(parsed.script)) {
      throw new Error('Failed to parse partial script JSON');
    }

    const rewritten = this._normalizeScript(parsed.script);
    const newScript = segment.script.slice();
    newScript.splice(start, end - start + 1, ...rewritten);

    const estimatedDuration = estimateDurationSeconds(newScript);

    return this.pipelineStore.updateSegment(segmentId, {
      script: newScript,
      estimatedDuration
    });
  }

  async expandChatMessage(chatMessage, showContext = {}) {
    if (!this.openai) throw new Error('OpenAI not configured');
    if (!chatMessage) throw new Error('Missing chat message');

    const recentExitContexts = this._recentExitContexts(3);
    const systemPrompt = `Generate a 2-4 line response to this chat message. Type: chat-response.\n` +
      `Requirements:\n` +
      `- First line is a short chat transition (e.g., "Let's check the chat.")\n` +
      `- Next 1-2 lines answer the message naturally\n` +
      `- Optional final line that hands back to the ongoing convo (short)\n` +
      `Context: ${recentExitContexts.join(' | ') || 'none'}.\n` +
      `Return ONLY valid JSON: { "script": [ { "speaker": "chad|virgin", "text": "..." } ], "exitContext": "..." }`;
    const userPrompt = `Chat message: "${chatMessage}"`;

    const completion = await this.openai.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7
    });

    const content = completion.choices?.[0]?.message?.content || '';
    const parsed = parseJson(content);
    if (!parsed || !Array.isArray(parsed.script)) {
      throw new Error('Failed to parse chat script JSON');
    }

    const script = this._normalizeScript(parsed.script);
    const estimatedDuration = estimateDurationSeconds(script);

    const segment = await this.pipelineStore.createSegment({
      type: 'chat-response',
      seed: chatMessage,
      script,
      estimatedDuration
    });

    await this.pipelineStore.updateSegment(segment.id, {
      exitContext: parsed.exitContext || null
    });

    return this.pipelineStore.getSegment(segment.id);
  }
}

module.exports = ScriptGenerator;
