const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { FFMPEG_PATH } = require('./platform');
const { analyzeLipSync } = require('./lipsync');
const BlinkController = require('./blink-controller');
const { compositeFrame, loadManifest, preloadLayers, setTVFrame, getTVViewport } = require('./compositor');
const { decodeAudio } = require('./audio-decoder');
const AnimationState = require('./state');
const StreamManager = require('./stream-manager');
const ContinuousStreamManager = require('./continuous-stream-manager');
const SyncedPlayback = require('./synced-playback');
const TVContentService = require('./tv-content');

// Lip sync mode: 'realtime' (new) or 'rhubarb' (legacy)
const LIPSYNC_MODE = process.env.LIPSYNC_MODE || 'realtime';

// Stream mode: 'synced' (audio muxed into video) or 'separate' (audio played separately)
const STREAM_MODE = process.env.STREAM_MODE || 'synced';

const app = express();
const port = process.env.ANIMATION_PORT || 3003;
const host = process.env.ANIMATION_HOST || '0.0.0.0';

const ROOT_DIR = path.resolve(__dirname, '..');
const STREAMS_DIR = path.join(ROOT_DIR, 'streams');
const TEMP_DIR = path.join(__dirname, 'temp');
const AUDIO_DIR = path.join(STREAMS_DIR, 'audio');
const TV_CONTENT_DIR = path.join(__dirname, 'tv-content', 'content');

// Ensure directories exist
fs.mkdirSync(STREAMS_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });
fs.mkdirSync(TV_CONTENT_DIR, { recursive: true });

app.use(cors());
app.use(express.json());

// Configure multer
const upload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Global state
const animationState = new AnimationState();  // Legacy: used in rhubarb mode
const syncedPlayback = new SyncedPlayback(16000, 15);  // New: real-time mode
const blinkControllers = {
  chad: new BlinkController(15),
  virgin: new BlinkController(15)
};
let streamManager = null;  // Will be either StreamManager or ContinuousStreamManager
let frameCount = 0;
let tvService = null;  // TV content service (initialized after preloadLayers)

// Track current speaking state for synced mode
let currentSpeaker = null;
let currentCaption = null;
let captionUntil = 0;
let captionTimeout = null;
let isAudioActive = false;
const renderQueue = [];

function setCaption(text, durationSeconds) {
  if (!text) return;
  currentCaption = text;
  captionUntil = Date.now() + Math.max(0, durationSeconds) * 1000;
  if (captionTimeout) {
    clearTimeout(captionTimeout);
  }
  captionTimeout = setTimeout(() => {
    currentCaption = null;
    captionUntil = 0;
    captionTimeout = null;
  }, Math.max(0, durationSeconds) * 1000);
}

function scheduleAudioCleanup(audioMp3Path, durationSeconds) {
  setTimeout(() => {
    try { fs.unlinkSync(audioMp3Path); } catch (e) {}
  }, (durationSeconds + 5) * 1000);
}

function handleAudioComplete() {
  currentSpeaker = null;
  currentCaption = null;
  captionUntil = 0;
  if (captionTimeout) {
    clearTimeout(captionTimeout);
    captionTimeout = null;
  }
  isAudioActive = false;
  processQueue();
}

async function startPlayback(item) {
  isAudioActive = true;
  currentSpeaker = item.character;

  if (LIPSYNC_MODE === 'realtime') {
    syncedPlayback.loadSamples(item.samples, item.duration, item.character);
    if (STREAM_MODE === 'synced') {
      streamManager.loadAudio(item.samples, item.sampleRate, item.character, item.duration);
    } else {
      syncedPlayback.start();
    }
  } else {
    animationState.startSpeaking(item.character, item.lipSyncCues, item.audioMp3Path, item.duration);
    setTimeout(handleAudioComplete, Math.max(0, item.duration) * 1000);
  }

  if (item.messageText) {
    setCaption(item.messageText, item.duration);
  }

  scheduleAudioCleanup(item.audioMp3Path, item.duration);
}

