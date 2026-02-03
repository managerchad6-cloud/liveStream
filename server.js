require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const axios = require('axios');
const FormData = require('form-data');
const voices = require('./voices');

const app = express();
const port = process.env.PORT || 3002;
const routerModel = process.env.ROUTER_MODEL || process.env.MODEL || 'gpt-4o-mini';
const autoModel = process.env.AUTO_MODEL || process.env.MODEL || 'gpt-4o-mini';
const autoTtsModel = process.env.AUTO_TTS_MODEL || 'eleven_turbo_v2';
const routerMaxPerSecond = parseInt(process.env.ROUTER_MAX_PER_SECOND || '3', 10);
const routerMaxPerMinute = parseInt(process.env.ROUTER_MAX_PER_MINUTE || '30', 10);
const routerTimestamps = [];
const memoryStore = {
  chad: '',
  virgin: ''
};
const memoryMaxChars = 600;
const memoryModel = process.env.MEMORY_MODEL || routerModel;
let memoryUpdateInFlight = false;
const memoryPending = {
  chad: null,
  virgin: null
};
const conversationHistory = [];
const autoConversation = {
  id: 0,
  history: []
};
let animationServerUrl = process.env.ANIMATION_SERVER_URL || 'http://localhost:3003';
if (process.platform === 'win32') {
  try {
    const u = new URL(animationServerUrl);
    if (u.hostname === 'localhost' || u.hostname === '::1') {
      u.hostname = '127.0.0.1';
      animationServerUrl = u.toString().replace(/\/$/, '');
    }
  } catch (err) {
    // If parsing fails, keep the original URL
  }
}
const dataDir = path.join(__dirname, 'data');
const commandsFile = path.join(dataDir, 'commands.json');
const commandsStore = {
  counts: Object.create(null),
  total: 0,
  updatedAt: null
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Middleware
app.use(cors());
app.use(express.json());

// Also serve frontend for backward compatibility (can be disabled on VPS with nginx)
app.use(express.static(path.join(__dirname, 'frontend')));

// API: Get available voices
app.get('/api/voices', (req, res) => {
  const voiceList = Object.entries(voices).map(([id, config]) => ({
    id,
    name: config.name
  }));
  res.json(voiceList);
});

// API: Auto conversation (pre-generated)
app.post('/api/auto', async (req, res) => {
  try {
    const {
      seed,
      turns = 12,
      model = autoModel,
      temperature = 0.7
    } = req.body;

    if (!seed || typeof seed !== 'string') {
      return res.status(400).json({ error: 'Seed is required and must be a string' });
    }

    const turnCount = Math.max(2, Math.min(30, parseInt(turns, 10) || 12));
    console.log('[Auto] Request seed="' + seed.slice(0, 40) + '...", turns=' + turnCount);

    autoConversation.id += 1;
    autoConversation.history = [];
    const script = await generateAutoScript(seed, turnCount, model, temperature);
    autoConversation.history.push(`System: Auto seed: ${seed}`);

    res.json({ ok: true, turns: script.length, script });

    const currentAutoId = autoConversation.id;
    console.log('[Auto] Playback starting ' + script.length + ' turns, animationServerUrl=' + animationServerUrl);
    setImmediate(() => {
      playAutoScript(script, currentAutoId).catch(err => {
        console.error('[Auto] Playback failed:', err.message);
      });
    });
  } catch (error) {
    console.error('[Auto] Error:', error.message);
    res.status(500).json({ error: 'Failed to generate auto conversation' });
  }
});

// Diagnostic: env presence and /render reachability (no secrets)
app.get('/api/auto/diagnostic', async (req, res) => {
  const env = {
    ELEVENLABS_API_KEY: !!process.env.ELEVENLABS_API_KEY,
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    ANIMATION_SERVER_URL: !!process.env.ANIMATION_SERVER_URL,
    AUTO_MODEL: !!process.env.AUTO_MODEL,
    AUTO_TTS_MODEL: !!process.env.AUTO_TTS_MODEL
  };
  const renderUrl = animationServerUrl + '/render';
  let renderReachable = false;
  let renderError = null;
  try {
    const healthUrl = animationServerUrl.replace(/\/$/, '') + '/health';
    const healthRes = await axios.get(healthUrl, { timeout: 5000 });
    renderReachable = healthRes.status === 200;
  } catch (err) {
    renderError = err.code || err.message || String(err);
  }
  res.json({
    animationServerUrl,
    env,
    renderUrl,
    renderReachable,
    renderError
  });
});

// API: Chat endpoint - returns audio
app.post('/api/chat', async (req, res) => {
  try {
    const {
      message,
      voice = 'chad',
      model = 'eleven_v3',
      temperature = 0.7,
      mode = 'direct'
    } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required and must be a string' });
    }

    if (isSlashCommand(message)) {
      const result = await recordCommand(message);
      return res.json({
        ok: true,
        command: result.command,
        count: result.count,
        total: commandsStore.total
      });
    }

    const normalizedMode = mode === 'router' ? 'router' : 'direct';
    const routingDecision = normalizedMode === 'router'
      ? await routeMessageToVoice(message)
      : { voice };

    if (normalizedMode === 'router' && routingDecision.filtered) {
      return res.json({
        filtered: true,
        reason: routingDecision.reason,
        counts: routingDecision.counts
      });
    }

    const selectedVoice = routingDecision.voice;
    const voiceConfig = voices[selectedVoice];
    if (!voiceConfig) {
      return res.status(400).json({ error: 'Invalid voice. Use "chad" or "virgin"' });
    }

    const memory = memoryStore[selectedVoice] || '';
    const systemPrompt = buildCharacterSystemPrompt(voiceConfig, model, memory, conversationHistory);

    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: process.env.MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ],
      max_tokens: 150,
      temperature: temperature,
    });

    const replyText = completion.choices[0].message.content;
    console.log(`[Chat] Voice: ${voiceConfig.name}, Model: ${model}, Temp: ${temperature}`);
    console.log(`[Chat] Response: ${replyText.substring(0, 100)}...`);

    // Call ElevenLabs
    const elevenLabsResponse = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceConfig.elevenLabsVoiceId}`,
      {
        text: replyText,
        model_id: model,
        voice_settings: voiceConfig.voiceSettings
      },
      {
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': process.env.ELEVENLABS_API_KEY
        },
        responseType: 'arraybuffer'
      }
    );

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-Selected-Voice', selectedVoice);
    res.send(elevenLabsResponse.data);

    appendConversationTurn(message, replyText, selectedVoice);
    enqueueMemoryUpdate(selectedVoice, message, replyText);
  } catch (error) {
    console.error('Error:', error.response?.data ? Buffer.from(error.response.data).toString() : error.message);
    if (error.response) {
      const errorText = Buffer.from(error.response.data).toString();
      return res.status(500).json({ error: `ElevenLabs API error: ${errorText}` });
    }
    res.status(500).json({ error: 'Failed to generate response' });
  }
});

// Legacy endpoint for backward compatibility
app.post('/chat', async (req, res) => {
  req.url = '/api/chat';
  app.handle(req, res);
});

// API: Record a slash command (vote)
app.post('/api/commands', async (req, res) => {
  try {
    const rawCommand = typeof req.body.command === 'string' ? req.body.command : req.body.message;
    if (!rawCommand || typeof rawCommand !== 'string') {
      return res.status(400).json({ error: 'Command is required and must be a string' });
    }
    if (!isSlashCommand(rawCommand)) {
      return res.status(400).json({ error: 'Command must start with "/"' });
    }
    const result = await recordCommand(rawCommand);
    res.json({
      ok: true,
      command: result.command,
      count: result.count,
      total: commandsStore.total
    });
  } catch (error) {
    console.error('[Commands] Error:', error.message);
    res.status(500).json({ error: 'Failed to record command' });
  }
});

// API: Get leaderboard
app.get('/api/leaderboard', (req, res) => {
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || '20', 10) || 20));
  const entries = Object.entries(commandsStore.counts)
    .map(([command, count]) => ({ command, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.command.localeCompare(b.command);
    })
    .slice(0, limit);

  res.json({
    ok: true,
    total: commandsStore.total,
    updatedAt: commandsStore.updatedAt,
    entries
  });
});

// Leaderboard page
app.get('/leaderboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'leaderboard.html'));
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', platform: process.platform });
});

// API: Get current conversation history (in-memory)
app.get('/api/history', (req, res) => {
  res.json({
    history: conversationHistory,
    autoHistory: autoConversation.history
  });
});

// Serve frontend index
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

initCommandStore()
  .catch(err => {
    console.error('[Commands] Failed to initialize store:', err.message);
  })
  .finally(() => {
    app.listen(port, () => {
      console.log(`API server running on http://localhost:${port}`);
      console.log(`Platform: ${process.platform}`);
      // Auto-conversation env (presence only, for diagnostics)
      console.log('[Auto] Env: ELEVENLABS_API_KEY=' + (process.env.ELEVENLABS_API_KEY ? 'set' : 'MISSING') +
        ', OPENAI_API_KEY=' + (process.env.OPENAI_API_KEY ? 'set' : 'MISSING') +
        ', ANIMATION_SERVER_URL=' + (process.env.ANIMATION_SERVER_URL ? 'set' : 'default') +
        ', AUTO_MODEL=' + (process.env.AUTO_MODEL ? 'set' : 'default') +
        ', AUTO_TTS_MODEL=' + (process.env.AUTO_TTS_MODEL ? 'set' : 'default'));
      console.log('[Auto] animationServerUrl=' + animationServerUrl);
    });
  });

