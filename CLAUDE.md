# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LiveStream Chatbox** - An animated chatbot with real-time lip-synced characters (Chad and Virgin from the Virgin vs Chad meme). Features OpenAI for conversation, ElevenLabs for TTS, and a custom animation system with HLS video streaming. Includes an in-scene TV with controllable video/image playlist.

**Tech Stack:** Node.js/Express, Sharp (image compositing), FFmpeg (video encoding/decoding), HLS.js (video playback), vanilla HTML/CSS/JS frontend.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│    Frontend     │────▶│   Chat API       │────▶│ Animation Server│
│  (HLS Player)   │     │   (Port 3002)    │     │   (Port 3003)   │
│                 │◀────────────────────────────▶│  HLS Stream     │
│  TV Control     │────────────────────────────▶│  TV Content     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

1. **Chat API Server** (port 3002): OpenAI chat, ElevenLabs TTS, conversation memory, voice routing
2. **Animation Server** (port 3003): Frame compositing, lip-sync, HLS streaming, TV content

## Directory Structure

```
/home/liveStream/
├── server.js              # Chat API server (OpenAI + ElevenLabs + routing)
├── voices.js              # Character personalities and voice configs
├── webhook-server.js      # GitHub webhook for auto-deploy
├── package.json           # Main dependencies
├── .env                   # Environment variables (API keys)
│
├── frontend/              # Web UI
│   ├── index.html         # Main chat interface with HLS player
│   ├── app.js             # Chat logic, HLS.js setup, delay controls
│   ├── config.js          # Environment detection for API URLs
│   ├── style.css          # Dark theme styling
│   └── tv-control.html    # TV content control panel
│
├── animation-server/      # Animation rendering server
│   ├── server.js          # Express server, render + TV content APIs
│   ├── compositor.js      # Sharp-based frame compositing
│   ├── continuous-stream-manager.js  # Persistent FFmpeg HLS streaming
│   ├── stream-manager.js  # Legacy stream manager
│   ├── realtime-lipsync.js    # Real-time phoneme detection
│   ├── synced-playback.js     # Frame-synchronized audio playback
│   ├── audio-decoder.js       # FFmpeg pipe-based PCM decoding
│   ├── blink-controller.js    # Natural random blinking
│   ├── state.js               # Animation state (legacy rhubarb mode)
│   ├── platform.js            # Cross-platform FFmpeg/Rhubarb paths
│   ├── package.json           # Animation server dependencies
│   └── tv-content/            # TV content service
│       ├── index.js           # TVContentService class
│       └── video-decoder.js   # Video frame extraction
│
├── exported-layers/       # Character PSD layers as PNGs (3840x2160)
│   ├── manifest.json      # Layer metadata (positions, z-index, types)
│   ├── mask.png           # TV viewport boundary mask
│   ├── TV_Reflection_.png # TV screen reflection overlay
│   ├── Background_.png    # Scene background
│   ├── Table.png          # Table prop
│   ├── Portatil.png       # Laptop prop
│   ├── chad/              # Chad character layers
│   │   ├── static_chad_*.png   # Body, face, eyes, chair
│   │   ├── blink_chad_closed.png
│   │   └── mouth/         # mouth_chad_A.png through H, smile, surprise
│   └── virgin/            # Virgin character layers
│       ├── static_virgin_*.png
│       ├── blink_virgin_closed.png
│       └── mouth/         # mouth_virgin_A.png through H, smile, surprise
│
├── streams/               # Runtime output
│   ├── live/              # HLS segments (.ts) and playlist (.m3u8)
│   └── audio/             # Decoded audio files (separate mode)
│
├── tools/
│   └── export-psd.js      # Extract layers from Stream.psd
│
├── vps-setup/             # Systemd service files
│   ├── livestream.service # Chat API service
│   ├── animation.service  # Animation server service
│   └── webhook.service    # GitHub webhook service
│
└── Stream.psd             # Source Photoshop file (~34MB)
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

# Run both servers concurrently
npm run dev

# Export layers from PSD (after modifying Stream.psd)
npm run export-psd

# Git shortcuts
npm run commit               # git add + commit
npm run push                 # git push to master
```

