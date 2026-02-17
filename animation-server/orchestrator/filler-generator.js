const voices = require('../../voices');
const { parseJson } = require('./utils');

const DEFAULT_MODEL = process.env.SCRIPT_MODEL || 'gpt-4o';

class FillerGenerator {
  constructor({ openai, pipelineStore }) {
    this.openai = openai;
    this.pipelineStore = pipelineStore;
  }

  async generateFiller(recentExitContexts = []) {
    if (!this.openai) throw new Error('OpenAI not configured');

    const hasContext = recentExitContexts.length > 0;
    const contextBlock = hasContext
      ? `Continue the ongoing conversation naturally. Pick up where they left off or riff on something already mentioned.\n\nRecent conversation history:\n${recentExitContexts.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
      : `Start a casual conversation. Chad and Virgin are hanging out on a livestream with nothing specific planned.`;

    const prompt = `Generate a short dialogue (3-5 exchanges) for Chad and Virgin.
${contextBlock}

The dialogue should feel like a natural continuation, NOT a topic switch. Don't announce the topic or force a segue — just keep talking as if the conversation never stopped.

Output JSON: { "script": [{ "speaker": "chad|virgin", "text": "..." }], "exitContext": "..." }

CHARACTER PROFILES:
CHAD: ${voices.chad.basePrompt}
VIRGIN: ${voices.virgin.basePrompt}

CRITICAL RULES:
- Chad must NEVER give advice, encouragement, or life coaching. No "just be yourself", "fake it till you make it", "just wing it", "you gotta", "try X sometime". Instead Chad ROASTS, brags about himself, or dismisses what Virgin said entirely.
- Chad must NEVER say "no worries", "you'll get there", "everyone starts somewhere", "you do you", "if that's your thing", or offer comfort/reassurance of any kind.
- Virgin must NEVER just agree with Chad or accept his frame. No "I guess", "I guess you're right", "easier said than done", "if only". Instead Virgin gets DEFENSIVE about his niche interests, fires back with an obscure fact, or changes the subject to something he knows about.
- Do NOT repeat the dynamic of Chad giving advice and Virgin accepting it. Instead: argue, roast, one-up, tangent, or disagree.
- Each line must introduce a NEW detail, opinion, or mini-topic — never just rephrase what was already said.`;

    const completion = await this.openai.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        { role: 'system', content: 'You generate natural continuation dialogue and return only JSON.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7
    });

    const content = completion.choices?.[0]?.message?.content || '';
    const parsed = parseJson(content);
    if (!parsed || !Array.isArray(parsed.script)) {
      throw new Error('Failed to parse filler JSON');
    }

    const script = parsed.script.map(line => ({
      speaker: String(line.speaker || '').toLowerCase(),
      text: String(line.text || '').trim()
    })).filter(line => line.speaker && line.text);

    const segment = await this.pipelineStore.createSegment({
      type: 'filler',
      seed: null,
      script,
      estimatedDuration: Math.max(10, script.length * 6)
    });

    await this.pipelineStore.updateSegment(segment.id, {
      exitContext: parsed.exitContext || null
    });

    return this.pipelineStore.getSegment(segment.id);
  }
}

module.exports = FillerGenerator;