function processQueue() {
  if (isAudioActive || renderQueue.length === 0) {
    return;
  }

  const next = renderQueue.shift();
  startPlayback(next).catch(err => {
    console.error('[Queue] Failed to start playback:', err.message);
    isAudioActive = false;
    processQueue();
  });
}

syncedPlayback.onComplete = handleAudioComplete;

// Frame renderer callback
// audioProgress is provided by ContinuousStreamManager: { playing, frame, total }
async function renderFrame(frame, audioProgress = null) {
  frameCount = frame;

  let speakingCharacter = null;
  let currentPhoneme = 'A';

  if (STREAM_MODE === 'synced' && audioProgress && audioProgress.playing) {
    // SYNCED MODE: Audio is fed through continuous stream
    // Use audioProgress.frame to get the exact phoneme for this video frame
    speakingCharacter = audioProgress.character;
    currentPhoneme = syncedPlayback.getPhonemeAtFrame(audioProgress.frame);
  } else if (LIPSYNC_MODE === 'realtime') {
    // SEPARATE MODE with real-time: tick advances through audio buffer
    const result = syncedPlayback.tick();
    speakingCharacter = result.done ? null : result.character;
    currentPhoneme = result.phoneme;
  } else {
    // LEGACY: Rhubarb mode - phoneme looked up from pre-calculated timestamps
    const state = animationState.getState();
    speakingCharacter = state.speakingCharacter;
    currentPhoneme = state.phoneme || 'A';
    if (!state.isPlaying && isAudioActive) {
      handleAudioComplete();
    }
  }

  // Chad gets the phoneme if he's speaking, otherwise neutral
  const chadPhoneme = speakingCharacter === 'chad' ? currentPhoneme : 'A';
  // Virgin gets the phoneme if she's speaking, otherwise neutral
  const virginPhoneme = speakingCharacter === 'virgin' ? currentPhoneme : 'A';

  // Update blink for both characters
  // Don't blink while speaking
  const chadBlinking = blinkControllers.chad.update(frame, speakingCharacter === 'chad');
  const virginBlinking = blinkControllers.virgin.update(frame, speakingCharacter === 'virgin');
  const caption = currentCaption && Date.now() < captionUntil ? currentCaption : null;

  // Update TV content - tick advances frame, get current frame for compositing
  if (tvService) {
    tvService.tick();
    const tvFrame = await tvService.getCurrentFrame();
    setTVFrame(tvFrame);
  }

  // Debug log every 30 frames (once per second)
  if (frame % 30 === 0) {
    const mode = STREAM_MODE === 'synced' ? 'SY' : (LIPSYNC_MODE === 'realtime' ? 'RT' : 'RH');
    const stateStr = speakingCharacter
      ? `${speakingCharacter} speaking (${currentPhoneme})`
      : 'idle';
    const tvState = tvService ? tvService.state : 'off';
    console.log(`[Frame ${frame}] [${mode}] ${stateStr} | chad:${chadPhoneme}${chadBlinking?'(blink)':''} virgin:${virginPhoneme}${virginBlinking?'(blink)':''} | TV:${tvState}`);
  }

  try {
    // Composite frame with both characters' state
    const buffer = await compositeFrame({
      chadPhoneme,
      virginPhoneme,
      chadBlinking,
      virginBlinking,
      caption
    });
    return buffer;
  } catch (err) {
    console.error('[Render] Frame error:', err.message);
    return null;
  }
}

