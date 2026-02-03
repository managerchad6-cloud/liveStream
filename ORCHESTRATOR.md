# Show Director / Orchestrator System

## Overview

A centralized production control system that unifies all LiveStream channels (conversation, TV, lighting) into a single orchestrated pipeline. The producer uses natural language director's notes — optionally with image/video attachments — to create show segments. An LLM agent expands these into full dialogue scripts with embedded TV and lighting cues. Segments flow through a visual pipeline (Draft → Forming → Ready → Pre-Air → On-Air → Aired) with drag-and-drop reordering, script preview/editing, and a persistent TV layer with default/override behavior.

---

## PHASE 1: COMPLETE

Phase 1 (Foundation — Backend Core) is fully implemented and tested. The following files exist and work:

### Implemented Files

| File | What it does |
|------|-------------|
| `animation-server/media-library.js` | `MediaLibrary` class — upload, thumbnail, list, delete media assets. Persists to `media-library/library.json`. Uses Sharp for image thumbnails, FFmpeg for video thumbnails. |
| `animation-server/orchestrator/pipeline-store.js` | `PipelineStore` class — segment CRUD, ordered pipeline, status transitions with validation, reorder, buffer health. Persists to `data/pipeline.json`. |
| `animation-server/orchestrator/tv-layer-manager.js` | `TVLayerManager` class — default/override/manual TV layer priority. Pushes content to TVContentService. |
| `animation-server/tv-content/index.js` | Modified — `addItem()` accepts optional `mediaId`. `getPlaylist()`, `getStatus()`, return values include `mediaId`. |
| `animation-server/server.js` | Modified — requires all 3 new services, initializes them in `start()`, has 20 new API endpoints (7 media, 7 pipeline, 6 tv-layer). |

### Implemented API Endpoints (on animation server, port 3003)

**Media Library (7):**
```
GET    /api/media                — list items (?type=&limit=&offset=)
POST   /api/media/upload         — multer multipart, field "file", 200MB limit
POST   /api/media/url            — { url, filename? }
GET    /api/media/:id            — item details
DELETE /api/media/:id            — remove
GET    /api/media/:id/original   — serve original file
GET    /api/media/:id/thumbnail  — serve thumbnail
```

**Pipeline (7):**
```
GET    /api/pipeline              — { segments, bufferHealth }
GET    /api/pipeline/:id          — segment details
POST   /api/pipeline              — create segment
PATCH  /api/pipeline/:id          — update segment fields
POST   /api/pipeline/:id/status   — transition status { status }
POST   /api/pipeline/reorder      — reorder { order: [id, ...] }
DELETE /api/pipeline/:id          — remove (draft/aired only)
```

**TV Layer (6):**
```
GET    /api/tv-layer              — getState()
POST   /api/tv-layer/default      — { mediaId }
POST   /api/tv-layer/override     — { mediaId } (segment-driven)
POST   /api/tv-layer/manual       — { mediaId } (manual override)
POST   /api/tv-layer/release      — release segment override
POST   /api/tv-layer/clear-manual — clear manual override
```

### Implemented Directories

```
media-library/originals/    — full-size uploaded files
media-library/thumbnails/   — 200x200 JPEG thumbnails
media-library/library.json  — media index
animation-server/orchestrator/ — orchestrator modules
data/pipeline.json          — pipeline state
```

### Status Transition Map (implemented in pipeline-store.js)

```
draft → forming (approved)
draft → deleted (discarded)
forming → ready (all rendered)
forming → draft (rejected)
ready → pre-air (promoted)
ready → draft (pulled back)
pre-air → on-air (goes live)
pre-air → ready (demoted)
on-air → aired (finished)
```

---

## EXISTING CODEBASE CONTEXT

Read this section carefully. Every new file you create must follow these patterns exactly.

### Project Structure

```
LiveStream/
├── server.js              # Chat API server (port 3002) — OpenAI + ElevenLabs + auto conversations
├── voices.js              # Character configs (voice IDs, personalities, voice settings)
├── .env                   # API keys (OPENAI_API_KEY, ELEVENLABS_API_KEY, etc.)
├── package.json           # Root deps: openai, axios, express, cors, dotenv, sharp
├── animation-server/
│   ├── server.js          # Animation server (port 3003) — compositing, streaming, all control APIs
│   ├── package.json       # Deps: express, cors, multer, sharp, uuid (NO openai here)
│   ├── platform.js        # Cross-platform FFmpeg/Rhubarb path resolution
│   ├── compositor.js      # Sharp frame compositing with 3-level cache
│   ├── continuous-stream-manager.js  # Persistent FFmpeg HLS stream (muxed audio)
│   ├── synced-playback.js           # Frame-synced audio playback + lip sync
│   ├── audio-decoder.js             # FFmpeg pipe-based PCM decoding
│   ├── realtime-lipsync.js          # Real-time phoneme detection
│   ├── expression-timeline.js       # Text→expression plan generation (heuristic)
│   ├── expression-evaluator.js      # Expression animation tweening
│   ├── blink-controller.js          # Natural random blinking
│   ├── media-library.js             # [PHASE 1] Media asset pool
│   ├── orchestrator/
│   │   ├── pipeline-store.js        # [PHASE 1] Segment data + pipeline
│   │   └── tv-layer-manager.js      # [PHASE 1] TV layer state machine
│   └── tv-content/
│       ├── index.js                 # TVContentService (playlist, playback, frames)
│       └── video-decoder.js         # Video frame extraction
├── frontend/
│   ├── index.html                   # Public viewer (HLS player + chat)
│   ├── app.js                       # Chat logic, HLS.js setup
│   ├── config.js                    # Environment detection
│   ├── style.css                    # Dark theme
│   ├── tv-control.html              # TV control panel
│   ├── lighting-control.html        # Lighting control panel
│   └── expression-control.html      # Expression tuning panel
└── exported-layers/                 # Character PSD layers as PNGs
```

