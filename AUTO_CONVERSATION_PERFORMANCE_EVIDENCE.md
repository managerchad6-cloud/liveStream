# Auto Conversation – Performance Evidence (Last Run)

Evidence collected from terminal logs and a one-time process snapshot. **No wall-clock timestamps** are currently logged by the app or animation server, so "exact timestamps" below use **frame numbers** (30 fps → 1 frame ≈ 33.3 ms) and **log order** as proxies.

---

## Latest run (stuttered <3 times) – snapshot

### Main app (3002) – excerpt

```
[Auto] Request seed="talk about why there's a lambo in the ro...", turns=12
[Auto] Playback starting 12 turns, animationServerUrl=http://127.0.0.1:3003
[Auto] Posting to http://127.0.0.1:3003/render (turn 1/12, chad)
[Auto] Posting to http://127.0.0.1:3003/render (turn 2/12, virgin)
...
[Auto] Posting to http://127.0.0.1:3003/render (turn 12/12, virgin)
```

### Animation server (3003) – excerpt

**Frame range in buffer:** ~8250 → ~9270+ (virgin/chad speaking; TV:stopped). [Render] lines were not in the captured buffer (scrolled off); only [Compositor] L1 cache miss and [Frame N] lines were captured.

**Sample [Frame] and [Compositor] L1 cache miss lines:**

```
[Frame 8250] [SY] virgin speaking (D) | chad:A virgin:D | TV:stopped
[Frame 8280] [SY] virgin speaking (E) | chad:A virgin:E | TV:stopped
[Compositor] L1 cache miss: 50ms (0 transforms)
[Compositor] L1 cache miss: 51ms (0 transforms)
[Compositor] L1 cache miss: 53ms (0 transforms)
[Compositor] L1 cache miss: 45ms (0 transforms)
...
[Compositor] L1 cache miss: 65ms (0 transforms)
[Compositor] L1 cache miss: 69ms (0 transforms)
...
[Frame 9210] [SY] chad speaking (D) | chad:D virgin:A | TV:stopped
[Compositor] L1 cache miss: 53ms (0 transforms)
[Compositor] L1 cache miss: 69ms (0 transforms)
```

**Stutter frame numbers:** Not reported by user. Likely correlates with frames where a compositor L1 miss exceeded the 33 ms budget (see summary below).

### Resource snapshot (Get-Process during/after run)

| PID   | CPU (total) | WorkingSet (MB) |
|-------|-------------|-----------------|
| 22228 | 139.6       | 139.2           |
| 26536 | 201.7       | 113.6           |
| 9188  | 63.6        | 76.9            |
| 11084 | 15.9        | 78.1            |
| 1848  | 25.5        | 62.7            |

(Snapshot taken after run; main app and animation server are among the higher WorkingSet node processes.)

### Summary – cache misses vs 33 ms frame budget

- **Do cache misses still exceed the 33 ms frame budget?** **Yes.** In the captured segment there were **125** [Compositor] L1 cache miss lines. **All** had reported times in the range **44–69 ms**; every one exceeds the 33.3 ms budget for 30 fps.
- **How often do they occur?** In this segment, L1 cache misses occur **very frequently** during speech (multiple per 30-frame second). Roughly 125 misses over ~1020 frames (8250→9270) → about **1 miss every 8 frames** on average; when a miss happens, that frame’s composite cost is 44–69 ms, so that frame can stutter or cause a dropped frame.
- **Remaining hotspots suggested by the logs:**
  1. **Compositor L1 cache miss (44–69 ms)** – Still the primary in-stream hotspot; every miss exceeds the frame budget.
  2. **Peak L1 times (e.g. 65, 66, 67, 69 ms)** – Worst frames are ~2× the 33 ms budget; likely to produce noticeable stutters when they occur.
  3. **Expression/state churn** – Frequent phoneme and expression changes (virgin/chad speaking, SMILE/SURPRISE, blink) cause new composite keys and cache misses.
  4. **No [Render] timing in this buffer** – Per-POST decode/total costs for this run were not in the captured animation server log; decode (45–75 ms) remains a suspected turn-start hotspot from earlier evidence.

