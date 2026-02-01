# Cursor AI Prompt: Windows Compatibility Check & Fix

## Mission
Check and fix Windows compatibility issues for the LiveStream Chatbox project. The project works perfectly on Linux VPS but needs to run on a local Windows development machine.

## Project Overview
- **Tech Stack**: Node.js, Express, Sharp (image processing), FFmpeg, Canvas (native module)
- **Architecture**: Two servers - Chat API (port 3002) and Animation Server (port 3003)
- **Key Feature**: Exports PSD layers to PNG files, composites them in real-time for lip-synced animation

## Critical Components to Check

### 1. Path Handling (HIGHEST PRIORITY)

**Files to audit:**
- `tools/export-psd.js` - Lines 6-8, 66-70, 92
- `animation-server/compositor.js` - Lines 8-11, 181
- `animation-server/server.js` - Any path references
- `animation-server/continuous-stream-manager.js` - FFmpeg paths
- `animation-server/platform.js` - Platform-specific paths

**What to check:**
- ✅ GOOD: `path.join()`, `path.resolve()`, `path.sep`
- ❌ BAD: Hardcoded `/` or `\` in paths, string concatenation like `dir + '/' + file`
- ⚠️ IMPORTANT: Manifest paths use Unix-style `/` (correct, don't change)
- ⚠️ IMPORTANT: When reading from manifest, must split by `/` and rejoin with `path.join()` (line 181 compositor.js is correct)

**Key pattern to verify:**
```javascript
// export-psd.js line 92 - This converts Windows paths to Unix-style for manifest
const relativePath = path.relative(OUTPUT_DIR, outputPath).split(path.sep).join('/');

// compositor.js line 181 - This converts manifest Unix-style back to platform paths
const layerPath = path.join(LAYERS_DIR, ...layer.path.split('/'));
```

### 2. FFmpeg Integration

**Files to check:**
- `animation-server/platform.js` - FFmpeg binary paths
- `animation-server/continuous-stream-manager.js` - FFmpeg command construction
- `animation-server/audio-decoder.js` - FFmpeg pipe operations
- `animation-server/tv-content/video-decoder.js` - Video decoding

**What to check:**
- FFmpeg path detection for Windows (should check for `ffmpeg.exe`)
- Command-line argument formatting (Windows CMD vs Unix shell)
- Pipe operations (`|` works differently on Windows)
- Temp file paths (should use `os.tmpdir()` or project-specific temp dir)

**Expected behavior:**
- Should detect FFmpeg in PATH or use `where ffmpeg` on Windows
- Should NOT use shell-specific features like `&&` or `||` in spawn commands
- Should handle Windows-style paths in FFmpeg arguments

### 3. Native Module: Canvas

**Files affected:**
- `tools/export-psd.js` - Uses canvas for PSD rendering
- `package.json` (root) - Has canvas dependency

**What to check:**
- Canvas requires Visual Studio Build Tools on Windows
- May need Python 2.7 or 3.x
- Installation instructions for Windows in documentation

**Action needed:**
- Verify `package.json` has compatible canvas version (should be ^3.2.1 or newer)
- Ensure documentation mentions Windows prerequisites
- Consider adding fallback or better error messages if canvas fails to load

### 4. File I/O Operations

**Files to check:**
- All files that create/delete/read files
- Especially: `streams/live/` directory operations
- Temp file handling in audio-decoder.js

**What to check:**
- File path construction uses `path.join()`
- Directory creation uses `{ recursive: true }` option
- File deletion handles Windows file locking issues
- No hardcoded `/tmp/` paths (use `os.tmpdir()` or project temp dir)

### 5. Environment Variables

**Files to check:**
- `.env.example` (if exists) or documentation
- `server.js` - Reads env vars
- `animation-server/server.js` - Reads env vars

**What to check:**
- ENV var setting instructions for Windows PowerShell and CMD
- PORT binding (Windows might block certain ports)
- Path-based env vars use proper separators

### 6. Process Management

**Files to check:**
- `animation-server/continuous-stream-manager.js` - Spawns FFmpeg process
- Any other child process spawning

**What to check:**
- Use `child_process.spawn()` not shell commands
- Proper signal handling (Windows doesn't support SIGTERM the same way)
- Process cleanup on exit

## Testing Checklist

After making fixes, verify these work on Windows:

### Step 1: Install Dependencies
```bash
npm install
cd animation-server && npm install
```
- Should succeed or provide clear Windows-specific error messages
- Canvas installation might require build tools (document this)

### Step 2: Export PSD
```bash
npm run export-psd
```
- Should export 62+ layers to `exported-layers/`
- Paths in `manifest.json` should use forward slashes `/`
- PNG files should exist at specified paths

### Step 3: Verify Export
```bash
npm run verify-export
```
- Should show all ✓ checkmarks
- Should find all 62+ layers, all phonemes, all files

### Step 4: Start Animation Server
```bash
npm run animation
```
- Should start without errors
- Should load all layers from manifest
- Should log: "Loaded manifest: 62 layers, 3840x2160"
- Should log all mouth shapes found
- Should log TV viewport extracted

### Step 5: Start Chat Server
```bash
npm start
```
- Should start on port 3002
- Should connect to animation server at localhost:3003

## Known Working Patterns

These patterns are CORRECT and should NOT be changed:

```javascript
// ✅ CORRECT: Export manifest with Unix-style paths
const relativePath = path.relative(OUTPUT_DIR, outputPath).split(path.sep).join('/');

