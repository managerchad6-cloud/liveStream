const voices = require('../../voices');
const { parseJson } = require('./utils');

const DEFAULT_MODEL = process.env.SCRIPT_MODEL || 'gpt-4o';

// Post-generation filter: strip lazy pivot phrases from the start of lines
const BANNED_PREFIXES = [
  /^speaking of\b/i,
  /^that reminds me\b/i,
  /^on that note\b/i,
  /^anyway\b/i,
  /^but seriously\b/i,
  /^let'?s talk about\b/i,
];

function cleanPivotPhrase(text) {
  let cleaned = text;
  for (const rx of BANNED_PREFIXES) {
    cleaned = cleaned.replace(rx, '').replace(/^[,.\s]+/, '');
  }
  if (cleaned.length > 0 && cleaned[0] !== cleaned[0].toUpperCase()) {
    cleaned = cleaned[0].toUpperCase() + cleaned.slice(1);
  }
  return cleaned || text;
}

class BridgeGenerator {
  constructor({ openai, pipelineStore }) {
    this.openai = openai;
    this.pipelineStore = pipelineStore;
  }

  async generateBridge(exitContext, nextSeed, lastSpeaker, { bridgeFor, bridgeAfter, targetScript, conversationHistory, targetFirstSpeaker } = {}) {
    if (!this.openai) throw new Error('OpenAI not configured');

    // Build conversation context from recent history
    let precedingLines = '';
    if (Array.isArray(conversationHistory) && conversationHistory.length > 0) {
      precedingLines = conversationHistory.map(l => `${l.speaker}: ${l.text}`).join('\n');
    }

    // The bridge speaker must be the OPPOSITE of whoever starts the next segment.
    // This creates a natural handoff: bridge speaker sets up → target speaker responds.
    const oppositeSpeaker = targetFirstSpeaker === 'chad' ? 'virgin'
      : targetFirstSpeaker === 'virgin' ? 'chad'
      : null;
    const speakerConstraint = oppositeSpeaker
      ? `\nIMPORTANT: The line MUST be spoken by ${oppositeSpeaker}. The next segment starts with ${targetFirstSpeaker}, so ${oppositeSpeaker} must set it up.`
      : '';

    const systemPrompt = `You are writing dialogue for two characters: Chad and Virgin from the Virgin vs Chad meme. They're having a conversation.

CHAD: ${voices.chad.basePrompt}
VIRGIN: ${voices.virgin.basePrompt}

You will be asked to continue a conversation with exactly 1 line from one character. This line should respond naturally to what was just said, and it should open the door to a new topic. The next segment of conversation will pick up from your line.
${speakerConstraint}

Output valid JSON: { "script": [{ "speaker": "chad" or "virgin", "text": "..." }], "exitContext": "brief summary" }
Only 1 entry in the script array. One character, one line.`;

    const userPrompt = `Here's the conversation so far:

${precedingLines || `[Topic: ${exitContext}]`}

Continue with exactly 1 line. The conversation naturally shifts toward ${nextSeed}.`;

    const completion = await this.openai.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.9
    });

    const content = completion.choices?.[0]?.message?.content || '';
    const parsed = parseJson(content);
    if (!parsed || !Array.isArray(parsed.script)) {
      throw new Error('Failed to parse bridge JSON');
    }

    // Take only the first line even if LLM generated more
    const script = parsed.script.slice(0, 1).map(line => {
      let speaker = String(line.speaker || '').toLowerCase();
      // Enforce opposite-speaker constraint even if LLM ignored it
      if (oppositeSpeaker && speaker !== oppositeSpeaker) {
        console.warn(`[BridgeGenerator] LLM used ${speaker} but target opens with ${targetFirstSpeaker}, forcing ${oppositeSpeaker}`);
        speaker = oppositeSpeaker;
      }
      return {
        speaker,
        text: cleanPivotPhrase(String(line.text || '').trim())
      };
    }).filter(line => line.speaker && line.text);

    const segment = await this.pipelineStore.createSegment({
      type: 'transition',
      seed: nextSeed || null,
      script,
      estimatedDuration: Math.max(3, script.length * 4)
    });

    await this.pipelineStore.updateSegment(segment.id, {
      exitContext: parsed.exitContext || exitContext || null,
      metadata: {
        bridgeFor: bridgeFor || null,
        bridgeAfter: bridgeAfter || null
      }
    });

    return this.pipelineStore.getSegment(segment.id);
  }
}

module.exports = BridgeGenerator;
