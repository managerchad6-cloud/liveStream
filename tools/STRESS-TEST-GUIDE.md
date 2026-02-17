# LiveStream Pipeline Stress-Test Guide

> Complete context for an AI agent to run pipeline stress tests autonomously.

## System Overview

This is a **live animated chatbot** with two characters (Chad and Virgin) that talk to each other and respond to viewer chat. Audio is generated via ElevenLabs TTS, composited onto animated character frames, and streamed as HLS video.

The **orchestrator pipeline** manages a queue of dialogue segments. Each segment goes through a lifecycle:

```
forming → ready → playing (on-air) → aired
```

### Segment Types

| Type | Source | Description |
|------|--------|-------------|
| `auto-convo` | Director seed prompt | 4-turn scripted dialogue generated from a topic |
| `expand` | Auto-generated | 2-turn continuation of the current conversation (metadata: `continuity: "expand"`) |
| `chat-response` | Viewer chat message | Narrator reads question + character answers |
| `bridge` | Auto-generated | 1-line transition connecting two different topics |
| `filler` | Legacy (disabled) | Buffer-filling segments (not used) |

### The Expand Chain (Infinite Conversation)

When a segment starts playing (`setOnAir`) and the pipeline is empty (no other `ready` or `forming` segments), the `PlaybackController` auto-generates an **expand** segment. This creates an infinite conversation loop:

```
seed → [play] → expand → [play] → expand → [play] → ...
```

Expand generation triggers **only when**:
1. A segment goes on-air (starts playing)
2. No other ready segments exist in the pipeline
3. No non-expand segments are currently rendering (forming)
4. No expand already exists for this segment

This means: **if a chat message or seed prompt is queued, expand generation is suppressed.** The system prioritizes real content over auto-generated continuations.

### Bridge Generation

When a segment of a different type follows the previous one (e.g., `auto-convo` after `chat-response`), a **bridge** is generated — a 1-line transition that smoothly connects the exit context of the preceding segment to the seed of the new one.

Bridges are inserted just before their target in pipeline order and use a **pre-gate**: the target segment's audio push waits until the bridge has pushed first.

### Pipeline-Order Enforcement

**Critical invariant**: Segments must push audio to the animation server's `/render` endpoint in pipeline order. The `SegmentRenderer` uses an ordered drain mechanism:

1. Multiple segments can TTS in parallel (Phase 1)
2. When TTS completes, results go into `pendingPushes` (a reorder buffer)
3. `_drainInPipelineOrder()` walks the pipeline and only pushes the next segment if it's the earliest pending one
4. If an earlier segment is still TTS-ing, later segments wait

This prevents fast-rendering segments (short chat replies) from jumping ahead of slower ones (long auto-convo scripts).

---

## API Reference

### Chat API Server (Port 3002)

#### Send a viewer chat message

```
POST http://127.0.0.1:3002/api/chat
Content-Type: application/json

{
  "message": "hey chad what's your bench press",
  "voice": "chad",          // "chad" or "virgin" — who responds
  "mode": "direct",         // always "direct" for testing
  "model": "eleven_v3",     // TTS model
  "temperature": 0.7        // LLM creativity (0.0–1.0)
}
```

**Response:** `{ "queued": true, "message": "Sent to director inbox", "voice": "chad" }`

**What happens:**
1. OpenAI generates a character response (~150 tokens)
2. The message + response are sent to the animation server's chat intake
3. If `autoApprove` is enabled, a `chat-response` segment is created immediately
4. The segment includes a narrator line (reads the question aloud) + the character's response
5. The segment is queued for rendering with bridge generation if needed

### Animation Server (Port 3003)

#### Seed an auto-convo topic (Director Console)

**Step 1: Generate script**
```
POST http://127.0.0.1:3003/api/orchestrator/expand
Content-Type: application/json

{
  "seed": "Chad brags about his gym routine while Virgin admits he's never been",
  "mediaRefs": []
}
```