## Environment Variables

### Chat API Server (.env in project root)

```bash
# Required
OPENAI_API_KEY=sk-...              # OpenAI API key
ELEVENLABS_API_KEY=...             # ElevenLabs TTS key

# Server
PORT=3002                          # Chat server port

# LLM Models
MODEL=gpt-4o-mini                  # Default LLM for all modes
ROUTER_MODEL=gpt-4o-mini           # Voice routing decisions (router mode)
AUTO_MODEL=gpt-4o-mini             # Auto conversation generation
MEMORY_MODEL=gpt-4o-mini           # Memory summarization

# TTS
AUTO_TTS_MODEL=eleven_turbo_v2     # TTS model for auto mode

# Rate Limiting (router mode)
ROUTER_MAX_PER_SECOND=3            # Max messages per second
ROUTER_MAX_PER_MINUTE=30           # Max messages per minute

# Animation Server
ANIMATION_SERVER_URL=http://localhost:3003
```

### Animation Server (environment or service file)

```bash
ANIMATION_PORT=3003          # Animation server port
ANIMATION_HOST=0.0.0.0       # Bind address
LIPSYNC_MODE=realtime        # 'realtime' (new) or 'rhubarb' (legacy)
STREAM_MODE=synced           # 'synced' (muxed audio) or 'separate'
```

## API Endpoints

### Chat API Server (Port 3002)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/chat` | POST | Send message, get audio response |
| `/api/auto` | POST | Generate scripted conversation |
| `/api/voices` | GET | List available voices |
| `/api/history` | GET | Get conversation history |
| `/api/health` | GET | Health check |
| `/` | GET | Serve frontend |

#### POST /api/chat

```json
{
  "message": "Hello!",
  "voice": "chad",              // "chad" or "virgin" (ignored in router/auto)
  "model": "eleven_turbo_v2",   // "eleven_turbo_v2" or "eleven_v3"
  "temperature": 0.7,           // 0.0-1.0
  "mode": "direct"              // "direct", "router", or "auto"
}
```

**Response:** `audio/mpeg` binary data
**Header:** `X-Selected-Voice` - the voice that responded

#### Chat Modes

| Mode | Description |
|------|-------------|
| `direct` | User selects voice manually |
| `router` | LLM automatically routes to chad or virgin based on context |
| `auto` | Generates multi-turn scripted conversation |

#### POST /api/auto

```json
{
  "seed": "Discuss the meaning of life",
  "turns": 4,                   // Number of back-and-forth exchanges
  "model": "eleven_v3",
  "temperature": 0.8
}
```

### Animation Server (Port 3003)

#### Core Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/render` | POST | Submit audio for lip-synced animation |
| `/streams/live/stream.m3u8` | GET | HLS live stream playlist |
| `/streams/live/*.ts` | GET | HLS video segments |
| `/audio/:filename` | GET | Audio file (separate mode) |
| `/playback-start` | POST | Signal audio playback started |
| `/stream-info` | GET | Current stream state |
| `/health` | GET | Health check |

#### POST /render

```
Content-Type: multipart/form-data

Fields:
- audio (file): MP3/WAV audio file
- character (string): "chad" or "virgin"
- message (string): Optional caption text
- mode (string): "direct" or "router"

Response:
{
  "streamUrl": "/streams/live/stream.m3u8",
  "duration": 5.2,
  "lipsyncMode": "realtime",
  "streamMode": "synced",
  "queued": false,
  "queuePosition": 0
}
```

#### TV Content Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/tv` | GET | Serve TV control panel |
| `/tv/playlist` | GET | Get playlist and status |
| `/tv/playlist/add` | POST | Add item by path/URL |
| `/tv/upload` | POST | Upload file to playlist |
| `/tv/playlist/:id` | DELETE | Remove item |
| `/tv/playlist/clear` | POST | Clear all items |
| `/tv/control` | POST | Playback control |
| `/tv/status` | GET | Playback status + viewport |
| `/tv/hold` | POST | Toggle hold mode |
| `/tv/volume` | GET/POST | Get/set audio volume |
| `/tv/audio/:filename` | GET | Serve extracted audio |

