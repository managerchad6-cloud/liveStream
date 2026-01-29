# CURSOR_TASKS.md

## Instructions for Cursor Agent

Execute these tasks IN ORDER. Each task is atomic and must be completed before moving to the next. Do not skip steps. Do not improvise. Follow exactly.

---

## PHASE 1: INSTALL DEPENDENCIES

### Task 1.1: Install PSD parsing library
```bash
cd /home/liveStream
npm install ag-psd
```

### Task 1.2: Install image processing libraries
```bash
npm install sharp canvas
```

### Task 1.3: Install video/streaming libraries
```bash
npm install fluent-ffmpeg hls-server
```

### Task 1.4: Install CORS for API separation
```bash
npm install cors
```

### Task 1.5: Verify FFmpeg is installed
```bash
ffmpeg -version
```
If not installed, run: `sudo apt install ffmpeg -y`

### Task 1.6: Install Rhubarb Lip Sync
```bash
cd /tmp
wget https://github.com/DanielSWolf/rhubarb-lip-sync/releases/download/v1.13.0/Rhubarb-Lip-Sync-1.13.0-Linux.zip
unzip Rhubarb-Lip-Sync-1.13.0-Linux.zip
sudo cp Rhubarb-Lip-Sync-1.13.0-Linux/rhubarb /usr/local/bin/
sudo chmod +x /usr/local/bin/rhubarb
rhubarb --version
```

---

## PHASE 2: CREATE DIRECTORY STRUCTURE

### Task 2.1: Create new directories
```bash
cd /home/liveStream
mkdir -p tools
mkdir -p exported-layers/chad/mouth
mkdir -p exported-layers/virgin/mouth
mkdir -p animation-server
mkdir -p frontend
mkdir -p streams
```

---

## PHASE 3: PSD EXPORT TOOL

### Task 3.1: Create PSD export script

Create file: `/home/liveStream/tools/export-psd.js`

```javascript
const fs = require('fs');
const path = require('path');
const { readPsd } = require('ag-psd');
const sharp = require('sharp');

const PSD_PATH = path.join(__dirname, '..', 'Stream.psd');
const OUTPUT_DIR = path.join(__dirname, '..', 'exported-layers');
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json');

const manifest = {
  width: 0,
  height: 0,
  layers: []
};

const nameCount = {};

function getUniqueName(name) {
  const cleanName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!nameCount[cleanName]) {
    nameCount[cleanName] = 0;
    return cleanName;
  }
  nameCount[cleanName]++;
  return `${cleanName}_${nameCount[cleanName]}`;
}

function getLayerType(name, parentPath) {
  const lowerName = name.toLowerCase();
  if (lowerName.includes('mouth_')) return 'mouth';
  if (lowerName.includes('blink')) return 'blink';
  return 'static';
}

function getCharacter(parentPath) {
  if (parentPath.toLowerCase().includes('chad')) return 'chad';
  if (parentPath.toLowerCase().includes('virgin')) return 'virgin';
  return null;
}

function getPhoneme(name) {
  const match = name.match(/mouth_(?:chad|virgin)_([A-H]|smile|surprise)/i);
  return match ? match[1].toUpperCase() : null;
}

async function exportLayer(layer, parentPath, zIndex) {
  if (!layer.canvas) return zIndex;

  const uniqueName = getUniqueName(layer.name);
  const layerType = getLayerType(layer.name, parentPath);
  const character = getCharacter(parentPath);

  let outputPath;
  if (layerType === 'mouth' && character) {
    outputPath = path.join(OUTPUT_DIR, character, 'mouth', `${uniqueName}.png`);
  } else if (character) {
    outputPath = path.join(OUTPUT_DIR, character, `${uniqueName}.png`);
  } else {
    outputPath = path.join(OUTPUT_DIR, `${uniqueName}.png`);
  }

  // Ensure directory exists
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // Export canvas to PNG buffer
  const canvas = layer.canvas;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  // Use sharp to save PNG with transparency
  await sharp(Buffer.from(imageData.data), {
    raw: {
      width: canvas.width,
      height: canvas.height,
      channels: 4
    }
  })
  .png()
  .toFile(outputPath);

  // Add to manifest
  const layerInfo = {
    id: uniqueName,
    name: layer.name,
    path: path.relative(OUTPUT_DIR, outputPath),
    x: layer.left || 0,
    y: layer.top || 0,
    width: canvas.width,
    height: canvas.height,
    opacity: (layer.opacity || 255) / 255,
    visible: layer.hidden !== true,
    zIndex: zIndex,
    type: layerType
  };

  if (character) layerInfo.character = character;
  if (layerType === 'mouth') layerInfo.phoneme = getPhoneme(layer.name);

  manifest.layers.push(layerInfo);
  console.log(`Exported: ${uniqueName} (z:${zIndex})`);

  return zIndex + 1;
}

async function processLayers(layers, parentPath = '', zIndex = 0) {
  for (const layer of layers) {
    const currentPath = parentPath ? `${parentPath}/${layer.name}` : layer.name;

    if (layer.children) {
      // It's a group, process children
      zIndex = await processLayers(layer.children, currentPath, zIndex);
    } else {
      // It's a layer, export it
      zIndex = await exportLayer(layer, parentPath, zIndex);
    }
  }
  return zIndex;
}

async function main() {
  console.log('Reading PSD file...');

  const buffer = fs.readFileSync(PSD_PATH);
  const psd = readPsd(buffer, {
    skipCompositeImageData: false,
    skipLayerImageData: false,
    skipThumbnail: true
  });

  manifest.width = psd.width;
  manifest.height = psd.height;

  console.log(`PSD dimensions: ${psd.width}x${psd.height}`);
  console.log('Exporting layers...');

  if (psd.children) {
    await processLayers(psd.children);
  }

  // Save manifest
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`\nManifest saved to: ${MANIFEST_PATH}`);
  console.log(`Total layers exported: ${manifest.layers.length}`);
}

main().catch(console.error);
```