function pruneRouterTimestamps(now) {
  while (routerTimestamps.length > 0 && now - routerTimestamps[0] > 60000) {
    routerTimestamps.shift();
  }
}

function shouldFilterRouterMessage() {
  const now = Date.now();
  pruneRouterTimestamps(now);
  routerTimestamps.push(now);

  const perSecondCount = routerTimestamps.filter(ts => now - ts <= 1000).length;
  const perMinuteCount = routerTimestamps.length;
  const overSecond = Math.max(0, perSecondCount - routerMaxPerSecond);
  const overMinute = Math.max(0, perMinuteCount - routerMaxPerMinute);

  if (overSecond === 0 && overMinute === 0) {
    return { filtered: false, counts: { perSecond: perSecondCount, perMinute: perMinuteCount } };
  }

  const dropProbability = Math.min(0.9, overSecond * 0.25 + overMinute * 0.05);
  const filtered = Math.random() < dropProbability;

  return {
    filtered,
    counts: { perSecond: perSecondCount, perMinute: perMinuteCount },
    reason: filtered ? 'Router throttled due to high message volume.' : undefined
  };
}

function isSlashCommand(message) {
  const text = typeof message === 'string' ? message.trim() : '';
  return text.startsWith('/') && text.length > 1;
}

function normalizeCommand(command) {
  const trimmed = command.trim();
  if (!trimmed.startsWith('/')) return null;
  const normalized = trimmed.replace(/\s+/g, ' ').toLowerCase();
  if (normalized.length > 200) return null;
  return normalized;
}

