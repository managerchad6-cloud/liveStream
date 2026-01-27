require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const OpenAI = require('openai');
const axios = require('axios');
const voices = require('./voices');

const app = express();
const port = process.env.PORT || 3002;

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
    const { message, voice = 'chad', model = 'eleven_v3', temperature = 0.7 } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required and must be a string' });
    }

    const voiceConfig = voices[voice];
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
