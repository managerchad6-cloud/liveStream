# ANIMATION_SYSTEM.md

## Project Vision

Transform the current audio-only chatbot into a live-streaming animated character system where Chad and Virgin respond with synchronized lip movements and natural blinking, all rendered in real-time from a Photoshop PSD file.

---

## Current State Analysis

### Existing Architecture
- **Backend (`server.js`)**: Express server that generates AI responses via OpenAI and converts them to speech via ElevenLabs, then sends audio MP3 to frontend
- **Frontend (`public/index.html`)**: Single HTML page served by backend, receives audio and plays it in browser
- **Deployment**: VPS at `http://93.127.214.75:3002` with systemd service
- **Problem**: Tightly coupled - frontend can't exist without backend serving it

### PSD File Structure
Located at project root: `Stream.psd` (3840x2160)

**Layer hierarchy** (bottom to top, as Photoshop stacks):
```
Background (static)
TV Reflection (static, 54% opacity)
Virgin/ (group)
  ├── Virgin Chair (static)
  ├── virgin body (static)
  ├── chad chair layer 2 (static)
  └── Virgin Face/ (group)
      ├── Face (static base)
      ├── L Eye (static)
      ├── R Eye (static)
      ├── Blink (toggleable - eyes closed)
      ├── Eye Cover (static)
      ├── Nose (static)
      ├── L Eyebrow (static, future: animated)
      ├── R Eyebrow (static, future: animated)
      └── Mouth/ (group - only ONE visible at a time)
          ├── mouth_virgin_C (multiple duplicates exist)
          ├── mouth_virgin_C
          ├── mouth_virgin_H
          ├── mouth_virgin_E
          ├── mouth_virgin_E
          ├── mouth_virgin_B
          ├── mouth_virgin_G
          ├── mouth_virgin_smile
          ├── mouth_virgin_surprise
          ├── mouth_virgin_C
          ├── mouth_virgin_F
          ├── mouth_virgin_D
          ├── mouth_virgin_D
          ├── mouth_virgin_A
          └── (14 total mouth shapes)

Chad/ (group)
  ├── Chad Chair (static)
  ├── Chad Body (static)
  └── Chad Face/ (group)
      ├── Face (static base)
      ├── Blink (toggleable - eyes closed)
      ├── R Eye (static)
      ├── L Eye (static)
      ├── Eye Cover (static)
      └── Mouth/ (group - only ONE visible at a time)
          ├── mouth_chad_E (currently visible)
          ├── mouth_chad_A
          ├── mouth_chad_C
          ├── mouth_chad_E
          ├── mouth_chad_B
          ├── mouth_chad_C
          ├── mouth_chad_G
          ├── mouth_chad_C
          ├── mouth_chad_F
          ├── mouth_chad_H
          ├── mouth_chad_D
          ├── mouth_chad_D
          ├── mouth_chad_smile
          ├── mouth_chad_surprise
          └── (14 total mouth shapes)

Front Desk/ (group)
  ├── Table (static)
  └── Portatil/ (group)
      ├── Portatil (static)
      └── $vvc (static)
```

**Critical observations**:
1. **Duplicate layer names exist** (multiple `mouth_chad_C`, `mouth_chad_D`, etc.) - Photoshop allows this but code must handle by index
2. **Stacking order matters** - Front Desk renders on top of characters
3. **Only one mouth shape visible at a time** per character
4. **Blink layers** - single layer per character (visible = eyes closed, hidden = eyes open)
5. **Static layers** - never change visibility (body, chair, face base, etc.)

---

## Target Architecture