#### POST /tv/playlist/add

```json
{
  "type": "video",           // "image" or "video"
  "source": "/path/to/file", // Local path or URL
  "duration": 10             // Seconds (images only)
}
```

#### POST /tv/control

```json
{
  "action": "play"           // "play", "pause", "stop", "next", "prev"
}
```

#### POST /tv/upload

```
Content-Type: multipart/form-data

Fields:
- file (file): Image or video file
- duration (number): Display duration for images
```

## Voice System

### Chad
- **Voice ID:** `nPczCjzI2devNBz1zQrb`
- **Personality:** Effortlessly successful, casual humble brags, charming, confident
- **Settings:** stability=0.0, similarity=0.8, style=0.6, speaker_boost=true
- **Audio tags (v3):** `[chuckles]`, `[laughs]`, `[sighs contentedly]`, `[casually]`

### Virgin
- **Voice ID:** `mrQhZWGbb2k9qWJb5qeA`
- **Personality:** Insecure, overthinks everything, stammering, self-deprecating
- **Settings:** stability=1.0, similarity=0.5, style=0.2, speaker_boost=false
- **Audio tags (v3):** `[nervous laugh]`, `[sighs]`, `[clears throat]`, `[quietly]`, `[mumbles]`

### TTS Models
- **eleven_turbo_v2** (default): Fast generation, no audio tag support
- **eleven_v3**: Expressive, interprets audio tags like `[laughs]`

### Memory System
Each character maintains a ~600 character memory that's updated asynchronously after each conversation turn. This provides continuity across conversations.

## Animation System

### Lipsync Modes

#### Realtime Mode (LIPSYNC_MODE=realtime)
- Analyzes audio on-the-fly during playback
- Sub-frame analysis (6 samples per video frame)
- Features: RMS energy, Zero Crossing Rate, peak detection
- Smoothing with configurable hold frames
- No pre-processing delay

#### Rhubarb Mode (LIPSYNC_MODE=rhubarb) - Legacy
- Pre-analyzes entire audio file before playback
- Uses external Rhubarb Lip Sync tool
- Returns phoneme timestamps
- Higher accuracy but adds processing delay

### Stream Modes

#### Synced Mode (STREAM_MODE=synced)
- Audio muxed into HLS video stream
- Single continuous FFmpeg process
- Lower latency, simpler frontend
- Audio/video always in sync

#### Separate Mode (STREAM_MODE=separate)
- Video and audio served separately
- Frontend syncs via JavaScript timing
- Allows independent audio control
- More complex but flexible

### Phoneme Set (Preston Blair)

| Phoneme | Mouth Shape | Sounds |
|---------|-------------|--------|
| A | Closed/neutral | Silence, M, B, P |
| B | Slightly open | Soft consonants |
| C | Open with teeth | E, I sounds |
| D | Wide open | A, AH, wide vowels |
| E | Rounded/pursed | O, OO sounds |
| F | Teeth on lip | F, V |
| G | Tongue behind teeth | TH, L |
| H | Wide with tongue | L sounds |
| SMILE | Smiling | Expression |
| SURPRISE | Surprised | Expression |

### Compositor Pipeline

1. **Static Base** - Pre-composited background, props, character bodies
2. **TV Content** - Current frame from TV playlist (if playing)
3. **TV Reflection** - Glass reflection overlay on TV
4. **Mouth Layers** - Phoneme-specific mouth for each character
5. **Blink Layers** - Blink overlay if character is blinking
6. **Caption** - Text overlay with current message

**Performance Features:**
- Frame caching by state key (eliminates redundant compositing)
- 1/3 scale rendering (1280x720 from 3840x2160 source)
- JPEG quality 80 for fast encoding
- Pipe-based audio decoding (no temp files)

### Stream Configuration
- **Resolution:** 1280x720
- **Framerate:** 15fps
- **Segment duration:** 2 seconds
- **Video codec:** H.264 (libx264 ultrafast)
- **Audio codec:** AAC 128kbps, stereo, 44.1kHz

