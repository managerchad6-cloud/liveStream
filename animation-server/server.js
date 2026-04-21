const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { FFMPEG_PATH } = require('./platform');
const { getChartScreenshot } = require('./chart-renderer');
const { analyzeLipSync } = require('./lipsync');
const BlinkController = require('./blink-controller');
const {
  compositeFrame,
  loadManifest,
  preloadLayers,
  setTVFrame,
  getTVViewport,
  setTVVisible,
  isTVVisible,
  setExpressionOffset,
  getExpressionOffsets,
  resetExpressionOffsets,
  getExpressionLimits,
  saveExpressionLimits,
  setEyebrowRotationLimits,
  setEyebrowAsymmetry,
  setSpeakingCharacter,
  addChatMessage,
  setTickerMessages,
  getTickerMessages,
  getTickerCurrentIndex,
  setFireState,
  setLightingState,
  advanceFireFrame,
  setDayCycle,
  tickDayCycle,
  getSceneState,
  setMemeQueue,
  setMemeVotingData,
  setSuggestionQueue,
  setVideosList,
  setRoadmapList,
  triggerGlow,
  setTokenStats
} = require('./compositor');
const { decodeAudio } = require('./audio-decoder');
const AnimationState = require('./state');
const StreamManager = require('./stream-manager');
const ContinuousStreamManager = require('./continuous-stream-manager');
const SyncedPlayback = require('./synced-playback');
const TVContentService = require('./tv-content');
const { buildExpressionPlan, buildIdlePlan, augmentExpressionPlan, normalizePlanTiming } = require('./expression-timeline');
const ExpressionEvaluator = require('./expression-evaluator');
const OpenAI = require('openai');
const MediaLibrary = require('./media-library');
const PipelineStore = require('./orchestrator/pipeline-store');
const TVLayerManager = require('./orchestrator/tv-layer-manager');
const OrchestratorSocket = require('./orchestrator/websocket');
const Orchestrator = require('./orchestrator');
const BackgroundMusicService = require('./background-music');
const SfxService = require('./sfx-service');
const SfxMatcher = require('./orchestrator/sfx-matcher');
const TwitterIngestService = require('./orchestrator/twitter-ingest');
const XChatListener = require('./orchestrator/x-chat-listener');

// Lip sync mode: 'realtime' (new) or 'rhubarb' (legacy)
const LIPSYNC_MODE = process.env.LIPSYNC_MODE || 'realtime';

// Stream mode: 'synced' (audio muxed into video) or 'separate' (audio played separately)
const STREAM_MODE = process.env.STREAM_MODE || 'synced';
const EXPRESSION_MODEL = process.env.EXPRESSION_MODEL || process.env.MODEL || 'gpt-4o-mini';
const USE_LLM_EXPRESSIONS = process.env.EXPRESSION_LLM === '1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
let activePumpToken  = process.env.PUMP_FUN_TOKEN || '';
const PUMP_FUN_PAIR  = process.env.PUMP_FUN_PAIR  || '';

const app = express();
const port = process.env.ANIMATION_PORT || 3003;
const host = process.env.ANIMATION_HOST || '0.0.0.0';

const ROOT_DIR = path.resolve(__dirname, '..');
const STREAMS_DIR = path.join(ROOT_DIR, 'streams');
const TEMP_DIR = path.join(__dirname, 'temp');
const AUDIO_DIR = path.join(STREAMS_DIR, 'audio');
const TV_CONTENT_DIR = path.join(__dirname, 'tv-content', 'content');
const ORCHESTRATOR_CONFIG_PATH = path.join(ROOT_DIR, 'data', 'orchestrator-config.json');
const SCENE_SETTINGS_PATH = path.join(__dirname, 'scene-settings.json');
const LOGS_DIR = path.join(ROOT_DIR, 'logs');
const LOGS_AUDIO_DIR = path.join(LOGS_DIR, 'audio');

// Auto-load YouTube cookies if previously uploaded
const _ytCookiesPath = path.join(__dirname, 'youtube-cookies.txt');
if (fs.existsSync(_ytCookiesPath) && !process.env.YTDLP_COOKIES) {
  process.env.YTDLP_COOKIES = _ytCookiesPath;
  console.log('[YT] Auto-loaded cookies from', _ytCookiesPath);
}

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

// Meme queue overlay — maps segment ID → display title for meme-reaction segments
const memeSegmentTitles = new Map(); // segmentId → "virgin X vs chad Y"

// Suggestion queue overlay — maps segment ID → suggestion text
const suggestionSegmentTitles = new Map(); // segmentId → suggestion text

function syncSuggestionQueueToCompositor() {
  const all = pipelineStore ? pipelineStore.getAllSegments() : [];
  for (const [id] of suggestionSegmentTitles) {
    const seg = all.find(s => s.id === id);
    if (!seg || seg.status === 'aired' || seg.status === 'deleted') {
      suggestionSegmentTitles.delete(id);
    }
  }
  // Build from Map insertion order (chronological), reverse for newest-first
  const items = [];
  for (const [id, title] of suggestionSegmentTitles) {
    const seg = all.find(s => s.id === id);
    if (seg && seg.status !== 'aired' && seg.status !== 'deleted') {
      items.push({ segmentId: id, title });
    }
  }
  setSuggestionQueue(items.reverse());
}

// ── External lists polling (videos + roadmap from :3007) ─────────────────────
const EXTERNAL_API = 'http://93.127.214.75:3007';
let _cachedVideosList = [];
let _cachedRoadmapList = [];

