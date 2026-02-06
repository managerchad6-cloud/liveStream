# Results

- Continuity decisions now run only on ON-AIR entry in `animation-server/orchestrator/playback-controller.js`.
- Buffer/tick-driven filler generation is disabled in `animation-server/orchestrator/buffer-monitor.js` (health reporting intact).
- Expand generation uses existing script/expand and render pathways; no new timers, no speculative generation, no changes to rendering/playback internals.

## Files Changed

- `animation-server/orchestrator/playback-controller.js`
- `animation-server/orchestrator/index.js`
- `animation-server/orchestrator/buffer-monitor.js`

## Tests

- Not run.
