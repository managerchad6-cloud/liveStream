# Windows Local Deployment Guide

## Step-by-Step Asset Extraction Verification

### 1. Verify Dependencies

First, ensure all required packages are installed:

```bash
# In project root
npm install

# In animation-server directory
cd animation-server
npm install
cd ..
```

**Critical Windows packages:**
- `ag-psd` - PSD file parsing
- `canvas` - Canvas rendering (requires node-gyp, Python, Visual Studio Build Tools)
- `sharp` - Image processing

### 2. Verify Stream.psd File

```bash
# Check if Stream.psd exists and its size
dir Stream.psd

# Expected: Should be around 50-55 MB for the latest version
```

If you have a different/updated Stream.psd, that's fine - just make sure it follows the naming conventions.

### 3. Run PSD Export

```bash
# From project root
npm run export-psd

# Or directly:
node tools/export-psd.js
```

**Expected Output:**
```
Reading PSD file: C:\...\liveStream\Stream.psd
PSD dimensions: 3840x2160
Exporting layers...
Exported: Fondo (z:0)
Exported: Background_ (z:1)
Exported: Lamborghini_ (z:2)
... [many more layers] ...
Exported: mouth_chad_H (z:53)
Exported: Table (z:54)
... [continues] ...

Manifest saved to: C:\...\liveStream\exported-layers\manifest.json
Total layers exported: 62
```

### 4. Verify Exported Files

Check that all required files are present:

```bash
# Check main directory
dir exported-layers\

# Should see:
# - manifest.json
# - mask.png
# - TV_Reflection_.png
# - Background_.png
# - Lamborghini_.png, Pillow.png, Poster.png, Wheel.png
# - Chad_Sculpture.png, Wizard_.png
# - Lights_On.png, Lights_Off.png
# - LED_Strip.png
# - LED_light_Emission__Background_.png
# - LED_light_Emission__Middleground_.png
# - LED_light_Emission__Foreground_.png
# - TV.png
# - Table.png, Portatil.png
# - Bills_.png, Toilet_Paper_.png, Keys.png, Virgin_ID.png, Pikachu_.png
# - chad\ (directory)
# - virgin\ (directory)

# Check character directories
dir exported-layers\chad\
dir exported-layers\virgin\

# Check mouth directories
dir exported-layers\chad\mouth\
dir exported-layers\virgin\mouth\
```

### 5. Verify manifest.json Structure

Open `exported-layers/manifest.json` and check:

```json
{
  "width": 3840,
  "height": 2160,
  "layers": [
    // Should have around 62+ layers
    // Each layer should have:
    {
      "id": "unique_name",
      "name": "Layer Name",
      "path": "relative/path.png",
      "x": 0,
      "y": 0,
      "width": 3840,
      "height": 2160,
      "opacity": 0.003921...,
      "visible": true,
      "zIndex": 0,
      "type": "static|mouth|blink",
      "character": "chad|virgin" // if applicable
    }
  ]
}
```

**Critical layers to verify:**
- All chad mouth shapes: `mouth_chad_A` through `mouth_chad_H`, plus `mouth_chad_smile`, `mouth_chad_surprise`
- All virgin mouth shapes: `mouth_virgin_A` through `mouth_virgin_H`, plus `mouth_virgin_smile`, `mouth_virgin_surprise`
- Blink layers: `blink_chad_closed`, `blink_virgin_closed`
- TV layers: `TV`, `TV_Reflection_`, `mask`

### 6. Common Windows Issues & Fixes

#### Issue: "Canvas module not found" or build errors

```bash
# Install Windows Build Tools (run as Administrator in PowerShell)
npm install --global --production windows-build-tools

# Or install Visual Studio Build Tools manually
# Then retry:
cd animation-server
npm install canvas --force
```

#### Issue: "Sharp installation failed"

```bash
# Try rebuilding sharp
npm rebuild sharp

# Or install specific version
npm install sharp@0.32.6
```

#### Issue: "Path not found" errors

Windows uses backslashes, but the code uses `path.join()` which should handle this. If you see issues:
- Make sure you're running commands from the project root
- Check that `Stream.psd` is in the root directory

#### Issue: Export succeeds but compositor crashes

Clear the compositor cache:

```javascript
// In compositor.js, add this at startup or restart the animation server
frameCache = {};
scaledLayerBuffers = {};
staticBaseBuffer = null;
```

