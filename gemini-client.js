/**
 * gemini-client.js
 *
 * Native Google Gemini client (built on @google/generative-ai) that presents the
 * small slice of the OpenAI SDK surface this project actually uses:
 *
 *   client.chat.completions.create({ model, messages, temperature, max_tokens, response_format })
 *     -> { choices: [ { message: { role, content }, finish_reason } ] }
 *
 *   client.audio.transcriptions.create({ file, model })
 *     -> { text, segments: [ { text, start, end } ] }
 *
 * Keeping this shape lets the existing call sites (and their test mocks) stay
 * unchanged while every request is served by Gemini underneath. OpenAI is no
 * longer a dependency anywhere.
 *
 * Model names: any non-"gemini*" model id (e.g. legacy "gpt-4o", "whisper-1")
 * is transparently mapped to GEMINI_MODEL (default "gemini-2.0-flash").
 */

const fs = require('fs');
const {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
} = require('@google/generative-ai');

const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// Gemini 2.5 models "think" by default, spending the maxOutputTokens budget on
// internal reasoning before emitting any text — which truncates short-limit
// responses (e.g. a 350-token JSON script comes back cut off with
// finishReason=MAX_TOKENS). This app generates dialogue/JSON, not math proofs,
// so we disable thinking. Configurable via GEMINI_THINKING_BUDGET (default 0).
// Only the 2.5 family accepts `thinkingBudget`, so we scope it to those models.
const THINKING_BUDGET =
  process.env.GEMINI_THINKING_BUDGET !== undefined
    ? parseInt(process.env.GEMINI_THINKING_BUDGET, 10)
    : 0;

function thinkingConfigFor(model) {
  if (/gemini-2\.5/i.test(String(model))) {
    return { thinkingBudget: Number.isFinite(THINKING_BUDGET) ? THINKING_BUDGET : 0 };
  }
  return undefined;
}

// The call sites' `max_tokens` values were tuned for OpenAI's terser models.
// Gemini is more verbose and truncates JSON mid-output at those low caps
// (finishReason=MAX_TOKENS). `max_tokens` is only an upper bound — the model
// still stops when done — so we raise any explicit cap to a safe floor.
// Override with GEMINI_MIN_OUTPUT_TOKENS.
const OUTPUT_FLOOR =
  process.env.GEMINI_MIN_OUTPUT_TOKENS !== undefined
    ? parseInt(process.env.GEMINI_MIN_OUTPUT_TOKENS, 10)
    : 2048;

function flooredMaxTokens(requested) {
  const floor = Number.isFinite(OUTPUT_FLOOR) ? OUTPUT_FLOOR : 2048;
  return Math.max(requested, floor);
}

// This project generates deliberately edgy / profane character dialogue. Gemini's
// default filters would refuse much of it, so we relax the four standard categories.
const SAFETY_SETTINGS = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
].map((category) => ({ category, threshold: HarmBlockThreshold.BLOCK_NONE }));

function resolveModel(requested) {
  if (requested && /^gemini/i.test(String(requested))) return requested;
  return DEFAULT_MODEL;
}

function dataUriToInlineData(url) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(String(url || ''));
  if (!m) return null;
  return { inlineData: { mimeType: m[1], data: m[2] } };
}

// Convert an OpenAI message `content` (string OR array of parts) to Gemini parts.
function partsFromContent(content) {
  if (typeof content === 'string') return [{ text: content }];
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (!item) continue;
      if (item.type === 'text') {
        parts.push({ text: String(item.text ?? '') });
      } else if (item.type === 'image_url') {
        const url = item.image_url?.url || '';
        const inline = dataUriToInlineData(url);
        // Gemini needs inline base64; remote URLs can't be fetched here, so we
        // degrade to a text reference rather than throwing.
        parts.push(inline || { text: `[image: ${url}]` });
      }
    }
    return parts.length ? parts : [{ text: '' }];
  }
  return [{ text: String(content ?? '') }];
}

/**
 * Translate an OpenAI-style messages array into Gemini's request shape.
 * - `system` messages become a single systemInstruction string.
 * - `assistant` maps to role "model", everything else to "user".
 * - Consecutive same-role turns are merged (Gemini prefers alternation), and a
 *   leading "model" turn is prefixed with a neutral user turn so the request is
 *   always valid.
 */