### Task 3.2: Run PSD export
```bash
cd /home/liveStream
node tools/export-psd.js
```

Verify output:
```bash
ls -la exported-layers/
cat exported-layers/manifest.json | head -50
```

---

## PHASE 4: SEPARATE FRONTEND FROM BACKEND

### Task 4.1: Move frontend files

```bash
cp /home/liveStream/public/index.html /home/liveStream/frontend/index.html
```

### Task 4.2: Create frontend config file

Create file: `/home/liveStream/frontend/config.js`

```javascript
const CONFIG = {
  API_BASE_URL: window.location.hostname === 'localhost'
    ? 'http://localhost:3002'
    : 'http://93.127.214.75:3002',
  ANIMATION_SERVER_URL: window.location.hostname === 'localhost'
    ? 'http://localhost:3003'
    : 'http://93.127.214.75:3003'
};
```

### Task 4.3: Create frontend styles

Create file: `/home/liveStream/frontend/style.css`

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
  background-color: #1a1a1a;
  color: #e0e0e0;
  margin: 0;
  padding: 0;
  height: 100vh;
  overflow: hidden;
}

.main-container {
  display: flex;
  height: 100vh;
  gap: 20px;
  padding: 20px;
}

.viewport-container {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
}

#viewport {
  width: 100%;
  aspect-ratio: 16 / 9;
  background-color: #0a0a0a;
  border: 2px solid #404040;
  border-radius: 8px;
  overflow: hidden;
}

#character-stream {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.chat-container {
  width: 400px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

h1 {
  margin: 0;
  color: #ffffff;
  font-size: 24px;
}

.controls {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.control-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.control-row label {
  color: #888;
  font-size: 14px;
  min-width: 80px;
}

.control-row select {
  padding: 8px 12px;
  border: 1px solid #404040;
  border-radius: 4px;
  background-color: #2d2d2d;
  color: #e0e0e0;
  font-size: 14px;
  cursor: pointer;
}

.control-row select:focus {
  outline: none;
  border-color: #007bff;
}

.control-row input[type="range"] {
  flex: 1;
  accent-color: #007bff;
}

.control-row .value {
  color: #e0e0e0;
  font-size: 14px;
  min-width: 35px;
  text-align: right;
}

#messageHistory {
  background: #2d2d2d;
  border: 1px solid #404040;
  border-radius: 8px;
  padding: 20px;
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.message {
  margin-bottom: 15px;
  padding: 10px;
  border-radius: 4px;
  color: #e0e0e0;
}

.user-message {
  background-color: #1e3a5f;
  text-align: right;
  color: #ffffff;
}

.status-message {
  background-color: #4a3d1f;
  text-align: center;
  font-style: italic;
  color: #ffd700;
}

.chatbox-container {
  display: flex;
  gap: 10px;
}

#chatbox {
  flex: 1;
  padding: 12px;
  border: 1px solid #404040;
  border-radius: 4px;
  font-size: 16px;
  background-color: #2d2d2d;
  color: #e0e0e0;
}

