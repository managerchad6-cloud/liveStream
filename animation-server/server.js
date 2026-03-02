const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { FFMPEG_PATH } = require('./platform');
const { analyzeLipSync } = require('./lipsync');
const BlinkController = require('./blink-controller');
const {
  compositeFrame,
  loadManifest,
  preloadLayers,
  setTVFrame,
  getTVViewport,
  setExpressionOffset,
  getExpressionOffsets,
  resetExpressionOffsets,
  getExpressionLimits,
  saveExpressionLimits,
  setEyebrowRotationLimits,
  setEyebrowAsymmetry,
  setSpeakingCharacter,
  setLeaderboard,
  getLeaderboard,
  getLeaderboardVersion,
  setLeaderboardTimer,
  getLeaderboardTimer,
  addChatMessage
} = require('./compositor');
const { decodeAudio } = require('./audio-decoder');
const AnimationState = require('./state');
const StreamManager = require('./stream-manager');
const ContinuousStreamManager = require('./continuous-stream-manager');
const SyncedPlayback = require('./synced-playback');
const TVContentService = require('./tv-content');
const { buildExpressionPlan, augmentExpressionPlan, normalizePlanTiming } = require('./expression-timeline');
const ExpressionEvaluator = require('./expression-evaluator');
const OpenAI = require('openai');
const MediaLibrary = require('./media-library');
const PipelineStore = require('./orchestrator/pipeline-store');
const TVLayerManager = require('./orchestrator/tv-layer-manager');
const OrchestratorSocket = require('./orchestrator/websocket');
const Orchestrator = require('./orchestrator');
const BackgroundMusicService = require('./background-music');
const TwitterIngestService = require('./orchestrator/twitter-ingest');

// Lip sync mode: 'realtime' (new) or 'rhubarb' (legacy)
const LIPSYNC_MODE = process.env.LIPSYNC_MODE || 'realtime';

// Stream mode: 'synced' (audio muxed into video) or 'separate' (audio played separately)
const STREAM_MODE = process.env.STREAM_MODE || 'synced';
const EXPRESSION_MODEL = process.env.EXPRESSION_MODEL || process.env.MODEL || 'gpt-4o-mini';
const USE_LLM_EXPRESSIONS = process.env.EXPRESSION_LLM === '1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const app = express();
const port = process.env.ANIMATION_PORT || 3003;
const host = process.env.ANIMATION_HOST || '0.0.0.0';

const ROOT_DIR = path.resolve(__dirname, '..');
const STREAMS_DIR = path.join(ROOT_DIR, 'streams');
const TEMP_DIR = path.join(__dirname, 'temp');
const AUDIO_DIR = path.join(STREAMS_DIR, 'audio');
const TV_CONTENT_DIR = path.join(__dirname, 'tv-content', 'content');
const ORCHESTRATOR_CONFIG_PATH = path.join(ROOT_DIR, 'data', 'orchestrator-config.json');
const LOGS_DIR = path.join(ROOT_DIR, 'logs');
const LOGS_AUDIO_DIR = path.join(LOGS_DIR, 'audio');

// Ensure directories exist
fs.mkdirSync(STREAMS_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(LOGS_AUDIO_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });
fs.mkdirSync(TV_CONTENT_DIR, { recursive: true });

app.use(cors());
app.use(express.json());

const DEFAULT_ORCHESTRATOR_CONFIG = {
  buffer: { warningThresholdSeconds: 15, criticalThresholdSeconds: 5 },
  filler: { enabled: false, maxConsecutive: 3, style: 'callback' },
  chatIntake: { enabled: true, ratePerMinute: 1, autoApprove: false },
  rendering: { maxConcurrentForming: 3, ttsModel: 'eleven_v3', retryAttempts: 3 },
  scriptGeneration: { model: 'gpt-4o', defaultExchanges: 8, maxExchanges: 30, wordsPerMinute: 150 }
};

function broadcastPipelineUpdate() {
  if (!orchestratorSocket || !pipelineStore) return;
  orchestratorSocket.broadcast('pipeline:update', {
    segments: pipelineStore.getAllSegments(),
    bufferHealth: pipelineStore.getBufferHealth()
  });
}

function loadOrchestratorConfig() {
  try {
    const raw = fs.readFileSync(ORCHESTRATOR_CONFIG_PATH, 'utf8');
    return { ...DEFAULT_ORCHESTRATOR_CONFIG, ...JSON.parse(raw) };
  } catch (err) {
    return { ...DEFAULT_ORCHESTRATOR_CONFIG };
  }
}

async function saveOrchestratorConfig(config) {
  const payload = JSON.stringify(config, null, 2);
  const tmpPath = `${ORCHESTRATOR_CONFIG_PATH}.tmp`;
  await fs.promises.writeFile(tmpPath, payload, 'utf8');
  await fs.promises.rename(tmpPath, ORCHESTRATOR_CONFIG_PATH);
}

// Configure multer
const upload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ── Background Music Routes ──────────────────────────────────────────────────

app.get('/music', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'frontend', 'music-control.html'));
});

app.get('/music/status', (req, res) => {
  if (!backgroundMusic) return res.json({ enabled: false, url: null, volume: 0.20, connected: false, bufferedSeconds: 0 });
  res.json(backgroundMusic.getStatus());
});

app.post('/music/start', (req, res) => {
  if (!backgroundMusic) return res.status(503).json({ error: 'Music service not ready' });
  const { url, volume } = req.body || {};
  if (!url && !backgroundMusic.url) return res.status(400).json({ error: 'url required' });
  backgroundMusic.start(url || undefined, volume !== undefined ? volume : undefined);
  res.json(backgroundMusic.getStatus());
});

app.post('/music/stop', (req, res) => {
  if (!backgroundMusic) return res.status(503).json({ error: 'Music service not ready' });
  backgroundMusic.stop();
  res.json(backgroundMusic.getStatus());
});

app.post('/music/volume', (req, res) => {
  if (!backgroundMusic) return res.status(503).json({ error: 'Music service not ready' });
  const volume = req.body?.volume;
  if (volume === undefined) return res.status(400).json({ error: 'volume required' });
  backgroundMusic.setVolume(volume);
  res.json(backgroundMusic.getStatus());
});

// ─────────────────────────────────────────────────────────────────────────────

// ============== Expression Control API ==============

app.get('/expression', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'frontend', 'expression-control.html'));
});

app.get('/expression/status', (req, res) => {
  res.json({
    offsets: getExpressionOffsets(),
    range: { min: -20, max: 20 }
  });
});

app.post('/expression/offset', (req, res) => {
  const { character, feature, x, y } = req.body;
  if (!character || !feature || typeof x !== 'number' || typeof y !== 'number') {
    return res.status(400).json({ error: 'Required: character, feature, x, y' });
  }
  setExpressionOffset(character, feature, x, y);
  res.json({ success: true, offsets: getExpressionOffsets() });
});

app.post('/expression/reset', (req, res) => {
  const { character } = req.body || {};
  resetExpressionOffsets(character);
  res.json({ success: true, offsets: getExpressionOffsets() });
});

// Expression limits (calibration)
app.get('/expression/limits', (req, res) => {
  const limits = getExpressionLimits();
  res.json({ limits, locked: limits !== null });
});

