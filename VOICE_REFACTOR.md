# Voice System Refactor Specification

## Overview

Add support for two distinct voice personalities: **Chad** and **Virgin**. Each voice has its own personality configuration that controls how OpenAI generates text, and a corresponding ElevenLabs voice ID for text-to-speech.

## File Changes Required

### 1. Create `voices.js` - Voice Configuration Module

Create a new file `/home/liveStream/voices.js`:

```javascript
const voices = {
  chad: {
    name: 'Chad',
    elevenLabsVoiceId: 'ErXwobaYiN019PkySvjV', // Antoni - confident male voice
    systemPrompt: `You are Chad, a supremely confident alpha male livestream host. Your traits:
- Extremely self-assured, borderline arrogant but in a charming way
- Uses bro-speak and gym culture references naturally
- Gives advice like everyone should already know this stuff
- Short, punchy responses with masculine energy
- Occasionally references gains, lifting, success, winning
- Never apologizes or shows weakness
- Talks like everything is easy and obvious
Keep responses under 2 sentences. No emojis, no markdown.`,
    voiceSettings: {
      stability: 0.3,        // Lower = more expressive/varied
      similarity_boost: 0.7,
      style: 0.5,
      use_speaker_boost: true
    }
  },
  virgin: {
    name: 'Virgin',
    elevenLabsVoiceId: '21m00Tcm4TlvDq8ikWAM', // Rachel - softer voice
    systemPrompt: `You are Virgin, a nervous, socially awkward livestream host. Your traits:
- Uncertain and self-doubting, often second-guesses yourself
- Overthinks everything, adds unnecessary qualifiers
- Uses filler words like "um", "uh", "I guess", "maybe", "I think"
- Apologizes frequently even when not needed
- References staying inside, anime, gaming, being shy
- Speaks in a hesitant, rambling way
- Gets flustered easily
Keep responses under 3 sentences. No emojis, no markdown.`,
    voiceSettings: {
      stability: 0.7,        // Higher = more consistent/nervous
      similarity_boost: 0.5,
      style: 0.3,
      use_speaker_boost: false
    }
  }
};

module.exports = voices;
```

### 2. Update `server.js` - Backend Changes

#### Import voices module at top:
```javascript
const voices = require('./voices');
```

#### Remove old constants:
- Delete `SYSTEM_PROMPT` constant
- Delete `ELEVENLABS_VOICE_ID` constant

#### Modify POST /chat endpoint:

Change the request body to accept a `voice` parameter:
```javascript
const { message, voice = 'chad' } = req.body;
```

Add voice validation after message validation:
```javascript
const voiceConfig = voices[voice];
if (!voiceConfig) {
  return res.status(400).json({ error: 'Invalid voice. Use "chad" or "virgin"' });
}
```

Update OpenAI call to use voice-specific system prompt:
```javascript
messages: [
  { role: 'system', content: voiceConfig.systemPrompt },
  { role: 'user', content: message }
]
```

Update ElevenLabs call to use voice-specific settings:
```javascript
const elevenLabsResponse = await axios.post(
  `https://api.elevenlabs.io/v1/text-to-speech/${voiceConfig.elevenLabsVoiceId}`,
  {
    text: replyText,
    model_id: 'eleven_turbo_v2',
    voice_settings: voiceConfig.voiceSettings
  },
  // ... rest stays the same
);
```

#### Add GET /voices endpoint (for frontend to fetch available voices):
```javascript
app.get('/voices', (req, res) => {
  const voiceList = Object.entries(voices).map(([id, config]) => ({
    id,
    name: config.name
  }));
  res.json(voiceList);
});
```

### 3. Update `public/index.html` - Frontend Changes

#### Add voice selector in the chat-container, after the h1:
```html
<div class="voice-selector">
  <label for="voiceSelect">Voice:</label>
  <select id="voiceSelect">
    <option value="chad">Chad</option>
    <option value="virgin">Virgin</option>
  </select>
</div>
```

#### Add CSS for voice selector (in the style section):
```css
.voice-selector {
  display: flex;
  align-items: center;
  gap: 10px;
}

.voice-selector label {
  color: #888;
  font-size: 14px;
}

#voiceSelect {
  padding: 8px 12px;
  border: 1px solid #404040;
  border-radius: 4px;
  background-color: #2d2d2d;
  color: #e0e0e0;
  font-size: 14px;
  cursor: pointer;
}

#voiceSelect:focus {
  outline: none;
  border-color: #007bff;
}
```

#### Update JavaScript sendMessage function:

Add voice selector reference at top of script:
```javascript
const voiceSelect = document.getElementById('voiceSelect');
```

Modify fetch body to include voice:
```javascript
body: JSON.stringify({
  message,
  voice: voiceSelect.value
}),
```

## API Contract

### POST /chat
Request:
```json
{
  "message": "string (required)",
  "voice": "chad | virgin (optional, defaults to chad)"
}
```

Response: Raw MP3 audio blob

### GET /voices
Response:
```json
[
  { "id": "chad", "name": "Chad" },
  { "id": "virgin", "name": "Virgin" }
]
```

## ElevenLabs Voice IDs

These are real ElevenLabs voice IDs:
- **Chad**: `ErXwobaYiN019PkySvjV` (Antoni - confident male)
- **Virgin**: `21m00Tcm4TlvDq8ikWAM` (Rachel - can work for nervous character)

Alternative voice IDs if needed:
- `pNInz6obpgDQGcFmaJgB` - Adam (male)
- `yoZ06aMxZJJ28mfd3POQ` - Sam (male)
- `VR6AewLTigWG4xSOukaG` - Arnold (deep male)

## Testing

After implementation:
1. Start server: `npm start`
2. Open browser to localhost:3000
3. Select "Chad" voice, send a message - should get confident response
4. Select "Virgin" voice, send a message - should get nervous, hesitant response
5. Verify different ElevenLabs voices are used for each

## Notes

- The voice configuration is extensible - add more voices by adding entries to the `voices` object
- Voice settings in ElevenLabs: lower stability = more expressive, higher = more consistent
- Keep system prompts focused on speech patterns and personality, not content restrictions