**Response:** Segment object with `id`, `script` (4 lines), `status: "forming"`, `exitContext`

**Step 2: Queue for rendering**
```
POST http://127.0.0.1:3003/api/orchestrator/render/{segmentId}
Content-Type: application/json
{}
```

**Response:** `{ "id": "...", "status": "forming", "message": "Render queued" }`

Both steps are needed — expand creates the segment, render kicks off TTS.

#### Monitor pipeline state

```
GET http://127.0.0.1:3003/api/orchestrator/state
```

Returns: `{ pipeline: { segments: [...], bufferHealth: {...} }, playback: { isPlaying, currentSegmentId }, chatIntake: { inbox: [], autoApprove: true } }`

#### Check orchestrator status (lightweight)

```
GET http://127.0.0.1:3003/api/orchestrator/status
```

Returns: `{ isPlaying, isPaused, currentSegmentId, fillerEnabled }`

#### Chat intake config

```
GET http://127.0.0.1:3003/api/orchestrator/chat/config
```

Returns: `{ autoApprove: true/false }`

#### Enable/disable auto-approve

```
POST http://127.0.0.1:3003/api/orchestrator/chat/auto-approve
Content-Type: application/json

{ "enabled": true }
```

---

## What To Test

### 1. Pipeline-Order Enforcement (Primary Goal)

**The invariant:** Segments must air in the exact order they appear in the pipeline. No segment should skip ahead because its TTS finished faster.

**How to verify:** After each monitoring check, read `pipeline.segments` from `/api/orchestrator/state`. Every `aired` segment must appear before every `ready`/`forming` segment, and within the aired group, their pipeline-array position must be monotonically increasing (no swaps).

### 2. Expand Chain Continuity

**Test:** Seed a topic and let it play without interruption. After the initial segment airs, an expand should auto-generate and play seamlessly. Then another expand after that, and so on.

**What to check:**
- No silence gaps between segments
- Expand segments have `metadata.continuity: "expand"` and `metadata.expandFrom: <parentId>`
- Each expand continues the conversation naturally (not repeating or hallucinating)
- Expand generation triggers when the current segment goes on-air, not when it finishes

### 3. Chat Interruption Mid-Conversation

**Test:** While an auto-convo or expand is playing, send a chat message. The chat response should be queued after whatever is currently rendering/ready, not skip ahead.

**What to check:**
- Chat-response segments appear in the pipeline after existing queued segments
- If an expand was already rendering when the chat arrived, the expand finishes and plays before the chat response
- A bridge is generated if the chat response follows an auto-convo/expand (type change)
- After the chat response airs, the expand chain resumes from the new context

### 4. Multiple Rapid Chat Messages

**Test:** Send 2–3 chat messages within a few seconds while the pipeline has content.

**What to check:**
- All chat-response segments are created and queued in FIFO order (first sent = first in pipeline)
- They air in the order they were sent, not in TTS-completion order
- No TTS quota exhaustion from too many parallel requests (ElevenLabs has per-second limits)
- Bridge generation only happens for the first chat-response if it follows a different type

### 5. Seed Topic Steering

**Test:** While the expand chain is running on Topic A, seed a new Topic B from the director console. The system should:
1. Finish whatever is currently on-air
2. Play any already-queued segments
3. Generate a bridge from the exit context to the new topic
4. Play the bridge
5. Play the new seed segment
6. Start expanding Topic B

**What to check:**
- The bridge references the previous exit context and the new seed
- No orphaned expand segments from Topic A remain unaired in the pipeline
- Topic B's expand chain picks up from Topic B's context, not Topic A's

### 6. Chat + Seed Racing

**Test:** Send a chat message and a seed prompt nearly simultaneously (within 1–2 seconds).

**What to check:**
- Both segments are created and neither is lost
- Pipeline order is maintained regardless of which one's TTS finishes first
- Bridge generation works correctly (bridge to whichever auto-convo/custom-script entry follows a different type)

