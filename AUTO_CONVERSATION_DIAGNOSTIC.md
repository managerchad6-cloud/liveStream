# Auto Conversation (12 turns) – Diagnostic

## Flow

1. **Frontend**: User clicks Auto Conversation → POSTs to `/api/auto` with `seed`, `turns: 12`, `temperature`.
2. **Server**: Generates script via OpenAI, responds with `{ ok, turns, script }`, then **calls `playAutoScript(script, autoId)`** in the background (`setImmediate`).
3. **playAutoScript**: For each turn, calls ElevenLabs TTS, then **POSTs to `${animationServerUrl}/render`** with FormData (audio + character + message). Logs `[Auto] Posting to <url> (turn n/m, speaker)`.

So playback runs **on the server**; the frontend only sees “Auto conversation started (N turns)...”. Video/stream updates come from the animation server when it receives each `/render` request.

---

## Exact server log lines

When you click **Auto Conversation**, watch the **main app** terminal (port 3002):

| Situation | Log line(s) |
|-----------|-------------|
| Request received | `[Auto] Request seed="...", turns=12` |
| Script generated, playback starting | `[Auto] Playback starting N turns, animationServerUrl=<url>` |
| Per turn | `[Auto] Posting to <url>/render (turn 1/12, chad)` (etc.) |
| Script generation failed (e.g. missing key) | `[Auto] Error: <message>` then HTTP 500 |
| Playback failed (TTS or /render) | `[Auto] Playback failed: <message>` |
| Playback failed with HTTP response | `[Auto] Response status: <status> <data>` |

**If it “stays stuck”:**  
- No `[Auto] Request...` → request never reached server (wrong URL, CORS, or frontend not in Auto mode).  
- `[Auto] Request...` then `[Auto] Error:...` → script generation failed (check OPENAI_API_KEY).  
- `[Auto] Playback starting...` then `[Auto] Playback failed:...` → TTS or /render failed (check ELEVENLABS_API_KEY and animation server reachable).

---

## Env vars (presence only)

| Var | Required | Purpose |
|-----|----------|--------|
| `ELEVENLABS_API_KEY` | Yes | TTS for each turn in playAutoScript |
| `OPENAI_API_KEY` | Yes | generateAutoScript (script generation) |
| `ANIMATION_SERVER_URL` | Yes | Base URL for POST /render (default `http://localhost:3003`) |
| `AUTO_MODEL` | No | Script generation model (default from MODEL or gpt-4o-mini) |
| `AUTO_TTS_MODEL` | No | TTS model (default eleven_turbo_v2) |

**Check presence (no secrets):**  
`GET /api/auto/diagnostic` returns `env: { ELEVENLABS_API_KEY: true/false, ... }` and `renderReachable` / `renderError`.

```bash
curl -s http://localhost:3002/api/auto/diagnostic | jq
```

---

## playAutoScript and /render

- **playAutoScript** is invoked **after** `/api/auto` returns: in `server.js` right after `res.json({ ok, turns, script })`, inside `setImmediate(() => playAutoScript(script, currentAutoId).catch(...))`.
- It POSTs to **`${animationServerUrl}/render`** (e.g. `http://localhost:3003/render`) with FormData: `audio`, `character`, `message`, `mode`.

---

## /render reachability

1. **From diagnostic:**  
   `GET /api/auto/diagnostic` now checks the animation server by requesting `${animationServerUrl}/health`. Response includes:
   - `renderReachable`: true if health returned 200
   - `renderError`: error code/message if health check failed (e.g. `ECONNREFUSED`)

2. **Manual check – health (same host as /render):**  
   ```bash
   curl -s http://localhost:3003/health | jq
   ```

3. **Manual check – /render (expect 400 without audio):**  
   ```bash
   curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3003/render
   ```
   Expect **400** (No audio file) if the endpoint is reachable; **000** or connection errors if the server is down or unreachable.

---

## Quick checklist

1. Main server and animation server running (`npm start` on 3002, `npm run animation` on 3003).
2. Env: `ELEVENLABS_API_KEY`, `OPENAI_API_KEY` set; `ANIMATION_SERVER_URL` set if animation server is not on localhost:3003.
3. `GET http://localhost:3002/api/auto/diagnostic` → `env` all true where required, `renderReachable: true`.
4. Click Auto Conversation; in main app logs you should see `[Auto] Request...`, then `[Auto] Playback starting...`, then `[Auto] Posting to .../render (turn 1/12, ...)`.
5. If you see `[Auto] Playback failed:` or `[Auto] Response status:`, use the message/status to fix TTS or /render (keys, network, animation server logs).