async function initCommandStore() {
  await fs.promises.mkdir(dataDir, { recursive: true });
  try {
    const raw = await fs.promises.readFile(commandsFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      commandsStore.counts = parsed.counts && typeof parsed.counts === 'object'
        ? parsed.counts
        : Object.create(null);
      commandsStore.total = Number.isFinite(parsed.total) ? parsed.total : 0;
      commandsStore.updatedAt = parsed.updatedAt || null;
      return;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[Commands] Resetting store due to read error:', err.message);
    }
  }
  await persistCommandStore();
}

async function persistCommandStore() {
  const payload = JSON.stringify({
    counts: commandsStore.counts,
    total: commandsStore.total,
    updatedAt: commandsStore.updatedAt
  }, null, 2);
  const tmpPath = `${commandsFile}.tmp`;
  await fs.promises.writeFile(tmpPath, payload, 'utf8');
  await fs.promises.rename(tmpPath, commandsFile);
}

async function recordCommand(command) {
  const normalized = normalizeCommand(command);
  if (!normalized) {
    throw new Error('Invalid command');
  }
  if (!Object.prototype.hasOwnProperty.call(commandsStore.counts, normalized)) {
    commandsStore.counts[normalized] = 0;
  }
  commandsStore.counts[normalized] += 1;
  commandsStore.total += 1;
  commandsStore.updatedAt = new Date().toISOString();
  await persistCommandStore();
  return { command: normalized, count: commandsStore.counts[normalized] };
}

async function routeMessageToVoice(message) {
  const filterDecision = shouldFilterRouterMessage();
  if (filterDecision.filtered) {
    return filterDecision;
  }

  const explicit = detectExplicitAddress(message);
  if (explicit) {
    return { voice: explicit };
  }

  const systemPrompt = buildRouterSystemPrompt(conversationHistory);

  const completion = await openai.chat.completions.create({
    model: routerModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message }
    ],
    max_tokens: 20,
    temperature: 0
  });

  const content = completion.choices[0].message.content.trim();
  const parsed = parseRouterResponse(content, message);
  return { voice: parsed.voice };
}

