# Paste This Prompt Into Cursor

Copy and paste this entire message into Cursor AI:

---

## Windows Compatibility Check & Fix

I need you to check and fix Windows compatibility issues in this LiveStream Chatbox project. The project works perfectly on Linux but needs to run on Windows local development.

### What to do:

1. **Read these files first** (in order):
   - `CURSOR_PROMPT.md` - Your detailed instructions
   - `WINDOWS_QUICKSTART.md` - Expected user workflow
   - `CLAUDE.md` - Project architecture

2. **Audit these critical files for Windows compatibility:**
   - `animation-server/platform.js` - Platform-specific FFmpeg/Rhubarb paths
   - `animation-server/compositor.js` - Especially line 181 (path handling)
   - `tools/export-psd.js` - Especially line 92 (path handling)
   - `animation-server/continuous-stream-manager.js` - FFmpeg process spawning
   - `animation-server/audio-decoder.js` - FFmpeg pipes
   - `animation-server/tv-content/video-decoder.js` - Video decoding

3. **Look for these issues:**
   - ❌ Hardcoded path separators (`/` or `\` in string concatenation)
   - ❌ Hardcoded Unix paths (`/usr/bin/`, `/tmp/`)
   - ❌ FFmpeg path detection that won't find `ffmpeg.exe` on Windows
   - ❌ Shell commands that won't work on Windows CMD/PowerShell
   - ✅ Should use `path.join()`, `path.resolve()` everywhere
   - ✅ Manifest paths should stay Unix-style `/` (this is correct!)

4. **Test that these work:**
   ```bash
   npm install
   cd animation-server && npm install
   npm run export-psd      # Should export 62+ layers
   npm run verify-export   # Should show all ✓ checkmarks
   npm run animation       # Should start and load 62 layers
   ```

5. **Fix any issues you find** but maintain cross-platform compatibility (don't break Linux!)

### Key Pattern That's Already Correct (DON'T CHANGE):

```javascript
// export-psd.js line 92 - Converts Windows paths to Unix for manifest
const relativePath = path.relative(OUTPUT_DIR, outputPath).split(path.sep).join('/');

// compositor.js line 181 - Converts manifest Unix paths back to platform paths
const layerPath = path.join(LAYERS_DIR, ...layer.path.split('/'));
```

### Success Criteria:

- All path operations use `path.join()` or `path.resolve()`
- FFmpeg detection works on Windows (finds `ffmpeg.exe`)
- No hardcoded Unix-specific paths
- `npm run verify-export` passes with all ✓
- Animation server starts and loads all 62 layers

### Report back:

List any issues you found and fixed, and confirm the test commands work.

---

## Alternative Short Version (if Cursor has context window issues):

Check Windows compatibility for this Node.js project:

1. Read `CURSOR_PROMPT.md` for full instructions
2. Audit path handling in:
   - `animation-server/platform.js`
   - `animation-server/compositor.js` (line 181)
   - `tools/export-psd.js` (line 92)
3. Fix FFmpeg path detection for Windows
4. Ensure all file paths use `path.join()`
5. Test: `npm run export-psd && npm run verify-export`

Don't change manifest.json format (Unix paths are intentional). Maintain Linux compatibility.

---

## VPS / Animation Service Check (optional)

When editing deployment or performance:

1. **Read** `vps-setup/animation.service`:
   - `WorkingDirectory` should point to animation-server (e.g. `/home/liveStream/animation-server`)
   - `Environment=ANIMATION_PORT=3003`
   - `Environment=UV_THREADPOOL_SIZE=4` — Node libuv thread pool; tune for VPS (2–4 low-core, 6–8 multi-core)

2. **Read** `animation-server/compositor.js` (top):
   - `sharp.concurrency(2)` — libvips threads; keep 2 on low-core VPS, can increase on beefy local/Win.

3. **Don’t break:** Linux VPS is production; any path or env change must stay cross-platform.