#chatbox:focus {
  outline: none;
  border-color: #007bff;
}

#chatbox::placeholder {
  color: #888;
}

#submitBtn {
  padding: 12px 24px;
  background-color: #007bff;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 16px;
}

#submitBtn:hover {
  background-color: #0056b3;
}

#submitBtn:disabled {
  background-color: #404040;
  color: #666;
  cursor: not-allowed;
}
```

### Task 4.4: Create frontend app.js

Create file: `/home/liveStream/frontend/app.js`

```javascript
const chatbox = document.getElementById('chatbox');
const submitBtn = document.getElementById('submitBtn');
const messageHistory = document.getElementById('messageHistory');
const voiceSelect = document.getElementById('voiceSelect');
const modelSelect = document.getElementById('modelSelect');
const tempSlider = document.getElementById('tempSlider');
const tempValue = document.getElementById('tempValue');
const characterStream = document.getElementById('character-stream');

tempSlider.addEventListener('input', () => {
  tempValue.textContent = tempSlider.value;
});

function addMessage(text, isUser, isStatus = false) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${isUser ? 'user-message' : isStatus ? 'status-message' : ''}`;
  messageDiv.textContent = text;
  messageHistory.appendChild(messageDiv);
  messageHistory.scrollTop = messageHistory.scrollHeight;
}

async function sendMessage() {
  const message = chatbox.value.trim();

  if (!message) return;

  chatbox.disabled = true;
  submitBtn.disabled = true;

  addMessage(message, true);
  addMessage('Generating response...', false, true);
  chatbox.value = '';

  try {
    // Step 1: Get audio from chat API
    const chatResponse = await fetch(`${CONFIG.API_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        voice: voiceSelect.value,
        model: modelSelect.value,
        temperature: parseFloat(tempSlider.value)
      }),
    });

    if (!chatResponse.ok) {
      const errorData = await chatResponse.json().catch(() => ({ error: 'Failed to get response' }));
      throw new Error(errorData.error || 'Failed to get response');
    }

    const audioBlob = await chatResponse.blob();

    // Remove status message
    const statusMsg = messageHistory.querySelector('.status-message');
    if (statusMsg) statusMsg.remove();

    addMessage('Rendering animation...', false, true);

    // Step 2: Send audio to animation server
    const formData = new FormData();
    formData.append('audio', audioBlob, 'audio.mp3');
    formData.append('character', voiceSelect.value);

    const renderResponse = await fetch(`${CONFIG.ANIMATION_SERVER_URL}/render`, {
      method: 'POST',
      body: formData
    });

    if (!renderResponse.ok) {
      throw new Error('Animation render failed');
    }

    const { streamUrl } = await renderResponse.json();

    // Remove status message
    const statusMsg2 = messageHistory.querySelector('.status-message');
    if (statusMsg2) statusMsg2.remove();

    // Step 3: Play video stream
    if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(streamUrl);
      hls.attachMedia(characterStream);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        characterStream.play();
      });
    } else if (characterStream.canPlayType('application/vnd.apple.mpegurl')) {
      characterStream.src = streamUrl;
      characterStream.play();
    }

    addMessage('Playing response...', false, true);
  } catch (error) {
    const statusMsg = messageHistory.querySelector('.status-message');
    if (statusMsg) statusMsg.remove();
    addMessage(`Error: ${error.message}`, false, true);
  } finally {
    chatbox.disabled = false;
    submitBtn.disabled = false;
    chatbox.focus();
  }
}

submitBtn.addEventListener('click', sendMessage);

chatbox.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

