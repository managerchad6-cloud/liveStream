const voices = require('../../voices');
const { parseJson } = require('./utils');

const DEFAULT_MODEL = process.env.SCRIPT_MODEL || 'gpt-4o';

class BridgeGenerator {
  constructor({ openai, pipelineStore }) {
    this.openai = openai;
    this.pipelineStore = pipelineStore;
  }

  async generateBridge(exitContext, nextSeed, lastSpeaker, { bridgeFor, bridgeAfter } = {}) {
    if (!this.openai) throw new Error('OpenAI not configured');

    const prompt = `Generate a 1-2 line transition between topics.
Ending topic: ${exitContext}
Starting topic: ${nextSeed}
Last speaker: ${lastSpeaker}

Output JSON: { "script": [{ "speaker": "chad|virgin", "text": "..." }], "exitContext": "..." }

Vary the style:
- Verbal pivot ("Speaking of which...", "That reminds me...")
- Personality-driven (Chad confidently changes subject, Virgin awkwardly stumbles)
- Natural beat (just start new topic)

CHARACTER PROFILES:
CHAD: ${voices.chad.basePrompt}
VIRGIN: ${voices.virgin.basePrompt}`;

    const completion = await this.openai.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        { role: 'system', content: 'You generate short transitions and return only JSON.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7
    });

    const content = completion.choices?.[0]?.message?.content || '';
    const parsed = parseJson(content);
    if (!parsed || !Array.isArray(parsed.script)) {
      throw new Error('Failed to parse bridge JSON');
    }

    const script = parsed.script.map(line => ({
      speaker: String(line.speaker || '').toLowerCase(),
      text: String(line.text || '').trim()
    })).filter(line => line.speaker && line.text);

    const segment = await this.pipelineStore.createSegment({
      type: 'transition',
      seed: nextSeed || null,
      script,
      estimatedDuration: Math.max(4, script.length * 4)
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