### Three Separate Systems
```
┌─────────────────────────────────────────────────────────────┐
│                         VPS SERVER                           │
│  - Hosts static frontend files (HTML/CSS/JS)                │
│  - Handles chat API (OpenAI + ElevenLabs)                   │
│  - Returns audio MP3 when message received                  │
│  - Does NOT handle video rendering                          │
└─────────────────────────────────────────────────────────────┘
                              ↓ Audio MP3 + Character ID
┌─────────────────────────────────────────────────────────────┐
│                    ANIMATION SERVER                          │
│  (Can run anywhere - local machine OR VPS)                  │
│  - Receives: Audio file + character name ('chad'|'virgin')  │
│  - Exports PSD layers to PNG files (one-time setup)         │
│  - Runs Rhubarb lip-sync analysis on audio                  │
│  - Generates video stream:                                   │
│    * Composites PNG layers in correct stacking order        │
│    * Toggles mouth shapes based on Rhubarb phonemes         │
│    * Auto-blinks randomly when not speaking                 │
│    * Outputs continuous video stream (WebRTC or HLS)        │
└─────────────────────────────────────────────────────────────┘
                              ↓ Video Stream
┌─────────────────────────────────────────────────────────────┐
│                      FRONTEND CLIENT                         │
│  - Static HTML/CSS/JS served from VPS                       │
│  - Sends chat messages to VPS                               │
│  - Receives video stream from Animation Server              │
│  - Displays live stream in viewport                         │
│  - NO audio playback (audio is in video stream)             │
└─────────────────────────────────────────────────────────────┘
```

---

## Required Refactoring Tasks

### 1. PSD Export System

**Goal**: Extract all layers as individual PNG files with transparency, preserving exact positions and dimensions.

**Requirements**:
- Export EVERY layer (including groups) as PNG
- Maintain alpha channels (transparency)
- Preserve exact pixel coordinates from PSD
- Generate a layer manifest JSON file:
```json
  {
    "width": 3840,
    "height": 2160,
    "layers": [
      {
        "name": "Background ",
        "path": "layers/background.png",
        "x": 0,
        "y": 0,
        "width": 3840,
        "height": 2160,
        "opacity": 1.0,
        "visible": true,
        "zIndex": 0,
        "type": "static"
      },
      {
        "name": "mouth_chad_A",
        "path": "layers/chad/mouth/mouth_chad_A.png",
        "x": 1234,
        "y": 567,
        "width": 200,
        "height": 100,
        "opacity": 1.0,
        "visible": false,
        "zIndex": 42,
        "type": "mouth",
        "character": "chad",
        "phoneme": "A"
      }
    ]
  }
```

**Tools to use**:
- Node.js library: `psd` or `ag-psd` (read PSD files)
- `sharp` or `canvas` (PNG export)
- Script should run ONCE during setup, not at runtime

**Output structure**:
```
exported-layers/
├── manifest.json
├── background.png
├── tv_reflection.png
├── chad/
│   ├── static_chad_body.png
│   ├── static_chad_chair.png
│   ├── static_chad_face.png
│   ├── static_chad_eye_left.png
│   ├── static_chad_eye_right.png
│   ├── static_chad_eye_cover.png
│   ├── blink_chad_closed.png
│   └── mouth/
│       ├── mouth_chad_A.png
│       ├── mouth_chad_B.png
│       ├── mouth_chad_C_1.png (handle duplicates with suffix)
│       ├── mouth_chad_C_2.png
│       └── ...
└── virgin/
    └── (same structure)
```

---

### 2. Separate Frontend from Backend

**Current problem**: `server.js` serves `public/index.html` via Express - frontend cannot load independently.

**New architecture**:

**Backend (`server.js`)**:
- Remove `app.use(express.static('public'))`
- Remove `app.get('/', ...)` route
- Keep ONLY API endpoints:
  - `POST /api/chat` - returns audio MP3 blob
  - `GET /api/voices` - returns voice options
- Add CORS headers to allow frontend from any origin
- Backend becomes pure API server

**Frontend (new structure)**:
```
frontend/
├── index.html (standalone, can open directly in browser)
├── style.css
├── app.js
└── config.js (contains API_BASE_URL)
```