---

## 1. Main app (port 3002) – log excerpt (last auto run)

From terminal 1 (main app), the last successful 12-turn auto run:

```
[Auto] Env: ELEVENLABS_API_KEY=set, OPENAI_API_KEY=set, ANIMATION_SERVER_URL=set, AUTO_MODEL=default, AUTO_TTS_MODEL=default
[Auto] animationServerUrl=http://127.0.0.1:3003
[Auto] Request seed="talk about why the Virgin vs Chad pumpfu...", turns=12
[Auto] Playback starting 12 turns, animationServerUrl=http://127.0.0.1:3003
[Auto] Posting to http://127.0.0.1:3003/render (turn 1/12, chad)
[Auto] Posting to http://127.0.0.1:3003/render (turn 2/12, virgin)
...
[Auto] Posting to http://127.0.0.1:3003/render (turn 12/12, virgin)
[Chat] Voice: Chad, Model: eleven_turbo_v2, Temp: 0.7
[Chat] Response: Honestly, the Virgin vs Chad meme...
```

**Observations:**

- No timestamps; only order of events.
- Each turn: main app does **TTS (ElevenLabs)** then **POST /render**; next turn starts only after that POST completes (sequential).
- After the 12th Posting, normal [Chat] logs appear (later user chat).

---

## 2. Animation server (port 3003) – log excerpt (same period)

From terminal 3 (animation server). Frames are logged every **30 frames** (once per second). The auto run corresponds to **chad/virgin speaking** and **Render/Compositor** activity.

**Frame range during auto run:** ~Frame 3480 → ~Frame 6990 (then idle). So ~**117 seconds** of stream time (3492 frames at 30 fps).

**Sample [Render] lines (per /render POST):**

```
[Render] chad | move:1ms decode:55ms total:82ms | 13.8s audio
[Render] virgin | move:0ms decode:48ms total:48ms | 9.1s audio
[Render] chad | move:1ms decode:46ms total:47ms | 10.1s audio
[Render] virgin | move:1ms decode:53ms total:54ms | 9.9s audio
[Render] chad | move:1ms decode:63ms total:64ms | 15.6s audio
...
```

**Sample [Compositor] L1 cache miss lines (during speech):**

```
[Compositor] L1 cache miss: 65ms (0 transforms)
[Compositor] L1 cache miss: 67ms (0 transforms)
[Compositor] L1 cache miss: 55ms (0 transforms)
[Compositor] L1 cache miss: 58ms (0 transforms)
[Compositor] L1 cache miss: 69ms (0 transforms)
[Compositor] L1 cache miss: 75ms (2 transforms)
...
```

**Other events in the same period:**

- `[RealtimeLipSync] Calibrated (1s sample): {...}` – per new clip
- `[SyncedPlayback] Loaded samples: X.XXs, NNN frames`
- `[ContinuousStreamManager] Audio started: X.XXs, NNN frames`
- `[Expr] Heuristic plan for chad/virgin: {...}` – expression plan per turn
- `[Server] Audio complete, resetting speaker` – at end of each clip

**FPS / processing timing:**

- **No per-frame duration or FPS** is logged. The only time base is **frame index** and the **every-30-frames** `[Frame N]` line.
- **No ffmpeg/HLS write timing** in the normal render path (StreamManager writes frames to ffmpeg stdin without logging each write).

---

## 3. Resource usage (Get-Process snapshot)

One-time snapshot (not during the run). Multiple Node processes; likely candidates for main app and animation server are those with high working set:

| PID   | CPU (total) | WorkingSet64 (MB) |
|-------|------------|-------------------|
| 6744  | 598.8      | ~279              |
| 1848  | 25.4       | ~287              |
| 26536 | 198.5      | ~93               |
| 9188  | 61.7       | ~76               |

