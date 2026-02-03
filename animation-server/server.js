const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { FFMPEG_PATH } = require('./platform');
const { analyzeLipSync } = require('./lipsync');
const BlinkController = require('./blink-controller');
const {
  compositeFrame,
  loadManifest,
  preloadLayers,
  setTVFrame,
  getTVViewport,
  setEmissionOpacity,
  getEmissionOpacity,
  setEmissionLayerBlend,
  getEmissionLayerBlend,
  setLightsOnOpacity,
  getLightsOnOpacity,
  setLightsMode,
  getLightsMode,
  setLightingHue,
  getLightingHue,
  setExpressionOffset,
  getExpressionOffsets,
  resetExpressionOffsets,
  getExpressionLimits,
  saveExpressionLimits,
  setEyebrowRotationLimits,
  setEyebrowAsymmetry,
  setSpeakingCharacter
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

// Ensure directories exist
fs.mkdirSync(STREAMS_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });
fs.mkdirSync(TV_CONTENT_DIR, { recursive: true });

app.use(cors());
app.use(express.json());

const DEFAULT_ORCHESTRATOR_CONFIG = {
  buffer: { warningThresholdSeconds: 15, criticalThresholdSeconds: 5 },
  filler: { enabled: true, maxConsecutive: 3, style: 'callback' },
  chatIntake: { enabled: true, ratePerMinute: 1, autoApprove: false },
  rendering: { maxConcurrentForming: 2, ttsModel: 'eleven_turbo_v2', retryAttempts: 3 },
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

const lightingState = {
  rainbow: { enabled: false, rpm: 1, timer: null, lastTick: 0, busy: false },
  flicker: { enabled: false, opacity: 1, timer: null }
};
const lightingQueue = {
  hue: { inFlight: false, pending: null },
  emissionOpacity: { inFlight: false, pending: null },
  emissionBlend: { inFlight: false, pendingByName: Object.create(null) }
};

function startLightingQueue(type) {
  if (type === 'hue') {
    if (lightingQueue.hue.inFlight) return;
    lightingQueue.hue.inFlight = true;
    setImmediate(async () => {
      try {
        while (lightingQueue.hue.pending !== null) {
          const next = lightingQueue.hue.pending;
          lightingQueue.hue.pending = null;
          await setLightingHue(next);
        }
      } catch (err) {
        console.error('[Lighting] Hue update failed:', err.message);
      } finally {
        lightingQueue.hue.inFlight = false;
      }
    });
    return;
  }

  if (type === 'emissionOpacity') {
    if (lightingQueue.emissionOpacity.inFlight) return;
    lightingQueue.emissionOpacity.inFlight = true;
    setImmediate(async () => {
      try {
        while (lightingQueue.emissionOpacity.pending !== null) {
          const next = lightingQueue.emissionOpacity.pending;
          lightingQueue.emissionOpacity.pending = null;
          await setEmissionOpacity(next);
        }
      } catch (err) {
        console.error('[Lighting] Emission opacity update failed:', err.message);
      } finally {
        lightingQueue.emissionOpacity.inFlight = false;
      }
    });
    return;
  }

  if (type === 'emissionBlend') {
    if (lightingQueue.emissionBlend.inFlight) return;
    lightingQueue.emissionBlend.inFlight = true;
    setImmediate(async () => {
      try {
        while (Object.keys(lightingQueue.emissionBlend.pendingByName).length > 0) {
          const pending = lightingQueue.emissionBlend.pendingByName;
          lightingQueue.emissionBlend.pendingByName = Object.create(null);
          for (const [name, blend] of Object.entries(pending)) {
            await setEmissionLayerBlend(name, blend);
          }
        }
      } catch (err) {
        console.error('[Lighting] Emission blend update failed:', err.message);
      } finally {
        lightingQueue.emissionBlend.inFlight = false;
      }
    });
  }
}

function wrapHue(value) {
  const wrapped = ((value + 180) % 360 + 360) % 360 - 180;
  return Math.max(-180, Math.min(180, wrapped));
}

async function tickRainbow() {
  const rainbow = lightingState.rainbow;
  if (!rainbow.enabled) return;
  if (rainbow.busy) return;
  rainbow.busy = true;
  try {
    const now = Date.now();
    const last = rainbow.lastTick || now;
    const elapsed = Math.max(0, now - last);
    rainbow.lastTick = now;
    const rpm = Math.max(0, Number(rainbow.rpm) || 0);
    if (rpm > 0 && elapsed > 0) {
      const delta = (rpm * 360) * (elapsed / 60000);
      const nextHue = wrapHue(getLightingHue() + delta);
      // Quantize to 2-degree steps: at 1 RPM (6 deg/sec) this means actual
      // hue updates ~every 333ms instead of every 100ms — 3x fewer rebuilds
      const quantized = Math.round(nextHue / 2) * 2;
      if (quantized === getLightingHue()) return;
      await setLightingHue(quantized);
    }
  } finally {
    rainbow.busy = false;
  }
}

function startRainbow() {
  const rainbow = lightingState.rainbow;
  if (rainbow.timer) return;
  rainbow.lastTick = Date.now();
  rainbow.timer = setInterval(() => {
    tickRainbow().catch(() => {});
  }, 100);
}

function stopRainbow() {
  const rainbow = lightingState.rainbow;
  if (rainbow.timer) {
    clearInterval(rainbow.timer);
    rainbow.timer = null;
  }
}

function stopFlicker() {
  const flicker = lightingState.flicker;
  if (flicker.timer) {
    clearInterval(flicker.timer);
    flicker.timer = null;
  }
  flicker.startTime = null;
}

function updateFlickerForFrame() {
  const flicker = lightingState.flicker;
  if (!flicker.enabled) return;
  const baseOpacity = Math.max(0, Math.min(1, Number(flicker.opacity) || 0));
  if (!flicker.startTime) {
    flicker.startTime = Date.now();
  }
  const periodMs = 2000;
  const elapsed = Date.now() - flicker.startTime;
  const phase = (elapsed % periodMs) / periodMs;
  const value = (Math.sin(phase * Math.PI * 2) + 1) / 2;
  setLightsMode('on');
  setLightsOnOpacity(baseOpacity * value);
}

app.get('/lighting', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'frontend', 'lighting-control.html'));
});