### How the Existing Auto Conversation Pipeline Works

This is in `server.js` (the chat API server on port 3002). The orchestrator's segment renderer will follow the same pattern.

**Step 1: Generate script via LLM**
```js
// server.js line 601-644
const script = await generateAutoScript(seed, turnCount, model, temperature);
// Returns: [{ speaker: "chad", text: "..." }, { speaker: "virgin", text: "..." }, ...]
```

**Step 2: For each line, call ElevenLabs TTS then POST to /render**
```js
// server.js line 764-821
async function playAutoScript(script, autoId) {
  for (const entry of script) {
    const speakerId = String(entry.speaker).toLowerCase(); // "chad" or "virgin"
    const text = String(entry.text).trim();
    const voiceConfig = voices[speakerId];

    // 1. Call ElevenLabs TTS
    const elevenLabsResponse = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceConfig.elevenLabsVoiceId}`,
      {
        text,
        model_id: autoTtsModel,  // "eleven_turbo_v2" or "eleven_v3"
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

    // 2. POST audio to animation server /render as multipart
    const form = new FormData();
    form.append('audio', Buffer.from(elevenLabsResponse.data), {
      filename: 'audio.mp3',
      contentType: 'audio/mpeg'
    });
    form.append('character', speakerId);
    form.append('message', text);
    form.append('mode', 'router');

    await axios.post(`${animationServerUrl}/render`, form, {
      headers: form.getHeaders()
    });
  }
}
```

**Key detail:** The `/render` endpoint on the animation server queues audio. When `mode=router`, items are queued and played sequentially. Each render call returns immediately with `{ queued: true, queuePosition: N, duration: X }`. The animation server handles playback timing internally.

### Voice Configuration (voices.js)

```js
const voices = {
  chad: {
    name: 'Chad',
    elevenLabsVoiceId: 'nPczCjzI2devNBz1zQrb',
    basePrompt: `...`, // personality prompt
    audioTags: `...`,   // [chuckles], [laughs], [sighs contentedly], [casually]
    voiceSettings: { stability: 0.0, similarity_boost: 0.8, style: 0.6, use_speaker_boost: true }
  },
  virgin: {
    name: 'Virgin',
    elevenLabsVoiceId: 'mrQhZWGbb2k9qWJb5qeA',
    basePrompt: `...`, // personality prompt
    audioTags: `...`,   // [nervous laugh], [sighs], [clears throat], [quietly], [mumbles]
    voiceSettings: { stability: 1.0, similarity_boost: 0.5, style: 0.2, use_speaker_boost: false }
  }
};
```

### How /render Works (animation-server/server.js)

```
POST /render
Content-Type: multipart/form-data
Fields: audio (file), character (string), message (string), mode (string)

Response: { streamUrl, duration, lipsyncMode, streamMode, queued, queuePosition }
```

When `mode=router`, items queue. The animation server decodes audio to PCM, feeds it to the ContinuousStreamManager which muxes it into the HLS stream. Lip sync runs in real-time from the PCM samples. Expression plans are generated from the message text.

The render queue processes sequentially — one audio at a time. When audio finishes, `handleAudioComplete()` is called, which resets state and calls `processQueue()` to start the next item.

### ContinuousStreamManager Key Methods

```js
// Load audio for playback — pre-computes resampled PCM buffer
streamManager.loadAudio(samples, sampleRate, character, duration);

// Callback when audio finishes playing
streamManager.onAudioComplete = () => { handleAudioComplete(); };