**Frontend changes**:
- Must work when opened as `file:///` OR served via any web server
- Configure API endpoint dynamically:
```js
  const API_BASE_URL = window.location.hostname === 'localhost' 
    ? 'http://localhost:3002'
    : 'http://93.127.214.75:3002';
```
- Replace chat submission to call `/api/chat` instead of `/chat`
- Remove audio playback code (video stream will have audio baked in)
- Add video stream player:
```html
  <video id="character-stream" autoplay muted></video>
```

**Deployment**:
- VPS serves frontend via nginx (separate from Node.js)
- OR frontend deployed to Netlify/Vercel/GitHub Pages
- Backend stays on VPS port 3002

---

### 3. Animation Server Architecture

**New Node.js service** (can run on VPS or local machine):

**Core responsibilities**:
1. **HTTP endpoint**: `POST /render` - receives audio blob + character ID
2. **Layer compositor**: Combines PNG layers in correct z-index order
3. **Lip-sync engine**: Uses Rhubarb to map audio → phonemes → mouth shapes
4. **Blink controller**: Random blinks every 3-5 seconds when character is idle
5. **Video stream generator**: Outputs live video stream (30fps)

**Technology stack**:
- Express.js (HTTP server)
- `fluent-ffmpeg` (video encoding)
- `canvas` or `sharp` (image compositing)
- Rhubarb Lip Sync binary (external tool, called via child_process)
- WebRTC or HLS for streaming output

**Data flow**:
```
POST /render
  ↓ audio.mp3 + character="chad"
1. Save audio to temp file
2. Run: rhubarb audio.mp3 -f json -o lipsync.json
3. Parse lipsync.json → get phoneme timings
4. Start video stream loop (30fps):
   FOR EACH FRAME:
     - Calculate current timestamp
     - Determine active mouth shape from phoneme timeline
     - Should blink? (random logic, avoid during speech)
     - Composite layers:
       * Load base layers (background, body, face, etc.)
       * Load correct mouth shape PNG
       * Load blink layer if blinking
       * Stack in manifest z-index order
     - Encode frame to video stream
5. Return stream URL to client
```

**Lip-sync phoneme mapping** (from manifest.json):
```js
const PHONEME_TO_LAYER = {
  'A': 'mouth_chad_A',  // Rest
  'B': 'mouth_chad_B',  // M, B, P
  'C': 'mouth_chad_C',  // E, teeth
  'D': 'mouth_chad_D',  // Ah, open
  'E': 'mouth_chad_E',  // O, rounded
  'F': 'mouth_chad_F',  // U
  'G': 'mouth_chad_G',  // F, V
  'H': 'mouth_chad_H',  // L, tongue
  'X': 'mouth_chad_A'   // Extended rest
};
```

**Blink logic**:
- Random interval: 3-5 seconds
- Duration: 100-150ms (3-5 frames at 30fps)
- States: open → half-closed → closed → half-closed → open
- **Critical**: Do NOT blink during active speech (check if current phoneme is not 'A')

---

### 4. Video Streaming Options

**Option A: HLS (HTTP Live Streaming)** - RECOMMENDED
- **Pro**: Simple, widely supported, works with `<video>` tag
- **Con**: 2-5 second latency
- **Implementation**:
  - FFmpeg outputs HLS playlist (.m3u8) + segments (.ts files)
  - nginx serves HLS files
  - Frontend uses `hls.js` library

**Option B: WebRTC**
- **Pro**: Low latency (<1 second)
- **Con**: Complex setup, requires STUN/TURN servers
- **Implementation**:
  - Use `mediasoup` or `Janus` server
  - Frontend uses native WebRTC APIs

**For MVP**: Use HLS, switch to WebRTC later if latency is issue.

---

### 5. Integration Flow