app.post('/expression/limits/save', (req, res) => {
  const existing = getExpressionLimits();
  if (existing) {
    return res.status(409).json({ error: 'Limits already locked. Delete expression-limits.json to recalibrate.' });
  }
  const limits = req.body;
  if (!limits || !limits.chad || !limits.virgin) {
    return res.status(400).json({ error: 'Invalid limits structure' });
  }
  try {
    saveExpressionLimits(limits);
    res.json({ success: true, limits: getExpressionLimits() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/expression/rotation-limits', (req, res) => {
  const { character, rotUp, rotDown } = req.body || {};
  if (!character || typeof rotUp !== 'number' || typeof rotDown !== 'number') {
    return res.status(400).json({ error: 'Required: character, rotUp, rotDown' });
  }
  setEyebrowRotationLimits(character, rotUp, rotDown);
  res.json({ success: true, limits: getExpressionLimits() });
});

app.post('/expression/eyebrow-asym', (req, res) => {
  const { character, leftY, rightY } = req.body || {};
  if (!character || typeof leftY !== 'number' || typeof rightY !== 'number') {
    return res.status(400).json({ error: 'Required: character, leftY, rightY' });
  }
  setEyebrowAsymmetry(character, leftY, rightY);
  console.log(`[Expression] ${character} brow asym L:${leftY} R:${rightY}`);
  res.json({ success: true, offsets: getExpressionOffsets() });
});

app.get('/expression/auto', (req, res) => {
  res.json({ enabled: autoExpressions });
});

app.post('/expression/auto', (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  autoExpressions = enabled;
  if (!enabled) {
    expressionEvaluator.clear();
    resetExpressionOffsets();
    lastExprState.chad = { eyeX: 0, eyeY: 0, browY: 0, browAsymL: 0, browAsymR: 0, mouth: null };
    lastExprState.virgin = { eyeX: 0, eyeY: 0, browY: 0, browAsymL: 0, browAsymR: 0, mouth: null };
  }
  console.log(`[Expression] Auto expressions: ${enabled}`);
  res.json({ enabled: autoExpressions });
});

// ============== End Expression Control API ==============

// Global state
const animationState = new AnimationState();  // Legacy: used in rhubarb mode
const STREAM_FPS = 30;
const LIPSYNC_FPS = 30; // Keep lipsync time base stable regardless of stream FPS
const syncedPlayback = new SyncedPlayback(16000, LIPSYNC_FPS);
const blinkControllers = {
  chad: new BlinkController(STREAM_FPS),
  virgin: new BlinkController(STREAM_FPS)
};
let streamManager = null;  // Will be either StreamManager or ContinuousStreamManager
let backgroundMusic = null;
let frameCount = 0;
let tvService = null;  // TV content service (initialized after preloadLayers)
let mediaLibrary = null;
let pipelineStore = null;
let tvLayerManager = null;
let scriptGenerator = null;
let bridgeGenerator = null;
let fillerGenerator = null;
let segmentRenderer = null;
let playbackController = null;
let chatIntake = null;
let orchestrator = null;
let orchestratorSocket = null;
let twitterIngest = null;
let lipSyncAccumulatorMs = 0;
let lastLipSyncTime = Date.now();
let lastLipSyncResult = { phoneme: 'A', character: null, done: true };
const expressionEvaluator = new ExpressionEvaluator();
let autoExpressions = true; // Toggle for automatic expression system
// Last applied expression state per character — skip compositor calls when unchanged
let lastExprState = {
  chad: { eyeX: 0, eyeY: 0, browY: 0, browAsymL: 0, browAsymR: 0, mouth: null },
  virgin: { eyeX: 0, eyeY: 0, browY: 0, browAsymL: 0, browAsymR: 0, mouth: null }
};

// Track current speaking state for synced mode
let playbackStartFrame = 0;
let currentSpeaker = null;
let currentCaption = null;
let captionUntil = 0;
let captionTimeout = null;
let isAudioActive = false;
let currentPlayingSegmentId = null;  // Track which pipeline segment is currently playing
const renderQueue = [];
let lastFrameBuffer = null;
let skipCompositingFrames = 0;
const FRAME_BUDGET_MS = 33;

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
  const completedSegId = currentPlayingSegmentId;
  currentSpeaker = null;
  currentCaption = null;
  captionUntil = 0;
  currentPlayingSegmentId = null;
  if (captionTimeout) {
    clearTimeout(captionTimeout);
    captionTimeout = null;
  }
  isAudioActive = false;
  lipSyncAccumulatorMs = 0;
  lastLipSyncResult = { phoneme: 'A', character: null, done: true };
  skipCompositingFrames = 0;
  expressionEvaluator.clear();
  resetExpressionOffsets();
  lastExprState.chad = { eyeX: 0, eyeY: 0, browY: 0, browAsymL: 0, browAsymR: 0, mouth: null };
  lastExprState.virgin = { eyeX: 0, eyeY: 0, browY: 0, browAsymL: 0, browAsymR: 0, mouth: null };
  processQueue();

  // After processQueue: currentPlayingSegmentId is set to the next item's segment (sync),
  // or stays null if the queue was empty. If it changed, the previous segment is done.
  if (completedSegId && completedSegId !== currentPlayingSegmentId) {
    if (playbackController) {
      playbackController.segmentDone(completedSegId).catch(err => {
        console.warn('[Server] segmentDone error:', err.message);
      });
    }
  }
}


async function buildExpressionPlanLLM({ message, character, listener, durationSec, limits }) {
  if (!openai) {
    console.warn('[Expr] OPENAI_API_KEY not set, using heuristic expression plan');
    return null;
  }

  const prompt = `You are generating a timed expression plan for an animated character.
Output ONLY valid JSON with this schema:
{
  "character": "chad|virgin",      // speaker
  "listener": "chad|virgin",
  "totalMs": number,
  "actions": [
    {
      "t": number,                // milliseconds from start
      "type": "eye"|"brow"|"mouth",
      "target": "chad|virgin",     // optional, defaults to speaker
      // for type="eye":
      "look": "listener"|"away"|"down"|"up"|"neutral",
      "amount": 0.3-0.5,
      "durationMs": number,
      // for type="brow":
      "emote": "raise"|"frown"|"skeptical",
      "amount": 0.3-0.5,
      // for type="mouth":
      "shape": "SMILE"
    }
  ]
}

Rules:
- Eyes are active but purposeful. Speaker looks at listener, glances away while thinking, returns.
- Aim for 2-4 eye movements per sentence (look → glance away → look back pattern).
- Brow expressions for emotional beats (questions, emphasis, reactions) - one per sentence max.
- Listener has occasional eye movements and reactions (every 2-3 sentences).
- totalMs should match the audio duration (in ms). Keep actions within 0..totalMs.
- Aim for 15-25 total actions for typical speeches.
- Do NOT add extra keys. Do NOT use flick emote.`;

  const content = `Character: ${character}\nListener: ${listener}\nDurationSec: ${durationSec}\nMessage: ${message}\n` +
    `Notes: Virgin is on right, Chad on left. When speaking to the other, look toward them.`;

  try {
    const completion = await openai.chat.completions.create({
      model: EXPRESSION_MODEL,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content }
      ],
      temperature: 0.35,
      max_tokens: 450
    });

    const raw = completion.choices[0].message.content.trim();
    const clean = raw.replace(/```json|```/gi, '').trim();
    const parsed = JSON.parse(clean);
    const safe = normalizeExpressionPlan(parsed, { message, character, listener, durationSec, limits });
    return safe;
  } catch (err) {
    console.warn('[Expr] LLM plan failed, using heuristic:', err.message);
    return null;
  }
}

function normalizeExpressionPlan(plan, context) {
  if (!plan || typeof plan !== 'object') return null;
  const totalMs = Number.isFinite(Number(plan.totalMs))
    ? Number(plan.totalMs)
    : Math.max(200, (context.durationSec || 1) * 1000);

  const actions = Array.isArray(plan.actions) ? plan.actions : [];
  const allowedLooks = new Set(['listener', 'away', 'down', 'up', 'neutral', 'left', 'right', 'up_left', 'up_right', 'down_left', 'down_right']);
  const allowedEmotes = new Set([
    'raise',
    'frown',
    'skeptical',
    'skeptical_left',
    'skeptical_right',
    'asym_up_left',
    'asym_up_right',
    'asym_down_left',
    'asym_down_right',
    'flick'
  ]);
  const allowedMouth = new Set(['SMILE', 'SURPRISE']);
  const allowedTargets = new Set(['chad', 'virgin']);

  const cleaned = actions.map(a => {
    const t = Math.max(0, Math.min(totalMs, Number(a.t) || 0));
    const target = allowedTargets.has(a.target) ? a.target : undefined;
    if (a.type === 'eye') {
      const look = allowedLooks.has(a.look) ? a.look : 'neutral';
      const amount = Math.max(0, Math.min(1, Number(a.amount) || 0.4));
      const durationMs = Math.max(80, Number(a.durationMs) || 200);
      return { t, type: 'eye', target, look, amount, durationMs };
    }
    if (a.type === 'brow') {
      const emote = allowedEmotes.has(a.emote) ? a.emote : 'raise';
      const amount = Math.max(0, Math.min(1, Number(a.amount) || 0.4));
      const durationMs = Math.max(80, Number(a.durationMs) || 220);
      const count = Math.max(1, Math.round(Number(a.count) || 2));
      const entry = { t, type: 'brow', target, emote, amount, durationMs };
      if (emote === 'flick') entry.count = count;
      return entry;
    }
    if (a.type === 'mouth') {
      const shape = typeof a.shape === 'string' ? a.shape.toUpperCase() : 'SMILE';
      const durationMs = Math.max(200, Number(a.durationMs) || 500);
      return { t, type: 'mouth', target, shape: allowedMouth.has(shape) ? shape : 'SMILE', durationMs };
    }
    return null;
  }).filter(Boolean);

  return {
    character: plan.character || context.character,
    listener: plan.listener || context.listener,
    totalMs,
    actions: cleaned
  };
}

function tickLipSyncByTime() {
  const now = Date.now();
  const dt = Math.max(0, now - lastLipSyncTime);
  lastLipSyncTime = now;
  lipSyncAccumulatorMs += dt;

  const frameMs = 1000 / LIPSYNC_FPS;
  let result = null;
  while (lipSyncAccumulatorMs >= frameMs) {
    result = syncedPlayback.tick();
    lipSyncAccumulatorMs -= frameMs;
  }

  if (result) {
    lastLipSyncResult = result;
  }
  return lastLipSyncResult;
}

async function startPlayback(item) {
  isAudioActive = true;
  currentSpeaker = item.character;
  currentPlayingSegmentId = item.segmentId || null;
  playbackStartFrame = frameCount;
  expressionEvaluator.clear();

  // Notify playback controller when a new segment starts playing
  if (currentPlayingSegmentId && playbackController) {
    playbackController.setOnAir(currentPlayingSegmentId);
  }

  if (LIPSYNC_MODE === 'realtime') {
    syncedPlayback.loadSamples(item.samples, item.duration, item.character);
    if (STREAM_MODE === 'synced') {
      streamManager.loadAudio(item.samples, item.sampleRate, item.character, item.duration);
    } else {
      lipSyncAccumulatorMs = 0;
      lastLipSyncTime = Date.now();
      lastLipSyncResult = { phoneme: 'A', character: null, done: true };
      syncedPlayback.start();
    }
  } else {
    animationState.startSpeaking(item.character, item.lipSyncCues, item.audioMp3Path, item.duration);
    setTimeout(handleAudioComplete, Math.max(0, item.duration) * 1000);
  }

  // Captions disabled — chat overlay shows viewer messages instead
  // if (item.messageText) {
  //   setCaption(item.messageText, item.duration);
  // }

  // Build expression plan and load into frame-driven evaluator
  if (item.messageText && autoExpressions) {
    const listener = item.character === 'virgin' ? 'chad' : 'virgin';
    const limits = getExpressionLimits();

    // Start with heuristic plan immediately
    let plan = buildExpressionPlan({
      message: item.messageText,
      character: item.character,
      listener,
      durationSec: item.duration,
      limits
    });
    plan = augmentExpressionPlan(plan, {
      message: item.messageText,
      character: item.character,
      listener,
      durationSec: item.duration
    });
    plan = normalizePlanTiming(plan, item.duration);
    console.log(`[Expr] Heuristic plan for ${item.character}:`, JSON.stringify(plan));
    expressionEvaluator.loadPlan(plan, limits);

    if (USE_LLM_EXPRESSIONS) {
      // Fire-and-forget LLM plan: swap in when ready
      buildExpressionPlanLLM({
        message: item.messageText,
        character: item.character,
        listener,
        durationSec: item.duration,
        limits
      }).then(llmPlan => {
        if (llmPlan && isAudioActive && currentSpeaker === item.character) {
          llmPlan = augmentExpressionPlan(llmPlan, {
            message: item.messageText,
            character: item.character,
            listener,
            durationSec: item.duration
          });
          llmPlan = normalizePlanTiming(llmPlan, item.duration);
          console.log(`[Expr] LLM plan swapped in for ${item.character}:`, JSON.stringify(llmPlan));
          expressionEvaluator.loadPlan(llmPlan, limits);
        }
      }).catch(err => {
        console.warn('[Expr] LLM plan async error:', err.message);
      });
    }
  }

  scheduleAudioCleanup(item.audioMp3Path, item.duration);
}