// Stream URL for HLS
streamManager.getStreamUrl(); // returns "/streams/live/stream.m3u8"
```

### Existing Lighting API (on animation server port 3003)

These are the endpoints the orchestrator's lighting cues should call:

```
POST /lighting/hue          — { hue: -180..180 }
POST /lighting/emission-opacity — { opacity: 0..1 }
POST /lighting/rainbow      — { enabled: bool, rpm: number }
POST /lighting/flicker      — { enabled: bool, opacity: 0..1 }
POST /lighting/lights        — { mode: "on"|"off" }
POST /lighting/lights-opacity — { opacity: 0..1 }
GET  /lighting/status        — full lighting state
```

### Persistence Pattern (used everywhere)

Atomic write with temp file + rename:
```js
async _persist() {
  const payload = JSON.stringify(this.data, null, 2);
  const tmpPath = `${this.filePath}.tmp`;
  await fs.promises.writeFile(tmpPath, payload, 'utf8');
  await fs.promises.rename(tmpPath, this.filePath);
}
```

### Error Handling Pattern (API endpoints)

```js
app.post('/api/something', async (req, res) => {
  if (!service) return res.status(503).json({ error: 'Service not initialized' });
  const { field } = req.body || {};
  if (!field) return res.status(400).json({ error: 'Missing field' });
  try {
    const result = await service.doThing(field);
    res.json(result);
  } catch (err) {
    if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});
```

### Available Dependencies

**Root package (server.js, port 3002):** openai, axios, express, cors, dotenv, sharp, form-data (used implicitly)

**Animation server package:** express, cors, multer, sharp, uuid, openai (loaded in server.js for expression LLM)

**Available globally in animation-server/server.js:** `openai` instance (if OPENAI_API_KEY set), `FFMPEG_PATH`, `ROOT_DIR`, `multer`, `crypto`, `fs`, `path`

### Environment Variables

```
OPENAI_API_KEY=sk-...              # Available in both servers
ELEVENLABS_API_KEY=...             # Only in root server.js
ANIMATION_SERVER_URL=http://localhost:3003  # Root server uses this to POST /render
EXPRESSION_MODEL=gpt-4o-mini      # LLM model for expression generation
```

---

## PHASE 2: Script Generation & Draft System

### Step 2.1: Create `animation-server/orchestrator/script-generator.js`

**Class: `ScriptGenerator`**

Constructor takes `{ openai, pipelineStore, mediaLibrary }`. The `openai` instance is already created in `animation-server/server.js` (line 54).

**Methods:**

#### `async expandDirectorNote(seed, mediaRefs, showContext)`

1. Build system prompt with character profiles from `voices.js` (require it: `const voices = require('../../voices')`)
2. Build user content — seed text + show context (recent exitContexts, what's on TV, current mood)
3. If `mediaRefs` contains image IDs, include image URLs in the OpenAI message using the vision format:
   ```js
   // For images, use base64 from media library
   const imagePath = mediaLibrary.getOriginalPath(mediaRef);
   const imageBase64 = fs.readFileSync(imagePath).toString('base64');
   const mimeType = mediaLibrary.get(mediaRef).mimeType;
   // Add to messages as: { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
   ```
4. Call OpenAI with model from `process.env.EXPRESSION_MODEL || 'gpt-4o-mini'` (or use a new `SCRIPT_MODEL` env var, default `gpt-4o`)
5. Parse JSON response into `DialogueLine[]` array
6. Estimate duration: count total words / 150 * 60 = seconds
7. Create segment in pipeline store with status `draft`, populated `script`, `estimatedDuration`, `tvCues`, `lightingCues`
8. Return the created segment

**System prompt structure:**
```
You are a show director for a livestream featuring Chad and Virgin (from the Virgin vs Chad meme).
Generate a dialogue script based on the producer's note.

Context:
- Recent show history: [last 3-5 segment exitContexts]
- Currently on TV: [media description or "nothing"]
- Current lighting mood: [current hue value]

CHARACTER PROFILES:
CHAD: [from voices.chad.basePrompt]
VIRGIN: [from voices.virgin.basePrompt]

OUTPUT FORMAT:
Return ONLY valid JSON:
{
  "script": [
    { "speaker": "chad", "text": "...", "cues": [] },
    { "speaker": "virgin", "text": "...", "cues": [{ "type": "tv:show", "target": "media-id-here" }] }
  ],
  "exitContext": "Brief summary of what was discussed"
}

Cue types:
- { "type": "tv:show", "target": "<media-id>" } — show media on TV when this line starts
- { "type": "tv:release" } — revert TV to default
- { "type": "lighting:hue", "target": "<number -180 to 180>" } — change lighting hue

Rules:
- Natural conversational flow (not rigid alternation)
- Chad can interrupt, Virgin can trail off
- One character can have multiple consecutive lines
- 1-3 sentences per line
- No emojis, no markdown in dialogue text
- Place TV cues at natural reference points ("check this out" → tv:show)
- Place tv:release before topic changes away from the media
- Audio tags for ElevenLabs v3: [laughs], [chuckles], [sighs], [nervous laugh], [clears throat], etc.
```

**JSON parsing:** Use the same `parseJsonObject` pattern from `server.js`:
```js
function parseJson(content) {
  const clean = content.replace(/```json|```/gi, '').trim();
  try { return JSON.parse(clean); } catch (e) {}
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch (e) {}
  }
  return null;
}
```

#### `async regenerateScript(segmentId, feedback)`

1. Get segment from pipeline store
2. Re-run `expandDirectorNote` with the original seed + feedback appended
3. Update segment with new script via `pipelineStore.updateSegment()`

#### `async regeneratePartial(segmentId, startLine, endLine, feedback)`

1. Get segment, extract script lines `startLine..endLine`
2. Send to LLM: "Rewrite lines {startLine}-{endLine} of this script. Feedback: {feedback}"
3. Splice new lines into existing script
4. Update segment

#### `async expandChatMessage(chatMessage, showContext)`

Lighter version — generates 1-3 exchange response to a chat message.
Same flow as `expandDirectorNote` but with a simpler prompt:
```
Generate a 1-3 exchange response to this chat message. Type: chat-response.
Chat message: "{chatMessage}"
Context: [recent show context]
```

**Segment shape output:**
```js
{
  id: 'uuid',
  status: 'draft',
  type: 'auto-convo' | 'chat-response',
  seed: 'original director note',
  mediaRefs: ['media-id-1'],
  script: [
    { speaker: 'chad', text: 'Yo check this out', cues: [{ type: 'tv:show', target: 'media-id-1' }] },
    { speaker: 'virgin', text: 'Oh no...', cues: [] }
  ],
  estimatedDuration: 24,
  tvCues: [{ type: 'tv:show', target: 'media-id-1', lineIndex: 0 }],
  lightingCues: [],
  exitContext: 'They discussed the meme, Chad loved it, Virgin was embarrassed'
}
```

**Wire into server.js:**

Add to requires at top:
```js
const ScriptGenerator = require('./orchestrator/script-generator');
```

Add global:
```js
let scriptGenerator = null;
```

In `start()`, after pipelineStore init:
```js
if (openai) {
  scriptGenerator = new ScriptGenerator({ openai, pipelineStore, mediaLibrary });
}
```

Add endpoints:
```
POST /api/orchestrator/expand     — { seed, mediaRefs?, showContext? } → creates draft segment
POST /api/orchestrator/expand-chat — { message, showContext? } → creates chat-response draft
POST /api/orchestrator/regenerate  — { segmentId, feedback? } → regenerates full script
POST /api/orchestrator/regenerate-partial — { segmentId, startLine, endLine, feedback }
```

### Step 2.2: Create `animation-server/orchestrator/bridge-generator.js`

**Class: `BridgeGenerator`**

Constructor takes `{ openai, pipelineStore }`.

**Method: `async generateBridge(exitContext, nextSeed, lastSpeaker)`**

1. Call OpenAI with prompt:
   ```
   Generate a 1-2 line transition between topics.
   Ending topic: {exitContext}
   Starting topic: {nextSeed}
   Last speaker: {lastSpeaker}

   Output JSON: { "script": [{ "speaker": "chad|virgin", "text": "..." }] }

   Vary the style:
   - Verbal pivot ("Speaking of which...", "That reminds me...")
   - Personality-driven (Chad confidently changes subject, Virgin awkwardly stumbles)
   - Natural beat (just start new topic)
   ```
2. Parse response
3. Create a segment with type `transition`, status `draft`
4. Return segment

**Wire into server.js** — add require, global, init in start(), add endpoint:
```
POST /api/orchestrator/bridge — { exitContext, nextSeed, lastSpeaker }
```

### Step 2.3: Create `animation-server/orchestrator/filler-generator.js`

**Class: `FillerGenerator`**

Constructor takes `{ openai, pipelineStore }`.

**Method: `async generateFiller(recentExitContexts)`**

1. Call OpenAI with prompt:
   ```
   Generate a short filler dialogue (3-5 exchanges) for Chad and Virgin.
   They should riff on recent topics or do generic banter.
   Recent topics: {recentExitContexts}

   Output JSON: { "script": [{ "speaker": "...", "text": "..." }, ...] }
   ```
2. Create segment with type `filler`, status `draft`
3. Return segment

**Wire into server.js** — same pattern. Endpoint:
```
POST /api/orchestrator/filler — { recentContexts? }
```

---

## PHASE 3: Rendering Pipeline

### Step 3.1: Create `animation-server/orchestrator/segment-renderer.js`

**Class: `SegmentRenderer`**

This is the most critical new file. It takes a draft-approved segment and renders all dialogue lines through TTS + animation.

Constructor takes `{ pipelineStore, animationServerUrl }`.
- `animationServerUrl` defaults to `http://127.0.0.1:${process.env.ANIMATION_PORT || 3003}`
- Requires `axios` (already in root package.json) and `form-data`

