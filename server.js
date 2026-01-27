require('dotenv').config();
const express = require('express');
const path = require('path');
const OpenAI = require('openai');
const axios = require('axios');
const voices = require('./voices');

const app = express();
const port = process.env.PORT || 3000;

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// GET /voices endpoint
app.get('/voices', (req, res) => {
  const voiceList = Object.entries(voices).map(([id, config]) => ({
    id,
    name: config.name
  }));
  res.json(voiceList);
});

// POST /chat endpoint
app.post('/chat', async (req, res) => {
  try {
    const { message, voice = 'chad' } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required and must be a string' });
    }

    // Validate voice
    const voiceConfig = voices[voice];
    if (!voiceConfig) {
      return res.status(400).json({ error: 'Invalid voice. Use "chad" or "virgin"' });
    }

    // Call OpenAI API to get text response
    const completion = await openai.chat.completions.create({
      model: process.env.MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: voiceConfig.systemPrompt },
        { role: 'user', content: message }
      ],
      max_tokens: 150, // Keep responses short
      temperature: 0.7,
    });

    const replyText = completion.choices[0].message.content;

    // Convert text to speech using ElevenLabs
    const elevenLabsResponse = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceConfig.elevenLabsVoiceId}`,
      {
        text: replyText,
        model_id: 'eleven_turbo_v2',
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

    // Return audio as MP3
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(elevenLabsResponse.data);
  } catch (error) {
    console.error('Error:', error.response?.data ? Buffer.from(error.response.data).toString() : error.message);
    if (error.response) {
      const errorText = Buffer.from(error.response.data).toString();
      console.error('ElevenLabs API Error:', errorText);
      return res.status(500).json({ error: `ElevenLabs API error: ${errorText}` });
    }
    res.status(500).json({ error: 'Failed to generate response' });
  }
});

// Serve index.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