function buildRouterSystemPrompt(history) {
  const chadProfile = voices.chad.basePrompt.trim();
  const virginProfile = voices.virgin.basePrompt.trim();
  const historySection = history.length
    ? `\n\nCONVERSATION HISTORY (most recent last):\n${history.join('\n')}`
    : '';

  return `You are an LLM router between two characters: "chad" and "virgin".
Your only task is to choose the best voice based on the message content and context.

CHARACTER PROFILES:
CHAD:
${chadProfile}

VIRGIN:
${virginProfile}

ROUTING RULES:
- If the user addresses one character to ask about the other (e.g., "what did chad say, virgin?"), route to the addressed character (Virgin in that example).
- If the user asks a question about Chad but does not address Virgin, route to Chad; likewise for Virgin.
- Prefer "virgin" for insults about being a loser, insecurity, awkwardness, timidity, or self-deprecation.
- Prefer "chad" for confidence, winning/success, dating wins, or asking Chad for advice.
- If unclear, choose the character whose personality best matches the user's tone.

Reply with JSON only: {"voice":"chad"} or {"voice":"virgin"}.` + historySection;
}

function parseRouterResponse(content, message) {
  const fallbackVoice = guessVoiceFromHeuristics(message);
  const clean = content.replace(/```json|```/gi, '').trim();
  try {
    const parsed = JSON.parse(clean);
    if (parsed.voice === 'chad' || parsed.voice === 'virgin') {
      return parsed;
    }
    if (typeof parsed.voice === 'string') {
      const normalized = parsed.voice.toLowerCase();
      if (normalized === 'chad' || normalized === 'virgin') {
        return { voice: normalized };
      }
    }
  } catch (error) {
    return { voice: fallbackVoice };
  }
  return { voice: fallbackVoice };
}

function detectExplicitAddress(text) {
  if (!text) return null;
  const lowered = text.toLowerCase();
  const hasChad = /\bchad\b/.test(lowered);
  const hasVirgin = /\bvirgin\b/.test(lowered);
  if (hasChad && !hasVirgin) return 'chad';
  if (hasVirgin && !hasChad) return 'virgin';

  // If both are mentioned, prefer the one being addressed (e.g., "... , virgin")
  if (hasChad && hasVirgin) {
    if (/(hey|hi|yo|sup|what's up|whats up|how are you|how're you|how r u|how you doing)\s+.*\bvirgin\b/.test(lowered)) {
      return 'virgin';
    }
    if (/(hey|hi|yo|sup|what's up|whats up|how are you|how're you|how r u|how you doing)\s+.*\bchad\b/.test(lowered)) {
      return 'chad';
    }
    if (/[,!?]\s*virgin\b/.test(lowered)) return 'virgin';
    if (/[,!?]\s*chad\b/.test(lowered)) return 'chad';
  }

  return null;
}

function guessVoiceFromHeuristics(text) {
  const lowered = text.toLowerCase();
  if (/\bvirgin\b/.test(lowered)) return 'virgin';
  if (/\bchad\b/.test(lowered)) return 'chad';
  if (lowered.includes('loser') || lowered.includes('awkward') || lowered.includes('insecure')) {
    return 'virgin';
  }
  if (lowered.includes('winning') || lowered.includes('money') || lowered.includes('success')) {
    return 'chad';
  }
  return 'chad';
}

function buildCharacterSystemPrompt(voiceConfig, model, memory, history) {
  const memorySection = memory
    ? `\n\nCONVERSATION MEMORY (use for continuity):\n${memory}\n\nAvoid repeating any "Recent anecdotes" unless the user asks to continue.`
    : '';
  const historySection = history && history.length
    ? `\n\nCONVERSATION HISTORY (most recent last):\n${history.join('\n')}`
    : '';
  const freshnessGuard = `\n\nSTYLE GUARDRAILS:\nAvoid repeating stock or clichéd anecdotes (e.g., helping a friend move and ending up owning a building). Keep each response fresh and aligned to the user's intent.`;
  const base = model === 'eleven_v3'
    ? voiceConfig.basePrompt + voiceConfig.audioTags
    : voiceConfig.basePrompt;
  return base + memorySection + historySection + freshnessGuard;
}