**IMPORTANT:** The segment renderer needs `ELEVENLABS_API_KEY` and access to `voices.js`. Since it runs inside the animation server process, it needs these values passed in or read from env. The simplest approach: require `voices.js` from `../../voices` and read `process.env.ELEVENLABS_API_KEY`.

**Method: `async renderSegment(segmentId)`**

1. Get segment from pipeline store
2. Transition status: `draft → forming` via `pipelineStore.transitionStatus(segmentId, 'forming')`
3. For each line in `segment.script` (sequentially):
   a. Get voice config from `voices[line.speaker]`
   b. Call ElevenLabs TTS:
      ```js
      const ttsResponse = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceConfig.elevenLabsVoiceId}`,
        {
          text: line.text,
          model_id: process.env.AUTO_TTS_MODEL || 'eleven_turbo_v2',
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
      ```
   c. POST audio to animation server `/render`:
      ```js
      const form = new FormData();
      form.append('audio', Buffer.from(ttsResponse.data), {
        filename: 'audio.mp3', contentType: 'audio/mpeg'
      });
      form.append('character', line.speaker);
      form.append('message', line.text);
      form.append('mode', 'router');

      const renderResult = await axios.post(
        `${this.animationServerUrl}/render`,
        form,
        { headers: form.getHeaders() }
      );
      ```
   d. Update `renderProgress`: `(lineIndex + 1) / totalLines`
      ```js
      await pipelineStore.updateSegment(segmentId, {
        renderProgress: (i + 1) / segment.script.length
      });
      ```
   e. If TTS or render fails, retry up to 3 times. On persistent failure, log error and continue to next line.
4. After all lines rendered, transition: `forming → ready`
5. Emit event (for WebSocket, Phase 5) — for now just console.log

**Error handling:** If a line fails all retries, mark it in metadata but continue rendering other lines. The segment still transitions to `ready` (partial render is better than blocking the pipeline).

**Method: `async renderBridge(segmentId)`**

Same as `renderSegment` but for transition segments (1-2 lines, no TV/lighting cues).

**Concurrency:** Add a `maxConcurrent` parameter (default 2). Use a simple semaphore:
```js
this.activeRenders = 0;
this.renderQueue = [];

async queueRender(segmentId) {
  if (this.activeRenders >= this.maxConcurrent) {
    return new Promise(resolve => {
      this.renderQueue.push(() => resolve(this.renderSegment(segmentId)));
    });
  }
  return this.renderSegment(segmentId);
}
```

**Wire into server.js** — add require, global, init, endpoints:
```
POST /api/orchestrator/render/:id   — start rendering a segment
GET  /api/orchestrator/render/:id   — get render progress
```

### Step 3.2: Create `animation-server/orchestrator/playback-controller.js`

**Class: `PlaybackController`**

Constructor takes `{ pipelineStore, tvLayerManager, segmentRenderer }`.

**State:**
- `isPlaying: false` — whether the orchestrator is actively managing playback
- `currentSegmentId: null` — segment currently on-air
- `currentLineIndex: 0` — which line is currently airing
- `waitingForRender: false` — waiting for animation server to finish current audio

**Method: `async start()`**

Starts the playback loop. Checks pipeline for pre-air or ready segments and begins airing them.

**Method: `async playNextSegment()`**

1. Find the pre-air segment (or auto-promote next ready)
2. Transition: `pre-air → on-air` (or `ready → pre-air → on-air`)
3. For each line in the on-air segment:
   a. Fire any cues attached to this line:
      - `tv:show` → call `tvLayerManager.pushOverride(mediaId)`
      - `tv:release` → call `tvLayerManager.releaseOverride()`
      - `lighting:hue` → call `POST /lighting/hue` on self (localhost:3003)
   b. The render already happened in Phase 3.1 — the audio is queued in the animation server's render queue
   c. Wait for the audio to finish playing (poll `/stream-info` or use the render duration)
4. When all lines done: transition `on-air → aired`
5. Generate exitContext (LLM call to summarize what was discussed)
6. Check for next segment, repeat

**IMPORTANT INTEGRATION NOTE:** The animation server's render queue is the actual playback mechanism. When the segment renderer POSTs each line to `/render` with `mode=router`, the audio gets queued. The playback controller doesn't need to manage audio timing — it just needs to know when the queue is empty (all audio played). It can poll `/stream-info` to check `state.isPlaying`.

However, for orchestrated playback, the segment renderer should NOT render everything at once into the queue (that would play the entire segment immediately). Instead, the playback controller should coordinate:
1. Renderer renders all lines to get audio files ready (store audio buffers, don't POST to /render yet)
2. Playback controller feeds lines to /render one at a time, firing cues between lines

**Alternative simpler approach:** Since `/render` with `mode=router` already queues, just render all lines at once during the forming phase. They'll play in order. Fire cues by timing — estimate when each line starts based on cumulative durations.

Choose the simpler approach for now. Track cumulative duration to know when to fire cues:
```js
let cumulativeMs = 0;
for (const line of segment.script) {
  if (line.cues) {
    setTimeout(() => fireCues(line.cues), cumulativeMs);
  }
  cumulativeMs += estimateLineDuration(line.text); // word count / 150 * 60 * 1000
}
```

**Wire into server.js** — endpoints:
```
POST /api/orchestrator/play     — start orchestrated playback
POST /api/orchestrator/stop     — stop orchestrated playback
GET  /api/orchestrator/status   — current playback state
```

### Step 3.3: Create `animation-server/orchestrator/buffer-monitor.js`

**Class: `BufferMonitor`**

Constructor takes `{ pipelineStore, fillerGenerator, eventEmitter }`.

**Method: `start(intervalMs = 1000)`**

Runs on interval. Each tick:
1. Call `pipelineStore.getBufferHealth()`
2. Determine health level:
   - `totalSeconds >= 30` → green
   - `totalSeconds >= 15` → yellow
   - `totalSeconds >= 5` → red
   - `totalSeconds < 5` → critical
3. If critical and filler enabled and no filler recently generated:
   - Call `fillerGenerator.generateFiller()`
   - Auto-approve (transition draft → forming)
   - Queue for rendering
4. Emit buffer status event (for WebSocket, Phase 5)

**Wire into server.js** — init in start(), no new endpoints needed (status exposed via `/api/pipeline` bufferHealth).

---

## PHASE 4: Chat Intake System

### Step 4.1: Create `animation-server/orchestrator/chat-intake.js`

**Class: `ChatIntakeAgent`**

Constructor takes `{ openai, scriptGenerator, pipelineStore }`.

**State:**
- `messageWindow: []` — rolling window of recent chat messages (last 50)
- `inbox: []` — curated chat cards ready for the producer
- `intakeRate: 1` — messages per minute to process
- `autoApprove: false` — skip draft stage for chat responses
- `lastIntakeTime: 0`

**Method: `addMessage(username, text, timestamp)`**

Push to messageWindow, trim to max 50.

**Method: `async processIntake()`**

Called on interval (every 60s / intakeRate):
1. If messageWindow is empty, skip
2. Call OpenAI to select the best message:
   ```
   Select the most entertaining/interesting message from this chat window.
   Prefer: open-ended questions, controversial takes, funny comments.
   Avoid: yes/no questions, repeated topics, toxic content.

   Messages:
   [list of messages with usernames]

   Output JSON: { "selected": { "username": "...", "text": "..." }, "reason": "..." }
   ```
3. Create a chat card in `inbox`
4. If `autoApprove`, call `scriptGenerator.expandChatMessage()` and auto-render

**Wire into server.js** — endpoints:
```
POST /api/orchestrator/chat/message     — receive chat message { username, text }
GET  /api/orchestrator/chat/inbox       — get inbox cards
POST /api/orchestrator/chat/intake-rate  — { rate: number }
POST /api/orchestrator/chat/auto-approve — { enabled: boolean }
GET  /api/orchestrator/chat/config       — get intake config
```

---

## PHASE 5: WebSocket & Orchestrator API

### Step 5.1: Add `ws` dependency

```bash
cd animation-server && npm install ws
```

### Step 5.2: Create `animation-server/orchestrator/websocket.js`

**Class: `OrchestratorSocket`**

Constructor takes `{ server }` (the HTTP server from `app.listen()`).

```js
const WebSocket = require('ws');

class OrchestratorSocket {
  constructor(server) {
    this.wss = new WebSocket.Server({ server, path: '/ws/orchestrator' });
    this.wss.on('connection', (ws) => {
      console.log('[WS] Client connected');
      ws.on('close', () => console.log('[WS] Client disconnected'));
    });
  }

  broadcast(event, data) {
    const message = JSON.stringify({ event, data, timestamp: Date.now() });
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }
}
```

**Events to broadcast:**
- `pipeline:update` — any pipeline mutation
- `segment:progress` — render progress (throttled to every 5%)
- `segment:draft-ready` — new draft available
- `tv:state-change` — TV layer change
- `buffer:warning` — buffer health threshold crossed
- `chat:new-card` — new chat message in inbox

**Wire into server.js:**

Change `app.listen()` to capture the server:
```js
// BEFORE:
app.listen(port, host, () => { ... });

// AFTER:
const server = app.listen(port, host, () => { ... });
const orchestratorSocket = new OrchestratorSocket(server);
```

Then pass `orchestratorSocket` to services that need to emit events (buffer monitor, playback controller, pipeline store).

### Step 5.3: Add orchestrator state endpoint

```
GET /api/orchestrator/state — full show state:
{
  pipeline: { segments, bufferHealth },
  tvLayer: tvLayerManager.getState(),
  lighting: { hue, rainbow, flicker, lights },
  playback: playbackController.getStatus(),
  chatIntake: { inbox, intakeRate, autoApprove }
}
```

### Step 5.4: Add orchestrator config endpoint

```
GET  /api/orchestrator/config — read from data/orchestrator-config.json
POST /api/orchestrator/config — update and persist
```

Default config:
```json
{
  "buffer": { "warningThresholdSeconds": 15, "criticalThresholdSeconds": 5 },
  "filler": { "enabled": true, "maxConsecutive": 3, "style": "callback" },
  "chatIntake": { "enabled": true, "ratePerMinute": 1, "autoApprove": false },
  "rendering": { "maxConcurrentForming": 2, "ttsModel": "eleven_turbo_v2", "retryAttempts": 3 },
  "scriptGeneration": { "model": "gpt-4o", "defaultExchanges": 8, "maxExchanges": 30, "wordsPerMinute": 150 }
}
```

---

## PHASE 6: Frontend — Orchestrator UI

### Step 6.1: Create `frontend/director.html`

Single HTML file (same pattern as `tv-control.html`, `lighting-control.html`). Vanilla HTML/CSS/JS, no build tools. Dark theme matching existing `style.css`.

Serve at `/director` from animation server:
```js
app.get('/director', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'frontend', 'director.html'));
});
```

Load SortableJS from CDN for drag-and-drop:
```html
<script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.0/Sortable.min.js"></script>
```

### Step 6.2: Layout Structure

```html
<div id="app">
  <!-- Header: stream preview + buffer health -->
  <header>
    <div id="stream-preview">
      <video id="preview-player" muted></video>
    </div>
    <div id="buffer-health">
      <div class="health-bar"><div class="health-fill"></div></div>
      <span class="health-text">28s ready</span>
    </div>
    <div id="on-air-info"></div>
  </header>

  <!-- Main area: ammunition + draft preview -->
  <main>
    <div id="ammunition">
      <div id="chat-inbox" class="ammo-column">
        <h3>Chat Inbox</h3>
        <div class="card-list"></div>
      </div>
      <div id="auto-ideas" class="ammo-column">
        <h3>Ideas</h3>
        <textarea id="idea-input" placeholder="Quick seed..."></textarea>
        <button id="create-idea">Create</button>
        <div class="card-list"></div>
      </div>
    </div>

    <div id="draft-preview" class="hidden">
      <h3>Draft Preview</h3>
      <div id="script-lines"></div>
      <div id="draft-actions">
        <button id="approve-draft">Approve</button>
        <button id="regen-draft">Regenerate</button>
        <button id="discard-draft">Discard</button>
      </div>
    </div>

    <!-- Director input -->
    <div id="director-input">
      <div id="media-attachments"></div>
      <div id="input-controls">
        <button id="attach-file">Upload</button>
        <button id="attach-library">Library</button>
        <input type="file" id="file-input" hidden accept="image/*,video/*">
      </div>
      <textarea id="director-note" placeholder="Director's note..."></textarea>
      <button id="create-draft">Create Draft</button>
    </div>
  </main>

  <!-- Pipeline row -->
  <div id="pipeline">
    <h3>Pipeline</h3>
    <div id="pipeline-cards" class="pipeline-row">
      <!-- Cards rendered here, SortableJS handles drag -->
    </div>
    <div id="pre-air-slot" class="pipeline-slot">PRE-AIR</div>
    <div id="on-air-slot" class="pipeline-slot">ON-AIR</div>
  </div>

  <!-- Aired archive -->
  <details id="aired-archive">
    <summary>Aired Archive</summary>
    <div id="aired-list"></div>
  </details>