app.get('/lighting/status', (req, res) => {
  res.json({
    hue: getLightingHue(),
    emissionOpacity: getEmissionOpacity(),
    emissionLayerBlends: getEmissionLayerBlend(),
    rainbow: {
      enabled: lightingState.rainbow.enabled,
      rpm: lightingState.rainbow.rpm
    },
    flicker: {
      enabled: lightingState.flicker.enabled,
      opacity: lightingState.flicker.opacity
    },
    lights: {
      mode: getLightsMode(),
      opacity: getLightsOnOpacity()
    }
  });
});

app.post('/lighting/hue', async (req, res) => {
  const hue = req.body?.hue;
  lightingQueue.hue.pending = hue;
  startLightingQueue('hue');
  res.json({ queued: true, hue: getLightingHue() });
});

app.post('/lighting/emission-opacity', async (req, res) => {
  const opacity = req.body?.opacity;
  lightingQueue.emissionOpacity.pending = opacity;
  startLightingQueue('emissionOpacity');
  res.json({ queued: true, opacity: getEmissionOpacity() });
});

app.post('/lighting/emission-layer-blend', async (req, res) => {
  const name = req.body?.name;
  const blend = req.body?.blend;
  if (typeof name === 'string' && typeof blend === 'string') {
    lightingQueue.emissionBlend.pendingByName[name] = blend;
  }
  startLightingQueue('emissionBlend');
  res.json({ queued: true, blends: getEmissionLayerBlend() });
});

app.post('/lighting/rainbow', (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  const rpm = Math.max(0, Number(req.body?.rpm) || 0);
  lightingState.rainbow.enabled = enabled;
  lightingState.rainbow.rpm = rpm;
  if (enabled && rpm > 0) {
    startRainbow();
  } else {
    stopRainbow();
  }
  res.json({ enabled, rpm });
});