**Complete message → video flow**:
```
1. USER types message in frontend
   ↓
2. Frontend: POST to VPS /api/chat
   {
     "message": "Hello Chad",
     "voice": "chad"
   }
   ↓
3. VPS Backend:
   - Calls OpenAI (generate text response)
   - Calls ElevenLabs (text → audio MP3)
   - Returns: audio blob
   ↓
4. Frontend:
   - Receives audio blob
   - Sends to Animation Server: POST /render
     * Body: audio blob
     * Header: X-Character: chad
   ↓
5. Animation Server:
   - Saves audio.mp3
   - Runs Rhubarb → phoneme timings
   - Starts video generation loop
   - Returns stream URL: /stream/abc123.m3u8
   ↓
6. Frontend:
   - Updates <video> src to stream URL
   - Video plays with lip-sync + audio
   ↓
7. Animation Server (continuous):
   - Keeps generating frames
   - Auto-blinks when idle
   - Stops after audio ends, returns to idle state
```

---

## Technical Specifications

### Layer Compositing Rules

**Z-index calculation** (from PSD structure, bottom to top):
```js
const LAYER_ORDER = [
  'Background',           // 0
  'TV Reflection',        // 1
  'static_virgin_chair',  // 2
  'static_virgin_body',   // 3
  'static_virgin_face',   // 4
  'static_virgin_eye_left', // 5
  'static_virgin_eye_right', // 6
  'blink_virgin_closed',  // 7 (only if blinking)
  'static_virgin_eye_cover', // 8
  'mouth_virgin_*',       // 9 (active mouth shape)
  'static_virgin_nose',   // 10
  'static_virgin_eyebrow_left', // 11
  'static_virgin_eyebrow_right', // 12
  // ... same for Chad ...
  'Table',                // N-2
  'Portatil',             // N-1
  '$vvc'                  // N (top)
];
```

**Compositing algorithm**:
```js
function compositeFrame(frameNumber, character, phoneme, isBlinking) {
  const canvas = createCanvas(3840, 2160);
  const ctx = canvas.getContext('2d');
  
  // 1. Load manifest
  const manifest = JSON.parse(fs.readFileSync('exported-layers/manifest.json'));
  
  // 2. Sort layers by zIndex
  const sortedLayers = manifest.layers.sort((a, b) => a.zIndex - b.zIndex);
  
  // 3. Composite each layer
  for (const layer of sortedLayers) {
    // Skip if layer is a mouth shape but not active
    if (layer.type === 'mouth') {
      if (layer.character !== character) continue;
      if (layer.phoneme !== phoneme) continue;
    }
    
    // Skip blink if not blinking
    if (layer.name.startsWith('blink_') && !isBlinking) continue;
    
    // Skip eyes if blinking
    if (isBlinking && layer.name.includes('eye') && !layer.name.includes('cover')) {
      continue;
    }
    
    // Load and draw PNG
    const img = await loadImage(layer.path);
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(img, layer.x, layer.y, layer.width, layer.height);
  }
  
  return canvas.toBuffer('image/png');
}
```

### Rhubarb Integration

**Install Rhubarb**:
```bash
# Linux
wget https://github.com/DanielSWolf/rhubarb-lip-sync/releases/download/v1.13.0/Rhubarb-Lip-Sync-1.13.0-Linux.zip
unzip Rhubarb-Lip-Sync-1.13.0-Linux.zip
sudo mv rhubarb /usr/local/bin/
```

**Usage**:
```js
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

async function analyzeLipSync(audioPath) {
  const outputPath = audioPath.replace('.mp3', '.json');
  await execAsync(`rhubarb -f json "${audioPath}" -o "${outputPath}"`);
  const result = JSON.parse(fs.readFileSync(outputPath));
  
  // result.mouthCues format:
  // [
  //   { start: 0.0, end: 0.1, value: "X" },
  //   { start: 0.1, end: 0.3, value: "D" },
  //   ...
  // ]
  
  return result.mouthCues;
}
```

### Performance Considerations

**Target**: 30fps video at 3840x2160 (4K)
**Challenge**: Compositing 20+ PNG layers every frame is CPU-intensive

**Optimizations**:
1. **Pre-composite static layers** - Background + bodies + chairs → single PNG (only render once)
2. **Cache loaded images** - Don't reload PNGs every frame
3. **Use GPU acceleration** if available (Sharp with libvips)
4. **Reduce resolution** for streaming (1920x1080 or 1280x720)
5. **Consider pre-rendering** - For production, render entire video once, serve as file