// Queue audio for playback
app.post('/render', upload.single('audio'), async (req, res) => {
  const renderStart = Date.now();
  const character = req.body.character || 'chad';
  const messageText = typeof req.body.message === 'string' ? req.body.message.trim() : '';
  const mode = req.body.mode || 'direct';
  const shouldQueue = mode === 'router';

  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' });
  }

  const audioPath = req.file.path;
  const audioId = crypto.randomBytes(8).toString('hex');
  const audioMp3Path = path.join(AUDIO_DIR, `${audioId}.mp3`);

  try {
    // Move to audio directory
    fs.renameSync(audioPath, audioMp3Path);
    const moveTime = Date.now() - renderStart;

    let audioDuration;
    const response = {
      streamUrl: streamManager.getStreamUrl(),
      lipsyncMode: LIPSYNC_MODE,
      streamMode: STREAM_MODE
    };

    if (LIPSYNC_MODE === 'realtime') {
      // Real-time mode - decode audio for lip sync analysis
      const decodeStart = Date.now();
      const result = await decodeAudio(audioMp3Path, syncedPlayback.sampleRate);
      const samples = result.samples;
      const sampleRate = result.sampleRate;
      audioDuration = result.duration;
      const decodeTime = Date.now() - decodeStart;

      const queueItem = {
        character,
        messageText,
        audioMp3Path,
        duration: audioDuration,
        samples,
        sampleRate
      };

      const queued = shouldQueue && (isAudioActive || renderQueue.length > 0);
      if (queued) {
        renderQueue.push(queueItem);
        response.queued = true;
        response.queuePosition = renderQueue.length;
      } else {
        await startPlayback(queueItem);
        response.queued = false;
      }

      const totalTime = Date.now() - renderStart;
      console.log(`[Render] ${character} | move:${moveTime}ms decode:${decodeTime}ms total:${totalTime}ms | ${audioDuration.toFixed(1)}s audio`);

    } else {
      // LEGACY: Rhubarb mode - analyze entire file upfront
      console.log(`[Render] [RH] Analyzing lip sync for ${character}...`);
      const analyzeStart = Date.now();

      const lipSyncCues = await analyzeLipSync(audioMp3Path);
      audioDuration = lipSyncCues.length > 0
        ? Math.max(...lipSyncCues.map(c => c.end))
        : 5;

      const analyzeTime = Date.now() - analyzeStart;
      console.log(`[Render] [RH] Analyzed in ${analyzeTime}ms, got ${lipSyncCues.length} cues, duration: ${audioDuration.toFixed(2)}s`);

      // Debug: log first few cues
      if (lipSyncCues.length > 0) {
        console.log('[Render] [RH] First cues:', lipSyncCues.slice(0, 5).map(c => `${c.start.toFixed(2)}-${c.end.toFixed(2)}: ${c.phoneme}`).join(', '));
      }

      const queueItem = {
        character,
        messageText,
        audioMp3Path,
        duration: audioDuration,
        lipSyncCues
      };

      const queued = shouldQueue && (isAudioActive || renderQueue.length > 0);
      if (queued) {
        renderQueue.push(queueItem);
        response.queued = true;
        response.queuePosition = renderQueue.length;
      } else {
        await startPlayback(queueItem);
        response.queued = false;
      }
    }

    response.duration = audioDuration;

    // Only provide separate audio URL in non-synced mode
    if (STREAM_MODE !== 'synced') {
      response.audioUrl = `/audio/${audioId}.mp3`;
    }

    res.json(response);

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

// Client signals audio playback has started - sync point
app.post('/playback-start', (req, res) => {
  if (LIPSYNC_MODE === 'realtime') {
    console.log('[Sync] Client signaled audio playback start - starting lip sync NOW');
    syncedPlayback.start();
    res.json({ status: 'ok', message: 'Lip sync started' });
  } else {
    res.json({ status: 'ok', message: 'Rhubarb mode - no action needed' });
  }
});

// Get current stream info
app.get('/stream-info', (req, res) => {
  const state = LIPSYNC_MODE === 'realtime'
    ? syncedPlayback.getState()
    : animationState.getState();

  res.json({
    streamUrl: streamManager ? streamManager.getStreamUrl() : null,
    state,
    frameCount,
    lipsyncMode: LIPSYNC_MODE
  });
});

// Serve TV control panel
app.get('/tv', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'tv-control.html'));
});

// ============== TV Content API ==============

const { spawn } = require('child_process');

