# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LiveStream Chatbox MVP - A web application providing a chatbox interface with two distinct AI personalities (Chad and Virgin from the Virgin vs Chad meme). Integrates OpenAI API for conversational responses and ElevenLabs API for text-to-speech with expressive audio tags.

Tech stack: Node.js/Express backend, vanilla HTML/CSS/JS frontend, no build step.

## Development Commands

```bash
npm install          # Install dependencies (one time)
npm start            # Start server (node server.js)
```

## Environment Variables

Create `.env` file with:
```
OPENAI_API_KEY=your_api_key_here
ELEVENLABS_API_KEY=your_elevenlabs_api_key_here
GITHUB_WEBHOOK_SECRET=your_webhook_secret_here
MODEL=gpt-4o-mini
PORT=3002
```

## Architecture

### Backend (`server.js`)

**Endpoints:**
- `POST /chat` - Main chat endpoint
- `GET /voices` - Returns available voice options

**Request body for `/chat`:**
```json
{
  "message": "string",
  "voice": "chad | virgin",
  "model": "eleven_v3 | eleven_turbo_v2",
  "temperature": 0.0-1.0
}
```

**Response:** Raw MP3 audio blob

### Voice System (`voices.js`)

Two personalities based on the Virgin vs Chad meme:

**Chad:**
- Effortlessly successful, things just work out
- Casual humble brags, funny anecdotes
- Charming and likeable, not arrogant
- Audio tags (v3 only): `[chuckles]`, `[laughs]`, `[sighs contentedly]`

**Virgin:**
- Chronically insecure, overthinks everything
- Stammering delivery with "um", "uh", qualifiers
- Self-deprecating humor, apologizes randomly
- Audio tags (v3 only): `[nervous laugh]`, `[sighs]`, `[clears throat]`, `[mumbles]`

### ElevenLabs Models

- **eleven_v3**: Expressive model with audio tag support (tags like `[laughs]` are interpreted)
- **eleven_turbo_v2**: Faster model, no audio tags (tags stripped from prompt automatically)

v3 stability values must be: `0.0` (Creative), `0.5` (Natural), or `1.0` (Robust)

### Frontend (`frontend/`)

- Two-column layout: 16:9 video viewport (left), chatbox (right)
- Dark theme, vanilla JS
- Controls: Voice selector, Model selector (v2 turbo default), Temperature slider
- HLS.js video player for live animation stream
- Audio synced into video stream (no separate audio player)

### Animation Server (`animation-server/`)

Separate Express server that renders animated characters with real-time lip sync.

**Port:** 3003 (set via `ANIMATION_PORT` env var)

**Key endpoints:**
- `POST /render` - Receive audio, start lip-synced animation
- `GET /streams/live/stream.m3u8` - HLS live stream
- `GET /health` - Server status

**Environment variables:**
- `LIPSYNC_MODE`: `realtime` (default) or `rhubarb` (legacy)
- `STREAM_MODE`: `synced` (audio in video) or `separate`

**Key files:**
- `server.js` - Main Express server
- `compositor.js` - Sharp-based frame compositing with caching
- `continuous-stream-manager.js` - FFmpeg HLS streaming with audio muxing
- `realtime-lipsync.js` - Real-time phoneme detection (90Hz analysis)
- `synced-playback.js` - Frame-synchronized audio playback
- `audio-decoder.js` - FFmpeg pipe-based audio decoding

**How it works:**
1. Audio received via `/render` endpoint
2. Decoded to PCM samples (pipe, no temp file)
3. Calibrated on first 1s of audio
4. Fed to continuous FFmpeg process (video + audio pipes)
5. Real-time phoneme detection at 90Hz (3x per video frame)
6. Frame compositor uses caching for identical states
7. HLS stream with 2-second segments at 720p 15fps

**Systemd service:**
```bash
sudo systemctl status|start|stop|restart animation
sudo journalctl -u animation -f
```

## VPS Deployment

**Production URL:** `http://93.127.214.75:3002`

### Systemd Services

**Main app (`livestream.service`):**
```bash
sudo systemctl status|start|stop|restart livestream
sudo journalctl -u livestream -f
```

**GitHub webhook (`webhook.service`):**
- Listens on port 3001 for GitHub push events
- Auto-pulls changes when triggered
```bash
sudo systemctl status|start|stop|restart webhook
sudo journalctl -u webhook -f
```

### Service Files Location
- `/home/liveStream/vps-setup/livestream.service`
- `/home/liveStream/vps-setup/webhook.service`

### GitHub Webhook Setup
1. Webhook URL: `http://93.127.214.75:3001/webhook`
2. Content type: `application/json`
3. Secret: Must match `GITHUB_WEBHOOK_SECRET` in `.env`
4. Events: Just the push event

## Git Workflow

From `.cursorrules`:
- Auto-commit and push after task completion (unless told not to)
- Use present tense commit messages: "Add feature" not "Added feature"
- Be specific: "Add voice selection dropdown", "Fix audio playback error handling"

Main branch: `master`

## Key Files

**Chat API:**
- `server.js` - Express server, chat API endpoints
- `voices.js` - Voice configurations (prompts, ElevenLabs settings)
- `webhook.js` - Standalone GitHub webhook listener

**Frontend:**
- `frontend/index.html` - Main UI
- `frontend/app.js` - Chat logic, HLS player
- `frontend/config.js` - Server URLs

**Animation Server:**
- `animation-server/server.js` - Animation API server
- `animation-server/compositor.js` - Frame rendering with Sharp
- `animation-server/continuous-stream-manager.js` - FFmpeg HLS streaming
- `animation-server/realtime-lipsync.js` - Phoneme detection
- `exported-layers/` - Character PSD layers as PNGs

**Config:**
- `.env` - API keys and config (not in repo)