### 7. Silence Avoidance (Empty Pipeline Recovery)

**Test:** Let the pipeline drain completely (all segments aired, nothing rendering). Then send a single chat message.

**What to check:**
- After the chat response airs, an expand should trigger (pipeline is empty again)
- No prolonged silence between the chat response and the expand
- The expand picks up from the chat response's exit context

### 8. High-Frequency Stress

**Test:** Send 3+ chat messages in rapid succession AND a seed prompt while the pipeline is actively playing.

**What to check:**
- No TTS failures from rate limiting (if they happen, they're graceful — segment fails, pipeline continues)
- No deadlocks in the ordered drain mechanism
- No segments stuck in `forming` indefinitely
- The push chain eventually drains all pending segments
- Server remains responsive throughout

---

## Recommended Test Cadence

**Important:** ElevenLabs has per-second and per-minute rate limits. Each segment TTS-es 2–4 lines sequentially. Space actions to avoid quota exhaustion.

### Timing Guidelines

| Action | Wait After |
|--------|-----------|
| Seed a topic | 20–30s (wait for TTS + first segment to start playing) |
| Send a chat message | 15–20s (wait for OpenAI response + TTS + push) |
| Send rapid chat burst (2–3 msgs) | 10–15s between messages, 30–40s after the burst |
| Seed while chat is rendering | 5–10s after chat, then 30s to observe |
| Check pipeline state | Every 5–10s during monitoring phase |

### Example Session Flow (Recommended)

This mirrors a realistic livestream session and tests all the key scenarios:

```
T+0:00   Seed topic: "Chad and Virgin debate which superhero would win in a fight"
         → Wait 25s for TTS + segment to start playing

T+0:25   [MONITOR] Check pipeline — should see seed segment playing, expand forming
         → Wait 30s for expand to render and start playing

T+0:55   [MONITOR] Verify expand is playing, second expand forming
         → Now interrupt with chat

T+1:00   Chat: "yo chad are you into marvel or dc" (voice: chad)
         → Wait 20s

T+1:20   [MONITOR] Chat response should be queued after current expand chain
         → Send another chat while first is still rendering/queued

T+1:25   Chat: "virgin what's the lamest superpower you'd want" (voice: virgin)
         → Wait 40s for both chats to air

T+2:05   [MONITOR] Both chat responses should have aired in order
         → Expand chain should resume after chats

T+2:10   Seed new topic: "The guys argue about whether hot dogs are sandwiches"
         → This tests topic steering — bridge should generate

T+2:15   Chat: "that's a stupid topic change lol" (voice: chad)
         → Racing a chat against the seed

T+2:45   [MONITOR] Check pipeline order:
         - Previous expand(s) → aired
         - Chat responses → aired (in FIFO order)
         - Bridge → aired (before new seed)
         - New seed → playing or aired
         - Racing chat → queued after seed

T+3:15   [MONITOR] Let pipeline drain, verify expand chain picks up new topic

T+3:30   Rapid burst: Send 3 chat messages with 5s gaps
         Chat 1: "chad how many hot dogs can you eat" (voice: chad)
         Chat 2: "virgin are you vegetarian" (voice: virgin)
         Chat 3: "who's a better cook" (voice: chad)
         → Wait 60s for all to process

T+4:30   [MONITOR] All 3 should air in order sent, expand resumes after

T+5:00   Final seed: "Chad reveals he's secretly a terrible cook"
         → Let pipeline drain completely
         → Verify expand chain runs on new topic

T+6:00   [END] Final pipeline audit — all segments aired in pipeline order
```

---

## Verification Checklist

After each monitoring check, verify:

- [ ] **Order**: No `aired` segment appears after a `ready`/`forming` segment in the pipeline array
- [ ] **No gaps**: Expand segments exist between content segments (no long silence periods)
- [ ] **Bridge placement**: Every bridge sits immediately before its target segment
- [ ] **FIFO chat**: Chat responses air in the order they were sent
- [ ] **No orphans**: No `forming` segments stuck for >60s without progress
- [ ] **Type transitions**: Bridges exist at type boundaries (auto-convo→chat-response or vice versa, when switching to auto-convo/custom-script)
- [ ] **Expand suppression**: No expand generates while chat-response or seed segments are rendering
- [ ] **Context continuity**: Each segment's `exitContext` is a natural continuation (not a hallucinated topic)
- [ ] **No duplicate expands**: Only one expand per on-air segment

### Reading the Pipeline State

```javascript
// From GET /api/orchestrator/state
const segments = state.pipeline.segments;

// Pipeline array order IS the play order (index 0 = first to play)
// Check that all aired segments come before non-aired:
let sawNonAired = false;
for (const seg of segments) {
  if (seg.status !== 'aired') sawNonAired = true;
  if (seg.status === 'aired' && sawNonAired) {
    // ORDER VIOLATION — this aired segment is after a non-aired one
  }
}
```

### Key Fields to Inspect

| Field | What to check |
|-------|---------------|
| `seg.status` | Lifecycle position (forming → ready → aired) |
| `seg.type` | Segment origin (auto-convo, expand, chat-response, bridge) |
| `seg.seed` | Original topic/question (truncated for chat-response) |
| `seg.exitContext` | Topic summary for continuity — should be concise, not a transcript |
| `seg.metadata.continuity` | "expand" if auto-generated continuation |
| `seg.metadata.expandFrom` | Parent segment ID for expands |
| `seg.metadata.renderError` | Non-null means TTS or push failed |
| `seg.renderProgress` | 0→0.5 = TTS phase, 0.5→1.0 = push phase, -1 = failed |
| `seg.script` | Array of `{ speaker, text }` — check for natural dialogue |

---

## Common Failure Modes

### ElevenLabs Quota Exhaustion
- **Symptom**: All segments fail with `401: exceeds your quota`
- **Cause**: Too many TTS requests burned through credits
- **Prevention**: Space chat messages 15–20s apart, don't fire >3 in a burst
- **Recovery**: Top up ElevenLabs credits, clear failed segments

### Pipeline Deadlock
- **Symptom**: Segments stuck in `forming` with renderProgress frozen
- **Cause**: Ordered drain waiting for a segment that will never complete
- **Check**: Look for segments in `activeTTS` that have no active TTS request
- **Recovery**: Restart animation server (clears pipeline on start)

### Expand Storm
- **Symptom**: Multiple expand segments generating at once
- **Cause**: Race condition in `_maybeGenerateExpand` (pendingExpand guard failing)
- **Check**: Count segments with `metadata.continuity: "expand"` and `status: "forming"`

### Bridge Timeout
- **Symptom**: Target segment delayed by 15s (BRIDGE_GATE_TIMEOUT_MS)
- **Cause**: Bridge TTS failed and gate didn't resolve
- **Check**: Bridge segment with `renderProgress: -1` and target's push delayed

### Chat Response Reordering
- **Symptom**: Chat responses air in different order than they were sent
- **Cause**: Pipeline-order enforcement failure — the exact bug this test catches
- **Check**: Compare `createdAt` timestamps of chat-response segments with their pipeline positions

---

## Cleanup Between Test Runs

Restart the animation server to clear the pipeline:
```bash
# Kill and restart animation server (port 3003)
# Pipeline is cleared on startup (PipelineStore.init() does clean slate)
```

Or if testing requires a fresh start without restart, note that there's no explicit "clear pipeline" API — restarting is the cleanest way.

---

## Environment Prereqs

- Both servers running: `npm run dev` (ports 3002 + 3003)
- ElevenLabs API key configured with sufficient credits
- OpenAI API key configured (for script generation + chat responses)
- Chat auto-approve enabled: `POST /api/orchestrator/chat/auto-approve { "enabled": true }`
- Playback started (should be by default): `POST /api/orchestrator/play`