**Alternative approach for production**:
- When audio received, render complete video file (takes 5-10 seconds)
- Serve as static MP4 file
- Pros: No real-time CPU load, perfect quality
- Cons: Delay before video starts

---

## File Structure After Refactor
```
livestream-chatbox/
├── CLAUDE.md (existing - chat system docs)
├── ANIMATION_SYSTEM.md (this file)
├── Stream.psd (Photoshop source file)
├── .env (API keys)
├── package.json
│
├── backend/ (VPS deployment)
│   ├── server.js (API only, no frontend serving)
│   ├── voices.js (personality configs)
│   └── package.json
│
├── frontend/ (static files, deploy anywhere)
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── config.js
│
├── animation-server/ (can run on VPS or local)
│   ├── server.js (render endpoint + streaming)
│   ├── compositor.js (layer stacking logic)
│   ├── lipsync.js (Rhubarb wrapper)
│   ├── blink-controller.js (random blink logic)
│   ├── stream-generator.js (FFmpeg video output)
│   └── package.json
│
├── tools/ (one-time setup scripts)
│   ├── export-psd.js (PSD → PNG layers + manifest.json)
│   └── test-composite.js (test layer stacking)
│
└── exported-layers/ (generated by export-psd.js)
    ├── manifest.json
    ├── static-composite.png (pre-rendered background)
    ├── chad/...
    └── virgin/...
```

---

## Phase 1 MVP Scope

**Must have**:
- [x] PSD export to PNG layers
- [x] Manifest JSON with layer metadata
- [x] Backend separated from frontend
- [x] Animation server accepts audio + character
- [x] Rhubarb lip-sync integration
- [x] Basic layer compositor (no optimizations)
- [x] Random auto-blink when idle
- [x] HLS video stream output
- [x] Frontend displays video stream

**Nice to have (Phase 2)**:
- [ ] WebRTC streaming (lower latency)
- [ ] GPU acceleration
- [ ] Pre-composite static layers
- [ ] Eye movement (left/right/up/down)
- [ ] Eyebrow expressions
- [ ] Background music/ambient sound
- [ ] Multiple simultaneous streams

---

## Critical Implementation Notes

### Handling Duplicate Layer Names

Photoshop allows duplicate names but code cannot reference by name alone. Solutions:

**Option A: Rename during PSD export** (RECOMMENDED)
```js
// In export-psd.js
const nameCount = {};
function getUniqueName(name) {
  if (!nameCount[name]) {
    nameCount[name] = 0;
    return name;
  }
  nameCount[name]++;
  return `${name}_${nameCount[name]}`;
}
```

**Option B: Reference by index**
```js
// In manifest.json, add unique ID
{
  "id": "mouth_chad_C_layer_7",
  "name": "mouth_chad_C",
  "layerIndex": 7
}
```

### Blink State Machine
```js
const BLINK_STATES = {
  OPEN: 'open',           // Normal eyes (blink layer hidden)
  CLOSING: 'closing',     // Transition frame (optional)
  CLOSED: 'closed',       // Eyes shut (blink layer visible)
  OPENING: 'opening'      // Transition frame (optional)
};

class BlinkController {
  constructor() {
    this.state = BLINK_STATES.OPEN;
    this.nextBlinkFrame = this.randomBlinkTime();
  }
  
  update(frameNumber, isSpeaking) {
    // Don't blink while talking
    if (isSpeaking && this.state === BLINK_STATES.OPEN) {
      this.nextBlinkFrame = frameNumber + this.randomBlinkTime();
      return false;
    }
    
    // Blink cycle: 3 frames closed, then return to open
    if (frameNumber >= this.nextBlinkFrame) {
      if (this.state === BLINK_STATES.OPEN) {
        this.state = BLINK_STATES.CLOSED;
        this.closeFrame = frameNumber;
        return true;
      }
      
      if (frameNumber >= this.closeFrame + 3) {
        this.state = BLINK_STATES.OPEN;
        this.nextBlinkFrame = frameNumber + this.randomBlinkTime();
        return false;
      }
      
      return true; // Still closed
    }
    
    return false;
  }
  
  randomBlinkTime() {
    // 3-5 seconds at 30fps = 90-150 frames
    return 90 + Math.random() * 60;
  }
}
```