async function updateMemorySummary(voiceId, userMessage, assistantMessage) {
  const current = memoryStore[voiceId] || '';
  const prompt = `You update a compact memory summary for a character.
Keep it under ${memoryMaxChars} characters.
Only store stable facts, preferences, ongoing topics, and notable context.
Avoid storing sensitive data. Track and rotate "Recent anecdotes" to avoid repetition.

EXISTING MEMORY:
${current || '(empty)'}

NEW EXCHANGE:
User: ${userMessage}
Assistant: ${assistantMessage}

Write the updated memory as plain text with these sections:
Summary: <1-3 sentences>
Recent anecdotes: <comma-separated short phrases, max 3>
Topics to continue: <comma-separated short phrases, optional>`;

  const timeoutMs = 8000;
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Memory update timeout')), timeoutMs);
  });

  const completion = await Promise.race([
    openai.chat.completions.create({
      model: memoryModel,
      messages: [{ role: 'system', content: prompt }],
      max_tokens: 200,
      temperature: 0
    }),
    timeoutPromise
  ]);

  const updated = completion.choices[0].message.content.trim();
  if (!updated) return;
  memoryStore[voiceId] = updated.slice(0, memoryMaxChars);
}

function enqueueMemoryUpdate(voiceId, userMessage, assistantMessage) {
  memoryPending[voiceId] = { userMessage, assistantMessage };
  if (memoryUpdateInFlight) return;
  memoryUpdateInFlight = true;
  processMemoryQueue();
}

function appendConversationTurn(userMessage, assistantMessage, voiceId) {
  const speaker = voiceId === 'virgin' ? 'Virgin' : 'Chad';
  conversationHistory.push(`User: ${userMessage}`);
  conversationHistory.push(`${speaker}: ${assistantMessage}`);
}

function appendDialogueLine(speakerId, text, targetHistory) {
  const speaker = speakerId === 'virgin' ? 'Virgin' : 'Chad';
  targetHistory.push(`${speaker}: ${text}`);
}

function appendSystemNote(text) {
  conversationHistory.push(`System: ${text}`);
}

async function generateAutoScript(seed, turns, model, temperature) {
  const chadProfile = voices.chad.basePrompt.trim();
  const virginProfile = voices.virgin.basePrompt.trim();
  const intent = await deriveAutoIntent(seed, model);
  const intentJson = JSON.stringify(intent);
  const systemPrompt = `You are writing a scripted dialogue between Chad and Virgin from the Virgin vs Chad meme.
The seed's intent is the blueprint. Do not deviate from it at any point.
Respect archetypes, but never override the intent.
Alternate speakers each turn, starting with Chad.
Write exactly ${turns} turns.
Each line should be 1-3 sentences, no emojis, no markdown.
Output JSON only as an array of objects like:
[
  {"speaker":"chad","text":"..."},
  {"speaker":"virgin","text":"..."}
]
INTENT BLUEPRINT (must be followed exactly):
${intentJson}

CHARACTER PROFILES:
CHAD:
${chadProfile}

VIRGIN:
${virginProfile}`;

  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: seed }
    ],
    max_tokens: 1200,
    temperature
  });

  const content = completion.choices[0].message.content.trim();
  const parsed = parseJsonArray(content);
  if (!Array.isArray(parsed)) {
    throw new Error('Auto script is not a JSON array');
  }
  const validated = await validateAutoScript(parsed, intent, model);
  return validated;
}

async function deriveAutoIntent(seed, model) {
  const prompt = `Extract an intent blueprint for a scripted dialogue.
Return JSON only with:
{
  "scenario": "<1 sentence>",
  "dynamics": "<1-2 sentences describing who leads/targets/frames the exchange>",
  "tone": "<short description>",
  "constraints": ["<short, non-negotiable rules>"]
}
Make constraints strong enough to prevent drift. Do not mention "Chad" or "Virgin" in constraints unless the seed requires it.`;

  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: seed }
    ],
    max_tokens: 200,
    temperature: 0
  });

  const content = completion.choices[0].message.content.trim();
  const parsed = parseJsonObject(content);
  if (!parsed || typeof parsed !== 'object') {
    return {
      scenario: seed.slice(0, 160),
      dynamics: 'Follow the seed exactly without drifting.',
      tone: 'As implied by the seed.',
      constraints: ['Do not deviate from the seed intent.']
    };
  }
  return parsed;
}

