const voices = require('../../voices');

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

class FillerGenerator {
  constructor({ openai, pipelineStore }) {
    this.openai = openai;
    this.pipelineStore = pipelineStore;
  }

  async generateFiller(recentExitContexts = []) {
    if (!this.openai) throw new Error('OpenAI not configured');

    const prompt = `Generate a short filler dialogue (3-5 exchanges) for Chad and Virgin.
They should riff on recent topics or do generic banter.
Recent topics: ${recentExitContexts.join(' | ') || 'none'}

Output JSON: { "script": [{ "speaker": "chad|virgin", "text": "...", "cues": [] }], "exitContext": "..." }

CHARACTER PROFILES:
CHAD: ${voices.chad.basePrompt}
VIRGIN: ${voices.virgin.basePrompt}`;

    const completion = await this.openai.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        { role: 'system', content: 'You generate short filler dialogue and return only JSON.' },
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
      text: String(line.text || '').trim(),
      cues: Array.isArray(line.cues) ? line.cues : []
    })).filter(line => line.speaker && line.text);

    const segment = await this.pipelineStore.createSegment({
      type: 'filler',
      seed: null,
      script,
      estimatedDuration: Math.max(10, script.length * 6),
      tvCues: [],
      lightingCues: []
    });

    await this.pipelineStore.updateSegment(segment.id, {
      exitContext: parsed.exitContext || null
    });

    return this.pipelineStore.getSegment(segment.id);
  }
}

module.exports = FillerGenerator;
