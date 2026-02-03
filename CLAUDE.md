# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LiveStream Chatbox** - An animated chatbot with real-time lip-synced characters (Chad and Virgin from the Virgin vs Chad meme). Features OpenAI for conversation, ElevenLabs for TTS, and a custom animation system with HLS video streaming. Includes an in-scene TV with controllable video/image playlist, dynamic facial expressions with LLM-driven animation, and a lighting control system.

**Tech Stack:** Node.js/Express, Sharp (image compositing), FFmpeg (video encoding/decoding), HLS.js (video playback), OpenAI SDK, vanilla HTML/CSS/JS frontend.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│    Frontend     │────▶│   Chat API       │────▶│ Animation Server│
│  (HLS Player)   │     │   (Port 3002)    │     │   (Port 3003)   │
│                 │◀────────────────────────────▶│  HLS Stream     │
│  Control Panels │────────────────────────────▶│  TV / Lighting  │
│  (TV, Lighting, │     │                  │     │  / Expression   │
│   Expression)   │     │                  │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

1. **Chat API Server** (port 3002): OpenAI chat, ElevenLabs TTS, conversation memory, voice routing, auto conversations, command leaderboard
2. **Animation Server** (port 3003): Frame compositing, lip-sync, HLS streaming, TV content, lighting control, expression animation

## Directory Structure

```
├── server.js              # Chat API server (OpenAI + ElevenLabs + routing + auto)
├── voices.js              # Character personalities and voice configs
├── webhook-server.js      # GitHub webhook for auto-deploy (port 3945)
├── package.json           # Main dependencies
├── .env                   # Environment variables (API keys)
├── expression-limits.json # Expression calibration bounds (per-character)
│
├── data/                  # Persistent data
│   └── commands.json      # Slash command votes/leaderboard
│
├── frontend/              # Web UI
│   ├── index.html         # Main chat interface with HLS player
│   ├── app.js             # Chat logic, HLS.js setup, delay controls
│   ├── config.js          # Environment detection + Cloudflare tunnel support
│   ├── style.css          # Dark theme styling
│   ├── tv-control.html    # TV content control panel
│   ├── lighting-control.html  # Lighting/hue control panel
│   └── expression-control.html # Expression tuning panel
│
├── animation-server/      # Animation rendering server
│   ├── server.js          # Express server, render + TV + lighting + expression APIs
│   ├── compositor.js      # Sharp-based frame compositing (3-level cache)
│   ├── continuous-stream-manager.js  # Persistent FFmpeg HLS streaming (muxed audio)
│   ├── synced-stream-manager.js      # Alternative stream manager
│   ├── stream-manager.js             # Legacy stream manager
│   ├── realtime-lipsync.js    # Real-time phoneme detection (micro-frame analysis)
│   ├── expression-timeline.js # Text-to-expression plan generation
│   ├── expression-evaluator.js # Expression animation evaluation/tweening
│   ├── synced-playback.js     # Frame-synchronized audio playback
│   ├── audio-decoder.js       # FFmpeg pipe-based PCM decoding
│   ├── blink-controller.js    # Natural random blinking
│   ├── lipsync.js             # Legacy Rhubarb lip sync integration
│   ├── state.js               # Animation state (legacy rhubarb mode)
│   ├── platform.js            # Cross-platform FFmpeg/Rhubarb paths
│   ├── lighting-settings.json # Persisted lighting state
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
│   │   ├── static_chad_*.png   # Body, face, eyes (L/R), eye_cover, eyebrows (L/R), chair
│   │   ├── blink_chad_closed.png
│   │   └── mouth/         # mouth_chad_A.png through H, smile, surprise
│   └── virgin/            # Virgin character layers
│       ├── static_virgin_*.png  # Body, face, eyes (L/R), eye_cover, eyebrows (L/R), nose
│       ├── blink_virgin_closed.png
│       └── mouth/         # mouth_virgin_A.png through H, smile, surprise
│
├── streams/               # Runtime output
│   ├── live/              # HLS segments (.ts) and playlist (.m3u8)
│   └── audio/             # Decoded audio files (separate mode)
│
├── tools/
│   ├── export-psd.js              # Extract layers from Stream.psd
│   ├── verify-export.js           # Verify PSD export integrity
│   ├── extract-expression-bounds.js # Extract expression calibration bounds
│   ├── visualize-expression-bounds.js # Visualize expression bounds as debug images
│   ├── renameStreamPSD.jsx        # Photoshop JSX script for layer renaming
│   └── inspect-psd.py            # Python PSD inspection tool
│
├── vps-setup/             # VPS deployment files
│   ├── livestream.service     # Chat API systemd service
│   ├── animation.service      # Animation server systemd service
│   ├── webhook.service        # GitHub webhook systemd service
│   ├── livestream-sync.service # File sync service
│   ├── livestream-sync.sh     # Sync script
│   ├── setup-livestream.sh    # Server setup script
│   ├── fix-line-endings.sh    # Line ending fix utility
│   └── README-VPS.md         # VPS deployment guide
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

# Verify PSD export
npm run verify-export

# Expression tools
npm run extract-expression-bounds
npm run visualize-expression-bounds

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
MEMORY_MODEL=gpt-4o-mini           # Memory summarization (defaults to ROUTER_MODEL)

# TTS
AUTO_TTS_MODEL=eleven_turbo_v2     # TTS model for auto mode

# Rate Limiting (router mode)
ROUTER_MAX_PER_SECOND=3            # Max messages per second
ROUTER_MAX_PER_MINUTE=30           # Max messages per minute

# Animation Server
ANIMATION_SERVER_URL=http://localhost:3003

# Webhook
WEBHOOK_PORT=3945                  # Webhook server port
WEBHOOK_SECRET=...                 # GitHub webhook HMAC secret
WEBHOOK_BRANCH=refs/heads/master   # Branch to watch
```

