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

### Frontend (`public/index.html`)

- Two-column layout: 16:9 viewport placeholder (left), chatbox (right)
- Dark theme, vanilla JS
- Controls: Voice selector, Model selector (v3/v2), Temperature slider
- Auto-plays MP3 response

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

- `server.js` - Express server, API endpoints
- `voices.js` - Voice configurations (prompts, ElevenLabs settings)
- `webhook.js` - Standalone GitHub webhook listener
- `public/index.html` - Frontend UI
- `.env` - API keys and config (not in repo)
