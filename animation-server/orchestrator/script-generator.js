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
- Generate exactly 1 dialogue turn (line) total
- Natural conversational flow (not rigid alternation)
- Chad can interrupt, Virgin can trail off
- One character can have multiple consecutive lines
- 1-3 sentences per line
- No emojis, no markdown in dialogue text
- Audio tags for ElevenLabs v3: [laughs], [chuckles], [sighs], [nervous laugh], [clears throat], etc.
- CRITICAL: Chad must NEVER give advice, encouragement, or act like a life coach. No "just wing it", "fake it till you make it", "you gotta", "try X sometime", "you do you". He ROASTS, brags, or dismisses — never helps.
- CRITICAL: Virgin must NEVER agree with Chad or accept his frame. No "I guess", "easier said than done", "if only". He gets defensive, counters with niche facts, or changes the subject.
- CRITICAL: Chad must NEVER repeat or paraphrase something he already said. Each line must be fresh content.
- The exitContext must be a brief TOPIC SUMMARY (e.g. "discussed parties and going out"), NOT a transcript of what was said`;
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
    // Create segment first to reserve position in pipeline
    const segment = await this.pipelineStore.createSegment({
      type: 'auto-convo',
      seed,
      script: [], // Placeholder
      estimatedDuration: 0
    });

    try {
      const generated = await this._generateScript(seed);

      await this.pipelineStore.updateSegment(segment.id, {
        script: generated.script,
        estimatedDuration: generated.estimatedDuration,
        exitContext: generated.exitContext
      });

      return this.pipelineStore.getSegment(segment.id);
    } catch (err) {
      // Delete placeholder segment if generation fails
      try {
        await this.pipelineStore.removeSegment(segment.id);
      } catch (_) {}
      throw err;
    }
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

  /**
   * Continue an ongoing conversation naturally. Collects full dialogue history
   * from recent aired/ready segments and generates 1 more turn.
   *
   * IMPORTANT: Creates the segment FIRST to reserve its position in the pipeline,
   * then generates the script. This prevents race conditions where chat messages
   * arriving during generation end up earlier in the queue.
   */
  async expandConversation({ isFirstExpand = false, wrapUp = false } = {}) {
    if (!this.openai) throw new Error('OpenAI not configured');

    // Collect conversation history from recent segments
    const segments = this.pipelineStore ? this.pipelineStore.getAllSegments() : [];
    const recentSegments = segments
      .filter(s => ['aired', 'ready'].includes(s.status) && Array.isArray(s.script))
      .slice(-6);

    if (recentSegments.length === 0) return null;

    // Build chat-style message history from all recent scripts
    const conversationLines = [];
    for (const seg of recentSegments) {
      for (const line of seg.script) {
        if (line.speaker === 'narrator') continue;
        conversationLines.push({ speaker: line.speaker, text: line.text });
      }
    }

    if (conversationLines.length === 0) return null;

    // Create segment immediately to reserve position in pipeline
    const segment = await this.pipelineStore.createSegment({
      type: 'expand',
      seed: null,
      script: [], // Placeholder, will be filled after generation
      estimatedDuration: 0
    });

    const historyText = conversationLines
      .map(l => `${l.speaker}: ${l.text}`)
      .join('\n');

    try {
      // Build JSON response format — first expand includes maxExpands
      let jsonFormat = '{ "script": [ { "speaker": "chad|virgin", "text": "..." } ], "exitContext": "brief topic summary"';
      if (isFirstExpand) {
        jsonFormat += ', "maxExpands": <number>';
      }
      jsonFormat += ' }';

      let maxExpandsClause = '';
      if (isFirstExpand) {
        maxExpandsClause = '\n\n"maxExpands" — how many total follow-up lines this topic deserves (0-5). Most conversations should be SHORT. Greetings like "hi", "what\'s up", "hey guys" = 0. Simple questions or generic comments = 0-1. A topic with mild debate potential = 2. A genuinely heated argument or deep lore discussion = 3-5. Default to 0 or 1 unless the topic is truly compelling. Silence is fine — don\'t force conversation.';
      }

      let wrapUpClause = '';
      if (wrapUp) {
        wrapUpClause = '\n\nIMPORTANT: This is the FINAL line on this topic. Wrap up naturally — make a closing remark, a dismissive sign-off, or a natural conversation-ender. Do NOT open new threads or ask questions.';
      }

      // Build as actual chat messages so the LLM naturally predicts the next lines
      const messages = [
        { role: 'system', content: `Livestream conversation between Chad and Virgin. Continue naturally.\n\nCHAD: ${voices.chad.basePrompt}\nVIRGIN: ${voices.virgin.basePrompt}\n\nCRITICAL RULES:\n- Chad must NEVER give advice, encouragement, or life coaching. No "just be yourself", "fake it till you make it", "just wing it", "you gotta", "try X sometime". Instead Chad ROASTS Virgin, brags about himself, or dismisses what Virgin said entirely.\n- Chad must NEVER say "no worries", "you'll get there", "everyone starts somewhere", "you do you", "if that's your thing", or offer comfort/reassurance of any kind.\n- Virgin must NEVER just agree with Chad or accept his frame. No "I guess", "I guess you're right", "easier said than done", "if only". Instead Virgin gets DEFENSIVE about his niche interests, fires back with an obscure fact, or changes the subject to something he knows about.\n- Do NOT repeat the dynamic of Chad giving advice and Virgin accepting it. Instead: argue, roast, one-up, tangent, or disagree.\n- Each continuation must introduce a NEW detail, opinion, or mini-topic — never just rephrase what was already said.\n\nRespond with ONLY JSON: ${jsonFormat}\nExactly 1 line. No emojis, no markdown. Audio tags allowed: [laughs], [chuckles], [sighs], [nervous laugh], etc.${maxExpandsClause}${wrapUpClause}` }
      ];

      // Feed conversation history as assistant messages so LLM sees it as its own output
      for (const line of conversationLines) {
        messages.push({ role: 'assistant', content: `${line.speaker}: ${line.text}` });
      }

      messages.push({ role: 'user', content: wrapUp ? 'Wrap it up.' : 'Continue.' });

      let completion = await this.openai.chat.completions.create({
        model: DEFAULT_MODEL,
        messages,
        temperature: 0.8,
        max_tokens: 250
      });

      let content = completion.choices?.[0]?.message?.content || '';
      let parsed = parseJson(content);

      // Retry once if parsing fails
      if (!parsed || !Array.isArray(parsed.script)) {
        console.warn('[ScriptGenerator] First expand attempt failed, retrying with explicit JSON format');
        console.warn('[ScriptGenerator] First response:', content.substring(0, 300));

        // Retry with a more explicit JSON-focused prompt
        const retryMessages = [
          { role: 'system', content: `Continue this conversation with exactly 1 line. Return ONLY valid JSON with this exact structure:\n{\n  "script": [\n    { "speaker": "chad|virgin", "text": "..." }\n  ]\n}\n\nNo markdown, no code blocks, no explanation - ONLY the JSON object.${wrapUp ? ' This is the FINAL line — wrap up the topic naturally.' : ''}` },
          { role: 'user', content: `Recent conversation:\n${historyText.slice(-500)}\n\nContinue naturally:` }
        ];

        completion = await this.openai.chat.completions.create({
          model: DEFAULT_MODEL,
          messages: retryMessages,
          temperature: 0.7,
          max_tokens: 250
        });

        content = completion.choices?.[0]?.message?.content || '';
        parsed = parseJson(content);
      }

      if (!parsed || !Array.isArray(parsed.script)) {
        console.error('[ScriptGenerator] Expand generation failed after retry - invalid JSON');
        console.error('[ScriptGenerator] Raw LLM response:', content.substring(0, 500));
        console.error('[ScriptGenerator] Parsed result:', parsed);
        throw new Error('Failed to parse expand script JSON');
      }

      const script = this._normalizeScript(parsed.script);
      const estimatedDuration = estimateDurationSeconds(script);

      const updateData = {
        script,
        estimatedDuration,
        exitContext: parsed.exitContext || null
      };

      // Store maxExpands from first expand's LLM response
      if (isFirstExpand && typeof parsed.maxExpands === 'number') {
        updateData.metadata = { ...(segment.metadata || {}), maxExpands: Math.max(0, Math.min(5, Math.round(parsed.maxExpands))) };
      }

      await this.pipelineStore.updateSegment(segment.id, updateData);

      return this.pipelineStore.getSegment(segment.id);
    } catch (err) {
      // Clean up placeholder segment on ANY failure (LLM error, parse error, etc.)
      console.error(`[ScriptGenerator] expandConversation failed, removing placeholder ${segment.id}: ${err.message}`);
      try {
        await this.pipelineStore.removeSegment(segment.id);
      } catch (_) {}
      throw err;
    }
  }

  async expandChatMessage(chatMessage, showContext = {}) {
    if (!this.openai) throw new Error('OpenAI not configured');
    if (!chatMessage) throw new Error('Missing chat message');

    // Create segment first to reserve position in pipeline
    const segment = await this.pipelineStore.createSegment({
      type: 'chat-response',
      seed: chatMessage,
      script: [], // Placeholder
      estimatedDuration: 0
    });

    try {
      const recentExitContexts = this._recentExitContexts(3);
      const systemPrompt = `Generate a 1-3 line response to this chat message. Type: chat-response.\n` +
        `Context: ${recentExitContexts.join(' | ') || 'none'}.\n` +
        `\nCHAD: ${voices.chad.basePrompt}\nVIRGIN: ${voices.virgin.basePrompt}\n` +
        `\nCRITICAL RULES:\n` +
        `- Chad must NEVER give advice, encouragement, or life coaching. No "just be yourself", "fake it till you make it", "just wing it", "you gotta", "try X sometime". Instead Chad ROASTS, brags, or dismisses.\n` +
        `- Chad must NEVER say "no worries", "you'll get there", "everyone starts somewhere", "you do you", "if that's your thing", or offer comfort/reassurance.\n` +
        `- Virgin must NEVER just agree with Chad or accept his frame. No "I guess", "I guess you're right", "easier said than done", "if only". Instead he gets DEFENSIVE, fires back with a niche fact, or changes the subject.\n` +
        `- Each line must introduce a NEW detail, opinion, or mini-topic — never just rephrase what was already said.\n` +
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

      await this.pipelineStore.updateSegment(segment.id, {
        script,
        estimatedDuration,
        exitContext: parsed.exitContext || null
      });

      return this.pipelineStore.getSegment(segment.id);
    } catch (err) {
      // Delete placeholder segment if generation fails
      try {
        await this.pipelineStore.removeSegment(segment.id);
      } catch (_) {}
      throw err;
    }
  }
}

module.exports = ScriptGenerator;