// Helper: Extract audio from video file
function extractAudioFromVideo(videoPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(FFMPEG_PATH, [
      '-i', videoPath,
      '-vn',                    // No video
      '-acodec', 'libmp3lame',  // MP3 codec
      '-ab', '128k',            // 128kbps bitrate
      '-ar', '44100',           // 44.1kHz sample rate
      '-y',                     // Overwrite output
      outputPath
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let hasAudio = true;
    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      // Check if video had no audio stream
      if (stderr.includes('does not contain any stream') ||
          stderr.includes('Output file is empty') ||
          !fs.existsSync(outputPath) ||
          fs.statSync(outputPath).size < 1000) {
        // No audio or extraction failed - clean up and resolve with null
        try { fs.unlinkSync(outputPath); } catch (e) {}
        resolve(null);
        return;
      }

      if (code !== 0) {
        resolve(null);  // Don't fail upload if audio extraction fails
        return;
      }

      resolve(outputPath);
    });

    ffmpeg.on('error', () => {
      resolve(null);  // Don't fail upload if audio extraction fails
    });
  });
}

// Configure multer for TV content uploads
const tvUpload = multer({
  dest: TV_CONTENT_DIR,
  limits: { fileSize: 100 * 1024 * 1024 }  // 100MB limit for videos
});