function processQueue() {
  if (isAudioActive || renderQueue.length === 0) {
    return;
  }
  if (playbackController && playbackController.isPaused) {
    console.log('[Queue] Paused — not dequeuing next segment');
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
    const lipFrame = Math.floor(audioProgress.frame * LIPSYNC_FPS / STREAM_FPS);
    currentPhoneme = syncedPlayback.getPhonemeAtFrame(lipFrame);
  } else if (LIPSYNC_MODE === 'realtime') {
    // SEPARATE MODE with real-time: tick advances through audio buffer
    const result = tickLipSyncByTime();
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

  // Inform compositor which character is speaking (for L2 pre-warming)
  setSpeakingCharacter(speakingCharacter);

  // Chad gets the phoneme if he's speaking, otherwise neutral
  let chadPhoneme = speakingCharacter === 'chad' ? currentPhoneme : 'A';
  // Virgin gets the phoneme if she's speaking, otherwise neutral
  let virginPhoneme = speakingCharacter === 'virgin' ? currentPhoneme : 'A';

  // Frame-driven expression evaluation
  if (autoExpressions && expressionEvaluator.loaded && isAudioActive) {
    // In synced mode, use audio frame position; otherwise fall back to elapsed video frames
    const currentTimeMs = (audioProgress && audioProgress.playing)
      ? (audioProgress.frame / STREAM_FPS) * 1000
      : ((frame - playbackStartFrame) / STREAM_FPS) * 1000;
    const exprState = expressionEvaluator.evaluateAtMs(currentTimeMs);
    const shouldApplyExpr = (frame % 3) === 0; // throttle expression updates to reduce cache churn

    for (const c of ['chad', 'virgin']) {
      if (!exprState[c]) continue;
      const s = exprState[c];
      const prev = lastExprState[c];

      // Quantize expression values to reduce cache key space explosion.
      // Rounding to multiples of 3 pixels reduces unique cache entries by ~9x
      // while maintaining visually smooth animation (with fewer expression changes).
      const QUANT = 4;
      const BROW_QUANT = 2;
      const browMin = 2;
      s.eyeX = Math.round(s.eyeX / QUANT) * QUANT;
      s.eyeY = Math.round(s.eyeY / QUANT) * QUANT;

      const rawBrowY = s.browY;
      const rawBrowAsymL = s.browAsymL;
      const rawBrowAsymR = s.browAsymR;

      s.browY = Math.round(s.browY / BROW_QUANT) * BROW_QUANT;
      s.browAsymL = Math.round(s.browAsymL / BROW_QUANT) * BROW_QUANT;
      s.browAsymR = Math.round(s.browAsymR / BROW_QUANT) * BROW_QUANT;

      if (rawBrowY !== 0 && s.browY === 0) s.browY = Math.sign(rawBrowY) * browMin;
      if (rawBrowAsymL !== 0 && s.browAsymL === 0) s.browAsymL = Math.sign(rawBrowAsymL) * browMin;
      if (rawBrowAsymR !== 0 && s.browAsymR === 0) s.browAsymR = Math.sign(rawBrowAsymR) * browMin;

      // Only call compositor setters when values actually changed —
      // each call wipes the frame cache, forcing expensive re-compositing
      if (shouldApplyExpr) {
        const eyeXChanged = Math.abs(s.eyeX - prev.eyeX) >= 2;
        const eyeYChanged = Math.abs(s.eyeY - prev.eyeY) >= 2;
        if (eyeXChanged || eyeYChanged) {
          setExpressionOffset(c, 'eyes', s.eyeX, s.eyeY);
          prev.eyeX = s.eyeX;
          prev.eyeY = s.eyeY;
        }

        const browYChanged = s.browY !== prev.browY;
        const asymChanged = s.browAsymL !== prev.browAsymL || s.browAsymR !== prev.browAsymR;

        // Apply base brow movement first so asymmetry is layered on top of latest Y.
        if (browYChanged) {
          setExpressionOffset(c, 'eyebrows', 0, s.browY);
          prev.browY = s.browY;
        }

        // Always apply asymmetry changes, including returning to neutral (0,0).
        if (asymChanged) {
          setEyebrowAsymmetry(c, s.browAsymL, s.browAsymR);
          prev.browAsymL = s.browAsymL;
          prev.browAsymR = s.browAsymR;
        }
      }

      // Apply mouth override for non-speaking character
      if (speakingCharacter !== c && s.mouth) {
        if (c === 'chad') chadPhoneme = s.mouth;
        else virginPhoneme = s.mouth;
      }
    }
  }

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

  if (skipCompositingFrames > 0 && lastFrameBuffer) {
    skipCompositingFrames -= 1;
    return lastFrameBuffer;
  }

  try {
    // Composite frame with both characters' state
    const start = Date.now();
    const buffer = await compositeFrame({
      chadPhoneme,
      virginPhoneme,
      chadBlinking,
      virginBlinking,
      caption,
      tvFrameIndex: tvService ? tvService.frameIndex : -1
    });
    const elapsed = Date.now() - start;
    if (elapsed > FRAME_BUDGET_MS) {
      // Proportional skip: longer overruns skip more frames (max 3)
      const skipCount = Math.min(3, Math.ceil(elapsed / FRAME_BUDGET_MS) - 1);
      skipCompositingFrames = Math.max(skipCompositingFrames, skipCount);
      if (elapsed > FRAME_BUDGET_MS * 1.5) {
        console.warn(`[Render] Frame over budget: ${elapsed}ms (skipping ${skipCount})`);
      }
    }
    lastFrameBuffer = buffer;
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
  const segmentId = req.body.segmentId || null;  // Track which pipeline segment this audio belongs to
  const lineIndexRaw = req.body.lineIndex;
  const lineIndexNum = lineIndexRaw !== undefined && lineIndexRaw !== '' ? parseInt(String(lineIndexRaw), 10) : NaN;
  const lineIndex = Number.isInteger(lineIndexNum) && lineIndexNum >= 0 ? lineIndexNum : undefined;
  const segmentType = req.body.segmentType || null;
  const priorityRaw = String(req.body.priority || '').toLowerCase();
  const isPriority = priorityRaw === 'high' || priorityRaw === 'true' || priorityRaw === '1';
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

    // Persist a copy to logs/audio (git-ignored) for replay: segmentId_lineIndex.mp3
    const logFileName = segmentId && lineIndex !== undefined
      ? `${segmentId}_${lineIndex}.mp3`
      : segmentId
        ? `${segmentId}_${audioId}.mp3`
        : `unknown_${audioId}.mp3`;
    const logAudioPath = path.join(LOGS_AUDIO_DIR, logFileName);
    fs.promises.copyFile(audioMp3Path, logAudioPath).catch(err => {
      console.warn('[Render] logs/audio copy failed:', err.message);
    });

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
        sampleRate,
        segmentId,  // Track which pipeline segment this belongs to
        segmentType,
        priority: isPriority
      };

      const queued = shouldQueue && (isAudioActive || renderQueue.length > 0);
      if (queued) {
        enqueueRenderItem(queueItem);
        response.queued = true;
        response.queuePosition = renderQueue.length;
      } else {
        await startPlayback(queueItem);
        response.queued = false;
      }

      const totalTime = Date.now() - renderStart;
      console.log(`[Render] ${character} seg:${segmentId || 'none'} | move:${moveTime}ms decode:${decodeTime}ms total:${totalTime}ms | ${audioDuration.toFixed(1)}s audio`);

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
        lipSyncCues,
        segmentId,  // Track which pipeline segment this belongs to
        segmentType,
        priority: isPriority
      };

      const queued = shouldQueue && (isAudioActive || renderQueue.length > 0);
      if (queued) {
        enqueueRenderItem(queueItem);
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
    state: {
      ...state,
      isPlaying: state.isPlaying || isAudioActive,
      queueLength: renderQueue.length,
      currentSegmentId: currentPlayingSegmentId  // Which pipeline segment is currently playing
    },
    frameCount,
    lipsyncMode: LIPSYNC_MODE
  });
});

// Serve TV control panel
app.get('/tv', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'tv-control.html'));
});

// Serve Director control panel
app.get('/director', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'director.html'));
});

// Serve Prompt Editor
app.get('/prompt-editor', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'prompt-editor.html'));
});

// Voice prompt API (mirrors chat server endpoints for same-process mutation)
const voices = require('../voices');

app.get('/api/voices/:id/prompt', (req, res) => {
  const voice = voices[req.params.id];
  if (!voice) return res.status(404).json({ error: 'Voice not found' });
  res.json({ basePrompt: voice.basePrompt, audioTags: voice.audioTags });
});

app.post('/api/voices/:id/prompt', (req, res) => {
  const voice = voices[req.params.id];
  if (!voice) return res.status(404).json({ error: 'Voice not found' });
  const { basePrompt, audioTags } = req.body;
  if (typeof basePrompt === 'string') voice.basePrompt = basePrompt;
  if (typeof audioTags === 'string') voice.audioTags = audioTags;
  console.log(`[Voices] Updated prompt for ${req.params.id} (animation server)`);
  res.json({ ok: true });
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

// Configure multer for TV content uploads (temp dir; files are moved to media library)
const tvUpload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: 100 * 1024 * 1024 }  // 100MB limit for videos
});

// Configure multer for media library uploads
const MEDIA_ORIGINALS_DIR = path.join(ROOT_DIR, 'media-library', 'originals');
fs.mkdirSync(MEDIA_ORIGINALS_DIR, { recursive: true });
const mediaUpload = multer({
  dest: MEDIA_ORIGINALS_DIR,
  limits: { fileSize: 200 * 1024 * 1024 }  // 200MB limit
});