</div>
```

### Step 6.3: JavaScript (`frontend/director.js` or inline in director.html)

**Core functions:**

```js
// API base URL (use config.js pattern)
const API_BASE = window.location.origin;

// Fetch helpers
async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`);
  return res.json();
}
async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

// Load pipeline
async function refreshPipeline() {
  const data = await apiGet('/api/pipeline');
  renderPipelineCards(data.segments);
  renderBufferHealth(data.bufferHealth);
}

// Load media library
async function refreshMedia() {
  const data = await apiGet('/api/media');
  renderMediaGrid(data.items);
}

// Create draft from director input
async function createDraft() {
  const seed = document.getElementById('director-note').value;
  const mediaRefs = getAttachedMediaIds();
  const result = await apiPost('/api/orchestrator/expand', { seed, mediaRefs });
  refreshPipeline();
  showDraftPreview(result);
}

// Approve draft
async function approveDraft(segmentId) {
  await apiPost(`/api/pipeline/${segmentId}/status`, { status: 'forming' });
  await apiPost(`/api/orchestrator/render/${segmentId}`);
  refreshPipeline();
}

// Pipeline drag-and-drop
const sortable = new Sortable(document.getElementById('pipeline-cards'), {
  animation: 150,
  onEnd: async (evt) => {
    const order = Array.from(evt.target.children).map(el => el.dataset.id);
    await apiPost('/api/pipeline/reorder', { order });
  }
});

// WebSocket for real-time updates
function connectWebSocket() {
  const ws = new WebSocket(`ws://${window.location.host}/ws/orchestrator`);
  ws.onmessage = (event) => {
    const { event: type, data } = JSON.parse(event.data);
    switch (type) {
      case 'pipeline:update': refreshPipeline(); break;
      case 'segment:progress': updateProgressBar(data.id, data.progress); break;
      case 'buffer:warning': flashBufferWarning(data.level); break;
      case 'chat:new-card': addChatCard(data); break;
    }
  };
  ws.onclose = () => setTimeout(connectWebSocket, 3000); // reconnect
}