chatbox.focus();
```

### Task 4.5: Create new frontend index.html

Create file: `/home/liveStream/frontend/index.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LiveStream Chatbox</title>
  <link rel="stylesheet" href="style.css">
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <script src="config.js"></script>
</head>
<body>
  <div class="main-container">
    <div class="viewport-container">
      <div id="viewport">
        <video id="character-stream" autoplay playsinline></video>
      </div>
    </div>

    <div class="chat-container">
      <h1>LiveStream Chat</h1>

      <div class="controls">
        <div class="control-row">
          <label for="voiceSelect">Voice:</label>
          <select id="voiceSelect">
            <option value="chad">Chad</option>
            <option value="virgin">Virgin</option>
          </select>
        </div>
        <div class="control-row">
          <label for="modelSelect">Model:</label>
          <select id="modelSelect">
            <option value="eleven_v3">v3 (Expressive)</option>
            <option value="eleven_turbo_v2">v2 Turbo (Fast)</option>
          </select>
        </div>
        <div class="control-row">
          <label for="tempSlider">Temp:</label>
          <input type="range" id="tempSlider" min="0" max="1" step="0.1" value="0.7">
          <span class="value" id="tempValue">0.7</span>
        </div>
      </div>

      <div id="messageHistory"></div>

      <div class="chatbox-container">
        <input
          type="text"
          id="chatbox"
          placeholder="Type your message here..."
          autocomplete="off"
        />
        <button id="submitBtn">Submit</button>
      </div>
    </div>
  </div>

  <script src="app.js"></script>
</body>
</html>
```

---

## PHASE 5: UPDATE BACKEND TO API-ONLY

### Task 5.1: Update server.js

Replace `/home/liveStream/server.js` with:

```javascript
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const axios = require('axios');
const voices = require('./voices');

const app = express();
const port = process.env.PORT || 3002;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Middleware
app.use(cors());
app.use(express.json());

// API: Get available voices
app.get('/api/voices', (req, res) => {
  const voiceList = Object.entries(voices).map(([id, config]) => ({
    id,
    name: config.name
  }));
  res.json(voiceList);
});

// API: Chat endpoint - returns audio
app.post('/api/chat', async (req, res) => {
  try {
    const { message, voice = 'chad', model = 'eleven_v3', temperature = 0.7 } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required and must be a string' });
    }

    const voiceConfig = voices[voice];
    if (!voiceConfig) {
      return res.status(400).json({ error: 'Invalid voice. Use "chad" or "virgin"' });
    }

    // Build system prompt - add audio tags only for v3
    const systemPrompt = model === 'eleven_v3'
      ? voiceConfig.basePrompt + voiceConfig.audioTags
      : voiceConfig.basePrompt;

    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: process.env.MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ],
      max_tokens: 150,
      temperature: temperature,
    });

    const replyText = completion.choices[0].message.content;
    console.log(`Voice: ${voiceConfig.name}, Model: ${model}, Temp: ${temperature}`);

    // Call ElevenLabs
    const elevenLabsResponse = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceConfig.elevenLabsVoiceId}`,
      {
        text: replyText,
        model_id: model,
        voice_settings: voiceConfig.voiceSettings
      },
      {
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': process.env.ELEVENLABS_API_KEY
        },
        responseType: 'arraybuffer'
      }
    );

    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(elevenLabsResponse.data);
  } catch (error) {
    console.error('Error:', error.response?.data ? Buffer.from(error.response.data).toString() : error.message);
    if (error.response) {
      const errorText = Buffer.from(error.response.data).toString();
      return res.status(500).json({ error: `ElevenLabs API error: ${errorText}` });
    }
    res.status(500).json({ error: 'Failed to generate response' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(port, () => {
  console.log(`API server running on http://localhost:${port}`);
});
```

### Task 5.2: Restart backend service
```bash
sudo systemctl restart livestream
sudo systemctl status livestream --no-pager
```

---

## PHASE 6: CREATE ANIMATION SERVER

### Task 6.1: Create animation server package.json

Create file: `/home/liveStream/animation-server/package.json`

```json
{
  "name": "animation-server",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "multer": "^1.4.5-lts.1",
    "sharp": "^0.33.0",
    "fluent-ffmpeg": "^2.1.2",
    "uuid": "^9.0.0"
  }
}
```

### Task 6.2: Install animation server dependencies
```bash
cd /home/liveStream/animation-server
npm install
```

### Task 6.3: Create lip-sync module

Create file: `/home/liveStream/animation-server/lipsync.js`

```javascript
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);

const PHONEME_MAP = {
  'A': 'A',  // Closed mouth (rest)
  'B': 'B',  // M, B, P sounds
  'C': 'C',  // EE, teeth showing
  'D': 'D',  // AH, open mouth
  'E': 'E',  // OH, rounded lips
  'F': 'F',  // OO, pursed lips
  'G': 'G',  // F, V sounds
  'H': 'H',  // L sound, tongue
  'X': 'A'   // Extended rest (map to A)
};

