# ON-AIR-Driven Continuity Refactor — Verification Report

## Test Results

- **Tests run:** 50 (orchestrator.test.js + integration.test.js, Jest)
- **Passed:** 47
- **Failed:** 3
- **Skipped / obsolete:** 3 tests are obsolete after the refactor (see below)

### Failed tests (all BufferMonitor / Filler-on-tick)

| Test | File | Reason |
|------|------|--------|
| **E.3** | orchestrator.test.js | `generates multiple fillers to reach target when below minimum` — expects `generateFiller` to be called ≥2 times on `monitor._tick()`. |
| **E.5** | orchestrator.test.js | `buffer low + filler enabled + non-filler content → fillers generated` — expects `generateFiller` to be called on `_tick()`. |
| **H.2** | orchestrator.test.js | `critical + filler enabled + active content → triggers filler batch` — expects `generateFiller` and `queueRender` to be called on `_tick()`. |

**Cause of failures:** In `buffer-monitor.js`, continuity is explicitly disabled for the refactor:

- `this.continuityDisabled = true` (line 24) with comment: *"Continuity generation is now driven by ON-AIR events (see PlaybackController). BufferMonitor should not generate filler/expand on ticks."*
- `_tick()` only runs filler generation when `!this.continuityDisabled` (line 166). With `continuityDisabled === true`, filler is never generated on tick.

So the failures are **not** due to broken control flow or removed buffer behavior; they assert the **old** tick-based filler behavior, which the refactor intentionally removed. The tests are **outdated** for the ON-AIR-only design.

**Integration tests:** All 6 integration tests passed (expand → render → setOnAir → segmentDone → aired, API routes, chat inbox, play/pause/stop).

---

## Invariant Verification

### Invariant A — ON AIR is the sole continuity trigger

**PASS**

- **Expand / continuity only from ON AIR:** In `playback-controller.js`, `_maybeGenerateExpand(segmentId)` is invoked only from `setOnAir(segmentId)` (line 64). There are no other call sites for expand or continuity in the orchestrator.
- **No timers or ticks for continuity:**  
  - `PlaybackController` has a 500ms `broadcastInterval` that only runs `_checkPendingDone()` and `_broadcastUpdate()` — no expand, no filler.  
  - `BufferMonitor` has a 1s timer that runs `_tick()`, but `continuityDisabled` is set to `true`, so `_tick()` never calls `_generateFillerBatch()`.  
- **Conclusion:** Continuity (expand) runs only when the animation server calls `setOnAir()` (in `server.js` inside `startPlayback()` when a segment’s audio starts). No background loops or timers drive continuity.

---

### Invariant B — Idempotency

**PASS**

- **At most one expand per ON AIR segment:**  
  - `pendingExpand` Set (line 21): `_maybeGenerateExpand` returns early if `this.pendingExpand.has(segmentId)` (line 172). Before calling `scriptGenerator.expandDirectorNote`, it does `this.pendingExpand.add(segmentId)` (line 185) and `this.pendingExpand.delete(segmentId)` in a `finally` block (line 205). So a single in-flight expand per segmentId is enforced.  
  - `setOnAir` only runs the block that calls `_maybeGenerateExpand` when `this.currentSegmentId !== segmentId` (line 59). So repeated `setOnAir(sameId)` (e.g. reconnect) does not re-enter expand for the same segment.  
  - `_hasExpandFor(segmentId)` (lines 164–167, 180) prevents creating another expand if one already exists with `expandFrom === segmentId`.  
- **Conclusion:** Expand generation runs at most once per ON AIR segment. Reconnect, rebroadcast, or repeated `setOnAir` for the same segment do not cause duplicate expand.

---

### Invariant C — No competition with real rendering

**PASS**

- **No expand when real segment is rendering:** `_maybeGenerateExpand` returns early if `this._hasRealRendering()` (line 178). `_hasRealRendering()` (lines 157–162) is true if any **forming** segment exists that is not an expand segment (`metadata.continuity === 'expand'`). So if a chat or director segment is forming, expand is not scheduled.
- **Expand does not block or delay chat/director:** Expand is scheduled via `this.segmentRenderer.queueRender(segment.id)` (line 198). It uses the same render queue as chat and director; ordering is by pipeline and renderer queue. The refactor does not add any path that blocks or delays chat or director segments. Chat/director are prioritized by the existing segment renderer and pipeline ordering.

---

### Invariant D — Context correctness

**PASS**

- **Expand seeds only from ON AIR (or aired) context:** In `_maybeGenerateExpand`, the seed is `const seed = onAir.exitContext || onAir.seed` (line 182), where `onAir = this.pipelineStore.getSegment(segmentId)` (line 173) and `segmentId` is the segment just set ON AIR. So the seed comes only from the segment that is currently ON AIR.  
- **No use of forming/ready for expand seed:** The code does not read forming or ready segments to build the expand seed; it only uses the single on-air segment. The guard `_pipelineHasOnlyOnAir(segmentId)` (line 176) ensures expand runs only when the only active (forming + ready) segment is that on-air segment, which is consistent with using only that segment’s context.

---

## Risks / Observations

1. **Obsolete tests:** E.3, E.5, and H.2 assume BufferMonitor drives filler on `_tick()`. With `continuityDisabled = true` this is intentionally disabled. If someone later sets `continuityDisabled = false` without removing or gating the ON-AIR path, both tick-based filler and ON-AIR expand could run (two sources of continuity).
2. **BufferMonitor still has a timer:** `bufferMonitor.start()` is called from `Orchestrator.init()` (orchestrator/index.js line 56). The timer runs `_tick()` every 1s for health level and `buffer:warning` broadcast; only filler generation is gated by `continuityDisabled`. No change to that is required for the refactor.
3. **PlaybackController 500ms interval:** Used only for `_checkPendingDone()` and `_broadcastUpdate()`. No continuity logic; no risk identified.

---

## Recommendation

**SAFE TO MERGE**

All four invariants hold. The three failing tests are obsolete for the ON-AIR-only design (they expect the old tick-based filler behavior). Suggested follow-up: **update or remove the three tests** (E.3, E.5, H.2) — e.g. skip them with a comment that continuity is now ON-AIR-only and BufferMonitor no longer generates filler on tick, or adjust expectations so that with `continuityDisabled === true` no filler is generated on `_tick()`.
