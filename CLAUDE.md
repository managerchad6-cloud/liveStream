# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LiveStream Chatbox** - An animated chatbot with real-time lip-synced characters (Chad and Virgin from the Virgin vs Chad meme). Features OpenAI for conversation, ElevenLabs for TTS, and a custom animation system with HLS video streaming.

**Tech Stack:** Node.js/Express, Sharp (image compositing), FFmpeg (video encoding), HLS.js (video playback), vanilla HTML/CSS/JS frontend.

## Architecture

The system consists of **two separate servers**:

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│    Frontend     │────▶│   Chat API       │     │ Animation Server│
│  (HLS Player)   │     │   (Port 3002)    │     │   (Port 3003)   │
│                 │────▶│                  │     │                 │
│                 │◀────────────────────────────▶│  HLS Stream     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

1. **Chat API Server** (port 3002): Handles OpenAI chat + ElevenLabs TTS
2. **Animation Server** (port 3003): Renders animated characters, produces HLS video stream

## Directory Structure

```
/home/liveStream/
├── server.js              # Chat API server (OpenAI + ElevenLabs)
├── voices.js              # Character personalities and voice configs
├── webhook.js             # GitHub webhook for auto-deploy
├── package.json           # Main dependencies
│
├── frontend/              # Web UI
│   ├── index.html         # Main page with HLS video player
│   ├── app.js             # Chat logic, HLS.js player setup
│   ├── config.js          # Server URL configuration
│   └── style.css          # Styles
│
├── animation-server/      # Animation rendering server
│   ├── server.js          # Express server, /render endpoint
│   ├── compositor.js      # Sharp-based frame compositing
│   ├── continuous-stream-manager.js  # FFmpeg HLS streaming
│   ├── realtime-lipsync.js    # Real-time phoneme detection
│   ├── synced-playback.js     # Frame-synchronized audio
│   ├── audio-decoder.js       # FFmpeg pipe-based decoding
│   ├── blink-controller.js    # Natural blinking animation
│   ├── platform.js            # Cross-platform path helpers
│   └── package.json           # Animation server dependencies
│
├── exported-layers/       # Character PSD layers as PNGs
│   ├── manifest.json      # Layer metadata (positions, z-index)
│   ├── chad/              # Chad character layers
│   │   ├── mouth/         # Phoneme mouth shapes (A-H)
│   │   └── *.png          # Body, face, eyes, blink layers
│   └── virgin/            # Virgin character layers
│       ├── mouth/
│       └── *.png
│
├── streams/               # Runtime: HLS output
│   └── live/              # Live stream segments (.ts) and playlist (.m3u8)
│
├── tools/
│   └── export-psd.js      # Extract layers from Stream.psd
│
├── vps-setup/             # Systemd service files
│   ├── livestream.service # Chat API service
│   ├── animation.service  # Animation server service
│   └── webhook.service    # GitHub webhook service
│
└── Stream.psd             # Source Photoshop file with all layers
```

## Development Commands

```bash
# Install dependencies (both servers)
npm install
cd animation-server && npm install

# Run chat API server
npm start                    # Port 3002

# Run animation server
npm run animation            # Port 3003

# Run both servers
npm run dev

# Export layers from PSD (after modifying Stream.psd)
npm run export-psd
```

## Environment Variables

Create `.env` in project root:
```
OPENAI_API_KEY=sk-...
ELEVENLABS_API_KEY=...
MODEL=gpt-4o-mini
PORT=3002
```

Animation server environment (set in service or shell):
```
ANIMATION_PORT=3003
LIPSYNC_MODE=realtime       # or 'rhubarb' (legacy)
STREAM_MODE=synced          # or 'separate'
```

## API Endpoints

### Chat API Server (Port 3002)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/chat` | POST | Send message, get audio response |
| `/api/voices` | GET | List available voices |
| `/api/health` | GET | Health check |
| `/` | GET | Serve frontend |

**POST /api/chat:**
```json
{
  "message": "Hello!",
  "voice": "chad",              // or "virgin"
  "model": "eleven_turbo_v2",   // or "eleven_v3" (expressive)
  "temperature": 0.7
}
```
Returns: `audio/mpeg` blob

### Animation Server (Port 3003)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/render` | POST | Submit audio for lip-synced animation |
| `/streams/live/stream.m3u8` | GET | HLS live stream playlist |
| `/health` | GET | Health check |