async function analyzeLipSync(audioPath) {
  const outputPath = audioPath.replace('.mp3', '_lipsync.json');

  try {
    await execAsync(`rhubarb -f json "${audioPath}" -o "${outputPath}" --machineReadable`);
    const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    fs.unlinkSync(outputPath); // Clean up

    // Map phonemes and return cues
    return result.mouthCues.map(cue => ({
      start: cue.start,
      end: cue.end,
      phoneme: PHONEME_MAP[cue.value] || 'A'
    }));
  } catch (error) {
    console.error('Rhubarb error:', error.message);
    // Return default closed mouth if analysis fails
    return [{ start: 0, end: 10, phoneme: 'A' }];
  }
}

function getPhonemeAtTime(cues, timeInSeconds) {
  for (const cue of cues) {
    if (timeInSeconds >= cue.start && timeInSeconds < cue.end) {
      return cue.phoneme;
    }
  }
  return 'A'; // Default to closed mouth
}

module.exports = { analyzeLipSync, getPhonemeAtTime };
```

### Task 6.4: Create blink controller

Create file: `/home/liveStream/animation-server/blink-controller.js`

```javascript
class BlinkController {
  constructor(fps = 30) {
    this.fps = fps;
    this.isBlinking = false;
    this.blinkStartFrame = 0;
    this.nextBlinkFrame = this.getRandomBlinkFrame(0);
    this.blinkDurationFrames = 2; // ~67ms at 30fps (faster blink)
  }

  getRandomBlinkFrame(currentFrame) {
    // Random blink every 1.5-3 seconds (faster than 3-5s)
    const minFrames = 1.5 * this.fps;
    const maxFrames = 3 * this.fps;
    return currentFrame + minFrames + Math.floor(Math.random() * (maxFrames - minFrames));
  }

  update(frameNumber, isSpeaking) {
    // If speaking and not already blinking, delay next blink
    if (isSpeaking && !this.isBlinking) {
      this.nextBlinkFrame = Math.max(this.nextBlinkFrame, frameNumber + this.fps);
      return false;
    }

    // Check if we should start blinking
    if (!this.isBlinking && frameNumber >= this.nextBlinkFrame) {
      this.isBlinking = true;
      this.blinkStartFrame = frameNumber;
      return true;
    }

    // Check if blink should end
    if (this.isBlinking) {
      if (frameNumber >= this.blinkStartFrame + this.blinkDurationFrames) {
        this.isBlinking = false;
        this.nextBlinkFrame = this.getRandomBlinkFrame(frameNumber);
        return false;
      }
      return true;
    }

    return false;
  }

  reset() {
    this.isBlinking = false;
    this.nextBlinkFrame = this.getRandomBlinkFrame(0);
  }
}

module.exports = BlinkController;
```

### Task 6.5: Create compositor module

Create file: `/home/liveStream/animation-server/compositor.js`

```javascript
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const LAYERS_DIR = path.join(__dirname, '..', 'exported-layers');
const manifestPath = path.join(LAYERS_DIR, 'manifest.json');

let manifest = null;
let layerCache = {};

function loadManifest() {
  if (!manifest) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }
  return manifest;
}

async function loadLayer(layerPath) {
  const fullPath = path.join(LAYERS_DIR, layerPath);
  if (!layerCache[fullPath]) {
    layerCache[fullPath] = await sharp(fullPath).raw().toBuffer({ resolveWithObject: true });
  }
  return layerCache[fullPath];
}

async function compositeFrame(character, phoneme, isBlinking) {
  const m = loadManifest();

  // Sort layers by zIndex
  const sortedLayers = [...m.layers].sort((a, b) => a.zIndex - b.zIndex);

  // Create base canvas
  let compositeOps = [];

  for (const layer of sortedLayers) {
    // Skip invisible layers
    if (!layer.visible && layer.type === 'static') continue;

    // Handle mouth layers - only show active phoneme for active character
    if (layer.type === 'mouth') {
      if (layer.character !== character) continue;
      if (layer.phoneme !== phoneme) continue;
    }

    // Handle blink layers
    if (layer.type === 'blink') {
      if (layer.character !== character) continue;
      if (!isBlinking) continue;
    }

    // Skip non-active character's blink when blinking
    if (layer.type === 'blink' && layer.character !== character) continue;

    try {
      compositeOps.push({
        input: path.join(LAYERS_DIR, layer.path),
        left: layer.x,
        top: layer.y,
        blend: 'over'
      });
    } catch (err) {
      console.error(`Failed to load layer: ${layer.path}`, err.message);
    }
  }

  // Composite all layers
  const result = await sharp({
    create: {
      width: m.width,
      height: m.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 }
    }
  })
  .composite(compositeOps)
  .png()
  .toBuffer();

  return result;
}

