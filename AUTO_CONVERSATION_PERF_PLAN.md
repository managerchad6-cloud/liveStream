# Auto Conversation Performance – High-Level Brief

## Context
Auto-conversation runs smoothly overall but still exhibits visible stutter. Logs show frequent compositor L1 cache misses and per-turn audio decode times that exceed a 30 fps frame budget. The goal is to eliminate perceptible lag **without sacrificing current behavior or visual richness**.

## Evidence Summary (from last 3 sessions)
- L1 cache miss times: **~57–170 ms** (avg ~95–100 ms) — far above 33 ms frame budget.
- L1 miss frequency: **~72 per 1000 frames** (431 misses over ~6000 frames).
- /render decode times: **~58–114 ms** per turn.
- No playback failures in the last 3 sessions.

## Objective
Remove all perceptible stutter in production while keeping current expression richness, mouth reactions, and eye/brow motion. Target should be a consistently smooth stream (no hitching) during auto-conversation.

## Constraints
- Do **not** reduce animation expressiveness or simplify the overall behavior.
- Do **not** introduce pauses between turns or visible buffering.
- Solutions must be robust under typical machine load.

## High-Level Direction (leave room for reasoning)
- **Decouple heavy compositing from the real-time frame loop** so rendering never blocks on expensive L1 rebuilds.
- **Reduce or eliminate cache-miss spikes** without visibly changing expression dynamics.
- **Ensure frame delivery remains continuous** even under transient slow paths.
- **Improve observability** enough to prove frame budget adherence and isolate remaining hotspots.

## What to Propose (preferred shape of response)
- A short diagnosis of the *true blocking path(s)* causing stalls.
- A prioritized plan that preserves current visual behavior while removing blocking work from the render loop.
- A minimal set of code changes (or a phased set) to make the fix reliable and maintainable.
- A validation plan (logs/metrics) that confirms stutter is eliminated.

## Metrics to Use for Validation
- Per-frame composite time vs 33 ms budget.
- Count and duration of any L1 cache miss events during speech.
- Max frame delay during auto-conversation runs.

## Notes for Implementation
- Current L1 cache misses are the dominant spike.
- /render decode time impacts turn start but is secondary to in-stream hitches.
- Any solution that merely “skips frames” should be treated as a fallback, not the primary fix.

