You are working in /home/liveStream. Goal: add a “TV viewport” content pipeline. There is a new layer `exported-layers/mask.png` intended as the TV viewport mask. We want a separate service that manages a playlist of content (local images, image URLs, videos) and outputs a single stream of frames that the main renderer can composite into the scene in a clean, organized way.

Current renderer: animation-server/compositor.js loads exported-layers/manifest.json and composites static layers + dynamic mouth/blink layers using sharp. The scene is 3840x2160 (rendered at 1/3 scale). mask.png exists as a layer in exported-layers/manifest.json below TV_Reflection_.png. The animation server streams HLS from /streams/live/stream.m3u8.

Please:
1) Propose a minimal design for a “TV content service”:
   - API endpoints to add/remove/list playlist items (local file or URL).
   - Playback controls (next/prev, pause, duration per item).
   - Output format for the renderer to consume (e.g., MJPEG endpoint, or local frame buffer).
2) Implement the service (Node preferred) with clear folder structure and simple config.
3) Update the main compositor to draw the current TV frame into the scene masked by mask.png and placed at the correct viewport (full frame unless you need a rectangle).
4) Keep it simple and stable; prefer streaming frames as a PNG buffer that the compositor can fetch/cached at a fixed FPS.
5) Add concise docs to README or a new doc file describing how to run the service and control it.

Constraints:
- Don’t break existing rendering pipeline.
- Use sharp for compositing; use ffmpeg if needed for video decode (prefer native tools already used in repo).
- Keep changes minimal and clear, with code comments only where needed.