// Init
refreshPipeline();
refreshMedia();
connectWebSocket();
```

### Step 6.4: Styling

Dark theme, matching existing panels. Key styles:
- Pipeline row: horizontal flexbox, scrollable
- Cards: dark bg (#2a2a2a), rounded corners, status badge color-coded
- Buffer health bar: green/yellow/red gradient
- Draft preview: side panel with editable script lines
- Drag handles on pipeline cards

### Step 6.5: Pipeline card rendering

```js
function renderPipelineCards(segments) {
  const container = document.getElementById('pipeline-cards');
  container.innerHTML = segments.map(seg => `
    <div class="pipeline-card" data-id="${seg.id}" data-status="${seg.status}">
      <div class="card-type">${seg.type}</div>
      <div class="card-title">${(seg.seed || '').slice(0, 30)}</div>
      <div class="card-status status-${seg.status}">
        ${seg.status}${seg.status === 'forming' ? ` ${Math.round(seg.renderProgress * 100)}%` : ''}
      </div>
      <div class="card-duration">${seg.estimatedDuration}s</div>
    </div>
  `).join('');
}
```

### Step 6.6: Stream preview

Small HLS player using HLS.js (already used in the main frontend):
```html
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
```
```js
const video = document.getElementById('preview-player');
if (Hls.isSupported()) {
  const hls = new Hls({ liveSyncDurationCount: 2, maxBufferLength: 6 });
  hls.loadSource(`${API_BASE}/streams/live/stream.m3u8`);
  hls.attachMedia(video);
  video.play();
}
```

---

## PHASE 7: Integration & Polish

### Step 7.1: Orchestrator index module

Create `animation-server/orchestrator/index.js` that wires everything together:

```js
class Orchestrator {
  constructor({ openai, pipelineStore, mediaLibrary, tvLayerManager, animationServerUrl }) {
    this.scriptGenerator = new ScriptGenerator({ openai, pipelineStore, mediaLibrary });
    this.bridgeGenerator = new BridgeGenerator({ openai, pipelineStore });
    this.fillerGenerator = new FillerGenerator({ openai, pipelineStore });
    this.segmentRenderer = new SegmentRenderer({ pipelineStore, animationServerUrl });
    this.playbackController = new PlaybackController({ pipelineStore, tvLayerManager, segmentRenderer: this.segmentRenderer });
    this.bufferMonitor = new BufferMonitor({ pipelineStore, fillerGenerator: this.fillerGenerator });
    this.chatIntake = new ChatIntakeAgent({ openai, scriptGenerator: this.scriptGenerator, pipelineStore });
  }