Or simply restart the animation server after re-exporting.

### 7. Test the Animation Server

```bash
# Start animation server
npm run animation

# Expected output:
# Loading manifest and layers...
# Loaded manifest: 62 layers, 3840x2160
# Mouth layers found:
#   chad - A: mouth_chad_A
#   chad - B: mouth_chad_B
#   ... [all mouth shapes] ...
# Blink layers found:
#   chad: blink_chad_closed
#   virgin: blink_virgin_closed
# [Compositor] Pre-loaded X static layers (scaled to 1280x720)
# [Compositor] TV viewport extracted: {x, y, width, height}
# Animation server running on port 3003
```

### 8. Environment Variables (Windows)

Create a `.env` file in the project root (if you haven't already):

```bash
# Chat API Server
OPENAI_API_KEY=sk-...
ELEVENLABS_API_KEY=...
PORT=3002
MODEL=gpt-4o-mini
ANIMATION_SERVER_URL=http://localhost:3003

# Optional overrides
# LIPSYNC_MODE=realtime
# STREAM_MODE=synced
```

For the animation server, you can set environment variables in PowerShell:

```powershell
$env:ANIMATION_PORT=3003
$env:ANIMATION_HOST="localhost"
$env:LIPSYNC_MODE="realtime"
$env:STREAM_MODE="synced"
npm run animation
```

### 9. Compare with Production

To verify your local export matches production, check these key indicators:

```bash
# Count layers in manifest
# Windows PowerShell:
(Get-Content exported-layers\manifest.json | ConvertFrom-Json).layers.Count
# Should be: 62 (or more if you added layers)

# Check file sizes (should be similar, not exact)
dir exported-layers\*.png
dir exported-layers\chad\*.png
dir exported-layers\virgin\*.png
```

### 10. Force Compositor to Reload Assets

If you've updated layers but the animation still shows old versions:

1. Stop the animation server (Ctrl+C)
2. Delete any cache/temp files:
   ```bash
   # Clear HLS segments
   del /q streams\live\*.ts
   del /q streams\live\*.m3u8
   ```
3. Restart the animation server:
   ```bash
   npm run animation
   ```

The compositor will reload all layers from `exported-layers/` on startup.

## Troubleshooting Checklist

- [ ] Node.js version 16+ installed
- [ ] Python and Visual Studio Build Tools installed (for canvas)
- [ ] All npm dependencies installed in root and animation-server
- [ ] Stream.psd exists in project root
- [ ] export-psd.js runs without errors
- [ ] exported-layers/ contains 62+ layer entries in manifest.json
- [ ] All PNG files exist at paths specified in manifest.json
- [ ] Chad and virgin directories contain all mouth shapes (A-H, smile, surprise)
- [ ] manifest.json has correct layer types (static/mouth/blink)
- [ ] Animation server starts without errors
- [ ] Compositor logs show correct number of layers loaded

## Quick Verification

Use the project verification script (no need to copy/paste code):

```bash
npm run verify-export
```

Or run directly: `node tools/verify-export.js`

This checks manifest, dimensions, layer types, Chad/Virgin mouth shapes and blink layers, critical static layers, and that every manifest path has a corresponding file. All checks should show ✓.

## Animation Server Performance (VPS / Local)

- **Compositor:** `animation-server/compositor.js` uses `sharp.concurrency(2)` by default for libvips. Override with env `SHARP_CONCURRENCY` (e.g. `SHARP_CONCURRENCY=4`) on Windows or multi-core machines.
- **VPS systemd:** `vps-setup/animation.service` sets `UV_THREADPOOL_SIZE=4` for Node async I/O (FFmpeg, file ops). On a multi-core VPS you can try 6–8; if the box is small, keep 2–4.

After changing `animation.service`, run:
```bash
sudo systemctl daemon-reload
sudo systemctl restart animation
```

## Still Having Issues?

If you continue to see old assets:

1. **Check browser cache** - The frontend might be caching the HLS stream. Hard refresh (Ctrl+Shift+R)
2. **Check compositor initialization** - Look at animation server console logs when it starts
3. **Verify layer loading** - The compositor logs should show which layers are being loaded
4. **Compare manifest.json** - Check if your local manifest matches the structure above
5. **Check git status** - Make sure you haven't accidentally reverted the exported-layers directory

Remember: The compositor loads layers ONCE on startup. If you re-export while the server is running, you MUST restart the animation server.