**Note:** CPU is cumulative; WorkingSet64 is current. No GPU or per-interval CPU/RAM during the auto run unless you capture Task Manager or a profiler during the next run.

---

## 4. Correlation: where stutters can align with log events

Without timestamps we can’t pin “stutter at clock time T”; we can only align **types of work** with **costs** and **order**.

| Phase | Main app (3002) | Animation server (3003) | Typical cost (from logs) |
|-------|------------------|-------------------------|---------------------------|
| Per turn start | TTS (ElevenLabs) | — | Not logged |
| After TTS | POST /render | Receives POST | — |
| /render handler | — | Move file, decode audio, lip sync, expression plan | move 0–1 ms, **decode 45–75 ms**, total **47–82 ms** |
| Each frame (30 fps) | — | `compositeFrame()` | **L1 cache miss 45–75 ms** when state changes (0–2 transforms) |
| After clip | — | `[Server] Audio complete` | — |
| HLS | — | Frame buffer → ffmpeg stdin | Not logged |

**Stutter correlation (best guess):**

1. **Right after each `[Auto] Posting to .../render (turn N/12)`**  
   Animation server does: move, decode (45–75 ms), load samples, build expression plan, then starts feeding frames. **Decode + plan** can block the handler briefly; first frames of the new clip may be delayed.

2. **When `[Compositor] L1 cache miss` appears**  
   Compositor is doing a full redraw for a new character/phoneme/blink state. Logged **45–75 ms** (up to **75 ms** with 2 transforms). At 30 fps (33.3 ms per frame), a single 65 ms miss can **delay that frame** and cause a visible stutter or dropped frame.

3. **Turn boundaries**  
   Main app does TTS then POST; animation server finishes previous clip (`Audio complete`), then receives next POST. So **turn boundary** = TTS latency (not logged) + network + decode + first-frame compositing. Any of these can feel like a pause or stutter.

---

## 5. Best-guess hotspots

| Hotspot | Evidence | Severity |
|--------|----------|----------|
| **Compositor L1 cache miss** | 45–75 ms per miss, logged frequently during speech when phoneme/expression changes | **High** – can exceed 33.3 ms frame budget and cause dropped frames or stutter. |
| **Audio decode per /render** | decode 45–75 ms, total 47–82 ms per POST | **Medium** – blocks the /render handler before playback; can delay start of a turn. |
| **Serial TTS + /render** | Each turn waits for ElevenLabs then POST; no overlap of turns | **Medium** – total run length and “gap” between turns dominated by TTS + one round-trip per turn. |
| **Expression plan (heuristic)** | [Expr] Heuristic plan logged per turn; no timing in logs | **Low–medium** – likely small compared to decode + compositor. |
| **ffmpeg/HLS writes** | No per-frame or per-segment timing in logs | **Unknown** – could add variance if disk or ffmpeg backs up. |

**Summary:** The only **measured** costs in the logs are **decode (45–75 ms)** per /render and **compositor L1 cache miss (45–75 ms)** per state change. Compositor misses are the best candidate for **in-stream stutters** (frame drops or hitches) because they sit in the 30 fps render path. TTS and decode add **latency between turns** and at **turn start**.

---

## 6. Recommendations for future runs

1. **Add timestamps** to key log lines (e.g. `ISO timestamp` or `elapsed ms` since server start) so you can align stutters with TTS, /render POST, decode, and compositor misses.
2. **Log per-frame composite time** (or at least when > 33 ms) so you can see which frames exceed the 30 fps budget.
3. **Optionally log TTS duration** on the main app (e.g. before/after ElevenLabs call) to quantify turn-start latency.
4. **Capture Task Manager (or Get-Process)** at 1–2 s intervals during a run to correlate CPU/RAM spikes with the events above.
