# Windows Quick Start Checklist

## Issue: Seeing old/incorrect assets after exporting Stream.psd

This happens because the compositor caches layers at startup. Follow these steps:

## Quick Fix (5 minutes)

### 1. Install Dependencies
```bash
npm install
cd animation-server
npm install
cd ..
```

**If `canvas` fails to install on Windows:**
- Install Visual Studio Build Tools (required for native modules)
- Run PowerShell as Administrator:
  ```powershell
  npm install --global --production windows-build-tools
  ```
- Retry: `npm install`

### 2. Export PSD Layers
```bash
npm run export-psd
```

**Expected:** Should see "Total layers exported: 62" (or more if you added layers)

### 3. Verify Export
```bash
npm run verify-export
```

**Expected:** Should show all ✓ checkmarks with no ❌ errors

### 4. Clear HLS Cache (Important!)
```bash
# Windows Command Prompt:
del /q streams\live\*.ts
del /q streams\live\*.m3u8

# Windows PowerShell:
Remove-Item streams\live\*.ts
Remove-Item streams\live\*.m3u8
```

### 5. Restart Animation Server
```bash
# Make sure any running servers are stopped (Ctrl+C)
npm run animation
```

**Expected startup logs:**
```
Loading manifest and layers...
Loaded manifest: 62 layers, 3840x2160
Mouth layers found:
  chad - A: mouth_chad_A
  chad - B: mouth_chad_B
  ... (all 10 chad mouth shapes)
  virgin - A: mouth_virgin_A
  ... (all 10 virgin mouth shapes)
Blink layers found:
  chad: blink_chad_closed
  virgin: blink_virgin_closed
[Compositor] Pre-loaded XX static layers
[Compositor] TV viewport extracted: { ... }
Animation server running on port 3003
```

### 6. Test Frontend
```bash
# In a new terminal, start the chat server:
npm start
```

Open browser: `http://localhost:3002`

**Force browser refresh:** Ctrl+Shift+R (to clear HLS cache)

---

## Troubleshooting

### Problem: "export-psd.js fails with canvas errors"

**Solution:** Install Windows build tools
```powershell
# Run as Administrator
npm install --global --production windows-build-tools
```

Then reinstall canvas:
```bash
cd animation-server
npm install canvas --force
cd ..
npm install canvas --force
```

### Problem: "Export works but I still see old assets"

**Cause:** Compositor loaded old layers into memory

**Solution:**
1. Stop animation server (Ctrl+C)
2. Clear streams cache (step 4 above)
3. Restart animation server (step 5 above)
4. Hard refresh browser (Ctrl+Shift+R)

### Problem: "Missing mouth shapes or phonemes"

**Cause:** PSD layer naming doesn't match expected pattern

**Required naming conventions:**
- Mouth layers: `mouth_chad_A`, `mouth_chad_B`, ..., `mouth_chad_H`, `mouth_chad_smile`, `mouth_chad_surprise`
- Mouth layers: `mouth_virgin_A`, `mouth_virgin_B`, ..., `mouth_virgin_H`, `mouth_virgin_smile`, `mouth_virgin_surprise`
- Blink layers: `blink_chad_closed`, `blink_virgin_closed`
- Static layers: `static_chad_body`, `static_chad_face`, etc.

**Solution:**
1. Open Stream.psd in Photoshop
2. Rename layers to match convention
3. Re-run `npm run export-psd`
4. Re-run `npm run verify-export` to confirm

### Problem: "Verification passes but animation doesn't work"

**Check compositor logs:**
```bash
npm run animation
```

Look for errors like:
- `[Compositor] Failed to load layer: ...` - Missing PNG file
- `[Compositor] Mouth layer not found for phoneme ...` - Naming issue
- `Sharp error: ...` - Image processing issue

**Common fixes:**
- Ensure all paths in manifest.json use forward slashes
- Verify PNG files are not corrupted (open them in image viewer)
- Check file permissions (should be readable)

---

## File Structure Check

Your `exported-layers/` directory should look like this:

```
exported-layers/
├── manifest.json          ✓ 62+ layers
├── mask.png              ✓ TV viewport mask
├── TV_Reflection_.png     ✓ TV reflection overlay
├── Background_.png        ✓ Scene background
├── [other static layers]  ✓ ~40 static PNG files
├── chad/
│   ├── blink_chad_closed.png
│   ├── static_chad_*.png (body, face, eyes, chair, etc.)
│   └── mouth/
│       ├── mouth_chad_A.png
│       ├── mouth_chad_B.png
│       ├── ... (C through H)
│       ├── mouth_chad_smile.png
│       └── mouth_chad_surprise.png
└── virgin/
    ├── blink_virgin_closed.png
    ├── static_virgin_*.png (body, face, eyes, chair, etc.)
    └── mouth/
        ├── mouth_virgin_A.png
        ├── mouth_virgin_B.png
        ├── ... (C through H)
        ├── mouth_virgin_smile.png
        └── mouth_virgin_surprise.png
```

Run `npm run verify-export` to automatically check this structure.

---

## Still Having Issues?

1. Compare your local `manifest.json` with the production version
2. Check that your Stream.psd has the correct layer structure
3. Look at the full documentation: `WINDOWS_DEPLOYMENT_GUIDE.md`
4. Check animation-server logs for specific errors

## Key Takeaway

**The compositor loads layers ONCE at startup and caches them in memory.**

After re-exporting PSD layers, you MUST:
1. Clear HLS cache
2. Restart the animation server
3. Hard refresh the browser

This ensures the new assets are loaded correctly.
