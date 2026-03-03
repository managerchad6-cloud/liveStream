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

  _buildSystemPrompt({ recentExitContexts, seed }) {
    const mandatoryBlock = seed
      ? `MANDATORY DIRECTIVE — THE DIALOGUE MUST BE EXPLICITLY ABOUT THIS:
"${seed}"

The characters MUST address this directly and by name. If it mentions a specific person, project, action, or event — at least one character must reference it explicitly in their line. Do NOT merely imply it, vaguely gesture at related topics, or let the character personality dilute the message. Character voice is HOW they deliver the directive, not a reason to avoid it.

`
      : '';

    return `You are scripting a dialogue exchange for a 24/7 livestream featuring Chad and Virgin (Virgin vs Chad meme).

${mandatoryBlock}Context:
- Recent show history: ${recentExitContexts.length ? recentExitContexts.join(' | ') : 'none'}

CHARACTER PROFILES (voice and tone only — the directive above takes full priority):
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
- 1-2 sentences per line. Only go to 3 if the line absolutely requires it. Short punchy lines beat long ones.
- No emojis, no markdown in dialogue text
- Audio tags for ElevenLabs v3: [laughs], [chuckles], [sighs], [nervous laugh], [clears throat], etc.
- CRITICAL: Chad must NEVER give advice, encouragement, or act like a life coach. No "just wing it", "fake it till you make it", "you gotta", "try X sometime", "you do you". He ROASTS, brags, or dismisses — never helps.
- CRITICAL: Virgin must NEVER agree with Chad or accept his frame. No "I guess", "easier said than done", "if only". He gets defensive, counters with niche facts, or changes the subject.
- CRITICAL: Chad must NEVER repeat or paraphrase something he already said. Each line must be fresh content.
- LANGUAGE: Adult platform, no filters. ~1 in 20 lines may use natural profanity (e.g. "let's fucking go", "what a bitch", "that's fucked up"). Never slurs or hate speech. Must feel authentic, not forced.
- The exitContext must be a brief TOPIC SUMMARY (e.g. "discussed parties and going out"), NOT a transcript of what was said`;
  }

  _buildUserContent(seed, imageDescription = null) {
    if (imageDescription && seed) {
      return `ATTACHED IMAGE (on the TV screen behind the characters, visible to the live audience):
${imageDescription}

DIRECTOR DIRECTIVE: ${seed}

The characters are reacting to this image. They are self-aware — if Chad or Virgin appear in the image, they recognise themselves and each other immediately. Execute the directive against the image content. Write the dialogue now.`;
    }
    if (imageDescription) {
      return `ATTACHED IMAGE (on the TV screen behind the characters, visible to the live audience):
${imageDescription}

The characters are reacting to this image. They are self-aware — if Chad or Virgin appear in the image, they recognise themselves and each other immediately. React naturally to what you see — no specific directive, just respond in character. Write the dialogue now.`;
    }
    return `REQUIRED SUBJECT: ${seed}\n\nWrite the dialogue now. Address the subject explicitly.`;
  }

  _normalizeScript(lines) {
    return (lines || []).map(line => ({
      speaker: String(line.speaker || '').toLowerCase(),
      text: String(line.text || '').trim()
    })).filter(line => line.speaker && line.text);
  }

  async _generateScript(seed, imageDescription = null) {
    if (!this.openai) throw new Error('OpenAI not configured');
    if (!seed && !imageDescription) throw new Error('Missing seed');

    const recentExitContexts = this._recentExitContexts(5);
    const systemPrompt = this._buildSystemPrompt({ recentExitContexts, seed });
    const userContent = this._buildUserContent(seed, imageDescription);

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

  async expandDirectorNote(seed, { imageBase64 = null, imageMimeType = 'image/jpeg', attachedMediaId = null } = {}) {
    // Vision pass before reserving a pipeline slot — no segment created yet
    let imageDescription = null;
    if (imageBase64) {
      console.log('[ScriptGenerator] Running vision pass on attached media...');
      imageDescription = await this._describeImage(imageBase64, imageMimeType);
      if (imageDescription) console.log('[ScriptGenerator] Image description:', imageDescription);
    }

    // Create segment to reserve position in pipeline
    const segment = await this.pipelineStore.createSegment({
      type: 'auto-convo',
      seed,
      script: [], // Placeholder
      estimatedDuration: 0
    });

    try {
      const generated = await this._generateScript(seed, imageDescription);

      await this.pipelineStore.updateSegment(segment.id, {
        script: generated.script,
        estimatedDuration: generated.estimatedDuration,
        exitContext: generated.exitContext,
        metadata: {
          ...(segment.metadata || {}),
          ...(attachedMediaId ? { attachedMediaId } : {}),
          ...(imageDescription ? { imageDescription } : { imageDescription: null })
        }
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
  async expandConversation({ isFirstExpand = false, wrapUp = false, sourceType = null, sourceWordCount = 0 } = {}) {
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
      // maxExpands is now computed server-side in PlaybackController — not LLM-determined
      const jsonFormat = '{ "script": [ { "speaker": "chad|virgin", "text": "..." } ], "exitContext": "brief topic summary" }';

      let wrapUpClause = '';
      if (wrapUp) {
        wrapUpClause = '\n\nIMPORTANT: This is the last line on THIS specific topic. Land a final jab, reaction, or dismissal about what was just discussed, then let it go. Do NOT open new threads or ask questions. The stream continues — do NOT say goodbye, sign off, or imply the show is ending.';
      }

      // Build as actual chat messages so the LLM naturally predicts the next lines
      const messages = [
        { role: 'system', content: `Livestream conversation between Chad and Virgin. Continue naturally.\n\nCHAD: ${voices.chad.basePrompt}\nVIRGIN: ${voices.virgin.basePrompt}\n\nCRITICAL RULES:\n- Chad must NEVER give advice, encouragement, or life coaching. No "just be yourself", "fake it till you make it", "just wing it", "you gotta", "try X sometime". Instead Chad ROASTS Virgin, brags about himself, or dismisses what Virgin said entirely.\n- Chad must NEVER say "no worries", "you'll get there", "everyone starts somewhere", "you do you", "if that's your thing", or offer comfort/reassurance of any kind.\n- Virgin must NEVER just agree with Chad or accept his frame. No "I guess", "I guess you're right", "easier said than done", "if only". Instead Virgin gets DEFENSIVE about his niche interests, fires back with an obscure fact, or changes the subject to something he knows about.\n- Do NOT repeat the dynamic of Chad giving advice and Virgin accepting it. Instead: argue, roast, one-up, tangent, or disagree.\n- Each continuation must introduce a NEW detail, opinion, or mini-topic — never just rephrase what was already said.\n- VIRGIN PHRASE BAN: Virgin must NEVER say "statistically speaking" or any variation of it. Virgin must never repeat the same hedge or filler phrase twice in a row — vary it every time.\n- LANGUAGE: Adult platform, no filters. ~1 in 20 lines may use natural profanity (e.g. "let's fucking go", "what a bitch", "that's fucked up"). Never slurs or hate speech. Authentic, not forced.\n\nRespond with ONLY JSON: ${jsonFormat}\nThe "script" array must contain EXACTLY 1 object — one speaker, one line. Never add a second entry. Keep it SHORT: 1 sentence, 2 max. No emojis, no markdown. Audio tags allowed: [laughs], [chuckles], [sighs], [nervous laugh], etc.${wrapUpClause}` }
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

      // maxExpands is controlled server-side in PlaybackController, not by LLM

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
      const systemPrompt = `Respond to this chat message in character. Match length strictly to how much the message deserves:\n` +
        `- Greetings, reactions, one-word inputs ("hi", "lol", "nice", "sup"): 1 line total, 3-6 words. A quick hit, nothing more.\n` +
        `- Simple questions or casual comments: 1-2 lines, 1 short sentence each.\n` +
        `- Substantive questions with real content: up to 3 lines, 2 sentences max per line.\n` +
        `Never pad a shallow message with a long answer. Silence deserves silence, "hi" deserves a word.\n\n` +
        `Context: ${recentExitContexts.join(' | ') || 'none'}.\n` +
        `\nCHAD: ${voices.chad.basePrompt}\nVIRGIN: ${voices.virgin.basePrompt}\n` +
        `\nCRITICAL RULES:\n` +
        `- Chad must NEVER give advice, encouragement, or life coaching. No "just be yourself", "fake it till you make it", "just wing it", "you gotta", "try X sometime". Instead Chad ROASTS, brags, or dismisses.\n` +
        `- Chad must NEVER say "no worries", "you'll get there", "everyone starts somewhere", "you do you", "if that's your thing", or offer comfort/reassurance.\n` +
        `- Virgin must NEVER just agree with Chad or accept his frame. No "I guess", "I guess you're right", "easier said than done", "if only". Instead he gets DEFENSIVE, fires back with a niche fact, or changes the subject.\n` +
        `- Each line must introduce a NEW detail, opinion, or mini-topic — never just rephrase what was already said.\n` +
        `- VIRGIN PHRASE BAN: Virgin must NEVER say "statistically speaking" or any variation of it. Virgin must never repeat the same hedge or filler phrase twice in a row.\n` +
        `- LANGUAGE: Adult platform, no filters. ~1 in 20 lines may use natural profanity (e.g. "let's fucking go", "what a bitch", "that's fucked up"). Never slurs or hate speech. Authentic, not forced.\n` +
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
  /**
   * Generate a high-energy hype segment for a pump.fun token launch.
   * 80% pure degen hype, 20% weaves in live stats if provided.
   * Goes hard with ElevenLabs v3 audio expression tags.
   */
  async generateHypeScript({ mcap, volume, holders } = {}) {
    if (!this.openai) throw new Error('OpenAI not configured');

    const hasStats = mcap || volume || holders;
    const statsBlock = hasStats
      ? [
          mcap    && `Market cap: $${mcap}`,
          volume  && `Volume: $${volume}`,
          holders && `Holders: ${holders}`
        ].filter(Boolean).join('\n')
      : null;

    const systemPrompt = `You are writing a HYPE segment for a live pump.fun token launch stream. Chad and Virgin are co-hosts going absolutely unhinged about the $VVC token.

THIS IS A HYPE SEGMENT — pure degen energy, CT-native language, maximum chaos.

CHARACTER RULES:
CHAD: ${voices.chad.basePrompt} — but amped to 11. His casual confidence becomes unstoppable, almost religious certainty. He's been right before and he KNOWS it.
VIRGIN: ${voices.virgin.basePrompt} — but his usual anxiety is flipped into manic degen euphoria. He's losing his mind in the best possible way. Shaking. Can't believe it.

TONE RULES:
- 80% of lines are pure raw hype with zero stats — just vibes, rhythm, and degen culture
- ${hasStats ? '20% of lines should reference the real numbers provided — use them to land a meaningful punch ("we\'re at X mcap and the normies haven\'t even sniffed this yet")' : 'No stats provided — 100% pure hype vibes, do NOT invent numbers'}
- Both characters are UNIFIED in shared bullishness for once — no roasting each other, just co-hype
- Short punchy lines — power comes from rhythm and intensity, not length
- CT language mandatory: LFG, WAGMI, ser, anon, aping in, we're so early, 100x, the narrative, this is the play, diamond hands, send it, ngmi (for paperhands), on-chain, based, bullish af, the meta, cooked, it's over for bears, we're not even warmed up
- No caveats, no FUD, no hedging — pure conviction

ELEVENLABS v3 AUDIO TAGS — go absolutely unhinged:
Use tags like: [screams], [yells], [gasps], [laughs maniacally], [laughs hysterically], [voice cracks with excitement], [breathes heavily], [whispers intensely], [shouts], [slams fist], [stutters with excitement], [gasps in disbelief]
Mix them with the standard: [laughs], [chuckles], [sighs contentedly]
Tags should be embedded mid-sentence or at the start of a line for maximum expressiveness. Be creative — don't just drop one at the start. E.g. "bro [gasps] the chart — [screams] I CANNOT"

Generate exactly 3-5 dialogue lines total. Return ONLY valid JSON:
{
  "script": [
    { "speaker": "chad|virgin", "text": "..." }
  ],
  "exitContext": "hype segment for $VVC token launch"
}`;

    const userLines = ['Generate a hype segment now.'];
    if (statsBlock) userLines.push(`\nLive stats:\n${statsBlock}`);

    const completion = await this.openai.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userLines.join('') }
      ],
      temperature: 1.0,
      max_tokens: 400
    });

    const content = completion.choices?.[0]?.message?.content || '';
    const parsed = parseJson(content);
    if (!parsed || !Array.isArray(parsed.script)) {
      throw new Error('Failed to parse hype script JSON');
    }

    const script = this._normalizeScript(parsed.script);
    const estimatedDuration = estimateDurationSeconds(script);

    return { script, estimatedDuration, exitContext: parsed.exitContext || 'hype segment' };
  }
  /**
   * Generate a 2–4 line reaction script for a tweet.
   * @param {string} [source] - 'community' = hype/supportive, 'single' = normal in-character behaviour
   * Does NOT create a segment — caller is responsible for that.
   */
  async _describeImage(imageBase64, imageMimeType = 'image/jpeg') {
    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: `You are a vision assistant for a livestream show hosted by two animated characters named Chad and Virgin.

CANONICAL CHARACTER DESCRIPTIONS — identify these if present in the image:
- Chad: Extremely tall, muscular, square-jawed man. Handsome, confident posture, often smirking. May appear in any art style (realistic, anime, illustration, cartoon). Always composed and dominant-looking.
- Virgin: Short, hunched, thin man, often with glasses, weak chin, nervous expression. May appear in any art style. Always depicted as awkward or insecure-looking.

Describe this image accurately and in detail. Cover:
- What type of image it is (photo, illustration, artwork, screenshot, meme, etc.)
- The main subject(s) and what is happening
- Any visible text, labels, or captions
- The overall tone, mood, or humor if applicable
- Any notable details a viewer would notice

If Chad or Virgin (as described above) appear in the image, identify them by name explicitly.
If this is a classic Virgin vs Chad format meme (two-column comparison with Virgin on left and Chad on right), describe both sides and what entities or behaviours they represent.
If it is any other kind of image, describe it accurately — do not force a meme lens onto it.

Be thorough. 3–5 sentences.`
            },
            { type: 'image_url', image_url: { url: `data:${imageMimeType};base64,${imageBase64}` } }
          ]
        }],
        max_tokens: 300
      });
      return response.choices?.[0]?.message?.content?.trim() || null;
    } catch (err) {
      console.warn('[ScriptGenerator] Image vision pass failed:', err.message);
      return null;
    }
  }

  async generateTweetResponseScript({ tweetText, tweetAuthor, source = 'single', instruction = null, imageBase64 = null, imageMimeType = 'image/jpeg' }) {
    if (!this.openai) throw new Error('OpenAI not configured');
    if (!tweetText) throw new Error('Missing tweetText');

    // Vision pass — describe attached image if present
    let imageDescription = null;
    if (imageBase64) {
      console.log('[ScriptGenerator] Running vision pass on tweet image...');
      imageDescription = await this._describeImage(imageBase64, imageMimeType);
      if (imageDescription) console.log('[ScriptGenerator] Image description:', imageDescription);
    }

    const isCommunity = source === 'community';

    const mandatoryOverride = instruction
      ? `MANDATORY DIRECTOR OVERRIDE — THIS GOVERNS HOW THE CHARACTERS BEHAVE:
"${instruction}"

Execute this as behaviour, not as a line to recite. The characters must DO what this says through their words, reactions, and tone — they must NOT quote or paraphrase this instruction itself. Character voice describes HOW they deliver it. This takes priority over everything else.

`
      : '';

    const toneBlock = isCommunity
      ? `TONE — COMMUNITY MEMBER TWEET:
- This person is inside our $VVC community — treat them like a fellow degen, not a target.
- Chad gives the tweet genuine props. He still keeps his cool and brags a little, but he acknowledges this person is on the right side of the trade. No roasting.
- Virgin is visibly excited and slightly flustered that someone else gets it — he over-validates, adds a tangent, or hypes the point harder than necessary.
- Both characters are on the same team here. Hype up the tweet's idea or sentiment.
- CT language: based, bullish, wagmi, ser, we're so early, this is the play, diamond hands, LFG, on-chain`
      : `TONE — EXTERNAL TWEET:
- React naturally and fully in-character.
- Chad roasts, brags, or dismisses as he sees fit — no obligation to be supportive.
- Virgin gets defensive, counters with niche facts, or spirals into self-doubt.
- Normal dynamic applies.`;

    const systemPrompt = `${mandatoryOverride}You are writing a dialogue script for a 24/7 pump.fun livestream for the $VVC token on Solana.
The hosts are Chad and Virgin (from the Virgin vs Chad meme). They are reacting to a tweet on X (Twitter).

CHARACTER PROFILES (voice/tone only — mandatory override above takes full priority):
CHAD: ${voices.chad.basePrompt}
VIRGIN: ${voices.virgin.basePrompt}

${toneBlock}

RULES:
- React to the specific tweet content — make it feel genuine and contextual
- 2–4 lines total, short punchy lines
- ElevenLabs v3 audio tags encouraged: [laughs], [chuckles], [sighs], [nervous laugh], [clears throat], etc.
- No emojis, no markdown in dialogue text
- Reference the tweet author by name if it adds character
- Crypto / CT language always welcome

Return ONLY valid JSON:
{
  "script": [
    { "speaker": "chad|virgin", "text": "..." }
  ],
  "exitContext": "brief topic summary"
}`;

    const imageContext = imageDescription
      ? `\nATTACHED IMAGE: ${imageDescription}`
      : '';

    const userPrompt = `Tweet by @${tweetAuthor}:\n"${tweetText}"${imageContext}`;

    const completion = await this.openai.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.9,
      max_tokens: 300
    });

    const content = completion.choices?.[0]?.message?.content || '';
    const parsed = parseJson(content);
    if (!parsed || !Array.isArray(parsed.script)) {
      throw new Error('Failed to parse tweet response script JSON');
    }

    const script = this._normalizeScript(parsed.script);
    const estimatedDuration = estimateDurationSeconds(script);

    return { script, estimatedDuration, exitContext: parsed.exitContext || null };
  }

  async generateMemeReactionScript({ virginSubject, chadSubject, virginLabels, chadLabels }) {
    if (!this.openai) throw new Error('OpenAI not configured');

    const virginLabelLines = virginLabels.map((l, i) => `${i + 1}. "${l}"`).join('\n');
    const chadLabelLines = chadLabels.map((l, i) => `${i + 1}. "${l}"`).join('\n');

    const systemPrompt = `MANDATORY DIRECTIVE — THE DIALOGUE MUST REACT TO THIS SPECIFIC MEME:

A "Virgin vs Chad" meme has just appeared on the TV screen. The meme is about:

VIRGIN SIDE: "${virginSubject}"
${virginLabelLines}

CHAD SIDE: "${chadSubject}"
${chadLabelLines}

The characters are watching this meme. They MUST reference specific label text — at least 2 individual labels must be directly quoted or clearly paraphrased in the dialogue. Do not speak in generalities. The labels are the punchline; name them.

VIRGIN'S MANDATORY REACTION:
- He is visibly salty and defensive about his specific labels. They clearly describe him.
- He challenges at least one label directly by text: "that's not fair", "technically...", "that's not even true, I—", etc.
- He does NOT accept any of his labels as accurate.
- He may try to briefly spin one as a positive before running out of steam.

CHAD'S MANDATORY REACTION:
- He casually confirms the Chad labels as obviously correct — not surprised, just vindicated.
- He picks out a specific Chad label and owns it without effort.
- Optional: he throws one of Virgin's labels back at him for an easy dig.

CHARACTER PROFILES (delivery only — the directive above takes full priority):
CHAD: ${voices.chad.basePrompt}
VIRGIN: ${voices.virgin.basePrompt}

RULES:
- 3–5 lines total, punchy and specific
- At least 2 specific label texts must be referenced by content
- No emojis, no markdown in dialogue text
- ElevenLabs v3 audio tags: [laughs], [chuckles], [nervous laugh], [sighs], [clears throat], etc.
- LANGUAGE: Adult platform. ~1 in 20 lines may use natural profanity. Never slurs or hate speech.

Return ONLY valid JSON:
{
  "script": [{ "speaker": "chad|virgin", "text": "..." }],
  "exitContext": "brief topic summary"
}`;

    const userPrompt = `React to the meme now. Name the specific labels.`;

    const completion = await this.openai.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.9,
      max_tokens: 400
    });

    const content = completion.choices?.[0]?.message?.content || '';
    const parsed = parseJson(content);
    if (!parsed || !Array.isArray(parsed.script)) {
      throw new Error('Failed to parse meme reaction script JSON');
    }

    const script = this._normalizeScript(parsed.script);
    const estimatedDuration = estimateDurationSeconds(script);

    return { script, estimatedDuration, exitContext: parsed.exitContext || null };
  }
}

module.exports = ScriptGenerator;