function parseJsonObject(content) {
  const clean = content.replace(/```json|```/gi, '').trim();
  try {
    return JSON.parse(clean);
  } catch (error) {
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(clean.slice(start, end + 1));
      } catch (innerError) {
        return null;
      }
    }
    return null;
  }
}

async function validateAutoScript(script, intent, model) {
  const prompt = `You are a strict validator. Check if the dialogue follows the intent blueprint.
If it fully complies, reply with: {"ok":true}
If not, reply with: {"ok":false,"issues":["..."],"fix":"<short instruction to rewrite>"}
Be concise and strict.`;

  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: JSON.stringify({ intent, script }) }
    ],
    max_tokens: 120,
    temperature: 0
  });

  const verdict = parseJsonObject(completion.choices[0].message.content.trim());
  if (verdict && verdict.ok === true) {
    return script;
  }

  const fix = verdict && verdict.fix ? verdict.fix : 'Rewrite to follow the intent blueprint without drift.';
  return rewriteAutoScript(script, intent, model, fix);
}

async function rewriteAutoScript(script, intent, model, fix) {
  const systemPrompt = `Rewrite this dialogue to strictly follow the intent blueprint.
Keep the number of turns and speakers, but fix any drift.
Output JSON only as an array of objects with speaker/text.`;

  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify({ intent, fix, script }) }
    ],
    max_tokens: 1200,
    temperature: 0.5
  });

  const content = completion.choices[0].message.content.trim();
  const parsed = parseJsonArray(content);
  if (!Array.isArray(parsed)) {
    return script;
  }
  return parsed;
}

function parseJsonArray(content) {
  const clean = content.replace(/```json|```/gi, '').trim();
  try {
    return JSON.parse(clean);
  } catch (error) {
    const start = clean.indexOf('[');
    const end = clean.lastIndexOf(']');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(clean.slice(start, end + 1));
      } catch (innerError) {
        return null;
      }
    }
    return null;
  }
}

async function playAutoScript(script, autoId) {
  const total = script.length;
  let index = 0;
  for (const entry of script) {
    if (autoId !== autoConversation.id) {
      return;
    }
    const speakerId = String(entry.speaker || '').toLowerCase();
    const text = String(entry.text || '').trim();
    if (!text) continue;

    const voiceConfig = voices[speakerId];
    if (!voiceConfig) continue;

    index += 1;
    try {
      const elevenLabsResponse = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceConfig.elevenLabsVoiceId}`,
        {
          text,
          model_id: autoTtsModel,
          voice_settings: voiceConfig.voiceSettings
        },
        {
          headers: {
            'Accept': 'audio/mpeg',
            'Content-Type': 'application/json',
            'xi-api-key': process.env.ELEVENLABS_API_KEY
          },
          responseType: 'arraybuffer'
        }
      );

      const form = new FormData();
      form.append('audio', Buffer.from(elevenLabsResponse.data), {
        filename: 'audio.mp3',
        contentType: 'audio/mpeg'
      });
      form.append('character', speakerId);
      form.append('message', text);
      form.append('mode', 'router');

      const renderUrl = `${animationServerUrl}/render`;
      console.log('[Auto] Posting to ' + renderUrl + ' (turn ' + index + '/' + total + ', ' + speakerId + ')');
      await axios.post(renderUrl, form, {
        headers: form.getHeaders()
      });

      appendDialogueLine(speakerId, text, autoConversation.history);
    } catch (err) {
      console.error('[Auto] Playback failed (turn ' + index + '/' + total + '):', err.message);
      if (err.response) {
        console.error('[Auto] Response status:', err.response.status, err.response.data);
      }
      throw err;
    }
  }
}

async function processMemoryQueue() {
  const voiceIds = Object.keys(memoryPending);
  let didWork = false;

  for (const voiceId of voiceIds) {
    const payload = memoryPending[voiceId];
    if (!payload) continue;
    memoryPending[voiceId] = null;
    didWork = true;
    try {
      await updateMemorySummary(voiceId, payload.userMessage, payload.assistantMessage);
    } catch (err) {
      console.warn('[Memory] Update failed:', err.message);
    }
  }

  if (didWork) {
    setImmediate(processMemoryQueue);
    return;
  }

  memoryUpdateInFlight = false;
}
