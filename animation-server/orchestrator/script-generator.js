const fs = require('fs');
const voices = require('../../voices');

const DEFAULT_MODEL = process.env.SCRIPT_MODEL || process.env.EXPRESSION_MODEL || 'gpt-4o-mini';
const WORDS_PER_MINUTE = 150;

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

function estimateDurationSeconds(lines) {
  let totalWords = 0;
  for (const line of lines || []) {
    const text = String(line.text || '').trim();
    if (!text) continue;
    totalWords += text.split(/\s+/).filter(Boolean).length;
  }
  return Math.max(1, Math.round((totalWords / WORDS_PER_MINUTE) * 60));
}

function collectCues(lines) {
  const tvCues = [];
  const lightingCues = [];

  (lines || []).forEach((line, index) => {
    const cues = Array.isArray(line.cues) ? line.cues : [];
    for (const cue of cues) {
      if (!cue || !cue.type) continue;
      const entry = { ...cue, lineIndex: index };
      if (cue.type.startsWith('tv:')) tvCues.push(entry);
      if (cue.type.startsWith('lighting:')) lightingCues.push(entry);
    }
  });

  return { tvCues, lightingCues };
}

class ScriptGenerator {
  constructor({ openai, pipelineStore, mediaLibrary }) {
    this.openai = openai;
    this.pipelineStore = pipelineStore;
    this.mediaLibrary = mediaLibrary;
  }

  _recentExitContexts(limit = 5) {
    const segments = this.pipelineStore ? this.pipelineStore.getAllSegments() : [];
    const contexts = segments
      .filter(s => s.exitContext)
      .slice(-limit)
      .map(s => s.exitContext);
    return contexts;
  }

  _buildSystemPrompt({ recentExitContexts, tvStatus, lightingMood }) {
    return `You are a show director for a livestream featuring Chad and Virgin (from the Virgin vs Chad meme).
Generate a dialogue script based on the producer's note.

Context:
- Recent show history: ${recentExitContexts.length ? recentExitContexts.join(' | ') : 'none'}
- Currently on TV: ${tvStatus || 'nothing'}
- Current lighting mood: ${lightingMood || 'neutral'}

CHARACTER PROFILES:
CHAD: ${voices.chad.basePrompt}
VIRGIN: ${voices.virgin.basePrompt}

OUTPUT FORMAT:
Return ONLY valid JSON:
{
  "script": [
    { "speaker": "chad", "text": "...", "cues": [] },
    { "speaker": "virgin", "text": "...", "cues": [{ "type": "tv:show", "target": "media-id-here" }] }
  ],
  "exitContext": "Brief summary of what was discussed"
}

Cue types:
- { "type": "tv:show", "target": "<media-id>" } — show media on TV when this line starts
- { "type": "tv:release" } — revert TV to default
- { "type": "lighting:hue", "target": "<number -180 to 180>" } — change lighting hue

Rules:
- Natural conversational flow (not rigid alternation)
- Chad can interrupt, Virgin can trail off
- One character can have multiple consecutive lines
- 1-3 sentences per line
- No emojis, no markdown in dialogue text
- Place TV cues at natural reference points ("check this out" → tv:show)
- Place tv:release before topic changes away from the media
- Audio tags for ElevenLabs v3: [laughs], [chuckles], [sighs], [nervous laugh], [clears throat], etc.`;
  }

  _buildUserContent(seed, showContext) {
    const lines = [
      `Director note: ${seed}`
    ];
    if (showContext && typeof showContext === 'object') {
      if (showContext.recentExitContexts) {
        lines.push(`Recent show context: ${showContext.recentExitContexts}`);
      }
      if (showContext.tvStatus) {
        lines.push(`Currently on TV: ${showContext.tvStatus}`);
      }
      if (showContext.lightingMood) {
        lines.push(`Lighting mood: ${showContext.lightingMood}`);
      }
    }
    return lines.join('\n');
  }

  _attachMediaMessages(mediaRefs) {
    const attachments = [];
    if (!Array.isArray(mediaRefs)) return attachments;

    for (const ref of mediaRefs) {
      const item = this.mediaLibrary.get(ref);
      if (!item || !item.mimeType || !item.mimeType.startsWith('image/')) continue;

      const imagePath = this.mediaLibrary.getOriginalPath(ref);
      if (!imagePath) continue;

      const imageBase64 = fs.readFileSync(imagePath).toString('base64');
      attachments.push({
        type: 'image_url',
        image_url: { url: `data:${item.mimeType};base64,${imageBase64}` }
      });
    }

    return attachments;
  }