  async init() {
    this.bufferMonitor.start();
  }
}
```

### Step 7.2: Lighting mood presets

Map mood names to lighting values for lighting cues:
```js
const MOODS = {
  dramatic: { hue: -60, emissionOpacity: 0.8 },
  upbeat: { hue: 30, emissionOpacity: 1.0 },
  chill: { hue: 180, emissionOpacity: 0.6 },
  spooky: { hue: -120, emissionOpacity: 0.4, flicker: true },
  neutral: { hue: 0, emissionOpacity: 0.7 }
};
```

### Step 7.3: Orchestrator config persistence

```js
const configPath = path.join(ROOT_DIR, 'data', 'orchestrator-config.json');
// Load on startup, save on change, same atomic write pattern
```

### Step 7.4: Error recovery

- TTS failure: retry 3 times with 2s delay between attempts
- Render failure: retry, skip line on persistent failure, log in segment metadata
- LLM failure: show error in draft, allow retry via UI
- Pipeline state recovery: pipeline.json is loaded on startup, segments resume from persisted state
- On-air tracking: if server restarts mid-segment, the on-air segment stays in the pipeline. On next startup, detect stale on-air segments (no active audio) and transition them to aired.

---

## FILE CREATION ORDER

For Codex or any agent continuing from Phase 1, create files in this order:

1. `animation-server/orchestrator/script-generator.js` — no deps on other new files
2. `animation-server/orchestrator/bridge-generator.js` — no deps on other new files
3. `animation-server/orchestrator/filler-generator.js` — no deps on other new files
4. `animation-server/orchestrator/segment-renderer.js` — depends on voices.js, pipeline-store
5. `animation-server/orchestrator/playback-controller.js` — depends on segment-renderer, tv-layer-manager, pipeline-store
6. `animation-server/orchestrator/buffer-monitor.js` — depends on pipeline-store, filler-generator
7. `animation-server/orchestrator/chat-intake.js` — depends on script-generator, pipeline-store
8. Wire all into `animation-server/server.js` — add requires, globals, init in start(), endpoints
9. `animation-server/orchestrator/websocket.js` — depends on ws npm package
10. `animation-server/orchestrator/index.js` — orchestrator index wiring everything
11. `frontend/director.html` — standalone, calls API endpoints
12. Integration + polish

**Each file should be testable independently with curl after wiring into server.js.**

---

## DEPENDENCIES TO INSTALL

```bash
# Phase 2-4 — no new deps needed (openai, axios, form-data already available)
# Phase 5 — WebSocket
cd animation-server && npm install ws