function httpGetJson(url, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

async function pollExternalLists() {
  try {
    const [videosData, roadmapData] = await Promise.all([
      httpGetJson(`${EXTERNAL_API}/api/videos`),
      httpGetJson(`${EXTERNAL_API}/api/roadmap`)
    ]);
    // Only show videos pending a vote (available=false) — already-available ones are done
    // Sorted longest title first (shorter items sink to bottom)
    _cachedVideosList = (videosData.videos || []).filter(v => !v.available).sort((a, b) => b.title.length - a.title.length);
    setVideosList(_cachedVideosList);
    _cachedRoadmapList = (roadmapData.items || []).sort((a, b) => b.title.length - a.title.length);
    setRoadmapList(_cachedRoadmapList);
    console.log(`[Lists] Fetched ${_cachedVideosList.length} videos, ${_cachedRoadmapList.length} roadmap items`);
  } catch (err) {
    console.warn('[Lists] Poll failed:', err.message);
  }
}

pollExternalLists();
setInterval(pollExternalLists, 60 * 1000);

// ── Meme rate limiter (per-user queue-depth + strike escalation) ──────────────
// A user may have at most MAX_PENDING memes in-flight (generating + queued but
// not yet aired). Exceeding this issues a strike and imposes an escalating
// personal cooldown. Strikes decay after 24 h of clean behaviour.

// ── Meme Intake Queue ─────────────────────────────────────────────────────────
// Holds /meme requests awaiting director approval. Auto-mode bypasses the queue.
let memeIntakeAutoMode = false;
const memeIntakeQueue = new Map(); // id → { id, userId, text, description, receivedAt }
let memeIntakeCounter = 0;

// ── MIMO Voting Mode ──────────────────────────────────────────────────────────
// mimoEnabled=true → current behavior (director queue / auto-process)
// mimoEnabled=false → voting mode: pool + countdown + winner queued to pipeline
let mimoEnabled = true;
let memeVotingState = 'idle'; // 'idle' | 'voting' | 'rolling'
const memeVotingPool = new Map(); // id → { id, number, userId, text, description, receivedAt, votes }
let memeVotingPoolCounter = 0;
let memeVotingCountdown = null; // { endsAt, timer } | null
let memeVotingWinnerSegId = null; // segment ID of winner while 'rolling'
const VOTING_DURATION_MS = 5 * 60 * 1000;

function getMimoStatus() {
  const pool = Array.from(memeVotingPool.values()).map(({ id, number, userId, description, votes }) => ({
    id, number, userId, description, votes
  }));
  return {
    mimoEnabled,
    votingState: memeVotingState,
    pool,
    countdownEndsAt: memeVotingCountdown?.endsAt || null
  };
}

function broadcastMemeIntakeUpdate() {
  if (!orchestratorSocket) return;
  orchestratorSocket.broadcast('meme:intake-update', {
    items: Array.from(memeIntakeQueue.values()),
    auto: memeIntakeAutoMode,
    mimo: getMimoStatus()
  });
}

function addToVotingPool(userId, text) {
  if (memeVotingState !== 'idle' && memeVotingState !== 'voting') return null;
  const id = `vote-${++memeVotingPoolCounter}-${Date.now()}`;
  const number = memeVotingPool.size + 1;
  memeVotingPool.set(id, { id, number, userId, text, description: text.slice(0, 60), receivedAt: Date.now(), votes: 0 });
  console.log(`[MimoVote] #${number} from ${userId.slice(0, 12)}: "${text.slice(0, 60)}"`);
  if (memeVotingState === 'idle') startVotingCountdown();
  else broadcastMemeIntakeUpdate();
  syncVotingToCompositor();
  return memeVotingPool.get(id);
}

function startVotingCountdown() {
  if (memeVotingCountdown?.timer) clearTimeout(memeVotingCountdown.timer);
  if (memeVotingCountdown?.tickInterval) clearInterval(memeVotingCountdown.tickInterval);
  memeVotingState = 'voting';
  const endsAt = Date.now() + VOTING_DURATION_MS;
  const timer = setTimeout(() => finalizeVoting(), VOTING_DURATION_MS);
  // Tick every 5s to keep the stream overlay countdown current
  const tickInterval = setInterval(() => {
    if (memeVotingState === 'voting') syncVotingToCompositor();
    else clearInterval(tickInterval);
  }, 5000);
  memeVotingCountdown = { endsAt, timer, tickInterval };
  broadcastMemeIntakeUpdate();
  syncVotingToCompositor();
}

function handleVoteMeme(userId, numStr) {
  if (memeVotingState !== 'voting') return false;
  const num = parseInt(numStr, 10);
  if (isNaN(num) || num < 1) return false;
  for (const item of memeVotingPool.values()) {
    if (item.number === num) {
      item.votes++;
      console.log(`[MimoVote] ${userId.slice(0, 12)} → #${num} (${item.votes} votes)`);
      broadcastMemeIntakeUpdate();
      syncVotingToCompositor();
      return true;
    }
  }
  return false;
}

async function finalizeVoting() {
  if (memeVotingCountdown?.tickInterval) clearInterval(memeVotingCountdown.tickInterval);
  if (memeVotingCountdown?.timer) clearTimeout(memeVotingCountdown.timer);
  memeVotingCountdown = null;
  if (memeVotingPool.size === 0) {
    memeVotingState = 'idle';
    broadcastMemeIntakeUpdate();
    syncVotingToCompositor();
    return;
  }
  let winner = null;
  for (const item of memeVotingPool.values()) {
    if (!winner || item.votes > winner.votes || (item.votes === winner.votes && item.receivedAt < winner.receivedAt)) {
      winner = item;
    }
  }
  memeVotingState = 'rolling';
  memeVotingPool.clear();
  memeVotingWinnerSegId = null;
  broadcastMemeIntakeUpdate();
  syncVotingToCompositor();
  console.log(`[MimoVote] Winner: #${winner.number} "${winner.description}" (${winner.votes} votes)`);
  if (!scriptGenerator || !pipelineStore || !mediaLibrary) {
    console.warn('[MimoVote] Pipeline not ready — resetting');
    memeVotingState = 'idle';
    broadcastMemeIntakeUpdate();
    syncVotingToCompositor();
    return;
  }
  try {
    const memeJob = trackMemeJob(winner.description, winner.userId);
    const result = await runMemeFromText(winner.text, winner.userId);
    memeVotingWinnerSegId = result?.segmentId || null;
    memeJob.done();
    broadcastPipelineUpdate();
  } catch (err) {
    console.error('[MimoVote] Winner generation failed:', err.message);
    memeVotingState = 'idle';
    broadcastMemeIntakeUpdate();
    syncVotingToCompositor();
  }
}

function resetVotingAfterMeme() {
  if (memeVotingState !== 'rolling') return;
  console.log('[MimoVote] Meme aired — resetting voting cycle');
  memeVotingState = 'idle';
  memeVotingPool.clear();
  memeVotingPoolCounter = 0;
  memeVotingWinnerSegId = null;
  broadcastMemeIntakeUpdate();
  syncVotingToCompositor();
}

function syncVotingToCompositor() {
  if (mimoEnabled || memeVotingState === 'idle') {
    setMemeVotingData(null);
    return;
  }
  const pool = Array.from(memeVotingPool.values()).map(({ number, description, votes }) => ({ number, description, votes }));
  const countdownSecs = memeVotingCountdown ? Math.max(0, Math.round((memeVotingCountdown.endsAt - Date.now()) / 1000)) : null;
  setMemeVotingData({ state: memeVotingState, pool, countdownSecs });
}

function addToMemeIntake(userId, text) {
  const id = `intake-${++memeIntakeCounter}-${Date.now()}`;
  const item = { id, userId, text, description: text.slice(0, 60), receivedAt: Date.now() };
  memeIntakeQueue.set(id, item);
  console.log(`[MemeIntake] Queued from ${userId.slice(0, 12)}: "${item.description}"`);
  broadcastMemeIntakeUpdate();
  return item;
}

function processMemeIntakeItem(item) {
  console.log(`[MemeIntake] Generating: "${item.description}"`);
  const memeJob = trackMemeJob(item.text.slice(0, 60), item.userId);
  runMemeFromText(item.text, item.userId).then(() => {
    memeJob.done();
    broadcastPipelineUpdate();
  }).catch(err => {
    console.error('[Meme] Intake generation failed:', err.message);
    memeJob.fail(err.message);
  });
  return true;
}

function syncMemeQueueToCompositor() {
  const all = pipelineStore ? pipelineStore.getAllSegments() : [];
  // Detect when voting winner has aired → reset voting cycle
  if (memeVotingWinnerSegId) {
    const winnerSeg = all.find(s => s.id === memeVotingWinnerSegId);
    if (winnerSeg && (winnerSeg.status === 'aired' || winnerSeg.status === 'deleted')) {
      resetVotingAfterMeme();
      memeVotingWinnerSegId = null;
    }
  }
  // Remove titles for segments that have aired or been deleted
  for (const [id] of memeSegmentTitles) {
    const seg = all.find(s => s.id === id);
    if (!seg || seg.status === 'aired' || seg.status === 'deleted') {
      memeSegmentTitles.delete(id);
    }
  }
  // Newest first: generating jobs are most recent, then pipeline items in reverse order
  const pipelineItems = all
    .filter(s => s.type === 'meme-reaction'
      && s.status !== 'aired'
      && s.status !== 'deleted'
      && memeSegmentTitles.has(s.id))
    .map(s => ({ segmentId: s.id, title: memeSegmentTitles.get(s.id) }))
    .reverse();
  const generatingItems = Array.from(memeGenerationQueue.values())
    .filter(job => job.status !== 'failed')
    .map(job => ({ segmentId: null, title: job.description }))
    .reverse();
  setMemeQueue([...generatingItems, ...pipelineItems]);
}

function broadcastPipelineUpdate() {
  syncMemeQueueToCompositor();
  syncSuggestionQueueToCompositor();
  if (!orchestratorSocket || !pipelineStore) return;
  orchestratorSocket.broadcast('pipeline:update', {
    segments: pipelineStore.getAllSegments(),
    bufferHealth: pipelineStore.getBufferHealth()
  });
}

// Meme generation job tracking
const memeGenerationQueue = new Map(); // id -> { id, description, status, startedAt, error? }
let memeJobCounter = 0;

function broadcastMemeQueueUpdate() {
  syncMemeQueueToCompositor();
  if (!orchestratorSocket) return;
  const jobs = Array.from(memeGenerationQueue.values());
  orchestratorSocket.broadcast('meme:queue-update', { jobs });
}

function trackMemeJob(description, userId = null) {
  const id = `meme-${++memeJobCounter}-${Date.now()}`;
  const job = { id, description, userId, status: 'generating', startedAt: Date.now() };
  memeGenerationQueue.set(id, job);
  broadcastMemeQueueUpdate();
  return {
    done() {
      memeGenerationQueue.delete(id);
      broadcastMemeQueueUpdate();
    },
    fail(errMsg) {
      job.status = 'failed';
      job.error = errMsg;
      memeGenerationQueue.set(id, job);
      broadcastMemeQueueUpdate();
      setTimeout(() => {
        memeGenerationQueue.delete(id);
        broadcastMemeQueueUpdate();
      }, 10000);
    }
  };
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

// ── SFX Soundboard Routes ────────────────────────────────────────────────────

app.get('/sfx', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'frontend', 'sfx-control.html'));
});

app.get('/sfx/list', (req, res) => {
  if (!sfxService) return res.status(503).json({ error: 'SFX service not ready' });
  res.json({ sounds: sfxService.list(), volume: sfxService.volume });
});