**POST /render:**
- Content-Type: `multipart/form-data`
- Fields: `audio` (file), `character` (string)
- Returns: `{ streamUrl, duration, streamMode }`

## Voice System

Two personalities in `voices.js`:

### Chad
- ElevenLabs Voice ID: `nPczCjzI2devNBz1zQrb`
- Personality: Effortlessly successful, casual humble brags, charming
- Voice Settings: stability=0.0, similarity=0.8, style=0.6
- Audio tags (v3 only): `[chuckles]`, `[laughs]`, `[sighs contentedly]`

### Virgin
- ElevenLabs Voice ID: `mrQhZWGbb2k9qWJb5qeA`
- Personality: Insecure, overthinks, stammering, self-deprecating
- Voice Settings: stability=1.0, similarity=0.5, style=0.2
- Audio tags (v3 only): `[nervous laugh]`, `[sighs]`, `[clears throat]`

### TTS Models
- **eleven_turbo_v2** (default): Fast, no audio tag support
- **eleven_v3**: Expressive, interprets audio tags like `[laughs]`

## Animation System

### How It Works
1. Audio uploaded to `/render` endpoint
2. Decoded to PCM via FFmpeg pipe (no temp files)
3. Calibrated on first 1 second of audio
4. Fed to continuous FFmpeg process
5. Real-time phoneme detection at 90Hz
6. Frame compositor renders characters with mouth/blink states
7. Output as HLS stream (720p @ 15fps, 2-second segments)

### Phoneme Detection (Preston Blair Set)
| Phoneme | Mouth Shape | Sound |
|---------|-------------|-------|
| A | Closed | Silence, M, B, P |
| B | Slightly open | Soft sounds |
| C | Open with teeth | E, I |
| D | Wide open | A, AH |
| E | Rounded | O |
| F | Teeth on lip | F, V |
| G | Tongue behind teeth | TH, L |
| H | Wide with tongue | L |

### Compositor Features
- Pre-composited static base image
- Frame caching for identical states (huge performance boost)
- Renders at 1/3 scale (1280x720 from 3840x2160 source)
- JPEG output at quality 80

### Stream Configuration
- Resolution: 1280x720
- Framerate: 15fps (sufficient for character animation)
- Segment duration: 2 seconds
- Codec: H.264 (libx264 ultrafast)
- Audio: AAC 128kbps, stereo, 44.1kHz

## VPS Deployment

**Production URL:** `http://93.127.214.75`
- Chat API: Port 3002
- Animation: Port 3003

### Systemd Services

```bash
# Chat API
sudo systemctl status|start|stop|restart livestream
sudo journalctl -u livestream -f

# Animation Server
sudo systemctl status|start|stop|restart animation
sudo journalctl -u animation -f

# GitHub Webhook (auto-deploy on push)
sudo systemctl status|start|stop|restart webhook
sudo journalctl -u webhook -f
```

### Service Files
Located in `/home/liveStream/vps-setup/`:
- `livestream.service` - Chat API (port 3002)
- `animation.service` - Animation server (port 3003)
- `webhook.service` - GitHub webhook (port 3001)

### GitHub Webhook
- URL: `http://93.127.214.75:3001/webhook`
- Content type: `application/json`
- Secret: Must match `GITHUB_WEBHOOK_SECRET` in `.env`
- Events: Push only

## Frontend Configuration

`frontend/config.js` auto-detects environment:
- **Production**: Uses same origin for API, explicit IP for animation
- **Local**: Uses localhost:3002 and localhost:3003
- **File protocol**: Uses explicit localhost URLs

## Adding/Modifying Characters

1. Edit `Stream.psd` in Photoshop
2. Layer naming convention:
   - `static_<character>_<part>` - Static body parts
   - `mouth_<character>_<phoneme>` - Mouth shapes (A-H)
   - `blink_<character>_closed` - Blink overlay
3. Run `npm run export-psd` to regenerate layers
4. Restart animation server

## Git Workflow

- Main branch: `master`
- Auto-deploy via webhook on push
- Commit style: Present tense, specific ("Add feature" not "Added feature")

## Key Performance Notes

- Frame caching eliminates redundant compositing for idle frames
- Pipe-based audio decoding avoids disk I/O
- Calibration limited to first 1 second for speed
- 90Hz phoneme detection captures fast speech
- 2-second HLS segments balance latency vs encoding stability
