require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const OpenAI = require('openai');
const axios = require('axios');
const voices = require('./voices');

const app = express();
const port = process.env.PORT || 3002;
const routerModel = process.env.ROUTER_MODEL || process.env.MODEL || 'gpt-4o-mini';
const routerMaxPerSecond = parseInt(process.env.ROUTER_MAX_PER_SECOND || '3', 10);
const routerMaxPerMinute = parseInt(process.env.ROUTER_MAX_PER_MINUTE || '30', 10);
const routerTimestamps = [];

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

    // Build system prompt - add audio tags only for v3
    const systemPrompt = model === 'eleven_v3'
      ? voiceConfig.basePrompt + voiceConfig.audioTags
      : voiceConfig.basePrompt;

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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', platform: process.platform });
});

// Serve frontend index
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

app.listen(port, () => {
  console.log(`API server running on http://localhost:${port}`);
  console.log(`Platform: ${process.platform}`);
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

async function routeMessageToVoice(message) {
  const filterDecision = shouldFilterRouterMessage();
  if (filterDecision.filtered) {
    return filterDecision;
  }

  const directAddress = detectDirectAddress(message);
  if (directAddress) {
    return { voice: directAddress };
  }

  const systemPrompt = buildRouterSystemPrompt();

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

function detectDirectAddress(text) {
  const lowered = text.toLowerCase();
  const hasVirgin = /\bvirgin\b/.test(lowered);
  const hasChad = /\bchad\b/.test(lowered);

  if (hasVirgin && !hasChad) return 'virgin';
  if (hasChad && !hasVirgin) return 'chad';
  return null;
}

function buildRouterSystemPrompt() {
  const chadProfile = voices.chad.basePrompt.trim();
  const virginProfile = voices.virgin.basePrompt.trim();

  return `You are an LLM router between two characters: "chad" and "virgin".
Your only task is to choose the best voice based on the message content and context.

CHARACTER PROFILES:
CHAD:
${chadProfile}

VIRGIN:
${virginProfile}

ROUTING RULES:
- If the message directly addresses "chad" or "virgin" (e.g., "hi virgin"), route to that character. This rule has highest priority.
- Prefer "virgin" for insults about being a loser, insecurity, awkwardness, timidity, or self-deprecation.
- Prefer "chad" for confidence, winning/success, dating wins, or asking Chad for advice.
- If unclear, choose the character whose personality best matches the user's tone.

Reply with JSON only: {"voice":"chad"} or {"voice":"virgin"}.`;
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

function guessVoiceFromHeuristics(text) {
  const lowered = text.toLowerCase();
  const direct = detectDirectAddress(text);
  if (direct) return direct;
  if (lowered.includes('loser') || lowered.includes('awkward') || lowered.includes('insecure')) {
    return 'virgin';
  }
  if (lowered.includes('winning') || lowered.includes('money') || lowered.includes('success')) {
    return 'chad';
  }
  return 'chad';
}