app.post('/sfx/play/:id', async (req, res) => {
  if (!sfxService) return res.status(503).json({ error: 'SFX service not ready' });
  const id = decodeURIComponent(req.params.id);
  try {
    await sfxService.play(id);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post('/sfx/label/:id', (req, res) => {
  if (!sfxService) return res.status(503).json({ error: 'SFX service not ready' });
  const id = decodeURIComponent(req.params.id);
  const { label } = req.body || {};
  if (!label) return res.status(400).json({ error: 'label required' });
  sfxService.setLabel(id, label);
  res.json({ ok: true, id, label });
});

app.post('/sfx/meaning/:id', (req, res) => {
  if (!sfxService) return res.status(503).json({ error: 'SFX service not ready' });
  const id = decodeURIComponent(req.params.id);
  const { meaning } = req.body || {};
  if (meaning === undefined) return res.status(400).json({ error: 'meaning required' });
  sfxService.setMeaning(id, meaning);
  res.json({ ok: true, id, meaning });
});

app.get('/sfx/volume', (req, res) => {
  if (!sfxService) return res.json({ volume: 0.85 });
  res.json({ volume: sfxService.volume });
});

app.post('/sfx/volume', (req, res) => {
  if (!sfxService) return res.status(503).json({ error: 'SFX service not ready' });
  const { volume } = req.body || {};
  if (volume === undefined) return res.status(400).json({ error: 'volume required' });
  sfxService.setVolume(volume);
  res.json({ volume: sfxService.volume });
});

app.get('/sfx/stats', (req, res) => {
  if (!sfxMatcher) return res.json({ stats: [] });
  res.json({ stats: sfxMatcher.getStats() });
});

app.post('/sfx/stats/reset', (req, res) => {
  if (!sfxMatcher) return res.status(503).json({ error: 'SFX matcher not ready' });
  sfxMatcher.resetStats();
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────

// ── Scene Control (Fire + Lighting) ──────────────────────────────────────────

let fireTimer = null;
let dayCycleTimer = null;
// Cycle ticks at 200ms — smooth enough for gradual blends without over-stressing Sharp
const DAY_CYCLE_TICK_MS = 200;

function restartFireTimer() {
  clearInterval(fireTimer);
  fireTimer = null;
  const { fps, playing } = getSceneState().fire;
  if (playing) {
    fireTimer = setInterval(() => advanceFireFrame(), Math.round(1000 / fps));
  }
}

function restartDayCycleTimer() {
  clearInterval(dayCycleTimer);
  dayCycleTimer = null;
  const { cycle } = getSceneState();
  if (cycle.enabled) {
    dayCycleTimer = setInterval(() => tickDayCycle(), DAY_CYCLE_TICK_MS);
  }
}

function saveSceneSettings() {
  try {
    const state = getSceneState();
    fs.writeFileSync(SCENE_SETTINGS_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Scene] Failed to save scene settings:', err.message);
  }
}

app.get('/scene', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'frontend', 'scene-control.html'));
});

app.get('/scene/status', (req, res) => {
  res.json(getSceneState());
});

app.post('/scene/fire', (req, res) => {
  const { playing, mode, fps } = req.body || {};
  const config = {};
  if (playing !== undefined) config.playing = Boolean(playing);
  if (mode !== undefined && ['circular', 'pingpong', 'random'].includes(mode)) config.mode = mode;
  if (typeof fps === 'number' && fps >= 1 && fps <= 30) config.fps = fps;
  setFireState(config);
  restartFireTimer();
  saveSceneSettings();
  res.json(getSceneState());
});

app.post('/scene/lighting', (req, res) => {
  const { nightOpacity, dayOpacity } = req.body || {};
  const config = {};
  if (typeof nightOpacity === 'number') config.nightOpacity = Math.max(0, Math.min(1, nightOpacity));
  if (typeof dayOpacity === 'number') config.dayOpacity = Math.max(0, Math.min(1, dayOpacity));
  setLightingState(config);
  saveSceneSettings();
  res.json(getSceneState());
});

app.post('/scene/cycle', (req, res) => {
  const { enabled, rpm, angle } = req.body || {};
  const config = {};
  if (enabled !== undefined) config.enabled = Boolean(enabled);
  if (typeof rpm === 'number') config.rpm = rpm;
  if (typeof angle === 'number') config.angle = angle;
  setDayCycle(config);
  restartDayCycleTimer();
  saveSceneSettings();
  res.json(getSceneState());
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

app.get('/expression/crazy', (req, res) => {
  res.json({ enabled: crazyMode });
});

app.post('/expression/crazy', (req, res) => {
  crazyMode = Boolean(req.body?.enabled);
  console.log(`[Expression] Crazy mode: ${crazyMode}`);
  res.json({ enabled: crazyMode });
});

app.get('/expression/idle', (req, res) => {
  res.json({ enabled: idleExpressions });
});

app.post('/expression/idle', (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  idleExpressions = enabled;
  if (!enabled) {
    // Only clear idle state if we're actually in idle (not interrupting live audio)
    if (!isAudioActive) {
      expressionEvaluator.clear();
      resetExpressionOffsets();
      lastExprState.chad = { eyeX: 0, eyeY: 0, browY: 0, browAsymL: 0, browAsymR: 0, mouth: null };
      lastExprState.virgin = { eyeX: 0, eyeY: 0, browY: 0, browAsymL: 0, browAsymR: 0, mouth: null };
    }
    idleExprStartMs = 0;
  } else if (!isAudioActive) {
    loadIdleExpressionPlan();
  }
  console.log(`[Expression] Idle expressions: ${enabled}`);
  res.json({ enabled: idleExpressions });
});

// ============== End Expression Control API ==============

// ── Token Stats Service ───────────────────────────────────────────────────────
let tokenStatsCache = null;
let tokenStatsLastFetch = 0;
let tokenStatsSessionHigh = 0;
const TOKEN_STATS_TTL_MS = 60 * 1000;

let socialStatsCache = null;
let socialStatsLastFetch = 0;
const SOCIAL_STATS_TTL_MS = 5 * 60 * 1000;

let tradeStatsCache = null;
let tradeStatsLastFetch = 0;
const TRADE_STATS_TTL_MS = 2 * 60 * 1000;

async function fetchTokenStatsFromDex() {
  if (!activePumpToken) return null;
  const url = `https://api.dexscreener.com/latest/dex/tokens/${activePumpToken}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);
    const data = await res.json();

    const pairs = data.pairs;
    if (!pairs || pairs.length === 0) {
      return { token: activePumpToken, noData: true, lastUpdated: Date.now() };
    }

    // Pick the pair with highest liquidity as the canonical one
    const pair = pairs.slice().sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    const mcap = pair.marketCap || 0;
    if (mcap > tokenStatsSessionHigh) tokenStatsSessionHigh = mcap;

    return {
      token: activePumpToken,
      name: pair.baseToken?.name || null,
      symbol: pair.baseToken?.symbol || null,
      priceUsd: pair.priceUsd || null,
      priceSol: pair.priceNative || null,
      marketCap: mcap || null,
      fdv: pair.fdv || null,
      liquidity: pair.liquidity?.usd || null,
      volume: pair.volume || null,
      priceChange: pair.priceChange || null,
      txns: pair.txns || null,
      dex: pair.dexId || null,
      pairAddress: pair.pairAddress || null,
      imageUrl: pair.info?.imageUrl || null,
      // Extract X handle from DexScreener socials if present
      xHandleFromDex: (() => {
        const s = (pair.info?.socials || []).find(s => s.type === 'twitter');
        if (!s?.url) return null;
        return s.url.replace(/^https?:\/\/(www\.)?(twitter|x)\.com\/@?/, '').split('/')[0] || null;
      })(),
      sessionHigh: tokenStatsSessionHigh,
      isAtSessionHigh: mcap > 0 && mcap >= tokenStatsSessionHigh,
      lastUpdated: Date.now()
    };
  } catch (err) {
    clearTimeout(timer);
    console.warn('[Token] DexScreener fetch failed:', err.message);
    return tokenStatsCache; // return stale on error
  }
}

app.get('/token/address', (req, res) => {
  res.json({ address: activePumpToken || null });
});

app.post('/token/set-address', (req, res) => {
  const { address } = req.body;
  if (typeof address !== 'string') return res.status(400).json({ error: 'address must be a string' });
  const trimmed = address.trim();
  activePumpToken = trimmed;
  // Reset all stats caches so next poll fetches fresh data for the new token
  tokenStatsCache = null;
  tokenStatsLastFetch = 0;
  tokenStatsSessionHigh = 0;
  socialStatsCache = null;
  socialStatsLastFetch = 0;
  tradeStatsCache = null;
  tradeStatsLastFetch = 0;
  // Restart pump chat listener on the new token if orchestrator is running
  if (orchestrator && typeof orchestrator.setToken === 'function') {
    orchestrator.setToken(trimmed);
  }
  console.log(`[Token] Address updated to: ${trimmed || '(cleared)'}`);
  res.json({ ok: true, address: trimmed });
});

app.get('/token/stats', async (req, res) => {
  const now = Date.now();
  if (!tokenStatsCache || now - tokenStatsLastFetch > TOKEN_STATS_TTL_MS) {
    tokenStatsCache = await fetchTokenStatsFromDex();
    tokenStatsLastFetch = now;
  }
  if (!tokenStatsCache) {
    return res.json({ token: activePumpToken || null, noData: true, lastUpdated: now });
  }
  res.json(tokenStatsCache);
});
app.post('/token/analyze-chart', async (req, res) => {
  if (!scriptGenerator) return res.status(503).json({ error: 'Script generator not initialized' });
  if (!pipelineStore)    return res.status(503).json({ error: 'Pipeline not initialized' });
  if (!mediaLibrary)     return res.status(503).json({ error: 'Media library not initialized' });

  try {
    // 1. Fresh token stats
    const now = Date.now();
    if (!tokenStatsCache || now - tokenStatsLastFetch > TOKEN_STATS_TTL_MS) {
      tokenStatsCache = await fetchTokenStatsFromDex();
      tokenStatsLastFetch = now;
    }
    const tokenData = tokenStatsCache;

    // 2. Render local chart screenshot (OHLCV from GeckoTerminal or pump.fun trades API)
    let chartImageBase64 = null;
    const chartImageMimeType = 'image/png';
    let chartMediaId = null;

    if (activePumpToken) {
      try {
        const { buffer, hasChart } = await getChartScreenshot({
          tokenAddress: activePumpToken,
          pairAddress:  tokenData?.pairAddress || null,
          symbol:       tokenData?.symbol || 'VVC',
          tokenData,
          tempDir:      TEMP_DIR,
        });
        if (hasChart && buffer) {
          const tmpPath = path.join(TEMP_DIR, `chart_${Date.now()}.png`);
          fs.writeFileSync(tmpPath, buffer);
          const mediaItem = await mediaLibrary.addFile(tmpPath, `chart_${Date.now()}.png`, 'image/png');
          chartMediaId = mediaItem.id;
          chartImageBase64 = buffer.toString('base64');
          try { fs.unlinkSync(tmpPath); } catch {}
          console.log('[Token] Chart screenshot captured via local renderer');
        } else {
          console.log('[Token] Chart skipped — not enough candle data');
        }
      } catch (err) {
        console.warn('[Token] Chart renderer failed:', err.message);
      }
    }

    // 3. LLM generates hype chart analysis script
    const { script, estimatedDuration, exitContext } = await scriptGenerator.generateChartAnalysisScript({
      tokenData,
      imageBase64: chartImageBase64,
      imageMimeType: chartImageMimeType
    });

    // 4. Create custom segment — chart screenshot shows on TV when it airs
    const segment = await pipelineStore.createSegment({
      type: 'custom-script',
      seed: 'chart-analysis',
      script,
      estimatedDuration,
      exitContext,
      metadata: {
        source: 'chart-analysis',
        ...(chartMediaId ? { attachedMediaId: chartMediaId } : {})
      }
    });

    if (orchestratorSocket) orchestratorSocket.broadcast('segment:draft-ready', segment);
    broadcastPipelineUpdate();
    segmentRenderer.queueRender(segment.id);

    res.json({ success: true, segmentId: segment.id, hasChart: !!chartMediaId });
  } catch (err) {
    console.error('[Token] Chart analysis error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ── Social Stats (holders + X) ────────────────────────────────────────────────

const PUMP_HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer': 'https://www.pump.fun/',
  'Origin': 'https://www.pump.fun',
};

async function fetchHolderCount(tokenAddress) {
  // pump.fun API (works for bonding-curve tokens; migrated tokens return null)
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`https://frontend-api.pump.fun/coins/${tokenAddress}`, {
      headers: PUMP_HEADERS, signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      if (data?.holder_count) return data.holder_count;
    }
  } catch {}
  return null; // migrated tokens: show -- rather than a wrong number
}

let _socialStatsFetchPromise = null; // prevent concurrent Puppeteer sessions

async function fetchSocialStats() {
  if (_socialStatsFetchPromise) return _socialStatsFetchPromise;
  _socialStatsFetchPromise = _doFetchSocialStats().finally(() => { _socialStatsFetchPromise = null; });
  return _socialStatsFetchPromise;
}

async function _doFetchSocialStats() {
  const result = { holders: null, xFollowers: null, xTweets: null, communityMembers: null, lastUpdated: Date.now() };

  if (activePumpToken) {
    result.holders = await fetchHolderCount(activePumpToken);
  }

  if (twitterIngest) {
    const [xStats, communityMembers] = await Promise.allSettled([
      twitterIngest.fetchXUserStats(),
      twitterIngest.fetchCommunityMemberCount(),
    ]);
    if (xStats.status === 'fulfilled' && xStats.value) {
      result.xFollowers = xStats.value.followers;
      result.xTweets    = xStats.value.tweets;
    }
    if (communityMembers.status === 'fulfilled') {
      result.communityMembers = communityMembers.value;
    }
  }

  return result;
}

async function fetchTradeStats() {
  if (!activePumpToken) return null;

  // Use GeckoTerminal for migrated tokens (have a pairAddress from DexScreener)
  const pairAddress = tokenStatsCache?.pairAddress;
  if (pairAddress) {
    return fetchTradeStatsGecko(pairAddress);
  }
  // Fallback: pump.fun for bonding-curve tokens
  return fetchTradeStatsPump(activePumpToken);
}

async function fetchTradeStatsGecko(poolAddress) {
  const nowMs = Date.now();
  const buyTrades = [];

  for (let page = 1; page <= 5; page++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(
        `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/trades?page=${page}`,
        { headers: { 'Accept': 'application/json;version=20230302' }, signal: controller.signal }
      );
      clearTimeout(timer);
      if (!res.ok) break;
      const data = await res.json();
      const trades = data?.data || [];
      if (!trades.length) break;

      let allOlderThan24h = true;
      for (const t of trades) {
        const attrs = t.attributes;
        const tsMs = new Date(attrs.block_timestamp).getTime();
        if (nowMs - tsMs <= 24 * 3600 * 1000) allOlderThan24h = false;
        if (attrs.kind === 'buy') {
          buyTrades.push({ tsMs, usd: parseFloat(attrs.volume_in_usd) || 0 });
        }
      }
      if (allOlderThan24h) break;
    } catch (err) {
      console.warn('[Token] GeckoTerminal trades page', page, 'failed:', err.message);
      break;
    }
  }

  if (!buyTrades.length) return null;

  const findBiggest = (windowMs) => {
    const recent = buyTrades.filter(t => nowMs - t.tsMs <= windowMs);
    if (!recent.length) return null;
    const best = recent.reduce((a, b) => b.usd > a.usd ? b : a);
    return { usd: best.usd, solAmt: null };
  };

  return {
    buy1h:  findBiggest(3600 * 1000),
    buy8h:  findBiggest(8 * 3600 * 1000),
    buy24h: findBiggest(24 * 3600 * 1000),
    lastUpdated: Date.now(),
  };
}

async function fetchTradeStatsPump(tokenAddress) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(`https://frontend-api.pump.fun/coins/${tokenAddress}/trades?limit=1000&offset=0`, {
      headers: PUMP_HEADERS, signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const trades = await res.json();
    if (!Array.isArray(trades) || !trades.length) return null;

    const nowSec = Date.now() / 1000;
    const solPriceUsd = (tokenStatsCache?.priceUsd && tokenStatsCache?.priceSol)
      ? Number(tokenStatsCache.priceUsd) / Number(tokenStatsCache.priceSol) : null;
    const buys = trades.filter(t => t.is_buy);

    const findBiggest = (windowSecs) => {
      const recent = buys.filter(t => t.timestamp >= nowSec - windowSecs);
      if (!recent.length) return null;
      const best = recent.reduce((a, b) => b.sol_amount > a.sol_amount ? b : a);
      const solAmt = best.sol_amount / 1e9;
      return { solAmt, usd: solPriceUsd ? solAmt * solPriceUsd : null };
    };

    return {
      buy1h:  findBiggest(3600),
      buy8h:  findBiggest(8 * 3600),
      buy24h: findBiggest(24 * 3600),
      lastUpdated: Date.now(),
    };
  } catch (err) {
    console.warn('[Token] pump.fun trade stats failed:', err.message);
    return null;
  }
}

app.get('/token/social-stats', async (req, res) => {
  const now = Date.now();
  const force = req.query.force === '1';
  if (force || !socialStatsCache || now - socialStatsLastFetch > SOCIAL_STATS_TTL_MS) {
    socialStatsCache = await fetchSocialStats();
    socialStatsLastFetch = now;
    setTokenStats(socialStatsCache, tradeStatsCache);
  }
  res.json(socialStatsCache);
});

app.get('/token/trade-stats', async (req, res) => {
  const now = Date.now();
  const force = req.query.force === '1';
  if (force || !tradeStatsCache || now - tradeStatsLastFetch > TRADE_STATS_TTL_MS) {
    tradeStatsCache = await fetchTradeStats();
    tradeStatsLastFetch = now;
    setTokenStats(socialStatsCache, tradeStatsCache);
  }
  res.json(tradeStatsCache || { lastUpdated: now });
});

// ── End Token Stats Service ───────────────────────────────────────────────────

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
let sfxService = null;
let sfxMatcher = null;
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
let xChatListener = null;
let lipSyncAccumulatorMs = 0;
let lastLipSyncTime = Date.now();
let lastLipSyncResult = { phoneme: 'A', character: null, done: true };
const expressionEvaluator = new ExpressionEvaluator();
let autoExpressions = true; // Toggle for automatic expression system
let crazyMode = false;      // When on, new segments get crazy: true in metadata
let idleExpressions = false; // When on, idle periods loop a natural expression plan
let idleExprStartMs = 0;    // Wall-clock ms when the current idle plan started
const IDLE_PLAN_DURATION_SEC = 30;
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
let currentLineIndex = 0;            // Which script line is currently playing (0-based)
let currentTotalLines = 1;           // Total lines in the current segment's script
const renderQueue = [];
let lastFrameBuffer = null;
let skipCompositingFrames = 0;
const FRAME_BUDGET_MS = 33;

function loadIdleExpressionPlan() {
  if (!idleExpressions || isAudioActive) return;
  const limits = getExpressionLimits();
  const plan = buildIdlePlan({ durationSec: IDLE_PLAN_DURATION_SEC, limits });
  expressionEvaluator.loadPlan(plan, limits);
  idleExprStartMs = Date.now();
  console.log('[Expr] Idle expression plan loaded');
}

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
  const completedLineIndex = currentLineIndex;
  const completedTotalLines = currentTotalLines;
  const isLastLine = completedLineIndex >= completedTotalLines - 1;

  console.log(`[Playback] DONE seg=${completedSegId?.slice(0,8) || 'none'} line=${completedLineIndex}/${completedTotalLines} isLastLine=${isLastLine}`);

  currentSpeaker = null;
  currentCaption = null;
  captionUntil = 0;
  currentPlayingSegmentId = null;
  currentLineIndex = 0;
  currentTotalLines = 1;
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

  // sfxAfter: only fire after the LAST line so the SFX plays after the whole segment,
  // not between lines of a multi-line segment.
  let sfxAfterDelayMs = 0;
  if (isLastLine && completedSegId && sfxService && pipelineStore) {
    const doneSeg = pipelineStore.getSegment(completedSegId);
    const sfxAfterId = doneSeg?.metadata?.sfxAfter
      || (doneSeg?.metadata?.sfxAttach?.placement === 'post' ? doneSeg?.metadata?.sfxAttach?.sfxId : null);

    if (sfxAfterId) {
      sfxAfterDelayMs = sfxService.getDurationMs(sfxAfterId); // synchronous — preloaded at startup
      sfxService.play(sfxAfterId).then(() => {
        if (doneSeg?.metadata?.sfxAttach?.placement === 'post' && sfxMatcher) {
          sfxMatcher.trackPlayed(sfxAfterId);
        }
        console.log(`[SFX] AFTER segment ${completedSegId.slice(0,8)}: ${sfxAfterId} (${sfxAfterDelayMs}ms)`);
      }).catch(err => console.warn('[SFX] AFTER play failed:', err.message));
    }
  }

  if (sfxAfterDelayMs > 0) {
    // Let the SFX play over silence before the next segment starts
    setTimeout(() => {
      processQueue();
      if (!isAudioActive && idleExpressions) loadIdleExpressionPlan();
    }, sfxAfterDelayMs);
  } else {
    processQueue();
    if (!isAudioActive && idleExpressions) loadIdleExpressionPlan();
  }

  // segmentDone: advance pipeline state + expand chain.
  // Only fire on the LAST line — multi-line segments (narrator cue + character response)
  // must not be marked aired until all lines have finished playing.
  if (isLastLine && completedSegId) {
    if (playbackController) {
      playbackController.segmentDone(completedSegId).then(() => {
        syncMemeQueueToCompositor();
        syncSuggestionQueueToCompositor();
      }).catch(err => {
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
  currentLineIndex = item.lineIndex !== undefined ? Number(item.lineIndex) : 0;
  currentTotalLines = item.totalLines || 1;
  playbackStartFrame = frameCount;
  idleExprStartMs = 0; // cancel idle clock
  expressionEvaluator.clear();

  console.log(`[Playback] START seg=${currentPlayingSegmentId?.slice(0,8) || 'none'} type=${item.segmentType || '?'} char=${item.character} line=${currentLineIndex}/${currentTotalLines} dur=${item.duration?.toFixed(2)}s`);

  // Notify playback controller when a new segment starts playing.
  // Only fire setOnAir on the FIRST line so expand generation isn't triggered for every line.
  if (currentPlayingSegmentId && playbackController && currentLineIndex === 0) {
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

  // Show caption during narrator segments so viewers can read the chat message on screen
  if (item.character === 'narrator' && item.messageText) {
    setCaption(item.messageText, item.duration);
  }

  // Build expression plan and load into frame-driven evaluator
  // Skip for narrator — it has no character layers to animate
  if (item.messageText && autoExpressions && item.character !== 'narrator') {
    const listener = item.character === 'virgin' ? 'chad' : 'virgin';
    const limits = getExpressionLimits();

    // Start with heuristic plan immediately
    let plan = buildExpressionPlan({
      message: item.messageText,
      character: item.character,
      listener,
      durationSec: item.duration,
      limits,
      crazy: item.crazy || false
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

  // sfxBefore: play SFX into the stream, wait for it to finish, THEN start the segment.
  // This ensures the SFX plays over silence (not over segment audio).
  const nextSeg = sfxService && pipelineStore ? pipelineStore.getSegment(next.segmentId) : null;
  const sfxBeforeId = nextSeg?.metadata?.sfxBefore
    || (nextSeg?.metadata?.sfxAttach?.placement === 'pre' ? nextSeg.metadata.sfxAttach.sfxId : null);

  if (sfxBeforeId && sfxService) {
    // Block the queue immediately so nothing else dequeues during the SFX gap
    isAudioActive = true;
    sfxService.play(sfxBeforeId)
      .then(() => {
        const dur = sfxService.getDurationMs(sfxBeforeId);
        if (sfxMatcher && nextSeg?.metadata?.sfxAttach?.placement === 'pre') {
          sfxMatcher.trackPlayed(sfxBeforeId);
        }
        console.log(`[SFX] BEFORE segment ${next.segmentId?.slice(0,8)}: ${sfxBeforeId} (${dur}ms)`);
        // Wait for SFX to finish, then start the segment
        setTimeout(() => {
          isAudioActive = false; // let startPlayback set it back to true
          startPlayback(next).catch(err => {
            console.error('[Queue] Failed to start playback after sfxBefore:', err.message);
            isAudioActive = false;
            processQueue();
          });
        }, dur);
      })
      .catch(err => {
        console.warn(`[SFX] sfxBefore play failed (${sfxBeforeId}): ${err.message}`);
        isAudioActive = false;
        startPlayback(next).catch(e => { isAudioActive = false; processQueue(); });
      });
    return;
  }

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

  // Frame-driven expression evaluation (active audio OR idle expressions)
  const isIdleExpr = idleExpressions && !isAudioActive && expressionEvaluator.loaded && idleExprStartMs > 0;
  if (autoExpressions && expressionEvaluator.loaded && (isAudioActive || isIdleExpr)) {
    // Idle: loop the plan clock; Active: follow audio position
    let currentTimeMs;
    if (isIdleExpr) {
      const elapsed = Date.now() - idleExprStartMs;
      const planMs = IDLE_PLAN_DURATION_SEC * 1000;
      currentTimeMs = elapsed % planMs;
      // Reload a fresh plan at the start of each loop for variety
      if (elapsed > 0 && Math.floor(elapsed / planMs) > Math.floor((elapsed - 33) / planMs)) {
        loadIdleExpressionPlan();
      }
    } else {
      currentTimeMs = (audioProgress && audioProgress.playing)
        ? (audioProgress.frame / STREAM_FPS) * 1000
        : ((frame - playbackStartFrame) / STREAM_FPS) * 1000;
    }
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
  const lineIndex = Number.isInteger(lineIndexNum) && lineIndexNum >= 0 ? lineIndexNum : 0;
  const totalLinesRaw = req.body.totalLines;
  const totalLinesNum = totalLinesRaw !== undefined && totalLinesRaw !== '' ? parseInt(String(totalLinesRaw), 10) : NaN;
  const totalLines = Number.isInteger(totalLinesNum) && totalLinesNum > 0 ? totalLinesNum : 1;
  const segmentType = req.body.segmentType || null;
  const priorityRaw = String(req.body.priority || '').toLowerCase();
  const isPriority = priorityRaw === 'high' || priorityRaw === 'true' || priorityRaw === '1';
  const isCrazy = req.body.crazy === 'true';
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
        priority: isPriority,
        crazy: isCrazy,
        lineIndex,
        totalLines
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
        priority: isPriority,
        lineIndex,
        totalLines
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

// TV visibility (slide in/out animation)
app.post('/tv/visibility', (req, res) => {
  const { visible } = req.body;
  if (typeof visible !== 'boolean') {
    return res.status(400).json({ error: 'visible must be a boolean' });
  }
  if (!visible && tvService) {
    // Stop content before sliding away
    tvService.stop();
    setTVFrame(null);
  }
  setTVVisible(visible);
  res.json({ success: true, visible });
});

app.get('/tv/visibility', (req, res) => {
  res.json({ visible: isTVVisible() });
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

// Seek TV playback to a specific time position
app.post('/tv/seek', (req, res) => {
  if (!tvService) return res.status(503).json({ error: 'TV service not initialized' });
  const { position } = req.body;
  if (typeof position !== 'number' || position < 0) {
    return res.status(400).json({ error: 'position must be a non-negative number (seconds)' });
  }
  tvService.seekToTime(position);
  res.json({ success: true, position });
});

// ── Video Reaction endpoints ──────────────────────────────────────────────────

// Start planning a video reaction (returns sessionId immediately, planning runs async)
app.post('/video-reaction/prepare', (req, res) => {
  if (!orchestrator) return res.status(503).json({ error: 'Orchestrator not initialized' });
  const { url } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required' });
  try {
    const sessionId = orchestrator.prepareVideoReaction(url);
    res.json({ sessionId, state: 'preparing' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get planning/session status
app.get('/video-reaction/status/:sessionId', (req, res) => {
  if (!orchestrator) return res.status(503).json({ error: 'Orchestrator not initialized' });
  const status = orchestrator.getVideoSessionStatus(req.params.sessionId);
  if (!status) return res.status(404).json({ error: 'Session not found' });
  res.json(status);
});

// Start session — adds intro to pipeline, arms session
app.post('/video-reaction/start/:sessionId', async (req, res) => {
  if (!orchestrator) return res.status(503).json({ error: 'Orchestrator not initialized' });
  try {
    const result = await orchestrator.startVideoReaction(req.params.sessionId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Cancel active session or abort a preparing one
app.post('/video-reaction/cancel', (req, res) => {
  if (!orchestrator) return res.status(503).json({ error: 'Orchestrator not initialized' });
  orchestrator.cancelVideoReaction();
  res.json({ success: true });
});

const YTDLP_COOKIES_PATH = path.join(__dirname, 'youtube-cookies.txt');

// GET /video-reaction/cookies — check if cookies are configured
app.get('/video-reaction/cookies', (req, res) => {
  res.json({ configured: fs.existsSync(YTDLP_COOKIES_PATH) });
});

// POST /video-reaction/cookies — upload cookies.txt
app.post('/video-reaction/cookies', multer({ storage: multer.memoryStorage() }).single('cookies'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    fs.writeFileSync(YTDLP_COOKIES_PATH, req.file.buffer);
    process.env.YTDLP_COOKIES = YTDLP_COOKIES_PATH;
    console.log('[YT] cookies.txt saved to', YTDLP_COOKIES_PATH);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  const { topic, attachedMediaId, sfxBefore, sfxAfter } = req.body || {};
  if (!topic && !attachedMediaId) return res.status(400).json({ error: 'Missing topic or attachedMediaId' });
  try {
    // Load attached image for vision pass if present
    let imageBase64 = null;
    let imageMimeType = 'image/jpeg';
    if (attachedMediaId && mediaLibrary) {
      const mediaItem = mediaLibrary.get(attachedMediaId);
      console.log('[Seed] attachedMediaId:', attachedMediaId, '-> mediaItem:', mediaItem ? `type=${mediaItem.type} mime=${mediaItem.mimeType}` : 'NOT FOUND');
      if (mediaItem && mediaItem.type === 'image') {
        try {
          const imgPath = mediaLibrary.getOriginalPath(attachedMediaId);
          console.log('[Seed] Loading image from:', imgPath);
          const buf = await fs.promises.readFile(imgPath);
          imageBase64 = buf.toString('base64');
          imageMimeType = mediaItem.mimeType || 'image/jpeg';
          console.log('[Seed] Image loaded, base64 length:', imageBase64.length, 'mimeType:', imageMimeType);
        } catch (imgErr) {
          console.warn('[Seed] Could not load attached image for vision pass:', imgErr.message);
        }
      }
    } else {
      console.log('[Seed] No attachedMediaId or mediaLibrary not ready. attachedMediaId:', attachedMediaId, 'mediaLibrary:', !!mediaLibrary);
    }

    const segment = await scriptGenerator.expandDirectorNote(topic, { imageBase64, imageMimeType, attachedMediaId });
    // Attach manual SFX if provided
    if (sfxBefore || sfxAfter) {
      const newMeta = { ...(segment.metadata || {}) };
      if (sfxBefore) newMeta.sfxBefore = sfxBefore;
      if (sfxAfter)  newMeta.sfxAfter  = sfxAfter;
      await pipelineStore.updateSegment(segment.id, { metadata: newMeta });
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

    // Create a separate narrator-cue segment to read the viewer message aloud
    let narratorSeg = null;
    if (segment && pipelineStore) {
      const narratorText = message.substring(0, 120);
      narratorSeg = await pipelineStore.createSegment({
        type: 'narrator-cue',
        seed: message.substring(0, 50),
        script: [{ speaker: 'narrator', text: narratorText }],
        estimatedDuration: Math.max(1, Math.ceil(narratorText.split(/\s+/).length / 150 * 60)),
      });
      await pipelineStore.updateSegment(narratorSeg.id, {
        metadata: { ...(narratorSeg.metadata || {}), companionFor: segment.id }
      });
      // Tag the chat-response so expand chain skips it (narrator+chat pair)
      await pipelineStore.updateSegment(segment.id, {
        metadata: { ...(segment.metadata || {}), hasNarratorPair: true }
      });
    }

    if (orchestratorSocket) {
      orchestratorSocket.broadcast('segment:draft-ready', segment);
      if (narratorSeg) orchestratorSocket.broadcast('segment:draft-ready', narratorSeg);
    }
    broadcastPipelineUpdate();
    res.json({ ...segment, narratorSegmentId: narratorSeg?.id || null });
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

  const { mcap, volume, holders, allTimeHigh } = req.body || {};

  try {
    const generated = await scriptGenerator.generateHypeScript({ mcap, volume, holders, allTimeHigh });

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

// Attach or detach manual SFX before/after a segment
app.patch('/api/orchestrator/segments/:id/sfx', async (req, res) => {
  if (!pipelineStore) return res.status(503).json({ error: 'Pipeline not initialized' });
  const segment = pipelineStore.getSegment(req.params.id);
  if (!segment) return res.status(404).json({ error: 'Segment not found' });

  const { sfxBefore, sfxAfter } = req.body || {};
  const newMeta = { ...(segment.metadata || {}) };

  if (sfxBefore) newMeta.sfxBefore = sfxBefore; else delete newMeta.sfxBefore;
  if (sfxAfter)  newMeta.sfxAfter  = sfxAfter;  else delete newMeta.sfxAfter;

  await pipelineStore.updateSegment(req.params.id, { metadata: newMeta });
  broadcastPipelineUpdate();
  res.json({ success: true, segmentId: req.params.id, sfxBefore: sfxBefore || null, sfxAfter: sfxAfter || null });
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
    // narratorText reads the viewer's seed/message; fall back to response text if no seed
    const narratorText = (seed || text).substring(0, 120);

    // Create narrator-cue FIRST so it naturally precedes the response in pipeline order.
    const narratorSeg = await pipelineStore.createSegment({
      type: 'narrator-cue',
      seed: seed || text.substring(0, 50),
      script: [{ speaker: 'narrator', text: narratorText }],
      estimatedDuration: Math.max(1, Math.ceil(narratorText.split(/\s+/).length / 150 * 60))
    });

    // Create the character response segment second
    const responseSeg = await pipelineStore.createSegment({
      type: 'chat-response',
      seed: seed || text.substring(0, 50),
      script: [{ speaker: speaker.toLowerCase(), text }],
      estimatedDuration: Math.max(1, Math.ceil(text.split(/\s+/).length / 150 * 60))
    });

    try {
      await pipelineStore.updateSegment(responseSeg.id, {
        metadata: { ...(responseSeg.metadata || {}), priority: 'high', source: 'chat', hasNarratorPair: true }
      });
    } catch (_) {}

    // Jump the pair to the front: narrator right after on-air, response right after narrator.
    if (pipelineStore.prioritizeSegment) {
      try {
        await pipelineStore.prioritizeSegment(narratorSeg.id, {
          afterOnAir: true,
          avoidTransitionSplit: true
        });
        const narratorIdx = pipelineStore.getSegmentIndex(narratorSeg.id);
        if (narratorIdx !== -1) {
          await pipelineStore.insertAt(responseSeg.id, narratorIdx + 1);
        }
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

    console.log(`[Orchestrator] Queued narrator+response: ${narratorSeg.id} → ${responseSeg.id} (${speaker})`);
    broadcastPipelineUpdate();

    const queueFn = orchestrator?.queueSegmentWithBridge
      ? (id => orchestrator.queueSegmentWithBridge(id))
      : (id => segmentRenderer.queueRender(id));
    Promise.resolve(queueFn(narratorSeg.id)).catch(err => {
      console.error(`[Orchestrator] Narrator render failed for ${narratorSeg.id}: ${err.message}`);
    });
    Promise.resolve(segmentRenderer.queueRender(responseSeg.id)).catch(err => {
      console.error(`[Orchestrator] Response render failed for ${responseSeg.id}: ${err.message}`);
    });

    res.json({ queued: true, segmentId: responseSeg.id, narratorSegmentId: narratorSeg.id });
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

  // Check for a narrator-cue companion segment (created by expand-chat)
  const narratorCompanion = pipelineStore.getAllSegments().find(
    s => s.type === 'narrator-cue' && s.metadata?.companionFor === segmentId && s.status === 'forming'
  );

  // Accept immediately, render in background
  res.json({ id: segmentId, status: 'rendering', message: 'Render queued' });

  const queueFn = orchestrator?.queueSegmentWithBridge
    ? (id => orchestrator.queueSegmentWithBridge(id))
    : (id => segmentRenderer.queueRender(id));

  Promise.resolve((async () => {
    if (narratorCompanion) {
      // Prioritize response first so narrator ends up ahead of it
      if (pipelineStore.prioritizeSegment) {
        try { await pipelineStore.prioritizeSegment(segmentId, { afterOnAir: true, avoidTransitionSplit: true }); } catch (_) {}
        try { await pipelineStore.prioritizeSegment(narratorCompanion.id, { afterOnAir: true, avoidTransitionSplit: true }); } catch (_) {}
      }
      // Queue narrator through bridge machinery, response directly
      await queueFn(narratorCompanion.id);
      await segmentRenderer.queueRender(segmentId);
    } else {
      await queueFn(segmentId);
    }
    broadcastPipelineUpdate();
  })()).catch(err => {
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
  const { ct0, authToken, communityUrl, xHandle, pollIntervalMinutes } = req.body || {};
  const result = twitterIngest.setConfig({ ct0, authToken, communityUrl, xHandle, pollIntervalMinutes });
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

// ── X Live Chat API ───────────────────────────────────────────────────────────

// GET  /api/orchestrator/x-chat/status       → connection state
// POST /api/orchestrator/x-chat/connect      → { broadcastId } — start listening
// POST /api/orchestrator/x-chat/disconnect   → stop listening

app.get('/api/orchestrator/x-chat/status', (req, res) => {
  if (!xChatListener) return res.status(503).json({ error: 'X chat listener not initialized' });
  res.json(xChatListener.getStatus());
});

app.post('/api/orchestrator/x-chat/connect', async (req, res) => {
  if (!xChatListener) return res.status(503).json({ error: 'X chat listener not initialized' });
  const { broadcastId } = req.body || {};
  if (!broadcastId) return res.status(400).json({ error: 'broadcastId required' });
  try {
    await xChatListener.connect(broadcastId);
    res.json(xChatListener.getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orchestrator/x-chat/debug', async (req, res) => {
  if (!xChatListener) return res.status(503).json({ error: 'X chat listener not initialized' });
  try {
    const result = await xChatListener.debug();
    const buf = Buffer.from(result.screenshotBase64, 'base64');
    res.set('Content-Type', 'image/png').set('Cache-Control', 'no-store').send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orchestrator/x-chat/debug/info', async (req, res) => {
  if (!xChatListener) return res.status(503).json({ error: 'X chat listener not initialized' });
  try {
    const result = await xChatListener.debug();
    const { screenshotBase64, ...rest } = result;
    res.json(rest);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orchestrator/x-chat/disconnect', async (req, res) => {
  if (!xChatListener) return res.status(503).json({ error: 'X chat listener not initialized' });
  await xChatListener.disconnect();
  res.json(xChatListener.getStatus());
});

// ============== End X Live Chat API ==============

// ── Meme Segment API ──────────────────────────────────────────────────────────

// Accept any freeform text, send to /generate/freestyle, poll, and queue a segment.
// Fire-and-forget from the route: responds immediately, runs in background.
app.post('/api/orchestrator/meme/freestyle', async (req, res) => {
  console.log('[Meme] /freestyle endpoint hit, body:', JSON.stringify(req.body).slice(0, 200));
  if (!scriptGenerator || !pipelineStore || !mediaLibrary) {
    console.error('[Meme] /freestyle: pipeline not initialized — scriptGenerator:', !!scriptGenerator, 'pipelineStore:', !!pipelineStore, 'mediaLibrary:', !!mediaLibrary);
    return res.status(503).json({ error: 'Pipeline not initialized' });
  }
  const { text, userId } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  // Voting mode: add to voting pool
  if (!mimoEnabled) {
    const item = addToVotingPool(userId || 'chat', text.trim());
    return res.json({ ok: true, queued: false, voting: true, id: item?.id || null });
  }

  // Manual mode: route to intake queue for director approval
  if (!memeIntakeAutoMode) {
    const item = addToMemeIntake(userId || 'chat', text.trim());
    return res.json({ ok: true, queued: false, intake: true, id: item?.id || null });
  }

  // Auto mode: generate immediately
  res.json({ ok: true, queued: true });
  const memeJob = trackMemeJob(text.trim().slice(0, 60), userId || null);
  runMemeFromText(text.trim(), userId || null).then(() => {
    memeJob.done();
    broadcastPipelineUpdate();
  }).catch(err => {
    console.error('[Meme] Freestyle failed:', err.message);
    memeJob.fail(err.message);
    if (err.response) {
      console.error('[Meme] API response:', err.response.status, JSON.stringify(err.response.data || '').slice(0, 500));
    } else {
      console.error('[Meme] Stack:', err.stack);
    }
  });
});

app.post('/api/orchestrator/suggestion/submit', async (req, res) => {
  if (!scriptGenerator || !pipelineStore) {
    return res.status(503).json({ error: 'Pipeline not initialized' });
  }
  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  res.json({ ok: true, queued: true });
  runSuggestionSegment(text.trim()).catch(err => {
    console.error('[Suggestion] Segment failed:', err.message);
  });
});

async function runSuggestionSegment(text) {
  console.log(`[Suggestion] Generating reaction for: "${text.slice(0, 80)}"`);

  const generated = await scriptGenerator.generateSuggestionReactionScript({ text });

  // Narrator reads the suggestion aloud before characters react
  generated.script.unshift({
    speaker: 'narrator',
    text: `New community suggestion: ${text}`
  });

  const segment = await pipelineStore.createSegment({
    type: 'suggestion-reaction',
    seed: `Suggestion: ${text.slice(0, 100)}`,
    script: generated.script,
    estimatedDuration: generated.estimatedDuration
  });

  await pipelineStore.updateSegment(segment.id, {
    exitContext: generated.exitContext,
    metadata: { source: 'suggestion', suggestionText: text }
  });

  // Register for on-screen overlay (removed when segment becomes 'aired')
  suggestionSegmentTitles.set(segment.id, text);
  syncSuggestionQueueToCompositor();

  const queueFn = orchestrator?.queueSegmentWithBridge
    ? id => orchestrator.queueSegmentWithBridge(id)
    : id => segmentRenderer.queueRender(id);
  queueFn(segment.id);

  console.log(`[Suggestion] Segment ${segment.id} queued`);
  broadcastPipelineUpdate();
}

app.post('/api/orchestrator/meme/create', async (req, res) => {
  if (!scriptGenerator || !pipelineStore || !mediaLibrary) {
    return res.status(503).json({ error: 'Pipeline not initialized' });
  }

  const { virgin, chad, virgin_labels, chad_labels } = req.body || {};
  if (!virgin || !chad) return res.status(400).json({ error: 'virgin and chad are required' });

  const virginSeedLabels = Array.isArray(virgin_labels) ? virgin_labels.filter(Boolean) : [];
  const chadSeedLabels = Array.isArray(chad_labels) ? chad_labels.filter(Boolean) : [];

  const memeJob = trackMemeJob(`${virgin} vs ${chad}`.slice(0, 60));
  try {
    const result = await runMemeAndCreateSegment({ virgin, chad, virginSeedLabels, chadSeedLabels });
    memeJob.done();
    broadcastPipelineUpdate();
    res.json({ segmentId: result.segmentId, virginLabels: result.virginLabels, chadLabels: result.chadLabels });
  } catch (err) {
    console.error('[Meme] Create segment error:', err.message);
    memeJob.fail(err.message);
    res.status(500).json({ error: err.message });
  }
});

// Queue a segment from an already-generated meme in the library (skip submit/poll)
async function runMemeFromExistingJob(jobId) {
  if (!mediaLibrary) throw new Error('Media library not available');
  if (!scriptGenerator) throw new Error('Script generator not available');
  if (!pipelineStore) throw new Error('Pipeline store not available');

  const MEME_API = 'http://93.127.214.75:8000';
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
const MEME_LIBRARY_URL = 'http://93.127.214.75:8000';

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

// ── Meme Intake API ───────────────────────────────────────────────────────────

app.get('/api/meme-intake', (req, res) => {
  res.json({ items: Array.from(memeIntakeQueue.values()), auto: memeIntakeAutoMode, mimo: getMimoStatus() });
});

app.post('/api/meme-intake/mimo', (req, res) => {
  const { enabled } = req.body || {};
  mimoEnabled = typeof enabled === 'boolean' ? enabled : !mimoEnabled;
  console.log(`[MIMO] Mode: ${mimoEnabled ? 'ON (direct)' : 'OFF (voting)'}`);
  if (mimoEnabled) {
    // Cancel any active voting when switching back to MIMO ON
    if (memeVotingCountdown?.tickInterval) clearInterval(memeVotingCountdown.tickInterval);
    if (memeVotingCountdown?.timer) clearTimeout(memeVotingCountdown.timer);
    memeVotingCountdown = null;
    memeVotingState = 'idle';
    memeVotingPool.clear();
    memeVotingWinnerSegId = null;
  }
  broadcastMemeIntakeUpdate();
  syncVotingToCompositor();
  res.json(getMimoStatus());
});

app.post('/api/meme-intake/vote', (req, res) => {
  const { userId, number } = req.body || {};
  const ok = handleVoteMeme(userId || 'director', String(number));
  res.json({ ok });
});

app.post('/api/meme-intake/auto', (req, res) => {
  const { enabled } = req.body || {};
  memeIntakeAutoMode = typeof enabled === 'boolean' ? enabled : !memeIntakeAutoMode;
  console.log(`[MemeIntake] Auto mode: ${memeIntakeAutoMode}`);
  broadcastMemeIntakeUpdate();
  res.json({ auto: memeIntakeAutoMode });
});

app.post('/api/meme-intake/generate-all', (req, res) => {
  const items = Array.from(memeIntakeQueue.values());
  memeIntakeQueue.clear();
  broadcastMemeIntakeUpdate();
  items.forEach(item => processMemeIntakeItem(item));
  res.json({ ok: true, count: items.length });
});

app.post('/api/meme-intake/:id/generate', (req, res) => {
  const item = memeIntakeQueue.get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  memeIntakeQueue.delete(item.id);
  broadcastMemeIntakeUpdate();
  processMemeIntakeItem(item);
  res.json({ ok: true });
});

app.delete('/api/meme-intake/:id', (req, res) => {
  if (!memeIntakeQueue.has(req.params.id)) return res.status(404).json({ error: 'Not found' });
  memeIntakeQueue.delete(req.params.id);
  broadcastMemeIntakeUpdate();
  res.json({ ok: true });
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

// Ticker — multi-slot scrolling playlist
app.get('/ticker', (req, res) => {
  res.json({ messages: getTickerMessages(), currentIndex: getTickerCurrentIndex() });
});

// Set full messages array
app.post('/ticker', (req, res) => {
  const msgs = Array.isArray(req.body.messages) ? req.body.messages : [];
  setTickerMessages(msgs);
  res.json({ messages: getTickerMessages() });
});

// Add one slot
app.post('/ticker/add', (req, res) => {
  const msgs = getTickerMessages();
  msgs.push((req.body.text || '').trim());
  setTickerMessages(msgs);
  res.json({ messages: getTickerMessages(), index: getTickerMessages().length - 1 });
});

// Update slot at index
app.put('/ticker/:index', (req, res) => {
  const idx = parseInt(req.params.index);
  const msgs = getTickerMessages();
  if (idx >= 0 && idx < msgs.length) {
    msgs[idx] = (req.body.text || '').trim();
    setTickerMessages(msgs);
  }
  res.json({ messages: getTickerMessages() });
});

// Delete slot at index
app.delete('/ticker/:index', (req, res) => {
  const idx = parseInt(req.params.index);
  const msgs = getTickerMessages();
  if (idx >= 0 && idx < msgs.length) {
    msgs.splice(idx, 1);
    setTickerMessages(msgs);
  }
  res.json({ messages: getTickerMessages() });
});

// Clear all slots
app.delete('/ticker', (req, res) => {
  setTickerMessages([]);
  res.json({ messages: [] });
});

// Health check
app.get('/api/lists', (req, res) => {
  res.json({
    videos: { count: _cachedVideosList.length, items: _cachedVideosList },
    roadmap: { count: _cachedRoadmapList.length, items: _cachedRoadmapList }
  });
});

app.post('/api/lists/refresh', async (req, res) => {
  await pollExternalLists();
  res.json({
    videos: _cachedVideosList.length,
    roadmap: _cachedRoadmapList.length
  });
});

// Vote by 1-based index shown on stream — triggers glow, persists to :3007 best-effort
app.post('/api/lists/vote', async (req, res) => {
  const { list, index } = req.body; // list: 'video'|'roadmap', index: 1-based
  const idx = parseInt(index, 10) - 1;
  if (list === 'video') {
    if (idx < 0 || idx >= _cachedVideosList.length) return res.status(404).json({ error: 'Index out of range' });
    const item = _cachedVideosList[idx];
    triggerGlow('video', item.file);
    // Best-effort persist to external API (fire-and-forget)
    httpGetJson(`${EXTERNAL_API}/api/videos`).then(d => {
      const v = (d.videos || []).find(x => x.file === item.file);
      if (v) { _cachedVideosList[idx].votes = v.votes; setVideosList([..._cachedVideosList]); }
    }).catch(() => {});
    return res.json({ ok: true, title: item.title });
  }
  if (list === 'roadmap') {
    if (idx < 0 || idx >= _cachedRoadmapList.length) return res.status(404).json({ error: 'Index out of range' });
    const item = _cachedRoadmapList[idx];
    // Increment locally so the compositor updates immediately
    _cachedRoadmapList[idx].votes = (item.votes || 0) + 1;
    setRoadmapList([..._cachedRoadmapList]);
    triggerGlow('roadmap', item.id);
    return res.json({ ok: true, title: item.title, votes: _cachedRoadmapList[idx].votes });
  }
  res.status(400).json({ error: 'list must be video or roadmap' });
});

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

// Parse the standard /meme command format: "virgin X (labels) vs chad Y (labels)"
// Labels in parentheses are optional. Returns null if the text doesn't match.
function parseMemeText(text) {
  const match = text.trim().match(/^virgin\s+(.+?)\s+vs\.?\s+chad\s+(.+?)$/i);
  if (!match) return null;
  const parseSubject = part => {
    const lm = part.trim().match(/^(.+?)\s*\(([^)]+)\)$/);
    return lm
      ? { subject: lm[1].trim(), labels: lm[2].split(',').map(s => s.trim()).filter(Boolean) }
      : { subject: part.trim(), labels: [] };
  };
  const v = parseSubject(match[1]);
  const c = parseSubject(match[2]);
  if (!v.subject || !c.subject) return null;
  return { virgin: v.subject, chad: c.subject, virginLabels: v.labels, chadLabels: c.labels };
}

// Entry point for /meme chat command.
// Tries /generate/freestyle first (handles any input format) to extract virgin/chad.
// Falls back to local regex parsing of the standard "virgin X vs chad Y" format.
// Either way, delegates to runMemeAndCreateSegment (the proven /generate/raw path).
async function runMemeFromText(text, userId = null) {
  const MEME_API = 'http://93.127.214.75:8000';
  const axios = require('axios');

  let virgin = null, chad = null, virginSeedLabels = [], chadSeedLabels = [];

  // Attempt 1: /generate/freestyle — quick timeout, non-blocking fallback on any failure
  try {
    console.log(`[Meme] Freestyle parse attempt: "${text.slice(0, 80)}"`);
    const res = await axios.post(`${MEME_API}/generate/freestyle`, { text }, { timeout: 10000 });
    console.log('[Meme] Freestyle response:', JSON.stringify(res.data).slice(0, 300));
    const p = res.data?.parsed || {};
    if (p.virgin && p.chad) {
      virgin = p.virgin;
      chad = p.chad;
      console.log(`[Meme] Freestyle gave: virgin="${virgin}", chad="${chad}"`);
    } else {
      console.warn('[Meme] Freestyle missing parsed.virgin/chad — falling back to local parse');
    }
  } catch (err) {
    const detail = err.response
      ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data || '').slice(0, 150)}`
      : err.message;
    console.warn(`[Meme] Freestyle failed (${detail}) — falling back to local parse`);
  }

  // Attempt 2: local regex parse of the standard format
  if (!virgin || !chad) {
    const parsed = parseMemeText(text);
    if (!parsed) {
      throw new Error(
        `Cannot parse meme text: "${text.slice(0, 80)}". ` +
        `Use format: /meme virgin X vs chad Y`
      );
    }
    virgin = parsed.virgin;
    chad = parsed.chad;
    virginSeedLabels = parsed.virginLabels;
    chadSeedLabels = parsed.chadLabels;
    console.log(`[Meme] Local parse: virgin="${virgin}", chad="${chad}"`);
  }

  // Delegate to proven /generate/raw pipeline
  return runMemeAndCreateSegment({ virgin, chad, virginSeedLabels, chadSeedLabels, userId });
}

// Submit a job to the MemeFactory API, poll until done, fetch labels + image,
// generate a character reaction script, create a pipeline segment, and queue it.
async function runMemeAndCreateSegment({ virgin, chad, virginSeedLabels = [], chadSeedLabels = [], userId = null, _attempt = 1 }) {
  if (!mediaLibrary) throw new Error('Media library not available');
  if (!scriptGenerator) throw new Error('Script generator not available');
  if (!pipelineStore) throw new Error('Pipeline store not available');

  const MEME_API = 'http://93.127.214.75:8000';
  const POLL_INTERVAL_MS = 5000;
  const POLL_TIMEOUT_MS = 5 * 60 * 1000;
  const MAX_ATTEMPTS = 2;
  const axios = require('axios');

  console.log(`[Meme] Submitting job (attempt ${_attempt}): virgin="${virgin}", chad="${chad}"`);
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
    if (status === 'failed') {
      const apiErr = pollRes.data.error || 'unknown';
      if (_attempt < MAX_ATTEMPTS) {
        console.warn(`[Meme] Job failed (${apiErr}), retrying in 3s... (attempt ${_attempt + 1}/${MAX_ATTEMPTS})`);
        await new Promise(r => setTimeout(r, 3000));
        return runMemeAndCreateSegment({ virgin, chad, virginSeedLabels, chadSeedLabels, userId, _attempt: _attempt + 1 });
      }
      throw new Error(`Meme job failed: ${apiErr}`);
    }
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
      userId: userId || null,
      virginSubject: virgin,
      chadSubject: chad,
      virginLabels,
      chadLabels,
      attachedMediaId: item.id
    }
  });

  // Register title for stream overlay (removed when segment becomes 'aired')
  memeSegmentTitles.set(segment.id, `virgin ${virgin} vs chad ${chad}`);
  syncMemeQueueToCompositor();

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

  // Wrap createSegment to inject crazy flag when crazyMode is active
  const _origCreateSegment = pipelineStore.createSegment.bind(pipelineStore);
  pipelineStore.createSegment = async (data) => {
    if (crazyMode) {
      data = { ...data, metadata: { ...(data.metadata || {}), crazy: true } };
    }
    return _origCreateSegment(data);
  };

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
  if (STREAM_MODE === 'synced' && streamManager.setTVContentService && tvService) {
    streamManager.setTVContentService(tvService);
  }

  // SFX soundboard
  sfxService = new SfxService();
  sfxService.preloadAll().catch(err => console.warn('[SFX] Preload error:', err.message));
  if (STREAM_MODE === 'synced' && streamManager.setSFXService) {
    streamManager.setSFXService(sfxService);
    console.log('[SFX] Service attached to stream manager');
  }

  // SFX auto-matcher is wired AFTER orchestrator.init() below (segmentRenderer/playbackController are null here)

  // Restore scene settings (fire animation + lighting) and start fire timer
  try {
    if (fs.existsSync(SCENE_SETTINGS_PATH)) {
      const saved = JSON.parse(fs.readFileSync(SCENE_SETTINGS_PATH, 'utf8'));
      if (saved.fire) setFireState(saved.fire);
      if (saved.lighting) setLightingState(saved.lighting);
      if (saved.cycle) setDayCycle(saved.cycle);
      console.log('[Scene] Restored scene settings from', SCENE_SETTINGS_PATH);
    }
  } catch (err) {
    console.warn('[Scene] Failed to restore scene settings:', err.message);
  }
  restartFireTimer();
  restartDayCycleTimer();

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
    tvService,
    animationServerUrl,
    eventEmitter: orchestratorSocket,
    config: orchestratorConfig,
    onChatMessage: addChatMessage,
    onMemeCommand: (userId, text) => {
      if (!mimoEnabled) {
        // Voting mode: add to pool
        addToVotingPool(userId, text);
        return;
      }
      if (memeIntakeAutoMode) {
        console.log(`[MemeIntake] Auto — generating: "${text.slice(0, 60)}"`);
        const memeJob = trackMemeJob(text.slice(0, 60), userId);
        runMemeFromText(text, userId).then(() => {
          memeJob.done();
          broadcastPipelineUpdate();
        }).catch(err => {
          console.error('[Meme] Auto generation failed:', err.message);
          memeJob.fail(err.message);
        });
      } else {
        addToMemeIntake(userId, text);
      }
    },
    onVoteMemeCommand: (userId, numStr) => {
      handleVoteMeme(userId, numStr);
    }
  });

  orchestrator.init();
  scriptGenerator = orchestrator.scriptGenerator;
  bridgeGenerator = orchestrator.bridgeGenerator;
  fillerGenerator = orchestrator.fillerGenerator;
  segmentRenderer = orchestrator.segmentRenderer;
  playbackController = orchestrator.playbackController;
  chatIntake = orchestrator.chatIntake;
  console.log('[Orchestrator] Initialized');

  // SFX auto-matcher — must be wired AFTER orchestrator.init() so segmentRenderer/playbackController exist
  sfxMatcher = new SfxMatcher({ sfxService, openai, pipelineStore });
  segmentRenderer.setSfxMatcher(sfxMatcher);
  console.log('[SFX] Auto-matcher enabled');

  // sfxBefore (manual + auto pre) is handled in processQueue() before startPlayback,
  // so the SFX plays over silence rather than overlapping with segment audio.

  // Initialize Twitter ingest service
  twitterIngest = new TwitterIngestService({ tempDir: TEMP_DIR });
  console.log('[Twitter] Ingest service initialized');

  // Initialize X live chat listener
  xChatListener = new XChatListener({
    chatIntake: orchestrator.chatIntake,
    onMemeCommand: orchestrator.pumpChatListener?.onMemeCommand || null,
    onVoteMemeCommand: orchestrator.pumpChatListener?.onVoteMemeCommand || null,
    getCredentials: () => twitterIngest?.getCredentials() || null
  });
  const xBroadcastId = process.env.X_BROADCAST_ID;
  if (xBroadcastId) {
    xChatListener.connect(xBroadcastId).catch(err => {
      console.warn(`[XChat] Auto-connect failed: ${err.message}`);
    });
  }
  console.log('[XChat] Listener initialized' + (xBroadcastId ? ` — connecting to ${xBroadcastId}` : ' — no X_BROADCAST_ID set'));

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
    // For images, keep on screen for segment duration + buffer (min 15s)
    const duration = mediaItem.type === 'image'
      ? Math.max(15, (segment.estimatedDuration || 0) + 5)
      : undefined;
    tvService.clear();
    tvService.addItem({ type: mediaItem.type, source, mediaId, duration }).then(() => {
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