function messagesToGemini(messages) {
  const systemChunks = [];
  const raw = [];

  for (const msg of messages || []) {
    if (!msg) continue;
    if (msg.role === 'system') {
      // System prompts in this codebase are always plain strings.
      systemChunks.push(
        typeof msg.content === 'string'
          ? msg.content
          : partsFromContent(msg.content).map((p) => p.text || '').join('\n')
      );
      continue;
    }
    const role = msg.role === 'assistant' ? 'model' : 'user';
    raw.push({ role, parts: partsFromContent(msg.content) });
  }

  // Merge consecutive same-role turns.
  const contents = [];
  for (const turn of raw) {
    const last = contents[contents.length - 1];
    if (last && last.role === turn.role) {
      last.parts.push(...turn.parts);
    } else {
      contents.push({ role: turn.role, parts: turn.parts.slice() });
    }
  }

  let systemInstruction = systemChunks.filter(Boolean).join('\n\n') || undefined;

  // Gemini rejects a request with no `contents`. Callers may legitimately send
  // only a system message (e.g. the memory summarizer). Promote that system text
  // into the sole user turn so the request is valid.
  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: systemInstruction || '' }] });
    systemInstruction = undefined;
  }

  // Gemini requires the first turn to be from the user.
  if (contents.length && contents[0].role === 'model') {
    contents.unshift({ role: 'user', parts: [{ text: '(continue)' }] });
  }

  return { systemInstruction, contents };
}

function mimeFromPath(p) {
  if (/\.wav$/i.test(p)) return 'audio/wav';
  if (/\.mp3$/i.test(p)) return 'audio/mpeg';
  if (/\.m4a$|\.mp4$/i.test(p)) return 'audio/mp4';
  if (/\.ogg$/i.test(p)) return 'audio/ogg';
  if (/\.flac$/i.test(p)) return 'audio/flac';
  return 'audio/mpeg';
}

class GeminiClient {
  constructor({ apiKey } = {}) {
    if (!apiKey) {
      throw new Error('GeminiClient: apiKey required (set GEMINI_API_KEY)');
    }
    this.genAI = new GoogleGenerativeAI(apiKey);

    // OpenAI-compatible namespaces.
    this.chat = {
      completions: {
        create: (opts) => this._createChatCompletion(opts),
      },
    };
    this.audio = {
      transcriptions: {
        create: (opts) => this._createTranscription(opts),
      },
    };
  }

  async _createChatCompletion({
    model,
    messages = [],
    temperature,
    max_tokens,
    response_format,
  } = {}) {
    const { systemInstruction, contents } = messagesToGemini(messages);

    const resolvedModel = resolveModel(model);
    const generationConfig = {};
    if (typeof temperature === 'number') generationConfig.temperature = temperature;
    if (typeof max_tokens === 'number') generationConfig.maxOutputTokens = flooredMaxTokens(max_tokens);
    if (response_format && response_format.type === 'json_object') {
      generationConfig.responseMimeType = 'application/json';
    }
    const thinkingConfig = thinkingConfigFor(resolvedModel);
    if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;

    const genModel = this.genAI.getGenerativeModel({
      model: resolvedModel,
      systemInstruction,
      safetySettings: SAFETY_SETTINGS,
    });

    const result = await genModel.generateContent({ contents, generationConfig });

    let content = '';
    try {
      content = result.response.text() || '';
    } catch (_) {
      content = '';
    }

    return {
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
    };
  }

  async _createTranscription({ file, model } = {}) {
    let buffer;
    let sourcePath = '';

    if (Buffer.isBuffer(file)) {
      buffer = file;
    } else if (typeof file === 'string') {
      sourcePath = file;
      buffer = fs.readFileSync(file);
    } else if (file && typeof file.path === 'string') {
      // fs.ReadStream exposes `.path`
      sourcePath = file.path;
      buffer = fs.readFileSync(file.path);
    } else {
      throw new Error('GeminiClient transcription: unsupported file input');
    }

    const resolvedModel = resolveModel(model);
    const transcriptionConfig = { responseMimeType: 'application/json' };
    const thinkingConfig = thinkingConfigFor(resolvedModel);
    if (thinkingConfig) transcriptionConfig.thinkingConfig = thinkingConfig;

    const genModel = this.genAI.getGenerativeModel({
      model: resolvedModel,
      safetySettings: SAFETY_SETTINGS,
    });

    const instruction =
      'Transcribe this audio. Return ONLY valid JSON of the form ' +
      '{"segments":[{"text":"...","start":<seconds>,"end":<seconds>}]}. ' +
      'Break the transcript into short segments (roughly one sentence each) and give ' +
      'accurate start/end timestamps in seconds. No commentary, JSON only.';

    const result = await genModel.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            { text: instruction },
            { inlineData: { mimeType: mimeFromPath(sourcePath), data: buffer.toString('base64') } },
          ],
        },
      ],
      generationConfig: transcriptionConfig,
    });

    let raw = '';
    try {
      raw = result.response.text() || '';
    } catch (_) {
      raw = '';
    }

    let segments = [];
    try {
      const obj = JSON.parse(raw);
      segments = Array.isArray(obj) ? obj : obj.segments || [];
    } catch (_) {
      segments = [];
    }

    segments = segments
      .map((s) => ({
        text: String(s.text || '').trim(),
        start: Number(s.start) || 0,
        end: Number(s.end) || (Number(s.start) || 0) + 2,
      }))
      .filter((s) => s.text);

    const text = segments.map((s) => s.text).join(' ').trim();
    return { text, segments };
  }
}

module.exports = GeminiClient;