### Animation Server (environment or service file)

```bash
ANIMATION_PORT=3003          # Animation server port
ANIMATION_HOST=0.0.0.0       # Bind address
LIPSYNC_MODE=realtime        # 'realtime' (default) or 'rhubarb' (legacy)
STREAM_MODE=synced           # 'synced' (muxed audio) or 'separate'

# Expression System
EXPRESSION_MODEL=gpt-4o-mini # LLM model for expression generation
EXPRESSION_LLM=1             # Enable LLM-driven expressions (0 to disable)
OPENAI_API_KEY=sk-...        # Required if EXPRESSION_LLM=1

# Performance
SHARP_CONCURRENCY=...        # Libvips thread pool size (optional)
```

## API Endpoints

### Chat API Server (Port 3002)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/chat` | POST | Send message, get audio response |
| `/api/auto` | POST | Generate scripted conversation |
| `/api/auto/diagnostic` | GET | Auto conversation system health check |
| `/api/voices` | GET | List available voices |
| `/api/history` | GET | Get conversation history |
| `/api/commands` | POST | Record slash command vote |
| `/api/leaderboard` | GET | Get command vote leaderboard |
| `/api/health` | GET | Health check |
| `/` | GET | Serve frontend |
| `/leaderboard` | GET | Leaderboard HTML page |

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
  "turns": 4,                   // Number of exchanges (2-30, default 12)
  "model": "eleven_v3",
  "temperature": 0.8
}
```

Auto conversation pipeline: seed -> intent blueprint extraction -> script generation -> LLM validation -> rewrite on failure -> sequential playback via `/render`.

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

#### Lighting Control Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/lighting` | GET | Serve lighting control panel |
| `/lighting/status` | GET | Get all lighting state |
| `/lighting/hue` | POST | Set HSL hue (-180 to 180) |
| `/lighting/emission-opacity` | POST | Set emission layer opacity |
| `/lighting/emission-layer-blend` | POST | Set blend mode per emission layer |
| `/lighting/rainbow` | POST | Enable/disable rainbow cycling with RPM |
| `/lighting/flicker` | POST | Enable/disable flicker effect |
| `/lighting/lights` | POST | Toggle lights on/off mode |
| `/lighting/lights-opacity` | POST | Set lights-on opacity |

#### Expression Control Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/expression` | GET | Serve expression control panel |
| `/expression/status` | GET | Get current expression offsets |
| `/expression/offset` | POST | Set character eye/eyebrow position |
| `/expression/reset` | POST | Reset expression offsets |
| `/expression/limits` | GET | Get calibration limits |
| `/expression/limits/save` | POST | Save calibration (locked once set) |
| `/expression/rotation-limits` | POST | Set eyebrow rotation limits |
| `/expression/eyebrow-asym` | POST | Set asymmetric eyebrow bias |
| `/expression/auto` | GET/POST | Get/set auto expression generation |

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
Each character maintains a ~600 character memory updated asynchronously after each conversation turn (non-blocking, 8s timeout). Memory uses a natural history format: summary, recent anecdotes, topics to continue. Provides continuity across conversations.

## Animation System

### Lipsync Modes

#### Realtime Mode (LIPSYNC_MODE=realtime) - Default
- Analyzes audio on-the-fly during playback
- Sub-frame micro-analysis (10ms precision)
- Features: RMS energy, Zero Crossing Rate, peak detection, spectral centroid
- Per-phoneme priority scoring for fast speech (A<B<F=G<E=C<D=H)
- Rolling 100ms history with majority voting
- Adaptive smoothing with per-phoneme hold times (60-100ms)
- No pre-processing delay