### Blinking System
- Natural random blinks every 2-6 seconds
- Blink duration: ~150ms (2-3 frames)
- Suppressed during speech
- Independent per character

## TV Content System

The TV visible in the background can display images and videos with audio.

### Features
- Playlist-based playback with auto-advance
- Images displayed for configurable duration
- Videos decoded at 15fps with audio extraction
- Volume control (0-100%)
- Hold mode to loop current item
- Upload progress tracking for large files

### Viewport
- **Position:** Extracted from mask.png bounds
- **Size:** ~316x167 pixels (at output resolution)
- **Layer order:** Content appears behind TV reflection

### TV Control Panel
Access at `http://<server>:3003/tv`

## Frontend

### Main Interface (index.html)

**Controls:**
- Chat input with mode selection (direct/router/auto)
- Voice selector (chad/virgin) - disabled in router/auto modes
- TTS model selector (turbo_v2/v3)
- Temperature slider (0.0-1.0)
- Delay slider (1-5 levels)

### Delay Levels

| Level | Live Sync | Max Buffer | Description |
|-------|-----------|------------|-------------|
| 1 | 2s | 6s | Low latency |
| 2 | 4s | 10s | Standard |
| 3 | 8s | 20s | Default |
| 4 | 12s | 30s | High stability |
| 5 | 16s | 45s | Maximum buffer |

### config.js Environment Detection
- **Production:** nginx proxy for API, explicit IP:3003 for animation
- **Localhost:** Direct ports 3002/3003
- **File protocol:** Explicit localhost URLs

## VPS Deployment

**Production URL:** `http://93.127.214.75`

### Systemd Services

```bash
# Chat API (port 3002)
sudo systemctl status|start|stop|restart livestream
sudo journalctl -u livestream -f

# Animation Server (port 3003)
sudo systemctl status|start|stop|restart animation
sudo journalctl -u animation -f

# GitHub Webhook (port 3001)
sudo systemctl status|start|stop|restart webhook
sudo journalctl -u webhook -f
```

### Service Files
Located in `/home/liveStream/vps-setup/`:
- `livestream.service` - Chat API
- `animation.service` - Animation server
- `webhook.service` - GitHub webhook auto-deploy

### GitHub Webhook
- **URL:** `http://93.127.214.75:3001/webhook`
- **Content type:** `application/json`
- **Secret:** Must match `GITHUB_WEBHOOK_SECRET` in `.env`
- **Events:** Push only

## Adding/Modifying Characters

1. Edit `Stream.psd` in Photoshop
2. Layer naming convention:
   - `static_<character>_<part>` - Static body parts
   - `mouth_<character>_<phoneme>` - Mouth shapes (A-H, smile, surprise)
   - `blink_<character>_closed` - Blink overlay
   - `TV_Reflection_` - TV reflection (composited above TV content)
   - `mask` - TV viewport bounds (not rendered, defines viewport area)
3. Run `npm run export-psd` to regenerate layers
4. Update `voices.js` if adding new character
5. Restart animation server

## Key Files Reference

| File | Purpose |
|------|---------|
| `server.js` | Chat API, OpenAI integration, voice routing, memory |
| `voices.js` | Character personalities, ElevenLabs voice configs |
| `animation-server/server.js` | Animation API, TV content API, render queue |
| `animation-server/compositor.js` | Frame compositing, layer management |
| `animation-server/realtime-lipsync.js` | Real-time phoneme detection |
| `animation-server/continuous-stream-manager.js` | FFmpeg HLS streaming |
| `animation-server/tv-content/index.js` | TV playlist management |
| `frontend/app.js` | HLS.js player, chat UI, delay controls |
| `frontend/tv-control.html` | TV content control panel |
| `exported-layers/manifest.json` | Layer positions, z-index, types |

## Git Workflow

- **Main branch:** `master`
- **Auto-deploy:** Webhook triggers on push
- **Commit style:** Present tense, specific ("Add feature" not "Added feature")