function clearCache() {
  layerCache = {};
}

module.exports = { compositeFrame, loadManifest, clearCache };
```

### Task 6.6: Create animation server main file

Create file: `/home/liveStream/animation-server/server.js`

```javascript
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');

const { analyzeLipSync, getPhonemeAtTime } = require('./lipsync');
const BlinkController = require('./blink-controller');
const { compositeFrame, loadManifest } = require('./compositor');

const app = express();
const port = process.env.ANIMATION_PORT || 3003;

const STREAMS_DIR = path.join(__dirname, '..', 'streams');
const TEMP_DIR = path.join(__dirname, 'temp');

// Ensure directories exist
fs.mkdirSync(STREAMS_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

app.use(cors());

// Configure multer for audio upload
const upload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

// Render endpoint
app.post('/render', upload.single('audio'), async (req, res) => {
  const sessionId = uuidv4();
  const character = req.body.character || 'chad';

  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' });
  }

  const audioPath = req.file.path;
  const audioMp3Path = `${audioPath}.mp3`;
  const sessionDir = path.join(STREAMS_DIR, sessionId);
  const framesDir = path.join(sessionDir, 'frames');

  fs.mkdirSync(framesDir, { recursive: true });

  try {
    // Rename uploaded file to .mp3
    fs.renameSync(audioPath, audioMp3Path);

    console.log(`[${sessionId}] Analyzing lip sync...`);
    const lipSyncCues = await analyzeLipSync(audioMp3Path);

    console.log(`[${sessionId}] Rendering frames...`);
    const fps = 30;
    const blinkController = new BlinkController(fps);

    // Get audio duration
    const audioDuration = lipSyncCues.length > 0
      ? lipSyncCues[lipSyncCues.length - 1].end
      : 5;

    const totalFrames = Math.ceil(audioDuration * fps);

    // Render frames
    for (let frame = 0; frame < totalFrames; frame++) {
      const timeInSeconds = frame / fps;
      const phoneme = getPhonemeAtTime(lipSyncCues, timeInSeconds);
      const isSpeaking = phoneme !== 'A';
      const isBlinking = blinkController.update(frame, isSpeaking);

      const frameBuffer = await compositeFrame(character, phoneme, isBlinking);
      const framePath = path.join(framesDir, `frame_${String(frame).padStart(5, '0')}.png`);
      fs.writeFileSync(framePath, frameBuffer);

      if (frame % 30 === 0) {
        console.log(`[${sessionId}] Rendered frame ${frame}/${totalFrames}`);
      }
    }

    console.log(`[${sessionId}] Encoding video...`);

    // Create HLS stream with FFmpeg
    const outputPath = path.join(sessionDir, 'stream.m3u8');

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(path.join(framesDir, 'frame_%05d.png'))
        .inputFPS(fps)
        .input(audioMp3Path)
        .outputOptions([
          '-c:v libx264',
          '-preset ultrafast',
          '-tune stillimage',
          '-c:a aac',
          '-b:a 128k',
          '-pix_fmt yuv420p',
          '-shortest',
          '-hls_time 2',
          '-hls_list_size 0',
          '-hls_segment_filename', path.join(sessionDir, 'segment_%03d.ts')
        ])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    console.log(`[${sessionId}] Stream ready`);

    // Clean up temp files
    fs.unlinkSync(audioMp3Path);
    fs.rmSync(framesDir, { recursive: true });

    const streamUrl = `/streams/${sessionId}/stream.m3u8`;
    res.json({ streamUrl, sessionId });

  } catch (error) {
    console.error(`[${sessionId}] Error:`, error);
    res.status(500).json({ error: error.message });

    // Clean up on error
    try {
      fs.unlinkSync(audioMp3Path);
      fs.rmSync(sessionDir, { recursive: true });
    } catch (e) {}
  }
});