#### Rhubarb Mode (LIPSYNC_MODE=rhubarb) - Legacy
- Pre-analyzes entire audio file before playback
- Uses external Rhubarb Lip Sync tool
- Returns phoneme timestamps
- Higher accuracy but adds processing delay

### Stream Modes

#### Synced Mode (STREAM_MODE=synced) - Default
- Audio muxed into HLS video stream
- Single continuous FFmpeg process (never restarts)
- Audio always enabled via pipe (silence when idle, real audio when speaking)
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

### Expression System

Dynamic facial expressions driven by text analysis and optional LLM generation.

#### Expression Timeline (`expression-timeline.js`)
- Parses message text into sentences and phrases
- Estimates word timings (165 WPM default)
- Classifies tone (angry/nervous/confident/sad/happy/question/neutral)
- Generates expression plans with:
  - Speaker eye movements (tracking listener or looking away)
  - Eyebrow reactions aligned to sentences (raise, frown, flick, skeptical)
  - Mouth reactions (smile/surprise) based on text cues
  - Listener reactions (mirrored emotional responses)

#### Expression Evaluator (`expression-evaluator.js`)
- Per-character animation tracks: eyeX, eyeY, browY, browAsymL, browAsymR, mouth
- Tween-based interpolation (360ms default tween duration)
- Supports multiple concurrent tracks per character
- Resolves eye looks (forward, left, right, down, up_left, etc.)
- Brow range calculations from calibrated limits

#### Expression Limits (`expression-limits.json`)
- Per-character eye bounds (minX/maxX/minY/maxY in pixels)
- Per-character eyebrow bounds with rotation (rotUp/rotDown in degrees)
- Locked after first save to prevent re-calibration (delete file to recalibrate)

#### LLM Expression Generation (Optional)
- Enabled via `EXPRESSION_LLM=1` environment variable
- Uses OpenAI to generate dynamic expression sequences contextually
- Model configurable via `EXPRESSION_MODEL`

### Compositor Pipeline

1. **Expression Base (L1)** - Pre-composited background, props, character bodies, expression layers (eyes, eyebrows, eye_cover, nose) with offsets
2. **TV Content** - Current frame from TV playlist (if playing)
3. **TV Reflection** - Glass reflection overlay on TV
4. **Mouth Layers** - Phoneme-specific mouth for each character
5. **Blink Layers** - Blink overlay if character is blinking
6. **Caption** - Text overlay with current message

**Three-Level Cache System:**
- **L1 (Expression Base Cache):** Raw RGBA buffers of static base + expression layers (25 entries max)
- **L2 (Frame Cache):** JPEG output after mouth/blink overlays (200 entries max)
- **Output Cache:** Full composited frames with captions/TV overlay (60 entries max)
- Committed-base pattern for atomic L1/L2 cache swaps during expression changes

**Performance Features:**
- Frame caching by state key (eliminates redundant compositing)
- 1/3 scale rendering (1280x720 from 3840x2160 source)
- JPEG quality 80 for fast encoding
- Pipe-based audio decoding (no temp files)
- 2-degree hue quantization (3x fewer lighting cache rebuilds)
- Pre-warmed L2 cache entries for speaking character

### Lighting System

- Adjustable HSL hue shifting on all emission layers (-180 to 180 degrees)
- Per-layer emission opacity and blend modes
- Separate lights-on layer with independent opacity
- Rainbow cycling effect with configurable RPM
- Flicker effect with sine wave modulation
- State persisted to `animation-server/lighting-settings.json`

### Stream Configuration
- **Resolution:** 1280x720
- **Framerate:** 30fps (configurable, default in ContinuousStreamManager)
- **Segment duration:** 1 second
- **HLS buffer:** 6 segments
- **Video codec:** H.264 (libx264 ultrafast)
- **Audio codec:** AAC 128kbps, stereo, 44.1kHz
- **Audio analysis:** 16kHz sample rate for lip sync processing

### Blinking System
- Natural random blinks every 2-5 seconds
- 4-frame blink duration (~133ms)
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

### Control Panels
- **TV Control:** `http://<server>:3003/tv`
- **Lighting Control:** `http://<server>:3003/lighting`
- **Expression Control:** `http://<server>:3003/expression`

## Frontend

### Main Interface (index.html)

**Controls:**
- Chat input with mode selection (direct/router/auto)
- Voice selector (chad/virgin) - disabled in router/auto modes
- TTS model selector (turbo_v2/v3)
- Temperature slider (0.0-1.0)
- Delay slider (1-5 levels)
- Slash command support (commands starting with `/` recorded as votes)