# Phase 6 — no npm deps (SortableJS and HLS.js loaded from CDN)
```

**Note:** `axios` and `form-data` are in the root `package.json` but NOT in `animation-server/package.json`. The segment renderer runs inside the animation server process, so either:
- Add `axios` and `form-data` to `animation-server/package.json`, OR
- Use Node's built-in `fetch` (available in Node 18+) with `FormData` from a simple implementation, OR
- Use `http` module directly

Recommended: add `axios` and `form-data` to animation-server deps:
```bash
cd animation-server && npm install axios form-data
```

---

## TESTING EACH PHASE

### Phase 2 Testing

```bash
# Start animation server
cd animation-server && node server.js

# Create a draft (needs OPENAI_API_KEY in env)
curl -X POST http://localhost:3003/api/orchestrator/expand \
  -H "Content-Type: application/json" \
  -d '{"seed":"Argue about pineapple on pizza"}'
# Expect: segment object with status "draft", script array, estimatedDuration

# Check pipeline has the draft
curl http://localhost:3003/api/pipeline
# Expect: segment in segments array

# Regenerate
curl -X POST http://localhost:3003/api/orchestrator/regenerate \
  -H "Content-Type: application/json" \
  -d '{"segmentId":"<id>","feedback":"Make it funnier"}'
```

### Phase 3 Testing

```bash
# Render a segment (needs ELEVENLABS_API_KEY in env)
curl -X POST http://localhost:3003/api/orchestrator/render/<id>
# Expect: rendering starts, progress updates in pipeline

# Watch progress
curl http://localhost:3003/api/pipeline/<id>
# Expect: renderProgress increasing, status "forming" → "ready"

# Start playback
curl -X POST http://localhost:3003/api/orchestrator/play
# Expect: next ready segment goes on-air, audio plays through HLS stream
```

### Phase 4 Testing

```bash
# Send a chat message
curl -X POST http://localhost:3003/api/orchestrator/chat/message \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","text":"Chad whats your bench press?"}'

# Check inbox
curl http://localhost:3003/api/orchestrator/chat/inbox
```

### Phase 5 Testing

```bash
# Connect WebSocket
wscat -c ws://localhost:3003/ws/orchestrator
# Then trigger pipeline changes in another terminal, observe events
```

### Phase 6 Testing

Open `http://localhost:3003/director` in browser. Verify:
- Pipeline cards render
- Drag-and-drop reorders
- Director input creates drafts
- Draft preview shows script
- Approve triggers rendering
- Buffer health bar updates
- WebSocket events update UI in real-time