// Add item to TV playlist
app.post('/tv/playlist/add', async (req, res) => {
  if (!tvService) {
    return res.status(503).json({ error: 'TV service not initialized' });
  }

  const { type, source, duration } = req.body;

  if (!type || !source) {
    return res.status(400).json({ error: 'Missing required fields: type, source' });
  }

  if (type !== 'image' && type !== 'video') {
    return res.status(400).json({ error: 'Invalid type. Must be "image" or "video"' });
  }

  try {
    const item = await tvService.addItem({ type, source, duration });
    res.json({ success: true, item });
  } catch (err) {
    console.error('[TV] Add item error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Upload and add file to TV playlist
app.post('/tv/upload', tvUpload.single('file'), async (req, res) => {
  if (!tvService) {
    return res.status(503).json({ error: 'TV service not initialized' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No file provided' });
  }

  const type = req.body.type || (req.file.mimetype.startsWith('video/') ? 'video' : 'image');
  const duration = req.body.duration ? parseFloat(req.body.duration) : undefined;

  // Generate a proper filename
  const ext = path.extname(req.file.originalname) || (type === 'video' ? '.mp4' : '.png');
  const newPath = path.join(TV_CONTENT_DIR, `${req.file.filename}${ext}`);
  fs.renameSync(req.file.path, newPath);

  let audioPath = null;

  // Extract audio for videos
  if (type === 'video') {
    const audioFilePath = path.join(TV_CONTENT_DIR, `${req.file.filename}.mp3`);
    audioPath = await extractAudioFromVideo(newPath, audioFilePath);
    if (audioPath) {
      console.log(`[TV] Extracted audio: ${audioPath}`);
    }
  }

  try {
    const item = await tvService.addItem({ type, source: newPath, duration, audioPath });
    res.json({ success: true, item });
  } catch (err) {
    console.error('[TV] Upload error:', err);
    try { fs.unlinkSync(newPath); } catch (e) {}
    if (audioPath) {
      try { fs.unlinkSync(audioPath); } catch (e) {}
    }
    res.status(500).json({ error: err.message });
  }
});

// Remove item from TV playlist
app.delete('/tv/playlist/:id', (req, res) => {
  if (!tvService) {
    return res.status(503).json({ error: 'TV service not initialized' });
  }

  const success = tvService.removeItem(req.params.id);
  if (success) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Item not found' });
  }
});

// Get TV playlist
app.get('/tv/playlist', (req, res) => {
  if (!tvService) {
    return res.status(503).json({ error: 'TV service not initialized' });
  }

  res.json({
    playlist: tvService.getPlaylist(),
    status: tvService.getStatus()
  });
});

// Clear TV playlist
app.post('/tv/playlist/clear', (req, res) => {
  if (!tvService) {
    return res.status(503).json({ error: 'TV service not initialized' });
  }

  tvService.clear();
  res.json({ success: true });
});

// TV playback control
app.post('/tv/control', (req, res) => {
  if (!tvService) {
    return res.status(503).json({ error: 'TV service not initialized' });
  }

  const { action } = req.body;

  if (!action) {
    return res.status(400).json({ error: 'Missing action' });
  }

  let success = false;
  switch (action) {
    case 'play':
      success = tvService.play();
      break;
    case 'pause':
      success = tvService.pause();
      break;
    case 'stop':
      success = tvService.stop();
      break;
    case 'next':
      success = tvService.next();
      break;
    case 'prev':
      success = tvService.prev();
      break;
    default:
      return res.status(400).json({ error: `Unknown action: ${action}` });
  }

  res.json({ success, status: tvService.getStatus() });
});

// Get TV status
app.get('/tv/status', (req, res) => {
  if (!tvService) {
    return res.status(503).json({ error: 'TV service not initialized' });
  }

  const viewport = getTVViewport();
  res.json({
    status: tvService.getStatus(),
    viewport
  });
});

// Set hold mode (lock current item, prevent auto-advance)
app.post('/tv/hold', (req, res) => {
  if (!tvService) {
    return res.status(503).json({ error: 'TV service not initialized' });
  }

  const { enabled } = req.body;
  const hold = tvService.setHold(enabled);
  res.json({ success: true, hold, status: tvService.getStatus() });
});

// Set/get TV volume
app.post('/tv/volume', (req, res) => {
  if (!tvService) {
    return res.status(503).json({ error: 'TV service not initialized' });
  }

  const { volume } = req.body;
  if (typeof volume !== 'number' || volume < 0 || volume > 1) {
    return res.status(400).json({ error: 'Volume must be a number between 0 and 1' });
  }

  const newVolume = tvService.setVolume(volume);
  res.json({ success: true, volume: newVolume });
});

app.get('/tv/volume', (req, res) => {
  if (!tvService) {
    return res.status(503).json({ error: 'TV service not initialized' });
  }

  res.json({ volume: tvService.getVolume() });
});

// Serve TV content audio files
app.get('/tv/audio/:filename', (req, res) => {
  const filePath = path.join(TV_CONTENT_DIR, req.params.filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Audio file not found' });
  }

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Accept-Ranges', 'bytes');
  fs.createReadStream(filePath).pipe(res);
});

// ============== End TV Content API ==============

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    platform: process.platform,
    ffmpeg: FFMPEG_PATH,
    streaming: streamManager ? streamManager.isRunning : false,
    lipsyncMode: LIPSYNC_MODE,
    streamMode: STREAM_MODE,
    tvService: tvService ? tvService.state : 'not initialized'
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

  // Initialize TV content service with viewport dimensions from compositor
  const viewport = getTVViewport();
  if (viewport) {
    tvService = new TVContentService(viewport.width, viewport.height, 15);
    console.log(`[TV] Service initialized with viewport ${viewport.width}x${viewport.height}`);
  } else {
    console.warn('[TV] Service disabled - no viewport defined');
  }

  // Start live stream
  if (STREAM_MODE === 'synced') {
    streamManager = new ContinuousStreamManager(STREAMS_DIR, 15);
    // Reset speaker when audio finishes
    streamManager.onAudioComplete = () => {
      console.log('[Server] Audio complete, resetting speaker');
      handleAudioComplete();
    };
  } else {
    streamManager = new StreamManager(STREAMS_DIR, 30);
  }
  streamManager.start(renderFrame);

  app.listen(port, host, () => {
    console.log(`Animation server running on http://${host}:${port}`);
    console.log(`Live stream: http://${host}:${port}${streamManager.getStreamUrl()}`);
    console.log(`Platform: ${process.platform}`);
    console.log(`Lip sync mode: ${LIPSYNC_MODE} | Stream mode: ${STREAM_MODE}`);
    console.log(`TV content: ${tvService ? 'enabled' : 'disabled'}`);
  });
}

start();