### Delay Levels

| Level | Low Latency | Live Sync | Max Buffer | Description |
|-------|-------------|-----------|------------|-------------|
| 1 | true | 2s | 6s | Low latency (1-2s) |
| 2 | true | 4s | 10s | Standard (2-3s) |
| 3 | true | 8s | 20s | Default (3-4s) |
| 4 | false | 12s | 30s | High stability |
| 5 | false | 16s | 45s | Maximum buffer |

### config.js Environment Detection
- **Production:** nginx proxy for API, explicit IP:3003 for animation
- **Localhost:** Direct ports 3002/3003
- **File protocol:** Explicit localhost URLs
- **Cloudflare tunnel:** Override via URL parameters `?anim=<tunnel-url>` and `?api=<tunnel-url>`

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

# GitHub Webhook (port 3945)
sudo systemctl status|start|stop|restart webhook
sudo journalctl -u webhook -f
```

### Service Files
Located in `vps-setup/`:
- `livestream.service` - Chat API
- `animation.service` - Animation server (UV_THREADPOOL_SIZE=4)
- `webhook.service` - GitHub webhook auto-deploy
- `livestream-sync.service` - File sync service
- `setup-livestream.sh` - Initial server setup script

### GitHub Webhook
- **Port:** 3945 (configurable via WEBHOOK_PORT)
- **Endpoint:** `POST /webhook`
- **Health:** `GET /webhook/health`
- **Signature:** HMAC-SHA256 via `X-Hub-Signature-256` header
- **Secret:** Must match `WEBHOOK_SECRET` in `.env`
- **Events:** Push only (watches `refs/heads/master`)

## Adding/Modifying Characters

1. Edit `Stream.psd` in Photoshop
2. Layer naming convention:
   - `static_<character>_<part>` - Static body parts (body, face, chair)
   - `static_<character>_eye_left/right` - Individual eyes (for expression movement)
   - `static_<character>_eye_cover` - Eye cover layer (composited above eyes)
   - `static_<character>_eyebrow_left/right` - Individual eyebrows (for expression movement + rotation)
   - `static_<character>_nose` - Nose layer (Virgin only, composited with expressions)
   - `mouth_<character>_<phoneme>` - Mouth shapes (A-H, smile, surprise)
   - `blink_<character>_closed` - Blink overlay
   - `TV_Reflection_` - TV reflection (composited above TV content)
   - `mask` - TV viewport bounds (not rendered, defines viewport area)
3. Run `npm run export-psd` to regenerate layers
4. Run `npm run verify-export` to check integrity
5. Update `voices.js` if adding new character
6. Run `npm run extract-expression-bounds` for expression calibration
7. Restart animation server

## Key Files Reference

| File | Purpose |
|------|---------|
| `server.js` | Chat API, OpenAI integration, voice routing, memory, auto conversations, leaderboard |
| `voices.js` | Character personalities, ElevenLabs voice configs |
| `webhook-server.js` | GitHub webhook auto-deploy (port 3945) |
| `expression-limits.json` | Per-character expression calibration bounds |
| `animation-server/server.js` | Animation API, TV content API, lighting API, expression API |
| `animation-server/compositor.js` | Frame compositing, 3-level cache, lighting, expression layers |
| `animation-server/realtime-lipsync.js` | Real-time micro-frame phoneme detection |
| `animation-server/continuous-stream-manager.js` | Persistent FFmpeg HLS streaming with muxed audio |
| `animation-server/synced-stream-manager.js` | Alternative stream manager |
| `animation-server/expression-timeline.js` | Text-to-expression plan generation |
| `animation-server/expression-evaluator.js` | Expression animation tweening/evaluation |
| `animation-server/synced-playback.js` | Frame-synchronized audio playback |
| `animation-server/audio-decoder.js` | FFmpeg pipe-based PCM decoding |
| `animation-server/blink-controller.js` | Natural random blinking |
| `animation-server/tv-content/index.js` | TV playlist management |
| `animation-server/tv-content/video-decoder.js` | Video frame extraction |
| `frontend/app.js` | HLS.js player, chat UI, delay controls |
| `frontend/config.js` | Environment detection, Cloudflare tunnel override |
| `frontend/tv-control.html` | TV content control panel |
| `frontend/lighting-control.html` | Lighting/hue control panel |
| `frontend/expression-control.html` | Expression tuning panel |
| `exported-layers/manifest.json` | Layer positions, z-index, types |

## Git Workflow

- **Main branch:** `master`
- **Auto-deploy:** Webhook triggers on push to master
- **Commit style:** Present tense, specific ("Add feature" not "Added feature")