app.post('/lighting/flicker', (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  const opacity = Math.max(0, Math.min(1, Number(req.body?.opacity) || 0));
  lightingState.flicker.enabled = enabled;
  lightingState.flicker.opacity = opacity;
  stopFlicker();
  setLightsOnOpacity(opacity);
  if (enabled) {
    setLightsMode('on');
    lightingState.flicker.startTime = Date.now();
  }
  res.json({ enabled, opacity });
});

app.post('/lighting/lights', (req, res) => {
  const mode = req.body?.mode;
  const value = setLightsMode(mode);
  res.json({ mode: value });
});

app.post('/lighting/lights-opacity', (req, res) => {
  const opacity = Math.max(0, Math.min(1, Number(req.body?.opacity) || 0));
  setLightsMode('on');
  const value = setLightsOnOpacity(opacity);
  res.json({ opacity: value });
});

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
  currentSpeaker = null;
  currentCaption = null;
  captionUntil = 0;
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
  playbackStartFrame = frameCount;
  expressionEvaluator.clear();

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

  if (item.messageText) {
    setCaption(item.messageText, item.duration);
  }

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
  updateFlickerForFrame();

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

// Serve Director control panel
app.get('/director', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'director.html'));
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
app.post('/api/orchestrator/expand', async (req, res) => {
  if (!scriptGenerator) return res.status(503).json({ error: 'Script generator not initialized' });
  const { seed, mediaRefs, showContext } = req.body || {};
  if (!seed) return res.status(400).json({ error: 'Missing seed' });
  try {
    const segment = await scriptGenerator.expandDirectorNote(seed, mediaRefs || [], showContext || {});
    if (orchestratorSocket) orchestratorSocket.broadcast('segment:draft-ready', segment);
    broadcastPipelineUpdate();
    res.json(segment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orchestrator/expand-chat', async (req, res) => {
  if (!scriptGenerator) return res.status(503).json({ error: 'Script generator not initialized' });
  const { message, showContext } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Missing message' });
  try {
    const segment = await scriptGenerator.expandChatMessage(message, showContext || {});
    if (orchestratorSocket) orchestratorSocket.broadcast('segment:draft-ready', segment);
    broadcastPipelineUpdate();
    res.json(segment);
  } catch (err) {
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

app.post('/api/orchestrator/filler', async (req, res) => {
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
  try {
    const segment = await segmentRenderer.queueRender(segmentId);
    broadcastPipelineUpdate();
    res.json(segment);
  } catch (err) {
    if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
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
  res.json(playbackController.getStatus());
});

// ============== Orchestrator Chat Intake API ==============
app.post('/api/orchestrator/chat/message', async (req, res) => {
  if (!chatIntake) return res.status(503).json({ error: 'Chat intake not initialized' });
  const { username, text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'Missing text' });
  chatIntake.addMessage(username || 'anonymous', text, Date.now());
  res.json({ success: true });
});

app.get('/api/orchestrator/chat/inbox', (req, res) => {
  if (!chatIntake) return res.status(503).json({ error: 'Chat intake not initialized' });
  res.json({ inbox: chatIntake.getInbox() });
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
    lighting: {
      hue: getLightingHue(),
      emissionOpacity: getEmissionOpacity(),
      lightsMode: getLightsMode(),
      lightsOpacity: getLightsOnOpacity(),
      emissionBlend: getEmissionLayerBlend(),
      rainbow: lightingState.rainbow,
      flicker: lightingState.flicker
    },
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
        orchestrator.bufferMonitor.fillerEnabled = config.filler?.enabled ?? true;
      }
    }
    res.json(config);
  } catch (err) {
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

  // Initialize pipeline store
  pipelineStore = new PipelineStore(path.join(ROOT_DIR, 'data'));
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

  const server = app.listen(port, host, () => {
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
    config: orchestratorConfig
  });

  orchestrator.init();
  scriptGenerator = orchestrator.scriptGenerator;
  bridgeGenerator = orchestrator.bridgeGenerator;
  fillerGenerator = orchestrator.fillerGenerator;
  segmentRenderer = orchestrator.segmentRenderer;
  playbackController = orchestrator.playbackController;
  chatIntake = orchestrator.chatIntake;
  console.log('[Orchestrator] Initialized');
}

start();