// Add item to TV playlist
app.post('/tv/playlist/add', async (req, res) => {
  if (!tvService) {
    return res.status(503).json({ error: 'TV service not initialized' });
  }

  const { type, source, duration, mediaId } = req.body;

  // mediaId path: resolve from media library
  if (mediaId) {
    if (!mediaLibrary) return res.status(503).json({ error: 'Media library not initialized' });
    const mediaItem = mediaLibrary.get(mediaId);
    if (!mediaItem) return res.status(404).json({ error: 'Media item not found' });
    const resolvedSource = mediaLibrary.getOriginalPath(mediaId);
    try {
      const item = await tvService.addItem({ type: mediaItem.type, source: resolvedSource, duration, mediaId });
      return res.json({ success: true, item });
    } catch (err) {
      console.error('[TV] Add item error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Path/URL path
  if (!type || !source) {
    return res.status(400).json({ error: 'Missing required fields: type, source (or mediaId)' });
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

// Upload and add file to TV playlist (routes through media library for persistence)
app.post('/tv/upload', tvUpload.single('file'), async (req, res) => {
  if (!tvService) {
    return res.status(503).json({ error: 'TV service not initialized' });
  }
  if (!mediaLibrary) {
    return res.status(503).json({ error: 'Media library not initialized' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided' });
  }

  const type = req.body.type || (req.file.mimetype.startsWith('video/') ? 'video' : 'image');
  const duration = req.body.duration ? parseFloat(req.body.duration) : undefined;

  // Add file to media library (copies from temp, generates thumbnail)
  let mediaItem;
  try {
    mediaItem = await mediaLibrary.addFile(req.file.path, req.file.originalname, req.file.mimetype);
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    return res.status(500).json({ error: err.message });
  }
  try { fs.unlinkSync(req.file.path); } catch (e) {}

  const source = mediaLibrary.getOriginalPath(mediaItem.id);
  let audioPath = null;

  // Extract audio for videos (stored in TV_CONTENT_DIR for /tv/audio serving)
  if (type === 'video') {
    const audioFilePath = path.join(TV_CONTENT_DIR, `${mediaItem.id}.mp3`);
    audioPath = await extractAudioFromVideo(source, audioFilePath);
    if (audioPath) {
      console.log(`[TV] Extracted audio: ${audioPath}`);
    }
  }

  try {
    const item = await tvService.addItem({ type, source, duration, audioPath, mediaId: mediaItem.id });
    res.json({ success: true, item, mediaId: mediaItem.id });
  } catch (err) {
    console.error('[TV] Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Fire-and-forget agent API: clear playlist, add one item, play
app.post('/tv/play', async (req, res) => {
  if (!tvService) return res.status(503).json({ error: 'TV service not initialized' });
  if (!mediaLibrary) return res.status(503).json({ error: 'Media library not initialized' });

  const { mediaId } = req.body;
  if (!mediaId) return res.status(400).json({ error: 'Missing mediaId' });

  const mediaItem = mediaLibrary.get(mediaId);
  if (!mediaItem) return res.status(404).json({ error: 'Media item not found' });

  const source = mediaLibrary.getOriginalPath(mediaId);
  tvService.clear();

  try {
    const item = await tvService.addItem({ type: mediaItem.type, source, mediaId });
    tvService.play();
    res.json({ success: true, item });
  } catch (err) {
    console.error('[TV] Play error:', err);
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

// ============== Media Library API ==============

app.get('/api/media', (req, res) => {
  if (!mediaLibrary) return res.status(503).json({ error: 'Media library not initialized' });
  const { type, limit, offset } = req.query;
  const result = mediaLibrary.list({ type, limit, offset });
  res.json(result);
});

app.post('/api/media/upload', mediaUpload.single('file'), async (req, res) => {
  if (!mediaLibrary) return res.status(503).json({ error: 'Media library not initialized' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  try {
    const item = await mediaLibrary.addFile(
      req.file.path,
      req.file.originalname,
      req.file.mimetype
    );
    // Clean up multer temp file (addFile copies it)
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    res.json(item);
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/media/url', async (req, res) => {
  if (!mediaLibrary) return res.status(503).json({ error: 'Media library not initialized' });
  const { url, filename } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing url' });

  try {
    const item = await mediaLibrary.addFromUrl(url, filename);
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/media/:id', (req, res) => {
  if (!mediaLibrary) return res.status(503).json({ error: 'Media library not initialized' });
  const item = mediaLibrary.get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json(item);
});

app.delete('/api/media/:id', async (req, res) => {
  if (!mediaLibrary) return res.status(503).json({ error: 'Media library not initialized' });
  try {
    const removed = await mediaLibrary.remove(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/media/:id/original', (req, res) => {
  if (!mediaLibrary) return res.status(503).json({ error: 'Media library not initialized' });
  const filePath = mediaLibrary.getOriginalPath(req.params.id);
  if (!filePath) return res.status(404).json({ error: 'Not found' });
  res.sendFile(filePath);
});

app.get('/api/media/:id/thumbnail', (req, res) => {
  if (!mediaLibrary) return res.status(503).json({ error: 'Media library not initialized' });
  const filePath = mediaLibrary.getThumbnailPath(req.params.id);
  if (!filePath) return res.status(404).json({ error: 'Not found' });
  res.sendFile(filePath);
});

// ============== End Media Library API ==============

// ============== Pipeline API ==============

app.get('/api/pipeline', (req, res) => {
  if (!pipelineStore) return res.status(503).json({ error: 'Pipeline store not initialized' });
  res.json({
    segments: pipelineStore.getAllSegments(),
    bufferHealth: pipelineStore.getBufferHealth()
  });
});

app.get('/api/pipeline/:id', (req, res) => {
  if (!pipelineStore) return res.status(503).json({ error: 'Pipeline store not initialized' });
  const segment = pipelineStore.getSegment(req.params.id);
  if (!segment) return res.status(404).json({ error: 'Segment not found' });
  res.json(segment);
});

app.post('/api/pipeline', async (req, res) => {
  if (!pipelineStore) return res.status(503).json({ error: 'Pipeline store not initialized' });
  try {
    const segment = await pipelineStore.createSegment(req.body || {});
    broadcastPipelineUpdate();
    res.json(segment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/pipeline/:id', async (req, res) => {
  if (!pipelineStore) return res.status(503).json({ error: 'Pipeline store not initialized' });
  try {
    const segment = await pipelineStore.updateSegment(req.params.id, req.body || {});
    broadcastPipelineUpdate();
    res.json(segment);
  } catch (err) {
    if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pipeline/:id/status', async (req, res) => {
  if (!pipelineStore) return res.status(503).json({ error: 'Pipeline store not initialized' });
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ error: 'Missing status' });

  try {
    const segment = await pipelineStore.transitionStatus(req.params.id, status);
    broadcastPipelineUpdate();
    res.json(segment);
  } catch (err) {
    if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
    if (err.message.includes('Invalid transition')) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pipeline/reorder', async (req, res) => {
  if (!pipelineStore) return res.status(503).json({ error: 'Pipeline store not initialized' });
  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: 'Missing order array' });

  try {
    const segments = await pipelineStore.reorder(order);
    broadcastPipelineUpdate();
    res.json({ segments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/pipeline/clear-aired', async (req, res) => {
  if (!pipelineStore) return res.status(503).json({ error: 'Pipeline store not initialized' });
  try {
    const aired = pipelineStore.getAllSegments().filter(s => s.status === 'aired');
    for (const seg of aired) {
      await pipelineStore.removeSegment(seg.id);
    }
    broadcastPipelineUpdate();
    res.json({ success: true, removed: aired.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/pipeline/:id', async (req, res) => {
  if (!pipelineStore) return res.status(503).json({ error: 'Pipeline store not initialized' });
  try {
    await pipelineStore.removeSegment(req.params.id);
    broadcastPipelineUpdate();
    res.json({ success: true });
  } catch (err) {
    if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
    if (err.message.includes('Can only remove')) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ============== End Pipeline API ==============

// ============== TV Layer API ==============

app.get('/api/tv-layer', (req, res) => {
  if (!tvLayerManager) return res.status(503).json({ error: 'TV layer manager not initialized' });
  res.json(tvLayerManager.getState());
});

app.post('/api/tv-layer/default', async (req, res) => {
  if (!tvLayerManager) return res.status(503).json({ error: 'TV layer manager not initialized' });
  const { mediaId } = req.body || {};
  if (!mediaId) return res.status(400).json({ error: 'Missing mediaId' });

  try {
    await tvLayerManager.setDefault(mediaId);
    const state = tvLayerManager.getState();
    if (orchestratorSocket) orchestratorSocket.broadcast('tv:state-change', state);
    res.json(state);
  } catch (err) {
    if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tv-layer/override', async (req, res) => {
  if (!tvLayerManager) return res.status(503).json({ error: 'TV layer manager not initialized' });
  const { mediaId } = req.body || {};
  if (!mediaId) return res.status(400).json({ error: 'Missing mediaId' });

  try {
    await tvLayerManager.pushOverride(mediaId);
    const state = tvLayerManager.getState();
    if (orchestratorSocket) orchestratorSocket.broadcast('tv:state-change', state);
    res.json(state);
  } catch (err) {
    if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tv-layer/manual', async (req, res) => {
  if (!tvLayerManager) return res.status(503).json({ error: 'TV layer manager not initialized' });
  const { mediaId } = req.body || {};
  if (!mediaId) return res.status(400).json({ error: 'Missing mediaId' });

  try {
    await tvLayerManager.pushManualOverride(mediaId);
    const state = tvLayerManager.getState();
    if (orchestratorSocket) orchestratorSocket.broadcast('tv:state-change', state);
    res.json(state);
  } catch (err) {
    if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tv-layer/release', async (req, res) => {
  if (!tvLayerManager) return res.status(503).json({ error: 'TV layer manager not initialized' });
  try {
    await tvLayerManager.releaseOverride();
    const state = tvLayerManager.getState();
    if (orchestratorSocket) orchestratorSocket.broadcast('tv:state-change', state);
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tv-layer/clear-manual', async (req, res) => {
  if (!tvLayerManager) return res.status(503).json({ error: 'TV layer manager not initialized' });
  try {
    await tvLayerManager.clearManualOverride();
    const state = tvLayerManager.getState();
    if (orchestratorSocket) orchestratorSocket.broadcast('tv:state-change', state);
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============== End TV Layer API ==============

// ============== Orchestrator Script API ==============
app.post('/api/orchestrator/seed', async (req, res) => {
  if (!scriptGenerator || !playbackController || !segmentRenderer) return res.status(503).json({ error: 'Orchestrator not initialized' });
  const { topic, attachedMediaId } = req.body || {};
  if (!topic) return res.status(400).json({ error: 'Missing topic' });
  try {
    const segment = await scriptGenerator.expandDirectorNote(topic);
    if (attachedMediaId) {
      await pipelineStore.updateSegment(segment.id, {
        metadata: { ...(segment.metadata || {}), attachedMediaId }
      });
    }
    if (orchestratorSocket) orchestratorSocket.broadcast('segment:draft-ready', segment);
    broadcastPipelineUpdate();
    segmentRenderer.queueRender(segment.id);
    await playbackController.start();
    processQueue();
    res.json({ segment: pipelineStore.getSegment(segment.id), playing: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orchestrator/expand', async (req, res) => {
  if (!scriptGenerator) return res.status(503).json({ error: 'Script generator not initialized' });
  const { seed } = req.body || {};
  if (!seed) return res.status(400).json({ error: 'Missing seed' });
  try {
    const segment = await scriptGenerator.expandDirectorNote(seed);
    if (orchestratorSocket) orchestratorSocket.broadcast('segment:draft-ready', segment);
    broadcastPipelineUpdate();
    res.json(segment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orchestrator/expand-chat', async (req, res) => {
  if (!scriptGenerator) return res.status(503).json({ error: 'Script generator not initialized' });
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Missing message' });
  try {
    const segment = await scriptGenerator.expandChatMessage(message);
    // Prepend narrator line to read the viewer's message
    if (segment && Array.isArray(segment.script)) {
      segment.script.unshift({ speaker: 'narrator', text: message.substring(0, 120) });
      await pipelineStore.updateSegment(segment.id, { script: segment.script });
    }
    if (orchestratorSocket) orchestratorSocket.broadcast('segment:draft-ready', segment);
    broadcastPipelineUpdate();
    res.json(segment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a segment from a custom JSON script (no LLM expansion)
app.post('/api/orchestrator/custom-script', async (req, res) => {
  if (!pipelineStore) return res.status(503).json({ error: 'Pipeline not initialized' });

  const {
    seed,
    type = 'custom-script',
    script,
    exitContext = null,
    estimatedDuration = null,
    metadata = {},
    attachedMediaId
  } = req.body || {};

  if (!Array.isArray(script) || script.length === 0) {
    return res.status(400).json({ error: 'Missing script array' });
  }

  const normalized = script.map((line) => ({
    speaker: String(line?.speaker || '').toLowerCase().trim(),
    text: String(line?.text || '').trim()
  })).filter((line) => line.speaker && line.text);

  if (normalized.length === 0) {
    return res.status(400).json({ error: 'Script must contain at least one valid line with speaker and text' });
  }

  try {
    const autoDuration = Math.max(1, Math.ceil(normalized.reduce((sum, line) => {
      const words = line.text.split(/\s+/).filter(Boolean).length;
      return sum + words;
    }, 0) / 150 * 60));

    const segment = await pipelineStore.createSegment({
      type,
      seed: seed || 'custom-script',
      script: normalized,
      estimatedDuration: (estimatedDuration !== null && estimatedDuration !== undefined && Number.isFinite(Number(estimatedDuration)))
        ? Number(estimatedDuration)
        : autoDuration
    });

    await pipelineStore.updateSegment(segment.id, {
      exitContext,
      metadata: {
        ...(segment.metadata || {}),
        ...(metadata || {}),
        source: 'custom-script',
        ...(attachedMediaId ? { attachedMediaId } : {})
      }
    });

    const created = pipelineStore.getSegment(segment.id);
    if (orchestratorSocket) orchestratorSocket.broadcast('segment:draft-ready', created);
    broadcastPipelineUpdate();
    res.json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate and queue a hype segment for the $VVC pump.fun launch
app.post('/api/orchestrator/hype', async (req, res) => {
  if (!scriptGenerator) return res.status(503).json({ error: 'Script generator not initialized' });
  if (!pipelineStore) return res.status(503).json({ error: 'Pipeline not initialized' });

  const { mcap, volume, holders } = req.body || {};

  try {
    const generated = await scriptGenerator.generateHypeScript({ mcap, volume, holders });

    const segment = await pipelineStore.createSegment({
      type: 'hype',
      seed: 'hype',
      script: generated.script,
      estimatedDuration: generated.estimatedDuration
    });

    await pipelineStore.updateSegment(segment.id, {
      exitContext: generated.exitContext,
      metadata: { ...(segment.metadata || {}), source: 'hype' }
    });

    const created = pipelineStore.getSegment(segment.id);
    if (orchestratorSocket) orchestratorSocket.broadcast('segment:draft-ready', created);
    broadcastPipelineUpdate();
    res.json(created);
  } catch (err) {
    console.error('[Orchestrator] hype generation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Attach or detach a media library item from a segment (fires before on-air)
app.patch('/api/orchestrator/segments/:id/media', async (req, res) => {
  if (!pipelineStore) return res.status(503).json({ error: 'Pipeline not initialized' });
  const segment = pipelineStore.getSegment(req.params.id);
  if (!segment) return res.status(404).json({ error: 'Segment not found' });

  const { mediaId } = req.body;
  if (mediaId && mediaLibrary && !mediaLibrary.get(mediaId)) {
    return res.status(404).json({ error: 'Media item not found' });
  }

  const newMeta = { ...(segment.metadata || {}) };
  if (mediaId) {
    newMeta.attachedMediaId = mediaId;
  } else {
    delete newMeta.attachedMediaId;
  }

  await pipelineStore.updateSegment(req.params.id, { metadata: newMeta });
  broadcastPipelineUpdate();
  res.json({ success: true, segmentId: req.params.id, mediaId: mediaId || null });
});

// Queue a pre-written single-line response directly to the pipeline
// Used by /api/chat after router + OpenAI generate the response text
app.post('/api/orchestrator/queue-response', async (req, res) => {
  if (!pipelineStore) return res.status(503).json({ error: 'Pipeline not initialized' });
  if (!segmentRenderer) return res.status(503).json({ error: 'Segment renderer not initialized' });

  const { speaker, text, seed } = req.body || {};
  if (!speaker || !text) {
    return res.status(400).json({ error: 'Missing speaker or text' });
  }

  try {
    // Narrator reads the viewer message, then character responds
    const narratorLine = { speaker: 'narrator', text: (seed || text).substring(0, 120) };
    const script = [narratorLine, { speaker: speaker.toLowerCase(), text }];
    const segment = await pipelineStore.createSegment({
      type: 'chat-response',
      seed: seed || text.substring(0, 50),
      script,
      estimatedDuration: Math.max(1, Math.ceil(text.split(/\s+/).length / 150 * 60) + 3)
    });

    try {
      await pipelineStore.updateSegment(segment.id, {
        metadata: { ...(segment.metadata || {}), priority: 'high', source: 'chat' }
      });
    } catch (_) {}

    if (pipelineStore.prioritizeSegment) {
      try {
        await pipelineStore.prioritizeSegment(segment.id, {
          afterOnAir: true,
          avoidTransitionSplit: true
        });
      } catch (_) {}
    }

    if (segmentRenderer.cancelQueuedSegmentsByType) {
      const cancelled = segmentRenderer.cancelQueuedSegmentsByType('filler', { keep: 1 });
      for (const id of cancelled) {
        try {
          await pipelineStore.removeSegment(id);
        } catch (_) {}
      }
    }

    console.log(`[Orchestrator] Queued response segment ${segment.id} (${speaker})`);
    broadcastPipelineUpdate();

    // Immediately queue for rendering (TTS + /render pipeline)
    const queueFn = orchestrator?.queueSegmentWithBridge
      ? (id => orchestrator.queueSegmentWithBridge(id))
      : (id => segmentRenderer.queueRender(id));
    Promise.resolve(queueFn(segment.id)).catch(err => {
      console.error(`[Orchestrator] Render failed for ${segment.id}: ${err.message}`);
    });

    res.json({ queued: true, segmentId: segment.id });
  } catch (err) {
    console.error('[Orchestrator] queue-response error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orchestrator/regenerate', async (req, res) => {
  if (!scriptGenerator) return res.status(503).json({ error: 'Script generator not initialized' });
  const { segmentId, feedback } = req.body || {};
  if (!segmentId) return res.status(400).json({ error: 'Missing segmentId' });
  try {
    const segment = await scriptGenerator.regenerateScript(segmentId, feedback);
    broadcastPipelineUpdate();
    res.json(segment);
  } catch (err) {
    if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orchestrator/regenerate-partial', async (req, res) => {
  if (!scriptGenerator) return res.status(503).json({ error: 'Script generator not initialized' });
  const { segmentId, startLine, endLine, feedback } = req.body || {};
  if (!segmentId) return res.status(400).json({ error: 'Missing segmentId' });
  if (startLine === undefined || endLine === undefined) {
    return res.status(400).json({ error: 'Missing startLine/endLine' });
  }
  try {
    const segment = await scriptGenerator.regeneratePartial(segmentId, startLine, endLine, feedback);
    broadcastPipelineUpdate();
    res.json(segment);
  } catch (err) {
    if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orchestrator/bridge', async (req, res) => {
  if (!bridgeGenerator) return res.status(503).json({ error: 'Bridge generator not initialized' });
  const { exitContext, nextSeed, lastSpeaker } = req.body || {};
  if (!exitContext || !nextSeed) return res.status(400).json({ error: 'Missing exitContext/nextSeed' });
  try {
    const segment = await bridgeGenerator.generateBridge(exitContext, nextSeed, lastSpeaker);
    broadcastPipelineUpdate();
    res.json(segment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orchestrator/filler/generate', async (req, res) => {
  if (!fillerGenerator) return res.status(503).json({ error: 'Filler generator not initialized' });
  const { recentContexts } = req.body || {};
  try {
    const segment = await fillerGenerator.generateFiller(Array.isArray(recentContexts) ? recentContexts : []);
    broadcastPipelineUpdate();
    res.json(segment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orchestrator/render/:id', async (req, res) => {
  if (!segmentRenderer) return res.status(503).json({ error: 'Segment renderer not initialized' });
  const segmentId = req.params.id;

  // Validate segment exists and is renderable before accepting
  const segment = pipelineStore.getSegment(segmentId);
  if (!segment) return res.status(404).json({ error: `Segment not found: ${segmentId}` });
  if (segment.status !== 'forming') {
    return res.status(400).json({ error: `Segment must be forming to render (current: ${segment.status})` });
  }
  if (!Array.isArray(segment.script) || segment.script.length === 0) {
    return res.status(400).json({ error: 'Segment has no script' });
  }

  // Accept immediately, render in background
  res.json({ id: segmentId, status: 'rendering', message: 'Render queued' });

  const queueFn = orchestrator?.queueSegmentWithBridge
    ? (id => orchestrator.queueSegmentWithBridge(id))
    : (id => segmentRenderer.queueRender(id));

  Promise.resolve(queueFn(segmentId)).then(() => {
    broadcastPipelineUpdate();
  }).catch(err => {
    console.error(`[Render] Background render failed for ${segmentId}: ${err.message}`);
  });
});

app.get('/api/orchestrator/render/:id', (req, res) => {
  if (!pipelineStore) return res.status(503).json({ error: 'Pipeline store not initialized' });
  const segment = pipelineStore.getSegment(req.params.id);
  if (!segment) return res.status(404).json({ error: 'Segment not found' });
  res.json({ id: segment.id, status: segment.status, renderProgress: segment.renderProgress });
});

app.post('/api/orchestrator/play', async (req, res) => {
  if (!playbackController) return res.status(503).json({ error: 'Playback controller not initialized' });
  try {
    const status = await playbackController.start();
    processQueue();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orchestrator/pause', async (req, res) => {
  if (!playbackController) return res.status(503).json({ error: 'Playback controller not initialized' });
  try {
    const status = await playbackController.pause();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orchestrator/stop', async (req, res) => {
  if (!playbackController) return res.status(503).json({ error: 'Playback controller not initialized' });
  try {
    const status = await playbackController.stop();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orchestrator/status', (req, res) => {
  if (!playbackController) return res.status(503).json({ error: 'Playback controller not initialized' });
  res.json({
    ...playbackController.getStatus(),
    fillerEnabled: orchestrator ? orchestrator.getFillerEnabled() : false
  });
});

app.post('/api/orchestrator/filler', (req, res) => {
  if (!orchestrator) return res.status(503).json({ error: 'Orchestrator not initialized' });
  const { enabled } = req.body || {};
  orchestrator.setFillerEnabled(enabled);
  res.json({ fillerEnabled: orchestrator.getFillerEnabled() });
});

// ============== Orchestrator Chat Intake API ==============
app.post('/api/orchestrator/chat/message', async (req, res) => {
  if (!chatIntake) return res.status(503).json({ error: 'Chat intake not initialized' });
  const { username, text, response } = req.body || {};
  if (!text) return res.status(400).json({ error: 'Missing text' });
  chatIntake.addMessage(username || 'anonymous', text, response || null);
  res.json({ success: true });
});

app.get('/api/orchestrator/chat/inbox', (req, res) => {
  if (!chatIntake) return res.status(503).json({ error: 'Chat intake not initialized' });
  res.json({ inbox: chatIntake.getInbox() });
});

app.delete('/api/orchestrator/chat/inbox', (req, res) => {
  if (!chatIntake) return res.status(503).json({ error: 'Chat intake not initialized' });
  chatIntake.clearInbox();
  res.json({ success: true });
});

app.delete('/api/orchestrator/chat/inbox/:id', (req, res) => {
  if (!chatIntake) return res.status(503).json({ error: 'Chat intake not initialized' });
  chatIntake.removeCard(req.params.id);
  res.json({ success: true });
});

app.post('/api/orchestrator/chat/intake-rate', (req, res) => {
  if (!chatIntake) return res.status(503).json({ error: 'Chat intake not initialized' });
  const { rate } = req.body || {};
  try {
    chatIntake.setIntakeRate(rate);
    res.json(chatIntake.getConfig());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/orchestrator/chat/auto-approve', (req, res) => {
  if (!chatIntake) return res.status(503).json({ error: 'Chat intake not initialized' });
  const { enabled } = req.body || {};
  chatIntake.setAutoApprove(enabled);
  res.json(chatIntake.getConfig());
});

app.get('/api/orchestrator/chat/config', (req, res) => {
  if (!chatIntake) return res.status(503).json({ error: 'Chat intake not initialized' });
  res.json(chatIntake.getConfig());
});

// ============== Orchestrator State & Config API ==============
app.get('/api/orchestrator/state', (req, res) => {
  if (!pipelineStore) return res.status(503).json({ error: 'Pipeline store not initialized' });
  res.json({
    pipeline: { segments: pipelineStore.getAllSegments(), bufferHealth: pipelineStore.getBufferHealth() },
    tvLayer: tvLayerManager ? tvLayerManager.getState() : null,
    playback: playbackController ? playbackController.getStatus() : null,
    chatIntake: chatIntake ? { inbox: chatIntake.getInbox(), ...chatIntake.getConfig() } : null
  });
});

app.get('/api/orchestrator/config', (req, res) => {
  const config = loadOrchestratorConfig();
  res.json(config);
});

app.post('/api/orchestrator/config', async (req, res) => {
  const config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...(req.body || {}) };
  try {
    await saveOrchestratorConfig(config);
    if (orchestrator) {
      if (chatIntake && config.chatIntake) {
        if (config.chatIntake.ratePerMinute) chatIntake.setIntakeRate(config.chatIntake.ratePerMinute);
        if (typeof config.chatIntake.autoApprove !== 'undefined') {
          chatIntake.setAutoApprove(config.chatIntake.autoApprove);
        }
      }
      if (orchestrator.bufferMonitor && config.buffer) {
        orchestrator.bufferMonitor.config = config.buffer;
        orchestrator.bufferMonitor.fillerEnabled = config.filler?.enabled ?? false;
      }
    }
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============== Twitter Ingest API ==============

function broadcastTwitterStatus() {
  if (!orchestratorSocket || !twitterIngest) return;
  orchestratorSocket.broadcast('twitter:status-update', twitterIngest.getPollingStatus());
}

app.get('/api/orchestrator/twitter/config', (req, res) => {
  if (!twitterIngest) return res.status(503).json({ error: 'Twitter ingest not initialized' });
  res.json(twitterIngest.getConfig());
});

app.post('/api/orchestrator/twitter/config', (req, res) => {
  if (!twitterIngest) return res.status(503).json({ error: 'Twitter ingest not initialized' });
  const { ct0, authToken, communityUrl, pollIntervalMinutes } = req.body || {};
  const result = twitterIngest.setConfig({ ct0, authToken, communityUrl, pollIntervalMinutes });
  res.json(result);
});

// Single tweet → directly to pipeline
app.post('/api/orchestrator/twitter/fetch', async (req, res) => {
  if (!twitterIngest) return res.status(503).json({ error: 'Twitter ingest not initialized' });
  if (!scriptGenerator) return res.status(503).json({ error: 'Script generator not initialized' });
  if (!mediaLibrary) return res.status(503).json({ error: 'Media library not initialized' });

  const { tweetUrl, instruction } = req.body || {};
  if (!tweetUrl) return res.status(400).json({ error: 'tweetUrl required' });

  try {
    const result = await twitterIngest.fetchSingleTweet({
      tweetUrl,
      instruction: instruction || undefined,
      mediaLibrary,
      scriptGenerator,
      pipelineStore,
      segmentRenderer,
      orchestrator
    });
    broadcastPipelineUpdate();
    res.json({ segmentId: result.segmentId });
  } catch (err) {
    console.error('[Twitter] Single fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Community — start polling (initializes if needed)
app.post('/api/orchestrator/twitter/community/start', async (req, res) => {
  if (!twitterIngest) return res.status(503).json({ error: 'Twitter ingest not initialized' });
  if (!scriptGenerator || !mediaLibrary || !pipelineStore || !segmentRenderer) {
    return res.status(503).json({ error: 'Pipeline not initialized' });
  }

  const { communityUrl, pollIntervalMinutes } = req.body || {};
  if (communityUrl || pollIntervalMinutes) {
    twitterIngest.setConfig({ communityUrl, pollIntervalMinutes });
  }

  try {
    await twitterIngest.startPolling(
      { mediaLibrary, scriptGenerator, pipelineStore, segmentRenderer, orchestrator },
      () => { broadcastPipelineUpdate(); broadcastTwitterStatus(); }
    );
    broadcastTwitterStatus();
    res.json(twitterIngest.getPollingStatus());
  } catch (err) {
    console.error('[Twitter] Start polling error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Community — stop polling
app.post('/api/orchestrator/twitter/community/stop', (req, res) => {
  if (!twitterIngest) return res.status(503).json({ error: 'Twitter ingest not initialized' });
  twitterIngest.stopPolling();
  broadcastTwitterStatus();
  res.json(twitterIngest.getPollingStatus());
});

// Community — status
app.get('/api/orchestrator/twitter/community/status', (req, res) => {
  if (!twitterIngest) return res.status(503).json({ error: 'Twitter ingest not initialized' });
  res.json(twitterIngest.getPollingStatus());
});

// Historical tweets list
app.get('/api/orchestrator/twitter/historical', (req, res) => {
  if (!twitterIngest) return res.status(503).json({ error: 'Twitter ingest not initialized' });
  res.json({ tweets: twitterIngest.getHistoricalTweets() });
});

// Queue a historical tweet → pipeline
app.post('/api/orchestrator/twitter/historical/:id/queue', async (req, res) => {
  if (!twitterIngest) return res.status(503).json({ error: 'Twitter ingest not initialized' });
  if (!scriptGenerator || !mediaLibrary || !pipelineStore || !segmentRenderer) {
    return res.status(503).json({ error: 'Pipeline not initialized' });
  }

  try {
    const result = await twitterIngest.queueHistoricalTweet(
      req.params.id,
      { mediaLibrary, scriptGenerator, pipelineStore, segmentRenderer, orchestrator }
    );
    broadcastPipelineUpdate();
    res.json({ segmentId: result.segmentId });
  } catch (err) {
    if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
    console.error('[Twitter] Queue historical error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============== End Twitter Ingest API ==============

// ── Meme Segment API ──────────────────────────────────────────────────────────

app.post('/api/orchestrator/meme/create', async (req, res) => {
  if (!scriptGenerator || !pipelineStore || !mediaLibrary) {
    return res.status(503).json({ error: 'Pipeline not initialized' });
  }

  const { virgin, chad, virgin_labels, chad_labels } = req.body || {};
  if (!virgin || !chad) return res.status(400).json({ error: 'virgin and chad are required' });

  const virginSeedLabels = Array.isArray(virgin_labels) ? virgin_labels.filter(Boolean) : [];
  const chadSeedLabels = Array.isArray(chad_labels) ? chad_labels.filter(Boolean) : [];

  try {
    const result = await runMemeAndCreateSegment({ virgin, chad, virginSeedLabels, chadSeedLabels });
    broadcastPipelineUpdate();
    res.json({ segmentId: result.segmentId, virginLabels: result.virginLabels, chadLabels: result.chadLabels });
  } catch (err) {
    console.error('[Meme] Create segment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Queue a segment from an already-generated meme in the library (skip submit/poll)
async function runMemeFromExistingJob(jobId) {
  if (!mediaLibrary) throw new Error('Media library not available');
  if (!scriptGenerator) throw new Error('Script generator not available');
  if (!pipelineStore) throw new Error('Pipeline store not available');

  const MEME_API = 'https://virginvschad.vip';
  const axios = require('axios');

  console.log(`[Meme] Loading existing job: ${jobId}`);

  // Fetch metadata and image in parallel
  const [metaRes, imageRes] = await Promise.all([
    axios.get(`${MEME_API}/jobs/${jobId}/metadata`, { timeout: 10000 }),
    axios.get(`${MEME_API}/jobs/${jobId}/image`, { responseType: 'arraybuffer', timeout: 30000 })
  ]);

  const virginLabels = metaRes.data.virgin_labels || [];
  const chadLabels = metaRes.data.chad_labels || [];
  const memeId = metaRes.data.id || jobId;

  // Parse virgin/chad subjects from meme_id (format: virgin_X_vs_chad_Y)
  const subjectMatch = memeId.match(/^virgin_(.+?)_vs_chad_(.+)$/);
  const virgin = subjectMatch ? subjectMatch[1].replace(/_/g, ' ') : memeId;
  const chad = subjectMatch ? subjectMatch[2].replace(/_/g, ' ') : memeId;

  console.log(`[Meme] Existing job: virgin="${virgin}", chad="${chad}", labels: ${virginLabels.length}v ${chadLabels.length}c`);

  // Save image to media library
  const timestamp = Date.now();
  const tempPath = path.join(TEMP_DIR, `meme_${timestamp}.png`);
  await fs.promises.writeFile(tempPath, Buffer.from(imageRes.data));
  const filename = `meme_${virgin.replace(/\s+/g, '_')}_vs_${chad.replace(/\s+/g, '_')}_${timestamp}.png`;
  const item = await mediaLibrary.addFile(tempPath, filename, 'image/png');
  try { await fs.promises.unlink(tempPath); } catch {}
  console.log(`[Meme] Media saved: ${item.id}`);

  // Generate reaction script
  const generated = await scriptGenerator.generateMemeReactionScript({
    virginSubject: virgin,
    chadSubject: chad,
    virginLabels,
    chadLabels
  });

  // Narrator announcement
  generated.script.unshift({
    speaker: 'narrator',
    text: `New VVC meme generated: virgin ${virgin} vs chad ${chad}`
  });

  // Create pipeline segment
  const segment = await pipelineStore.createSegment({
    type: 'meme-reaction',
    seed: `Meme: virgin ${virgin} vs chad ${chad}`,
    script: generated.script,
    estimatedDuration: generated.estimatedDuration
  });

  await pipelineStore.updateSegment(segment.id, {
    exitContext: generated.exitContext,
    metadata: {
      ...(segment.metadata || {}),
      source: 'meme',
      virginSubject: virgin,
      chadSubject: chad,
      virginLabels,
      chadLabels,
      attachedMediaId: item.id
    }
  });

  const queueFn = orchestrator?.queueSegmentWithBridge
    ? id => orchestrator.queueSegmentWithBridge(id)
    : id => segmentRenderer.queueRender(id);
  queueFn(segment.id);

  console.log(`[Meme] Existing job segment ${segment.id} queued`);
  return { segmentId: segment.id, mediaId: item.id };
}

// Proxy meme library listing (localhost:8000 — same machine as animation server)
const MEME_LIBRARY_URL = 'https://virginvschad.vip';

app.get('/api/meme-library', async (req, res) => {
  const axios = require('axios');
  const { page = 1, limit = 20 } = req.query;
  try {
    const r = await axios.get(`${MEME_LIBRARY_URL}/memes`, {
      params: { page: Number(page), limit: Number(limit), status: 'done' },
      timeout: 10000
    });
    res.json(r.data);
  } catch (err) {
    console.error('[MemeLib] Fetch error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// Queue a segment from an existing meme job
app.post('/api/orchestrator/meme/queue-existing', async (req, res) => {
  if (!scriptGenerator || !pipelineStore || !mediaLibrary) {
    return res.status(503).json({ error: 'Pipeline not initialized' });
  }
  const { job_id } = req.body || {};
  if (!job_id) return res.status(400).json({ error: 'job_id required' });

  try {
    const result = await runMemeFromExistingJob(job_id);
    broadcastPipelineUpdate();
    res.json({ segmentId: result.segmentId });
  } catch (err) {
    console.error('[Meme] Queue existing error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============== End Orchestrator Script API ==============

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

// ── Meme generation ───────────────────────────────────────────────────────────
// Submit a job to the MemeFactory API, poll until done, fetch labels + image,
// generate a character reaction script, create a pipeline segment, and queue it.
async function runMemeAndCreateSegment({ virgin, chad, virginSeedLabels = [], chadSeedLabels = [] }) {
  if (!mediaLibrary) throw new Error('Media library not available');
  if (!scriptGenerator) throw new Error('Script generator not available');
  if (!pipelineStore) throw new Error('Pipeline store not available');

  const MEME_API = 'https://virginvschad.vip';
  const POLL_INTERVAL_MS = 5000;
  const POLL_TIMEOUT_MS = 5 * 60 * 1000;
  const axios = require('axios');

  console.log(`[Meme] Submitting job: virgin="${virgin}", chad="${chad}"`);
  const body = { virgin, chad };
  if (virginSeedLabels.length) body.virgin_labels = virginSeedLabels;
  if (chadSeedLabels.length) body.chad_labels = chadSeedLabels;

  const submitRes = await axios.post(`${MEME_API}/generate/raw`, body, { timeout: 15000 });
  const jobId = submitRes.data.job_id;
  if (!jobId) throw new Error('No job_id in response');
  console.log(`[Meme] Job submitted: ${jobId}`);

  // Poll until done
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let status = submitRes.data.status;
  while (status === 'processing') {
    if (Date.now() > deadline) throw new Error('Meme generation timed out after 5 minutes');
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const pollRes = await axios.get(`${MEME_API}/jobs/${jobId}`, { timeout: 10000 });
    status = pollRes.data.status;
    console.log(`[Meme] Job ${jobId}: ${status}`);
    if (status === 'failed') throw new Error(`Meme job failed: ${pollRes.data.error || 'unknown'}`);
  }

  // Fetch metadata (labels) and image in parallel
  const [metaRes, imageRes] = await Promise.all([
    axios.get(`${MEME_API}/jobs/${jobId}/metadata`, { timeout: 10000 }),
    axios.get(`${MEME_API}/jobs/${jobId}/image`, { responseType: 'arraybuffer', timeout: 30000 })
  ]);
  const virginLabels = metaRes.data.virgin_labels || [];
  const chadLabels = metaRes.data.chad_labels || [];
  console.log(`[Meme] Labels: ${virginLabels.length} virgin, ${chadLabels.length} chad`);

  // Save image to media library
  const timestamp = Date.now();
  const tempPath = path.join(TEMP_DIR, `meme_${timestamp}.png`);
  await fs.promises.writeFile(tempPath, Buffer.from(imageRes.data));
  const filename = `meme_${virgin.replace(/\s+/g, '_')}_vs_${chad.replace(/\s+/g, '_')}_${timestamp}.png`;
  const item = await mediaLibrary.addFile(tempPath, filename, 'image/png');
  try { await fs.promises.unlink(tempPath); } catch {}
  console.log(`[Meme] Media saved: ${item.id}`);

  // Generate reaction script
  const generated = await scriptGenerator.generateMemeReactionScript({
    virginSubject: virgin,
    chadSubject: chad,
    virginLabels,
    chadLabels
  });

  // Narrator announces the meme before characters react
  generated.script.unshift({
    speaker: 'narrator',
    text: `New VVC meme generated: virgin ${virgin} vs chad ${chad}`
  });

  // Create pipeline segment
  const segment = await pipelineStore.createSegment({
    type: 'meme-reaction',
    seed: `Meme: virgin ${virgin} vs chad ${chad}`,
    script: generated.script,
    estimatedDuration: generated.estimatedDuration
  });

  await pipelineStore.updateSegment(segment.id, {
    exitContext: generated.exitContext,
    metadata: {
      ...(segment.metadata || {}),
      source: 'meme',
      virginSubject: virgin,
      chadSubject: chad,
      virginLabels,
      chadLabels,
      attachedMediaId: item.id
    }
  });

  const queueFn = orchestrator?.queueSegmentWithBridge
    ? id => orchestrator.queueSegmentWithBridge(id)
    : id => segmentRenderer.queueRender(id);
  queueFn(segment.id);

  console.log(`[Meme] Segment ${segment.id} queued`);
  return { segmentId: segment.id, mediaId: item.id, virginLabels, chadLabels };
}

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
    tvService = new TVContentService(viewport.width, viewport.height, STREAM_FPS);
    console.log(`[TV] Service initialized with viewport ${viewport.width}x${viewport.height}`);
  } else {
    console.warn('[TV] Service disabled - no viewport defined');
  }

  // Initialize media library
  mediaLibrary = new MediaLibrary(ROOT_DIR);
  await mediaLibrary.init();

  // Restore TV playlist from last session
  if (tvService) {
    await tvService.restore((id) => mediaLibrary.getOriginalPath(id));
  }

  // Initialize pipeline store with dialogue logging to logs/ (git-ignored)
  const dialogueLogPath = path.join(LOGS_DIR, 'dialogue.jsonl');
  const onSegmentActivity = (segment, event) => {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      event,
      id: segment.id,
      type: segment.type,
      seed: segment.seed,
      script: segment.script,
      metadata: segment.metadata || {}
    }) + '\n';
    fs.promises.appendFile(dialogueLogPath, line, 'utf8').catch(err => {
      console.warn('[Log] dialogue write failed:', err.message);
    });
  };
  pipelineStore = new PipelineStore(path.join(ROOT_DIR, 'data'), { onSegmentActivity });
  await pipelineStore.init();

  // Initialize TV layer manager
  if (tvService) {
    tvLayerManager = new TVLayerManager(tvService, mediaLibrary);
    console.log('[TVLayer] Manager initialized');
  }

  const animationServerUrl = `http://${host}:${port}`;
  const orchestratorConfig = loadOrchestratorConfig();

  // Start live stream
  if (STREAM_MODE === 'synced') {
    streamManager = new ContinuousStreamManager(STREAMS_DIR, STREAM_FPS);
    // Reset speaker when audio finishes
    streamManager.onAudioComplete = () => {
      console.log('[Server] Audio complete, resetting speaker');
      handleAudioComplete();
    };
  } else {
    streamManager = new StreamManager(STREAMS_DIR, STREAM_FPS);
  }
  streamManager.start(renderFrame);

  // Background music — init and restore persisted state
  backgroundMusic = new BackgroundMusicService();
  backgroundMusic.restore();
  if (STREAM_MODE === 'synced' && streamManager.setBackgroundMusic) {
    streamManager.setBackgroundMusic(backgroundMusic);
  }

  // Start leaderboard polling (every 2 seconds)
  const CHAT_API_PORT = process.env.PORT || 3002;
  const CHAT_API_HOST = 'localhost';
  const LEADERBOARD_UPDATE_MS = 2000;

  async function fetchLeaderboard() {
    try {
      const http = require('http');
      const options = {
        hostname: CHAT_API_HOST,
        port: CHAT_API_PORT,
        path: '/api/leaderboard?limit=3',
        method: 'GET',
        timeout: 1000
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const parsed = JSON.parse(data);
              if (Array.isArray(parsed.entries) && parsed.entries.length > 0) {
                setLeaderboard(parsed.entries);
              } else {
                setLeaderboard(null);
              }
            }
          } catch (err) {
            // Silently fail - leaderboard is optional
          }
        });
      });

      req.on('error', () => {
        // Silently fail - leaderboard is optional
      });

      req.end();
    } catch (err) {
      // Silently fail - leaderboard is optional
    }
  }

  // Initial fetch and start interval
  fetchLeaderboard();
  setInterval(fetchLeaderboard, LEADERBOARD_UPDATE_MS);
  console.log('[Leaderboard] Polling enabled (every 2s)');

  // Start leaderboard timer (10 min voting + 5 min cooldown, aligned to clock)
  // Cycle: 15 minutes total, starts at :00, :15, :30, :45 of each hour
  const COUNTDOWN_DURATION_SEC = 600; // 10 minutes
  const IDLE_DURATION_SEC = 300;      // 5 minutes
  const CYCLE_DURATION_SEC = COUNTDOWN_DURATION_SEC + IDLE_DURATION_SEC; // 15 minutes

  let timerState = {
    capturedWinner: null, // Freeze winner name for full idle phase
    lastPhase: null       // Track phase transitions
  };

  async function clearLeaderboardVotes() {
    try {
      const http = require('http');
      const options = {
        hostname: CHAT_API_HOST,
        port: CHAT_API_PORT,
        path: '/api/leaderboard/clear',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 1000
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            console.log('[Leaderboard] Votes cleared successfully');
          }
        });
      });

      req.on('error', (err) => {
        console.warn('[Leaderboard] Failed to clear votes:', err.message);
      });

      req.end();
    } catch (err) {
      console.warn('[Leaderboard] Clear request error:', err.message);
    }
  }

  /**
   * Parse winner command to extract virgin/chad subjects
   * Format: /virgin_X_vs_chad_Y or variations
   */
  function parseWinnerCommand(command) {
    if (!command || typeof command !== 'string') return null;

    // Remove leading slash and convert to lowercase
    const normalized = command.toLowerCase().replace(/^\/+/, '');

    // Match pattern: virgin_something_vs_chad_something
    const match = normalized.match(/virgin[_\s]+(.+?)[_\s]+vs[_\s]+chad[_\s]+(.+)/i);
    if (match) {
      return {
        virgin: match[1].replace(/_/g, ' ').trim(),
        chad: match[2].replace(/_/g, ' ').trim()
      };
    }

    return null;
  }

  /**
   * Generate meme via MemeFactory API and queue a pipeline segment with character reactions.
   */
  async function generateAndDisplayMeme(winnerCommand) {
    if (!winnerCommand || !mediaLibrary || !scriptGenerator || !pipelineStore) {
      console.log('[Meme] Cannot generate: missing prerequisites');
      return;
    }

    const parsed = parseWinnerCommand(winnerCommand);
    if (!parsed) {
      console.log(`[Meme] Could not parse winner command: ${winnerCommand}`);
      return;
    }

    try {
      await runMemeAndCreateSegment({ virgin: parsed.virgin, chad: parsed.chad });
    } catch (err) {
      console.error('[Meme] Generation error:', err.message);
    }
  }

  function updateLeaderboardTimer() {
    const now = Date.now();
    const currentDate = new Date(now);

    // Get minutes and seconds within current hour
    const minutesInHour = currentDate.getMinutes();
    const secondsInMinute = currentDate.getSeconds();
    const totalSecondsInHour = minutesInHour * 60 + secondsInMinute;

    // Calculate position within 15-minute cycle (0-899 seconds)
    const positionInCycle = totalSecondsInHour % CYCLE_DURATION_SEC;

    // Determine if we're in voting or idle phase
    const isIdle = positionInCycle >= COUNTDOWN_DURATION_SEC;
    const phase = isIdle ? 'idle' : 'countdown';

    // Calculate remaining seconds in current phase
    let remainingSeconds;
    if (isIdle) {
      // In idle phase: show time remaining until next voting starts
      remainingSeconds = CYCLE_DURATION_SEC - positionInCycle;
    } else {
      // In countdown phase: show time remaining until idle starts
      remainingSeconds = COUNTDOWN_DURATION_SEC - positionInCycle;
    }

    // Detect phase transitions
    if (timerState.lastPhase !== phase) {
      if (phase === 'idle') {
        // Just transitioned to idle - capture winner and clear votes
        const leaderboard = getLeaderboard();
        const winner = (leaderboard && leaderboard.length > 0)
          ? leaderboard[0].command
          : null;
        timerState.capturedWinner = winner;
        console.log(`[Leaderboard Timer] Idle phase started, winner: ${winner || 'none'}`);
        clearLeaderboardVotes();

        // Generate and display winning meme on TV
        if (winner) {
          generateAndDisplayMeme(winner).catch(err => {
            console.error('[Meme] Background generation failed:', err.message);
          });
        }
      } else {
        // Just transitioned to countdown
        timerState.capturedWinner = null;
        console.log('[Leaderboard Timer] Countdown phase started');
      }
      timerState.lastPhase = phase;
    }

    // Update timer display
    if (isIdle) {
      setLeaderboardTimer(remainingSeconds, true, timerState.capturedWinner);
    } else {
      setLeaderboardTimer(remainingSeconds, false, null);
    }
  }

  // Initial timer setup - sync with clock immediately
  updateLeaderboardTimer();
  // Update timer every second
  setInterval(updateLeaderboardTimer, 1000);

  const now = new Date();
  const mins = now.getMinutes();
  const secs = now.getSeconds();
  const posInCycle = (mins * 60 + secs) % CYCLE_DURATION_SEC;
  const nextCycleStart = new Date(now.getTime() + (CYCLE_DURATION_SEC - posInCycle) * 1000);
  console.log(`[Leaderboard Timer] Started (10min voting + 5min cooldown, clock-aligned)`);
  console.log(`[Leaderboard Timer] Next cycle starts at ${nextCycleStart.toLocaleTimeString()}`);

  const server = app.listen(port, host, () => {
    const startLine = JSON.stringify({ at: new Date().toISOString(), event: 'server_start', server: 'animation' }) + '\n';
    fs.promises.appendFile(dialogueLogPath, startLine, 'utf8').catch(err => console.warn('[Log] server_start write failed:', err.message));
    console.log(`Animation server running on http://${host}:${port}`);
    console.log(`Live stream: http://${host}:${port}${streamManager.getStreamUrl()}`);
    console.log(`Platform: ${process.platform}`);
    console.log(`Lip sync mode: ${LIPSYNC_MODE} | Stream mode: ${STREAM_MODE}`);
    console.log(`TV content: ${tvService ? 'enabled' : 'disabled'}`);
  });

  orchestratorSocket = new OrchestratorSocket(server);

  orchestrator = new Orchestrator({
    openai,
    pipelineStore,
    mediaLibrary,
    tvLayerManager,
    animationServerUrl,
    eventEmitter: orchestratorSocket,
    config: orchestratorConfig,
    onChatMessage: addChatMessage
  });

  orchestrator.init();
  scriptGenerator = orchestrator.scriptGenerator;
  bridgeGenerator = orchestrator.bridgeGenerator;
  fillerGenerator = orchestrator.fillerGenerator;
  segmentRenderer = orchestrator.segmentRenderer;
  playbackController = orchestrator.playbackController;
  chatIntake = orchestrator.chatIntake;
  console.log('[Orchestrator] Initialized');

  // Initialize Twitter ingest service
  twitterIngest = new TwitterIngestService({ tempDir: TEMP_DIR });
  console.log('[Twitter] Ingest service initialized');

  // TV media cue: when a segment with attachedMediaId goes on-air, switch TV to that media
  playbackController.registerOnAirHook((segmentId, segment) => {
    const mediaId = segment?.metadata?.attachedMediaId;
    if (!mediaId || !tvService || !mediaLibrary) return;
    const mediaItem = mediaLibrary.get(mediaId);
    if (!mediaItem) {
      console.warn(`[TV Cue] Media ${mediaId} not found for segment ${segmentId}`);
      return;
    }
    const source = mediaLibrary.getOriginalPath(mediaId);
    tvService.clear();
    tvService.addItem({ type: mediaItem.type, source, mediaId }).then(() => {
      tvService.play();
      console.log(`[TV Cue] On-air: playing media ${mediaId} for segment ${segmentId}`);
    }).catch(err => {
      console.error(`[TV Cue] Failed to play media for segment ${segmentId}:`, err.message);
    });
  });
}

start();
function getPipelineOrderIndex(segmentId) {
  if (!pipelineStore || !segmentId) return Number.POSITIVE_INFINITY;
  const ready = pipelineStore.getReadyQueue();
  const index = ready.findIndex(s => s.id === segmentId);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

function enqueueRenderItem(queueItem) {
  if (!queueItem) return;

  const segmentId = queueItem.segmentId || null;
  const orderIndex = getPipelineOrderIndex(segmentId);

  // Keep items from the same segment contiguous
  if (segmentId) {
    for (let i = renderQueue.length - 1; i >= 0; i--) {
      if (renderQueue[i]?.segmentId === segmentId) {
        renderQueue.splice(i + 1, 0, queueItem);
        return;
      }
    }
  }

  // Insert by pipeline order (older ready segments first)
  if (Number.isFinite(orderIndex)) {
    let insertIndex = 0;
    while (insertIndex < renderQueue.length) {
      const nextOrder = getPipelineOrderIndex(renderQueue[insertIndex]?.segmentId || null);
      if (nextOrder > orderIndex) break;
      insertIndex += 1;
    }
    renderQueue.splice(insertIndex, 0, queueItem);
    return;
  }

  // Unknown order: append, but keep priority items ahead of unknown non-priority
  if (queueItem.priority) {
    let insertIndex = 0;
    while (insertIndex < renderQueue.length && renderQueue[insertIndex]?.priority) {
      insertIndex += 1;
    }
    renderQueue.splice(insertIndex, 0, queueItem);
    return;
  }

  renderQueue.push(queueItem);
}
