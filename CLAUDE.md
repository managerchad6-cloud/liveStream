# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LiveStream Chatbox MVP - A minimal web application providing a chatbox interface for real-time chat that integrates with OpenAI API for conversational responses and ElevenLabs API for text-to-speech. Designed to simulate a livestream host responding casually in chat.

Tech stack: Node.js/Express backend, vanilla HTML/CSS/JS frontend, no build step.

## Development Commands

```bash
npm install          # Install dependencies (one time)
npm start            # Start server (node server.js) - runs on port 3000
```

## Environment Variables

Create `.env` file with:
```
OPENAI_API_KEY=your_api_key_here
ELEVENLABS_API_KEY=your_elevenlabs_api_key_here
MODEL=gpt-4o-mini
PORT=3000
```

## Architecture

**Backend (`server.js`):**
- Express server with single `POST /chat` endpoint
- OpenAI integration: Uses gpt-4o-mini with "livestream host" system prompt, max 150 tokens, temp 0.7
- ElevenLabs TTS: Rachel voice (21m00Tcm4TlvDq8ikWAM), eleven_turbo_v2 model
- Returns raw MP3 audio as response (Content-Type: audio/mpeg)

**Frontend (`public/index.html`):**
- Two-column layout: 16:9 viewport placeholder (left), chatbox (right)
- Dark theme, vanilla JS
- Sends message to `/chat`, receives and auto-plays MP3 blob response

**API Contract:**
- Request: `POST /chat` with `{ "message": "string" }`
- Response: Raw MP3 audio blob

## VPS Deployment

Scripts in `vps-setup/` provide bidirectional git sync:
- `setup-livestream.sh` - One-time VPS setup (installs deps, clones repo, sets up systemd service)
- `livestream-sync.sh` - Daemon that pulls remote changes every 5 seconds and auto-commits local changes
- `livestream-sync.service` - systemd unit file

Service commands:
```bash
sudo systemctl start|stop|restart|status livestream-sync
sudo journalctl -u livestream-sync -f    # View logs
```

## Git Workflow

From `.cursorrules`:
- Auto-commit and push after task completion (unless told not to)
- Use present tense commit messages: "Add feature" not "Added feature"
- Be specific: "Add voice selection dropdown", "Fix audio playback error handling"

Deployment scripts:
```bash
./git-push.sh "Description of changes"    # Bash
./git-push.ps1 "Description of changes"   # PowerShell
```

Main branch: `master`