// ✅ CORRECT: Read manifest paths and convert to platform-specific
const layerPath = path.join(LAYERS_DIR, ...layer.path.split('/'));

// ✅ CORRECT: Cross-platform path building
const ROOT_DIR = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'exported-layers');

// ✅ CORRECT: Directory creation
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
```

## Common Windows Issues to Fix

### Issue 1: Hardcoded Path Separators
```javascript
// ❌ BAD
const filePath = 'exported-layers/' + character + '/mouth/' + file;

// ✅ GOOD
const filePath = path.join('exported-layers', character, 'mouth', file);
```

### Issue 2: Shell Commands
```javascript
// ❌ BAD - Won't work on Windows
exec('ls -la && cat file.txt');

// ✅ GOOD
const files = fs.readdirSync(dir);
const content = fs.readFileSync(path.join(dir, 'file.txt'), 'utf8');
```

### Issue 3: Temp Directories
```javascript
// ❌ BAD - /tmp doesn't exist on Windows
const tmpFile = '/tmp/audio.mp3';

// ✅ GOOD
const tmpFile = path.join(os.tmpdir(), 'audio.mp3');
// OR use project scratchpad (already exists in project)
```

### Issue 4: FFmpeg Path Detection
```javascript
// ❌ BAD
const ffmpegPath = '/usr/bin/ffmpeg';

// ✅ GOOD
const ffmpegPath = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
// Or check multiple locations and PATH
```

## Files That Definitely Need Review

Priority order:

1. **`animation-server/platform.js`** - Platform-specific paths (FFmpeg, Rhubarb)
2. **`animation-server/compositor.js`** - Layer loading (line 181 especially)
3. **`tools/export-psd.js`** - PSD export and path handling (line 92)
4. **`animation-server/continuous-stream-manager.js`** - FFmpeg process spawning
5. **`animation-server/audio-decoder.js`** - Audio decoding with FFmpeg
6. **`animation-server/tv-content/video-decoder.js`** - Video decoding

## Expected Output

After your fixes, the user should be able to:

1. Clone repo on Windows
2. Run `npm install` (both root and animation-server)
3. Run `npm run export-psd` successfully
4. Run `npm run verify-export` - see all ✓ checkmarks
5. Run `npm run animation` - server starts, loads 62 layers
6. Run `npm start` - chat server starts
7. Open `http://localhost:3002` - see animated chatbox working

## Documentation to Update

If you find issues, update these files:
- `WINDOWS_DEPLOYMENT_GUIDE.md` - Add any new gotchas you discover
- `WINDOWS_QUICKSTART.md` - Update if process changes
- `CLAUDE.md` - Update if architecture changes

## Verification Commands

Run these to verify your fixes:

```bash
# 1. Check all path.join usage
grep -r "path.join" --include="*.js" .

# 2. Check for hardcoded separators (should only be in manifest handling)
grep -r "'/'" --include="*.js" . | grep -v "split('/')" | grep -v "join('/')"

# 3. Check for /tmp usage
grep -r "/tmp" --include="*.js" .

# 4. Check for shell commands
grep -r "exec\|execSync" --include="*.js" .

# 5. Verify FFmpeg integration
grep -r "ffmpeg" --include="*.js" animation-server/
```

## Success Criteria

- ✅ All path operations use `path.join()` or `path.resolve()`
- ✅ Manifest paths use Unix-style `/` (for cross-platform compatibility)
- ✅ Layer loading correctly converts manifest paths to platform paths
- ✅ FFmpeg detection works on Windows (finds ffmpeg.exe)
- ✅ No hardcoded Unix paths like `/usr/bin/` or `/tmp/`
- ✅ All file operations handle Windows path style
- ✅ Process spawning doesn't rely on Unix shell features
- ✅ Documentation mentions Windows prerequisites (Build Tools for canvas)
- ✅ `npm run verify-export` passes with all checkmarks
- ✅ Animation server starts and loads all layers correctly

## Final Notes

- The VPS (Linux) version is working perfectly - don't break it!
- Maintain cross-platform compatibility
- Test both Windows and Linux if possible
- The manifest.json intentionally uses Unix-style paths for consistency
- Focus on making it work, not perfect - the user needs to get running quickly

## Quick Reference: Where Things Are

```
/home/liveStream/
├── tools/
│   ├── export-psd.js          ← PSD export, path handling critical
│   └── verify-export.js        ← Verification script (should work as-is)
├── animation-server/
│   ├── server.js              ← Main animation server
│   ├── compositor.js          ← Layer loading (line 181 critical)
│   ├── platform.js            ← Platform-specific paths
│   ├── continuous-stream-manager.js  ← FFmpeg integration
│   ├── audio-decoder.js       ← Audio processing
│   └── tv-content/
│       └── video-decoder.js   ← Video processing
├── exported-layers/
│   └── manifest.json          ← Generated, Unix paths
├── WINDOWS_QUICKSTART.md      ← User guide
└── WINDOWS_DEPLOYMENT_GUIDE.md ← Detailed troubleshooting

Key line: compositor.js:181
const layerPath = path.join(LAYERS_DIR, ...layer.path.split('/'));
```

Good luck! The main issues are likely in FFmpeg path handling and ensuring all file operations use proper path methods.