### Audio + Video Sync

**Critical**: Audio must stay in sync with lip movements.

**Solution**: Embed audio directly in video stream
```js
// FFmpeg command
ffmpeg -loop 1 -framerate 30 -i frame_%04d.png \
       -i audio.mp3 \
       -c:v libx264 -tune stillimage -c:a aac \
       -shortest -pix_fmt yuv420p \
       output.mp4
```

**For live streaming**: Use FFmpeg to multiplex video frames + audio into HLS stream simultaneously.

---

## Testing Strategy

### Unit Tests
- `export-psd.js` - Verify all layers exported, manifest correct
- `compositor.js` - Test layer stacking with mock PNGs
- `lipsync.js` - Test Rhubarb output parsing
- `blink-controller.js` - Test blink timing logic

### Integration Tests
- Send audio to `/render`, verify video output
- Check lip-sync accuracy (manual review)
- Verify blink doesn't occur during speech
- Test both Chad and Virgin characters

### Performance Tests
- Measure FPS during rendering
- Check CPU/memory usage
- Test with 10+ second audio clips
- Verify no frame drops in stream

---

## Deployment Checklist

### VPS Setup
- [ ] Install Node.js 18+
- [ ] Install FFmpeg (`sudo apt install ffmpeg`)
- [ ] Install Rhubarb binary to `/usr/local/bin/`
- [ ] Clone repo, run `npm install` in all directories
- [ ] Create `.env` with API keys
- [ ] Run PSD export: `node tools/export-psd.js`
- [ ] Start backend: `pm2 start backend/server.js`
- [ ] Start animation server: `pm2 start animation-server/server.js`
- [ ] Configure nginx to serve frontend + proxy API + serve HLS streams
- [ ] Test full flow: message → video

### Frontend Deployment (if separate)
- [ ] Update `config.js` with production API URL
- [ ] Deploy to Netlify/Vercel OR serve via nginx
- [ ] Test CORS headers
- [ ] Verify video stream playback

---

## Success Criteria

**The system is complete when**:
1. User sends "Hello Chad" in frontend
2. Backend generates audio response
3. Animation server renders video with:
   - Chad's mouth moving in sync with audio
   - Natural blinks during pauses
   - All layers composited correctly (Front Desk visible on top)
4. Frontend displays smooth video stream
5. Virgin remains idle with occasional blinks
6. No audio/video desync
7. System can handle back-to-back messages without crashing

---

## Questions for Claude Code

When implementing this system, please analyze:

1. **PSD export**: Which library (`psd` vs `ag-psd` vs `psd.js`) best handles layer position/opacity/transparency?
2. **Image compositing**: Should we use `sharp`, `canvas`, or `jimp`? Consider performance for 4K.
3. **Video encoding**: What FFmpeg settings balance quality vs. encoding speed?
4. **Streaming protocol**: Confirm HLS is best for MVP, or should we use WebRTC from start?
5. **Layer caching**: How to efficiently cache loaded PNGs without memory leaks?
6. **Duplicate layer names**: Should we rename during export or handle in compositor?
7. **Blink timing**: Is random 3-5 second interval natural, or should we use Poisson distribution?
8. **Error handling**: How to gracefully handle missing layers, Rhubarb failures, FFmpeg crashes?
9. **Concurrent requests**: Can animation server handle multiple render requests simultaneously?
10. **Frontend state**: Should frontend know about "currently speaking" state or just play video?

Please provide detailed implementation guidance for each component, including:
- Exact npm packages and versions
- Complete code examples with error handling
- Configuration options for production
- Performance optimization strategies
- Testing approaches
I wan
The goal is a production-ready system that can run 24/7 on the VPS with minimal manual intervention.