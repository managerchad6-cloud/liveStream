const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { FFMPEG_PATH } = require('./platform');
const { analyzeLipSync } = require('./lipsync');
const BlinkController = require('./blink-controller');
const { compositeFrame, loadManifest, preloadLayers } = require('./compositor');
const AnimationState = require('./state');
const StreamManager = require('./stream-manager');

const app = express();
const port = process.env.ANIMATION_PORT || 3003;

const ROOT_DIR = path.resolve(__dirname, '..');
const STREAMS_DIR = path.join(ROOT_DIR, 'streams');
const TEMP_DIR = path.join(__dirname, 'temp');
const AUDIO_DIR = path.join(STREAMS_DIR, 'audio');

// Ensure directories exist
fs.mkdirSync(STREAMS_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });

app.use(cors());

// Configure multer
const upload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Global state
const animationState = new AnimationState();
const blinkControllers = {
  chad: new BlinkController(30),
  virgin: new BlinkController(30)
};
let streamManager = null;
let frameCount = 0;

// Frame renderer callback
async function renderFrame(frame) {
  frameCount = frame;
  const state = animationState.getState();

  // Determine which character to animate
  const activeCharacter = state.speakingCharacter || 'chad';
  const phoneme = state.phoneme || 'A';

  // Update blink for non-speaking character (or both if idle)
  const isSpeaking = state.isPlaying;
  const chadBlinking = blinkControllers.chad.update(frame, activeCharacter === 'chad' && isSpeaking);
  const virginBlinking = blinkControllers.virgin.update(frame, activeCharacter === 'virgin' && isSpeaking);

  try {
    // Composite frame with current state
    const buffer = await compositeFrame(
      activeCharacter,
      phoneme,
      activeCharacter === 'chad' ? chadBlinking : virginBlinking
    );
    return buffer;
  } catch (err) {
    console.error('[Render] Frame error:', err.message);
    return null;
  }
}

// Queue audio for playback
app.post('/render', upload.single('audio'), async (req, res) => {
  const character = req.body.character || 'chad';

  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' });
  }

  const audioPath = req.file.path;
  const audioId = crypto.randomBytes(8).toString('hex');
  const audioMp3Path = path.join(AUDIO_DIR, `${audioId}.mp3`);

  try {
    // Move to audio directory
    fs.renameSync(audioPath, audioMp3Path);

    console.log(`[Render] Analyzing lip sync for ${character}...`);
    const lipSyncCues = await analyzeLipSync(audioMp3Path);

    // Get audio duration from cues
    const audioDuration = lipSyncCues.length > 0
      ? Math.max(...lipSyncCues.map(c => c.end))
      : 5;

    console.log(`[Render] Got ${lipSyncCues.length} cues, duration: ${audioDuration.toFixed(2)}s`);

    // Update animation state
    animationState.startSpeaking(character, lipSyncCues, audioMp3Path, audioDuration);

    // Schedule cleanup after audio finishes
    setTimeout(() => {
      try { fs.unlinkSync(audioMp3Path); } catch (e) {}
    }, (audioDuration + 5) * 1000);

    res.json({
      streamUrl: streamManager.getStreamUrl(),
      audioUrl: `/audio/${audioId}.mp3`,
      duration: audioDuration
    });

  } catch (error) {
    console.error('[Render] Error:', error);
    res.status(500).json({ error: error.message });
    try { fs.unlinkSync(audioMp3Path); } catch (e) {}
  }
});

// Serve audio files
app.use('/audio', express.static(AUDIO_DIR, {
  setHeaders: (res) => {
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
}));

// Serve HLS streams
app.use('/streams', express.static(STREAMS_DIR, {
  setHeaders: (res, filePath) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (filePath.endsWith('.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
    } else if (filePath.endsWith('.ts')) {
      res.setHeader('Content-Type', 'video/mp2t');
    }
  }
}));

// Get current stream info
app.get('/stream-info', (req, res) => {
  res.json({
    streamUrl: streamManager ? streamManager.getStreamUrl() : null,
    state: animationState.getState(),
    frameCount
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    platform: process.platform,
    ffmpeg: FFMPEG_PATH,
    streaming: streamManager ? streamManager.isRunning : false
  });
});

// Start server
async function start() {
  try {
    loadManifest();
    console.log('Preloading layers...');
    await preloadLayers();
  } catch (err) {
    console.warn('Warning:', err.message);
    console.warn('Run "node tools/export-psd.js" to generate layers from PSD');
  }

  // Start live stream
  streamManager = new StreamManager(STREAMS_DIR, 30);
  streamManager.start(renderFrame);

  app.listen(port, () => {
    console.log(`Animation server running on http://localhost:${port}`);
    console.log(`Live stream: http://localhost:${port}${streamManager.getStreamUrl()}`);
    console.log(`Platform: ${process.platform}`);
  });
}

start();