// Serve HLS streams
app.use('/streams', express.static(STREAMS_DIR));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(port, () => {
  console.log(`Animation server running on http://localhost:${port}`);

  // Load manifest on startup
  try {
    loadManifest();
    console.log('Layer manifest loaded successfully');
  } catch (err) {
    console.error('Warning: Could not load manifest:', err.message);
  }
});
```

### Task 6.7: Create animation server systemd service

Create file: `/home/liveStream/vps-setup/animation.service`

```ini
[Unit]
Description=Animation Server for LiveStream
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/liveStream/animation-server
ExecStart=/root/.nvm/versions/node/v18.20.8/bin/node /home/liveStream/animation-server/server.js
Restart=on-failure
RestartSec=10
Environment=ANIMATION_PORT=3003

[Install]
WantedBy=multi-user.target
```

### Task 6.8: Install and start animation service
```bash
sudo cp /home/liveStream/vps-setup/animation.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable animation
sudo systemctl start animation
sudo systemctl status animation --no-pager
```

---

## PHASE 7: SERVE FRONTEND

### Task 7.1: Install nginx if not present
```bash
which nginx || sudo apt install nginx -y
```

### Task 7.2: Create nginx config

Create file: `/etc/nginx/sites-available/livestream`

```nginx
server {
    listen 80;
    server_name 93.127.214.75;

    # Frontend
    location / {
        root /home/liveStream/frontend;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    # API proxy
    location /api/ {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    # Animation server proxy
    location /render {
        proxy_pass http://127.0.0.1:3003;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        client_max_body_size 10M;
    }

    # HLS streams
    location /streams/ {
        proxy_pass http://127.0.0.1:3003;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }
}
```

### Task 7.3: Enable nginx site
```bash
sudo ln -sf /etc/nginx/sites-available/livestream /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

---

## PHASE 8: UPDATE FRONTEND CONFIG FOR PRODUCTION

### Task 8.1: Update frontend config.js for nginx proxy

Replace `/home/liveStream/frontend/config.js` with:

```javascript
const CONFIG = {
  API_BASE_URL: '',  // Empty = same origin (nginx proxies /api/)
  ANIMATION_SERVER_URL: ''  // Empty = same origin (nginx proxies /render and /streams)
};
```

---

## PHASE 9: VERIFICATION

### Task 9.1: Check all services are running
```bash
sudo systemctl status livestream --no-pager
sudo systemctl status animation --no-pager
sudo systemctl status webhook --no-pager
sudo systemctl status nginx --no-pager
```

### Task 9.2: Test API endpoint
```bash
curl http://localhost:3002/api/health
```
Expected: `{"status":"ok"}`

### Task 9.3: Test animation endpoint
```bash
curl http://localhost:3003/health
```
Expected: `{"status":"ok"}`

### Task 9.4: Test nginx
```bash
curl http://93.127.214.75/
```
Expected: HTML content of frontend

### Task 9.5: Test full flow
Open browser to: `http://93.127.214.75`
1. Select "Chad" voice
2. Type "Hello"
3. Click Submit
4. Should see video render in viewport

---

## PHASE 10: COMMIT ALL CHANGES

### Task 10.1: Commit everything
```bash
cd /home/liveStream
git add -A
git commit -m "Implement animation system with PSD layers, lip-sync, and HLS streaming"
git push origin master
```

---

## TROUBLESHOOTING

### If PSD export fails:
- Verify Stream.psd exists at `/home/liveStream/Stream.psd`
- Check ag-psd can read it: `node -e "require('ag-psd').readPsd(require('fs').readFileSync('Stream.psd'))"`

### If Rhubarb fails:
- Verify installation: `rhubarb --version`
- Test manually: `rhubarb test.mp3 -f json`

### If FFmpeg fails:
- Verify installation: `ffmpeg -version`
- Check codec: `ffmpeg -codecs | grep libx264`

### If animation server crashes:
- Check logs: `sudo journalctl -u animation -f`
- Verify manifest exists: `cat /home/liveStream/exported-layers/manifest.json`

### If video doesn't play:
- Check browser console for CORS errors
- Verify HLS segments exist in `/home/liveStream/streams/`
- Test HLS URL directly in VLC

---

## ROLLBACK

If something breaks, restore original functionality:

```bash
# Stop new services
sudo systemctl stop animation
sudo systemctl disable animation

# Restore original server.js from git
git checkout HEAD~1 -- server.js

# Restart original service
sudo systemctl restart livestream

# Remove nginx config
sudo rm /etc/nginx/sites-enabled/livestream
sudo systemctl reload nginx
```