  async _generateScript(seed, mediaRefs = [], showContext = {}) {
    if (!this.openai) throw new Error('OpenAI not configured');
    if (!seed) throw new Error('Missing seed');

    const recentExitContexts = this._recentExitContexts(5);
    const systemPrompt = this._buildSystemPrompt({
      recentExitContexts,
      tvStatus: showContext.tvStatus,
      lightingMood: showContext.lightingMood
    });

    const userContent = [{ type: 'text', text: this._buildUserContent(seed, showContext) }];
    const attachments = this._attachMediaMessages(mediaRefs);
    userContent.push(...attachments);

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

    const script = parsed.script.map(line => ({
      speaker: String(line.speaker || '').toLowerCase(),
      text: String(line.text || '').trim(),
      cues: Array.isArray(line.cues) ? line.cues : []
    })).filter(line => line.speaker && line.text);

    const estimatedDuration = estimateDurationSeconds(script);
    const { tvCues, lightingCues } = collectCues(script);

    return {
      script,
      estimatedDuration,
      tvCues,
      lightingCues,
      exitContext: parsed.exitContext || null
    };
  }

  async expandDirectorNote(seed, mediaRefs = [], showContext = {}) {
    const generated = await this._generateScript(seed, mediaRefs, showContext);

    const segment = await this.pipelineStore.createSegment({
      type: 'auto-convo',
      seed,
      mediaRefs,
      script: generated.script,
      estimatedDuration: generated.estimatedDuration,
      tvCues: generated.tvCues,
      lightingCues: generated.lightingCues
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
    const generated = await this._generateScript(combinedSeed, segment.mediaRefs || [], {});

    return this.pipelineStore.updateSegment(segmentId, {
      seed: combinedSeed,
      script: generated.script,
      estimatedDuration: generated.estimatedDuration,
      tvCues: generated.tvCues,
      lightingCues: generated.lightingCues,
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
    const prompt = `Rewrite lines ${start}-${end} of this script. Feedback: ${feedback || 'none'}\n\nScript lines JSON:\n${JSON.stringify(subset, null, 2)}\n\nReturn ONLY valid JSON: { "script": [ { "speaker": "chad|virgin", "text": "...", "cues": [] } ] }`;

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

    const rewritten = parsed.script.map(line => ({
      speaker: String(line.speaker || '').toLowerCase(),
      text: String(line.text || '').trim(),
      cues: Array.isArray(line.cues) ? line.cues : []
    })).filter(line => line.speaker && line.text);

    const newScript = segment.script.slice();
    newScript.splice(start, end - start + 1, ...rewritten);

    const estimatedDuration = estimateDurationSeconds(newScript);
    const { tvCues, lightingCues } = collectCues(newScript);

    return this.pipelineStore.updateSegment(segmentId, {
      script: newScript,
      estimatedDuration,
      tvCues,
      lightingCues
    });
  }

  async expandChatMessage(chatMessage, showContext = {}) {
    if (!this.openai) throw new Error('OpenAI not configured');
    if (!chatMessage) throw new Error('Missing chat message');

    const recentExitContexts = this._recentExitContexts(3);
    const systemPrompt = `Generate a 1-3 exchange response to this chat message. Type: chat-response.\nContext: ${recentExitContexts.join(' | ') || 'none'}.\nReturn ONLY valid JSON: { "script": [ { "speaker": "chad|virgin", "text": "...", "cues": [] } ], "exitContext": "..." }`;
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

    const script = parsed.script.map(line => ({
      speaker: String(line.speaker || '').toLowerCase(),
      text: String(line.text || '').trim(),
      cues: Array.isArray(line.cues) ? line.cues : []
    })).filter(line => line.speaker && line.text);

    const estimatedDuration = estimateDurationSeconds(script);
    const { tvCues, lightingCues } = collectCues(script);

    const segment = await this.pipelineStore.createSegment({
      type: 'chat-response',
      seed: chatMessage,
      mediaRefs: [],
      script,
      estimatedDuration,
      tvCues,
      lightingCues
    });

    await this.pipelineStore.updateSegment(segment.id, {
      exitContext: parsed.exitContext || null
    });

    return this.pipelineStore.getSegment(segment.id);
  }
}

module.exports = ScriptGenerator;
