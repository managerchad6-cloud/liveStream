const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Libvips thread pool: default 4 for Windows, 2 for VPS. Override with SHARP_CONCURRENCY env.
const defaultConcurrency = process.platform === 'win32' ? 4 : 2;
const sharpConcurrency = parseInt(process.env.SHARP_CONCURRENCY, 10);
sharp.concurrency(Number.isFinite(sharpConcurrency) && sharpConcurrency > 0 ? sharpConcurrency : defaultConcurrency);
console.log(`[Compositor] Sharp concurrency: ${sharp.concurrency()}`);

const ROOT_DIR = path.resolve(__dirname, '..');
const LAYERS_DIR = path.join(ROOT_DIR, 'exported-layers');
const MANIFEST_PATH = path.join(LAYERS_DIR, 'manifest.json');
const MASK_PATH = path.join(LAYERS_DIR, 'mask.png');
const EXPRESSION_LIMITS_PATH = path.join(ROOT_DIR, 'expression-limits.json');
const TICKER_SETTINGS_PATH = path.join(__dirname, 'ticker-settings.json');

// Friendszone font — embedded as base64 for SVG @font-face (librsvg picks it up)
const FRIENDSZONE_B64 = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, 'fonts', 'Friendszone.ttf')).toString('base64');
  } catch (e) {
    console.warn('[Compositor] Friendszone.ttf not found, falling back to system font');
    return null;
  }
})();
const FRIENDSZONE_FACE = FRIENDSZONE_B64
  ? `<defs><style>@font-face{font-family:'Friendszone';src:url('data:font/truetype;base64,${FRIENDSZONE_B64}');}</style></defs>`
  : '';
const FRIENDSZONE_FAMILY = FRIENDSZONE_B64 ? "'Friendszone', " : '';
console.log(`[Compositor] Friendszone font: ${FRIENDSZONE_B64 ? 'loaded' : 'not found'}`);

// ── Twemoji color emoji loader ────────────────────────────────────────────────
// librsvg's bundled fontconfig can't find system emoji fonts (e.g. Segoe UI Emoji),
// so we fetch Twemoji 72x72 PNGs and embed them as <image> elements in SVG.
const emojiImgCache = new Map(); // codepoint string (e.g. '1f3af') → base64 data URI

function emojiCodepoint(char) {
  return [...char]
    .map(c => c.codePointAt(0).toString(16))
    .filter(cp => cp !== 'fe0f') // drop variation selector-16
    .join('-');
}

async function loadEmoji(char) {
  const cp = emojiCodepoint(char); // normalize: strip variation selectors
  if (emojiImgCache.has(cp)) return emojiImgCache.get(cp);
  const dir = path.join(__dirname, 'fonts', 'emoji');
  const file = path.join(dir, `${cp}.png`);
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    const https = require('https');
    const url = `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/${cp}.png`;
    buf = await new Promise((res, rej) => {
      https.get(url, r => {
        const chunks = [];
        r.on('data', d => chunks.push(d));
        r.on('end', () => res(Buffer.concat(chunks)));
        r.on('error', rej);
      }).on('error', rej);
    });
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, buf); } catch {}
  }
  const uri = `data:image/png;base64,${buf.toString('base64')}`;
  emojiImgCache.set(cp, uri);
  return uri;
}

// Matches single emoji chars and ZWJ sequences (e.g. 👨‍🎨)
const EMOJI_RE = /\p{Extended_Pictographic}(?:\uFE0F)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F)?)*/gu;

function parseEmojiParts(str) {
  const parts = [];
  let last = 0;
  for (const m of str.matchAll(EMOJI_RE)) {
    if (m.index > last) parts.push({ t: 'text', v: str.slice(last, m.index) });
    parts.push({ t: 'emoji', v: m[0] });
    last = m.index + m[0].length;
  }
  if (last < str.length) parts.push({ t: 'text', v: str.slice(last) });
  return parts;
}

// Renders a mixed emoji+text title as SVG elements starting from (x, y).
// Emoji chars become <image> elements (Twemoji PNGs), text uses Friendszone.
function svgEmojiTitle({ text, x, y, fontSize, fill, fontFamily, fontWeight = '700', letterSpacing = '1.5', centerInWidth, groupShift = 0, emojiShift = 0 }) {
  const CHAR_W = fontSize * 0.62;  // approx advance per Friendszone char (used only for emoji placement)
  const EM_SZ  = Math.round(fontSize * 1.1);
  const EM_PAD = Math.round(fontSize * 0.22);
  const parts  = parseEmojiParts(text);
  const els    = [];

  if (centerInWidth != null) {
    // Text centered with SVG text-anchor="middle"; emoji placed to its left via estimate.
    // groupShift moves BOTH emoji and text right together as a unit.
    const textParts  = parts.filter(p => p.t === 'text');
    const emojiParts = parts.filter(p => p.t === 'emoji');
    const estTextHalfW = textParts.reduce((s, p) => s + p.v.trim().length * CHAR_W * 0.42, 0);
    const totalEmojiW  = emojiParts.length * (EM_SZ + EM_PAD);
    let emojiCx = Math.round(centerInWidth / 2 - estTextHalfW - totalEmojiW) + groupShift + emojiShift;
    const textX = Math.round(centerInWidth / 2) + groupShift;

    for (const p of parts) {
      if (p.t === 'emoji') {
        const uri = emojiImgCache.get(emojiCodepoint(p.v));
        const iy  = Math.round(y - EM_SZ * 0.82);
        if (uri) els.push(`<image x="${emojiCx}" y="${iy}" width="${EM_SZ}" height="${EM_SZ}" href="${uri}"/>`);
        else     els.push(`<text x="${emojiCx}" y="${y}" fill="${fill}" font-size="${fontSize}">${p.v}</text>`);
        emojiCx += EM_SZ + EM_PAD;
      } else {
        els.push(`<text x="${textX}" y="${y}" text-anchor="middle" fill="${fill}" font-family="${fontFamily}" font-size="${fontSize}" font-weight="${fontWeight}" letter-spacing="${letterSpacing}">${escapeSvgText(p.v.trim())}</text>`);
      }
    }
    return els.join('');
  }

  // Non-centered path: left-to-right from x
  let cx = x;
  for (const p of parts) {
    if (p.t === 'emoji') {
      const uri = emojiImgCache.get(emojiCodepoint(p.v));
      if (uri) {
        const iy = Math.round(y - EM_SZ * 0.82);
        els.push(`<image x="${Math.round(cx)}" y="${iy}" width="${EM_SZ}" height="${EM_SZ}" href="${uri}"/>`);
      } else {
        els.push(`<text x="${Math.round(cx)}" y="${y}" fill="${fill}" font-size="${fontSize}">${p.v}</text>`);
      }
      cx += EM_SZ + EM_PAD;
    } else {
      els.push(`<text x="${Math.round(cx)}" y="${y}" fill="${fill}" font-family="${fontFamily}" font-size="${fontSize}" font-weight="${fontWeight}" letter-spacing="${letterSpacing}">${escapeSvgText(p.v)}</text>`);
      cx += p.v.length * CHAR_W;
    }
  }
  return els.join('');
}

const PANEL_EMOJIS = ['🎯', '🌍', '😆', '⭐'];
Promise.all(PANEL_EMOJIS.map(loadEmoji))
  .then(() => console.log('[Compositor] Panel emojis loaded'))
  .catch(e => console.warn('[Compositor] Emoji load error:', e.message));

let manifest = null;
let scaledLayerBuffers = {};
let staticBaseBuffer = null; // Pre-composited static layers { data, info } raw RGBA
let frameCache = {};          // Cache for character state (raw RGBA buffers) - Level 2
const FRAME_CACHE_MAX = 50;   // Level 2 cache: expression base + phoneme + blink (raw = larger)
let lastOutputKey = null;     // Key of the last full output frame
let lastOutputBuffer = null;  // Last complete JPEG output buffer
let outputCache = {};         // Cache for full output frames (raw RGBA buffers)
const OUTPUT_CACHE_MAX = 10;  // Max cached output frames (raw RGBA = ~3.5MB each)
let exprLayerCache = {};      // Per-layer cache for shifted eyes / rotated brows
const EXPR_LAYER_CACHE_MAX = 300; // Max cached expression layer buffers
let exprBaseCache = {};       // Level 1 cache: staticBase + expression layers + nose → raw RGBA
let exprBaseInFlight = new Map();
let lastExprBaseKey = null;
let lastExprBaseBuffer = null;   // { data, info: {width, height, channels} }
const EXPR_BASE_CACHE_MAX = 25;   // Raw buffers are ~3.7MB vs ~0.5-1MB PNG, so fewer entries

// Committed-base pattern: the currently active expression base with pre-warmed L2 entries.
// On L1 miss we keep using the committed base (guaranteeing L2 hits) until the new base
// and its L2 pre-warm are both complete, then atomically swap.
let committedExprBaseKey = null;
let committedExprBaseBuffer = null; // { data, info } raw RGBA

// Pre-warm concurrency guard: at most one pre-warm batch in flight + one pending (latest-wins).
// Prevents >6 concurrent Sharp ops from stacking during heavy speech.
let _preWarmL2InFlight = false;
let _preWarmL2Pending = null; // null or { exprBaseCacheKey, exprBaseRaw, speakingChar }

// Speaking character tracking for L2 pre-warming
let currentSpeakingCharacter = null;
const OUTPUT_SCALE = 1/3; // Render at 1280x720 instead of 3840x2160
const JPEG_QUALITY = 80;  // Reduced from 90 for faster encoding
let outputWidth = 0;
let outputHeight = 0;
let staticLayerEntries = [];
let expressionLayerEntries = []; // Eye/eyebrow layers composited dynamically with offsets
let noseLayerEntries = [];       // Nose layers composited above eye_cover (z-order)
let staticBaseVersion = 0;

// Vertical offset applied to the TV group at load time (pixels at output resolution).
// Positive = move TV down. Adjust this to control how many panel item rows are visible above the TV.
const TV_Y_OFFSET = 21;

// TV viewport bounds (extracted from mask.png, scaled to output resolution)
let TV_VIEWPORT = null;
let currentTVFrame = null; // Current TV frame buffer for compositing
let tvContentVersion = 0;  // Stable content version: same buffer ref → same version (WeakMap-based)
let _lastTVFrameRef = null; // Last buffer passed to setTVFrame
const _tvFrameVersionMap = new WeakMap(); // Buffer → stable version number (GC-safe)
let _tvVersionCounter = 0; // Monotonic counter for assigning new version numbers
let tvReflectionBuffer = null; // TV reflection layer (composited above TV content)
let tvReflectionPos = { x: 0, y: 0 }; // Position of TV reflection layer
let tvFrameLayerBuffer = null; // TV physical frame layer (separate from upperStaticBuffer for slide animation)

// TV slide animation state
const tvSlide = {
  visible: true,       // logical target state
  offsetY: 0,          // current pixel offset (0=fully shown, TV_SLIDE_DIST=fully hidden)
  animFromY: 0,
  animToY: 0,
  animStartMs: 0,
  animDurMs: 1500,
};
const TV_SLIDE_DIST = 600; // px — enough to push content + reflection off-screen at 720p

function _tvEase(t, hiding) {
  // Hide: ease-in (gravity drop — slow start, fast finish)
  // Show: ease-out (decelerates into position)
  return hiding ? t * t * t : 1 - Math.pow(1 - t, 3);
}

function _tickTVSlide() {
  if (tvSlide.animFromY === tvSlide.animToY) return false;
  const elapsed = Date.now() - tvSlide.animStartMs;
  const t = Math.min(1, elapsed / tvSlide.animDurMs);
  const hiding = tvSlide.animToY > tvSlide.animFromY;
  const ease = _tvEase(t, hiding);
  tvSlide.offsetY = Math.round(tvSlide.animFromY + (tvSlide.animToY - tvSlide.animFromY) * ease);
  if (t >= 1) {
    tvSlide.offsetY = tvSlide.animToY;
    tvSlide.animFromY = tvSlide.animToY;
    lastOutputKey = null; // bust cache after animation settles
    return false;
  }
  return true;
}

function setTVVisible(visible) {
  if (tvSlide.visible === visible && tvSlide.animFromY === tvSlide.animToY) return;
  tvSlide.visible = visible;
  tvSlide.animFromY = tvSlide.offsetY;
  tvSlide.animToY = visible ? 0 : TV_SLIDE_DIST;
  tvSlide.animStartMs = Date.now();
  lastOutputKey = null;
}

function isTVVisible() {
  return tvSlide.visible;
}

// Chat overlay state (Twitch-style message log)
let chatMessages = [];       // Array of { character, text, addedAt }
let chatVersion = 0;         // Bumped on add/expire (cache invalidation)
const CHAT_MAX_MESSAGES = 8;
const CHAT_EXPIRE_MS = 45000; // 45 seconds

// Ticker state — scrolling bottom strip (multi-slot playlist)
let tickerMessages = [];       // array of strings, plays in order
let tickerCurrentIndex = 0;    // index into tickerMessages of currently playing slot
let tickerSlotStartMs = 0;     // when the current slot started scrolling
const TICKER_SPEED = 28;      // px/sec, right to left
const TICKER_FONT_SIZE = 20;  // px
const TICKER_HEIGHT = 36;     // px (≈5% of 720p)

// Meme queue overlay (top-right corner)
let memeQueueItems = [];  // Array of { segmentId, title }
let memeQueueVersion = 0; // Bumped on change (cache invalidation)
// Voting mode data (replaces queue display when MIMO is OFF)
let memeVotingData = null; // null | { state, pool: [{number,description,votes}], countdownSecs }

// Suggestion queue overlay (top-left corner)
let suggestionQueueItems = [];  // Array of { segmentId, title }
let suggestionQueueVersion = 0; // Bumped on change (cache invalidation)

// External lists — static panels in outer slots
let videosList = [];      // Array of { file, title, available, votes }
let videosListVersion = 0;
let roadmapList = [];     // Array of { id, title, votes }
let roadmapListVersion = 0;

// Glow state — tracks recently voted items for the flash effect
const GLOW_DURATION_MS  = 700;
const PLUS_ONE_DURATION_MS = 1700; // +1 lingers an extra second after glow fades
const GLOW_CLEANUP_MS   = Math.max(GLOW_DURATION_MS, PLUS_ONE_DURATION_MS);
const videosGlow = new Map(); // file -> glowStartMs
const roadmapGlow = new Map(); // id -> glowStartMs
const memeVoteGlow = new Map(); // proposal number -> glowStartMs

// Panel paging — shows ITEMS_PER_PAGE items at a time, crossfades to next batch after PAGE_SHOW_MS
const ITEMS_PER_PAGE = 6;
const PAGE_SHOW_MS   = 5000; // hold each page for 5 seconds
const PAGE_FADE_MS   = 700;  // crossfade duration between pages

const _pageState = {
  videos:   { page: 0, phase: 'show', phaseStartMs: 0, lastVersion: -1 },
  roadmap:  { page: 0, phase: 'show', phaseStartMs: 0, lastVersion: -1 },
  memeVote: { page: 0, phase: 'show', phaseStartMs: 0, lastVersion: -1 }
};

// Current resolved page/fadeT — set by tickPage() calls in compositeFrame,
// read by buildVideosListSvg / buildRoadmapListSvg (also called from async pre-raster)
let _videosPage = 0, _videosFadeT = 0;
let _roadmapPage = 0, _roadmapFadeT = 0;
let _memeVotePage = 0, _memeVoteFadeT = 0;

function tickPage(state, itemCount, listVersion, perPage = ITEMS_PER_PAGE) {
  const now = Date.now();
  // Reset when list is replaced
  if (state.lastVersion !== listVersion) {
    state.page = 0; state.phase = 'show'; state.phaseStartMs = now;
    state.lastVersion = listVersion;
  }
  if (!state.phaseStartMs) state.phaseStartMs = now;
  const totalPages = Math.max(1, Math.ceil(itemCount / perPage));
  const elapsed = now - state.phaseStartMs;
  if (totalPages > 1) {
    if (state.phase === 'show' && elapsed >= PAGE_SHOW_MS) {
      state.phase = 'fade'; state.phaseStartMs = now;
    } else if (state.phase === 'fade' && elapsed >= PAGE_FADE_MS) {
      state.page = (state.page + 1) % totalPages;
      state.phase = 'show'; state.phaseStartMs = now;
    }
  } else {
    state.page = 0; state.phase = 'show';
  }
  state.page = state.page % totalPages;
  const fadeT = state.phase === 'fade'
    ? Math.min(1, (now - state.phaseStartMs) / PAGE_FADE_MS)
    : 0;
  return { page: state.page, fadeT };
}

// Panel raster cache — pre-rasterized RGBA to avoid per-frame SVG rasterization.
// Each entry: { rgba: Buffer|null, width, height, left, top, key: string|null, pending: bool }
// Updated asynchronously: fired when the panel key changes, never awaited in the frame loop.
const _panelRaster = {
  videos:  { rgba: null, width: 0, height: 0, left: 0, top: 0, key: null, pending: false },
  roadmap: { rgba: null, width: 0, height: 0, left: 0, top: 0, key: null, pending: false },
  socialStats: { rgba: null, width: 0, height: 0, left: 0, top: 0, key: null, pending: false },
  tradeStats:  { rgba: null, width: 0, height: 0, left: 0, top: 0, key: null, pending: false }
};

// Token stat data pushed from server.js
let _tokenStatsPanelData = { social: null, trade: null };
let _tokenStatsVersion = 0;

function _maybeUpdatePanelRaster(name, buildFn, newKey) {
  const s = _panelRaster[name];
  if (s.key === newKey || s.pending) return; // already current or render in flight
  s.pending = true;
  const svgOp = buildFn();
  if (!svgOp) { s.rgba = null; s.key = newKey; s.pending = false; return; }
  sharp(svgOp.input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .then(({ data, info }) => {
      s.rgba   = data;
      s.width  = info.width;
      s.height = info.height;
      s.left   = svgOp.left;
      s.top    = svgOp.top;
      s.key    = newKey;
    })
    .catch(err => console.warn(`[Compositor] Panel raster failed (${name}):`, err.message))
    .finally(() => { s.pending = false; });
}

// Fire animation state
let fireState = { frame: 0, mode: 'circular', fps: 8, playing: true, pingPongDir: 1 };
let lightingState = { nightOpacity: 1.0, dayOpacity: 0.0 };
// Day/night auto cycle: advances a cosine angle to smoothly blend between night and day.
// dayOpacity = (1 - cos(angle)) / 2  →  angle=0 → night, angle=π → day, angle=2π → night again.
// advance rate = rpm * π / 60 rad/sec, so 2 RPM = one full day/night cycle per minute.
let dayCycleState = { enabled: false, rpm: 2, angle: 0, lastTickMs: 0 };
const fireFramePairs = [];       // [{ fire: entry, reflection: entry }, ...] x5
const lightingLayerBuffers = {}; // { No_Light, Night_Light, Day_Light } → { buffer, x, y, zIndex, scaledWidth, scaledHeight }
const lightingOpacityCache = {}; // { 'Night_Light': { opacity, buffer }, 'Day_Light': { opacity, buffer } }
let _baseRebuildInFlight = false;
let _baseRebuildDirty = false;
// Fire frame base cache: { [0..4]: { data, info } raw RGBA }
// Caches _buildBaseFromParts(n) so L1 misses only pay ~20ms (expression composite)
// instead of ~150ms (full scene rebuild). Cleared when staticBaseVersion increments.
let fireFrameBaseCache = {};
// Split static base: lowerStaticBase = Fondo only (raw RGBA, built once)
//                    upperStaticBuffer = TV + chars + props (transparent PNG, built once)
// Fire rebuild only composites ~6 layers instead of all 25+
let lowerStaticBase = null;
let upperStaticBuffer = null;

// Expression limits (loaded from expression-limits.json if it exists)
let expressionLimits = null;
try {
  if (fs.existsSync(EXPRESSION_LIMITS_PATH)) {
    expressionLimits = JSON.parse(fs.readFileSync(EXPRESSION_LIMITS_PATH, 'utf8'));
    console.log('[Compositor] Loaded expression limits from', EXPRESSION_LIMITS_PATH);
  }
} catch (err) {
  console.warn('[Compositor] Failed to load expression limits:', err.message);
}

try {
  if (fs.existsSync(TICKER_SETTINGS_PATH)) {
    const saved = JSON.parse(fs.readFileSync(TICKER_SETTINGS_PATH, 'utf8'));
    tickerMessages = (saved.messages || []).map(m => (m || '').trim());
    console.log('[Compositor] Loaded ticker messages from', TICKER_SETTINGS_PATH);
  }
} catch (err) {
  console.warn('[Compositor] Failed to load ticker settings:', err.message);
}

// Expression control (eye and eyebrow positions)
let expressionOffsets = {
  chad: {
    eyes: { x: 0, y: 0 },
    eyebrows: {
      x: 0,
      y: 0,
      rotation: 0,
      left: { y: 0, rotation: 0 },
      right: { y: 0, rotation: 0 },
      bias: { leftY: 0, rightY: 0 }
    }  // rotation in degrees, sent by frontend
  },
  virgin: {
    eyes: { x: 0, y: 0 },
    eyebrows: {
      x: 0,
      y: 0,
      rotation: 0,
      left: { y: 0, rotation: 0 },
      right: { y: 0, rotation: 0 },
      bias: { leftY: 0, rightY: 0 }
    }
  }
};
let expressionRotationTargets = {
  chad: { left: 0, right: 0 },
  virgin: { left: 0, right: 0 }
};
let lastExpressionUpdate = Date.now();

const EXPRESSION_LAYER_NAMES = new Set([
  'static_chad_eye_left',
  'static_chad_eye_right',
  'static_chad_eye_cover',
  'static_chad_eyebrow_left',
  'static_chad_eyebrow_right',
  'static_virgin_eye_left',
  'static_virgin_eye_right',
  'static_virgin_eye_cover',
  'static_virgin_eyebrow_left',
  'static_virgin_eyebrow_right'
]);

// Map expression layer IDs to their character + feature for offset lookup
// eye_cover layers map to null feature — they're dynamic for z-order but don't move
const EXPRESSION_LAYER_MAP = {
  'static_chad_eye_left': { character: 'chad', feature: 'eyes' },
  'static_chad_eye_right': { character: 'chad', feature: 'eyes' },
  'static_chad_eye_cover': null,
  'static_chad_eyebrow_left': { character: 'chad', feature: 'eyebrows' },
  'static_chad_eyebrow_right': { character: 'chad', feature: 'eyebrows' },
  'static_virgin_eye_left': { character: 'virgin', feature: 'eyes' },
  'static_virgin_eye_right': { character: 'virgin', feature: 'eyes' },
  'static_virgin_eye_cover': null,
  'static_virgin_eyebrow_left': { character: 'virgin', feature: 'eyebrows' },
  'static_virgin_eyebrow_right': { character: 'virgin', feature: 'eyebrows' }
};

// Nose layers are composited above eye_cover (drawn after expression layers)
const NOSE_LAYER_IDS = new Set(['static_virgin_nose', 'static_chad_nose']);

// Fire animation layers (managed separately, not in staticLayerEntries)
const FIRE_IDS = new Set([
  'Fire_1', 'Fire_2', 'Fire_3', 'Fire_4', 'Fire_5',
  'Fire_Reflection_1', 'Fire_Reflection_2', 'Fire_Reflection_3', 'Fire_Reflection_4', 'Fire_Reflection_5'
]);

// Background lighting layers (managed separately with per-opacity compositing)
const LIGHTING_IDS = new Set(['No_Light', 'Night_Light', 'Day_Light']);

// Eyebrow rotation: vertical-only movement with rotation derived from calibrated limits
const DEFAULT_EXPRESSION_RANGE = 20; // fallback symmetric range (pixels)
const DEFAULT_EYEBROW_ROTATION_UP = 10;   // degrees at max up
const DEFAULT_EYEBROW_ROTATION_DOWN = 10; // degrees at max down
const EXPRESSION_EASE_MS = 220;
const EYEBROW_LAYER_SIDES = {
  'static_chad_eyebrow_left': 'left',
  'static_chad_eyebrow_right': 'right',
  'static_virgin_eyebrow_left': 'left',
  'static_virgin_eyebrow_right': 'right'
};

function loadManifest() {
  if (!manifest) {
    if (!fs.existsSync(MANIFEST_PATH)) {
      throw new Error(`Manifest not found: ${MANIFEST_PATH}. Run 'node tools/export-psd.js' first.`);
    }
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    outputWidth = Math.round(manifest.width * OUTPUT_SCALE);
    outputHeight = Math.round(manifest.height * OUTPUT_SCALE);
    console.log(`Loaded manifest: ${manifest.layers.length} layers, ${manifest.width}x${manifest.height}`);

    // Debug: log mouth layers
    const mouthLayers = manifest.layers.filter(l => l.type === 'mouth');
    console.log('Mouth layers found:');
    mouthLayers.forEach(l => console.log(`  ${l.character} - ${l.phoneme}: ${l.id}`));

    const blinkLayers = manifest.layers.filter(l => l.type === 'blink');
    console.log('Blink layers found:');
    blinkLayers.forEach(l => console.log(`  ${l.character}: ${l.id}`));
  }
  return manifest;
}

/**
 * Extract TV viewport bounds from mask.png
 * Finds the bounding box of non-transparent pixels
 */
async function extractTVViewport() {
  if (!fs.existsSync(MASK_PATH)) {
    console.warn('[Compositor] mask.png not found, TV viewport disabled');
    return null;
  }

  try {
    const image = sharp(MASK_PATH);
    const { width, height, channels } = await image.metadata();

    // Get raw pixel data
    const { data } = await image.raw().toBuffer({ resolveWithObject: true });

    let minX = width, minY = height, maxX = 0, maxY = 0;
    let found = false;

    // Find bounding box of non-transparent pixels
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * channels;
        const alpha = channels === 4 ? data[idx + 3] : 255;

        if (alpha > 0) {
          found = true;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (!found) {
      console.warn('[Compositor] No non-transparent pixels found in mask.png');
      return null;
    }

    // Scale to output resolution
    const viewport = {
      x: Math.round(minX * OUTPUT_SCALE),
      y: Math.round(minY * OUTPUT_SCALE),
      width: Math.round((maxX - minX + 1) * OUTPUT_SCALE),
      height: Math.round((maxY - minY + 1) * OUTPUT_SCALE)
    };

    console.log(`[Compositor] TV viewport extracted: ${viewport.x},${viewport.y} ${viewport.width}x${viewport.height}`);
    return viewport;
  } catch (err) {
    console.error('[Compositor] Failed to extract TV viewport:', err.message);
    return null;
  }
}

/**
 * Find bounding box of non-transparent pixels in a full-frame PNG buffer.
 * Used to locate eyebrow content for rotation around its center.
 */
async function findContentBounds(pngBuffer, totalWidth, totalHeight) {
  const { data } = await sharp(pngBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let minX = totalWidth, minY = totalHeight, maxX = 0, maxY = 0;
  let found = false;

  for (let y = 0; y < totalHeight; y++) {
    for (let x = 0; x < totalWidth; x++) {
      if (data[(y * totalWidth + x) * 4 + 3] > 0) {
        found = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (!found) return null;
  const pad = 4;
  return {
    left: Math.max(0, minX - pad),
    top: Math.max(0, minY - pad),
    width: Math.min(totalWidth - Math.max(0, minX - pad), maxX - minX + 1 + pad * 2),
    height: Math.min(totalHeight - Math.max(0, minY - pad), maxY - minY + 1 + pad * 2)
  };
}

async function preloadLayers() {
  const m = loadManifest();
  outputWidth = Math.round(m.width * OUTPUT_SCALE);
  outputHeight = Math.round(m.height * OUTPUT_SCALE);

  // Extract TV viewport bounds from mask.png, then apply load-time vertical offset
  TV_VIEWPORT = await extractTVViewport();
  if (TV_VIEWPORT) TV_VIEWPORT.y += TV_Y_OFFSET;

  console.log('Preloading layer images...');

  // Separate static and dynamic layers
  const staticLayers = [];
  const dynamicLayers = [];
  staticLayerEntries = [];
  expressionLayerEntries = [];
  noseLayerEntries = [];
  fireFramePairs.length = 0;
  for (const k of Object.keys(lightingLayerBuffers)) delete lightingLayerBuffers[k];
  for (const k of Object.keys(lightingOpacityCache)) delete lightingOpacityCache[k];
  lowerStaticBase = null;
  upperStaticBuffer = null;
  tvFrameLayerBuffer = null;

  for (const layer of m.layers) {
    const layerPath = path.join(LAYERS_DIR, ...layer.path.split('/'));

    if (!fs.existsSync(layerPath)) {
      console.warn(`Warning: Layer not found: ${layerPath}`);
      continue;
    }

    try {
      const scaledWidth = Math.round(layer.width * OUTPUT_SCALE);
      const scaledHeight = Math.round(layer.height * OUTPUT_SCALE);

      if (scaledWidth > 0 && scaledHeight > 0) {
        const buffer = await sharp(layerPath)
          .resize(scaledWidth, scaledHeight)
          .png()
          .toBuffer();

        scaledLayerBuffers[layer.id] = buffer;

        // Categorize layer
        // TV frame — extracted from upperStaticBuffer so it can be animated (slide in/out)
        if (layer.id === 'TV') {
          tvFrameLayerBuffer = buffer;
          console.log('[Compositor] TV frame layer stored for slide animation');
        // TV Reflection is handled separately (composited above TV content)
        } else if (layer.id === 'TV_Reflection_') {
          tvReflectionBuffer = await applyOpacityToBuffer(
            buffer,
            { width: scaledWidth, height: scaledHeight },
            0.11
          );
          tvReflectionPos = {
            x: Math.round(layer.x * OUTPUT_SCALE),
            y: Math.round(layer.y * OUTPUT_SCALE)
          };
          console.log('[Compositor] TV Reflection layer stored for overlay');
        } else if (layer.id === 'mask') {
          // Mask is only used for viewport extraction, not rendering
          console.log('[Compositor] Mask layer excluded from rendering');
        } else if (layer.type === 'static' && layer.visible !== false && EXPRESSION_LAYER_NAMES.has(layer.id)) {
          // Expression layers (eyes/eyebrows/eye_cover) are composited dynamically with offsets
          // Ensure buffer matches output dimensions exactly (avoid rounding mismatches)
          let exprBuffer = buffer;
          if (scaledWidth !== outputWidth || scaledHeight !== outputHeight) {
            exprBuffer = await sharp(buffer)
              .resize(outputWidth, outputHeight, { fit: 'fill' })
              .png()
              .toBuffer();
          }
          const exprEntry = {
            ...layer,
            buffer: exprBuffer,
            scaledX: Math.round(layer.x * OUTPUT_SCALE),
            scaledY: Math.round(layer.y * OUTPUT_SCALE),
            scaledWidth: outputWidth,
            scaledHeight: outputHeight
          };

          // For eyebrow layers, find content bounds and store cropped buffer for rotation
          const eyebrowSide = EYEBROW_LAYER_SIDES[layer.id];
          if (eyebrowSide) {
            const bounds = await findContentBounds(exprBuffer, outputWidth, outputHeight);
            if (bounds) {
              exprEntry.eyebrowSide = eyebrowSide;
              exprEntry.contentBounds = bounds;
              exprEntry.croppedBuffer = await sharp(exprBuffer)
                .extract(bounds)
                .png()
                .toBuffer();
              console.log(`[Compositor] Eyebrow bounds for ${layer.id}: ${bounds.left},${bounds.top} ${bounds.width}x${bounds.height} (side: ${eyebrowSide})`);
            }
          }

          expressionLayerEntries.push(exprEntry);
          console.log(`[Compositor] Expression layer stored: ${layer.id} (${scaledWidth}x${scaledHeight})`);
        } else if (layer.type === 'static' && layer.visible !== false && NOSE_LAYER_IDS.has(layer.id)) {
          // Nose layers: composite above eye_cover (stored separately, drawn after expression layers)
          noseLayerEntries.push({
            ...layer,
            buffer,
            scaledX: Math.round(layer.x * OUTPUT_SCALE),
            scaledY: Math.round(layer.y * OUTPUT_SCALE),
            scaledWidth,
            scaledHeight
          });
          console.log(`[Compositor] Nose layer stored (above eye_cover): ${layer.id}`);
        } else if (FIRE_IDS.has(layer.id)) {
          // Fire animation layers — stored in scaledLayerBuffers only; fireFramePairs built below
          console.log(`[Compositor] Fire layer loaded: ${layer.id}`);
        } else if (LIGHTING_IDS.has(layer.id)) {
          // Background lighting layers — managed separately for per-opacity compositing
          lightingLayerBuffers[layer.id] = {
            buffer,
            x: layer.x,
            y: layer.y,
            zIndex: layer.zIndex,
            scaledWidth,
            scaledHeight
          };
          console.log(`[Compositor] Lighting layer stored: ${layer.id}`);
        } else if (layer.type === 'static' && layer.visible !== false) {
          staticLayers.push({ ...layer, buffer });
        } else {
          dynamicLayers.push(layer);
        }
      }
    } catch (err) {
      console.warn(`Warning: Could not load ${layer.id}:`, err.message);
    }
  }

  console.log(`Loaded ${staticLayers.length} static, ${dynamicLayers.length} dynamic layers`);

  // Build fire frame pairs (Fire_1..5 + Fire_Reflection_1..5)
  for (let i = 1; i <= 5; i++) {
    const fireBuf = scaledLayerBuffers[`Fire_${i}`];
    const refBuf = scaledLayerBuffers[`Fire_Reflection_${i}`];
    const fireLayer = m.layers.find(l => l.id === `Fire_${i}`);
    const refLayer = m.layers.find(l => l.id === `Fire_Reflection_${i}`);
    fireFramePairs.push({
      fire: fireLayer && fireBuf ? { buffer: fireBuf, x: fireLayer.x, y: fireLayer.y, zIndex: fireLayer.zIndex } : null,
      reflection: refLayer && refBuf ? { buffer: refBuf, x: refLayer.x, y: refLayer.y, zIndex: refLayer.zIndex } : null
    });
  }
  if (fireFramePairs.length === 5) {
    console.log('[Compositor] Fire animation: 5 frame pairs loaded');
  }

  staticLayerEntries = staticLayers;

  // Split staticLayerEntries into lower (below fire, zIndex < 4) and upper (above fire, zIndex > 13).
  // Lower = just Fondo (background). Upper = TV, characters, props.
  // These are each pre-composited ONCE and never rebuilt, making fire-frame updates cheap.
  console.log('Pre-compositing split static bases...');
  const lowerEntries = staticLayerEntries.filter(l => l.zIndex < 4);
  const upperEntries = staticLayerEntries.filter(l => l.zIndex > 13);

  lowerStaticBase = await buildStaticBaseFromEntries(lowerEntries);

  // Upper base uses a TRANSPARENT background so fire shows through any gaps
  const upperSorted = [...upperEntries].sort((a, b) => a.zIndex - b.zIndex);
  upperStaticBuffer = await sharp({
    create: { width: outputWidth, height: outputHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .composite(upperSorted.map(layer => ({
      input: layer.buffer,
      left: Math.round(layer.x * OUTPUT_SCALE),
      top: Math.round(layer.y * OUTPUT_SCALE),
      blend: 'over'
    })))
    .png()
    .toBuffer();
  console.log(`[Compositor] lowerEntries: ${lowerEntries.length}, upperEntries: ${upperEntries.length}`);

  // Build initial staticBaseBuffer from the split components (cheap path)
  staticBaseBuffer = await _buildBaseFromParts();
  staticBaseVersion += 1;
  frameCache = {};
  lastOutputKey = null;
  lastOutputBuffer = null;
  committedExprBaseKey = null;
  committedExprBaseBuffer = null;
  lastExprBaseKey = null;
  lastExprBaseBuffer = null;

  console.log(`Preloaded ${Object.keys(scaledLayerBuffers).length} layers, static base ready`);
}

function escapeSvgText(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function wrapCaptionText(text, maxCharsPerLine, maxLines) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxCharsPerLine) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = word;
      if (lines.length >= maxLines) break;
    }
    if (lines.length >= maxLines) break;
  }

  if (lines.length < maxLines && current) {
    lines.push(current);
  }

  if (lines.length > maxLines) {
    lines.length = maxLines;
  }

  if (lines.length === maxLines) {
    const last = lines[lines.length - 1];
    if (words.join(' ').length > lines.join(' ').length) {
      lines[lines.length - 1] = last.length > 1 ? `${last.slice(0, -1)}…` : '…';
    }
  }

  return lines;
}

function buildCaptionSvg(text) {
  if (!text || !outputWidth || !outputHeight) {
    return null;
  }

  const trimmed = text.trim().slice(0, 200);
  if (!trimmed) return null;

  const margin = 24;
  const padding = 18;
  const fontSize = 36;
  const lineHeight = Math.round(fontSize * 1.25);
  const maxLines = 2;
  const maxTextWidth = outputWidth - margin * 2 - padding * 2;
  const maxCharsPerLine = Math.max(10, Math.floor(maxTextWidth / (fontSize * 0.6)));

  const lines = wrapCaptionText(trimmed, maxCharsPerLine, maxLines);
  const textBlockHeight = lineHeight * lines.length;
  const bannerHeight = textBlockHeight + padding * 2;
  const bannerWidth = outputWidth - margin * 2;
  const bannerX = margin;
  const bannerY = outputHeight - margin - bannerHeight;
  const textX = bannerX + padding;
  const textY = bannerY + padding + fontSize;

  // Coordinates relative to the SVG's own origin (top-left = bannerX, bannerY in output)
  const relTextX = padding;
  const relTextY = padding + fontSize;
  const textLines = lines.map((line, index) => {
    const y = relTextY + index * lineHeight;
    return `<text x="${relTextX}" y="${y}">${escapeSvgText(line)}</text>`;
  }).join('');

  const svg = `
    <svg width="${bannerWidth}" height="${bannerHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${bannerWidth}" height="${bannerHeight}" rx="16" ry="16" fill="rgba(0,0,0,0.6)"/>
      <g fill="#ffffff" font-family="DejaVu Sans, Arial, sans-serif" font-size="${fontSize}" font-weight="600">
        ${textLines}
      </g>
    </svg>
  `;

  // Return composite op directly — caller uses { input, left, top } to position in output
  return { input: Buffer.from(svg), left: bannerX, top: bannerY };
}

/**
 * Build a compact key-value stats panel SVG.
 * rows = [{ label, value }]
 * Returns { input: Buffer, left, top } or null.
 */
function buildStatsPanelSvg({ rows, left, top, title }) {
  if (!outputWidth || !outputHeight || !rows || rows.length === 0) return null;

  const PAD_X    = 10;
  const PAD_Y    = 8;
  const TITLE_H  = title ? 22 : 0;
  const ROW_H    = 18;
  const FONT_SZ  = 11;
  const TITLE_SZ = 12;
  const PANEL_W  = 160;
  const PANEL_H  = PAD_Y * 2 + TITLE_H + rows.length * ROW_H;

  const titleEl = title
    ? `<text x="${PAD_X}" y="${PAD_Y + TITLE_SZ}" font-size="${TITLE_SZ}" font-weight="700" fill="#c8a84b" font-family="DejaVu Sans,Arial,sans-serif">${escapeSvgText(title)}</text>`
    : '';

  const rowEls = rows.map((r, i) => {
    const y = PAD_Y + TITLE_H + i * ROW_H + FONT_SZ + 2;
    const val = (r.value == null || r.value === '' || r.value === null) ? '\u2014' : String(r.value);
    return [
      `<text x="${PAD_X}" y="${y}" font-size="${FONT_SZ}" fill="#888" font-family="DejaVu Sans,Arial,sans-serif">${escapeSvgText(r.label)}</text>`,
      `<text x="${PANEL_W - PAD_X}" y="${y}" text-anchor="end" font-size="${FONT_SZ}" font-weight="600" fill="#e8e8e8" font-family="DejaVu Sans,Arial,sans-serif">${escapeSvgText(val)}</text>`
    ].join('');
  }).join('');

  const dividerY = PAD_Y + TITLE_H;
  const divider  = title ? `<line x1="${PAD_X}" y1="${dividerY}" x2="${PANEL_W - PAD_X}" y2="${dividerY}" stroke="#333" stroke-width="1"/>` : '';

  const svg = `<svg width="${PANEL_W}" height="${PANEL_H}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${PANEL_W}" height="${PANEL_H}" rx="8" ry="8" fill="rgba(8,8,14,0.78)"/>
  ${titleEl}${divider}${rowEls}
</svg>`;

  return { input: Buffer.from(svg), left, top };
}

function buildSocialStatsSvg() {
  const d = _tokenStatsPanelData.social;
  const rows = [
    { label: 'HOLDERS',   value: d?.holders     != null ? Number(d.holders).toLocaleString()   : null },
    { label: 'FOLLOWERS', value: d?.followers    != null ? Number(d.followers).toLocaleString() : null },
    { label: 'COMMUNITY', value: d?.communityMembers != null ? Number(d.communityMembers).toLocaleString() : null },
    { label: 'X POSTS',   value: d?.postCount    != null ? Number(d.postCount).toLocaleString()  : null },
  ];
  return buildStatsPanelSvg({ rows, left: 455, top: 520, title: 'SOCIAL' });
}

function buildTradeStatsSvg() {
  const d = _tokenStatsPanelData.trade;
  const fmt = (v) => v != null ? `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : null;
  const fmtPct = (v) => v != null ? `${Number(v).toFixed(2)}%` : null;
  const rows = [
    { label: 'BIG BUY 24H', value: fmt(d?.biggestBuy24h) },
    { label: 'BIG BUY 8H',  value: fmt(d?.biggestBuy8h)  },
    { label: 'BIG BUY 1H',  value: fmt(d?.biggestBuy1h)  },
    { label: 'CHG 5M',      value: fmtPct(d?.priceChange5m) },
  ];
  return buildStatsPanelSvg({ rows, left: 665, top: 520, title: 'TRADING' });
}

/**
 * Parse ticker text into segments, splitting on <h>...</h> highlight tags.
 * Returns [{ text, highlight }]
 */
function parseTickerSegments(raw) {
  const segments = [];
  const regex = /<h>(.*?)<\/h>/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: raw.slice(lastIndex, match.index), highlight: false });
    }
    segments.push({ text: match[1], highlight: true });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < raw.length) {
    segments.push({ text: raw.slice(lastIndex), highlight: false });
  }
  return segments;
}

/**
 * Build scrolling ticker SVG — black strip at bottom, text sliding right→left on loop.
 * Supports <h>text</h> tags to highlight sections in yellow (#D99A1C).
 * Plays tickerMessages in sequence, one full scroll cycle per slot, then advances.
 */
function buildTickerSvg() {
  if (!tickerMessages.length || !outputWidth || !outputHeight) return null;

  // Find the next non-empty slot starting from tickerCurrentIndex
  const findNextActive = (start) => {
    for (let i = 0; i < tickerMessages.length; i++) {
      const idx = (start + i) % tickerMessages.length;
      if (tickerMessages[idx] && tickerMessages[idx].trim()) return idx;
    }
    return -1;
  };

  const activeIdx = findNextActive(tickerCurrentIndex);
  if (activeIdx === -1) return null;

  // Snap to first available non-empty slot if current is empty
  if (activeIdx !== tickerCurrentIndex) {
    tickerCurrentIndex = activeIdx;
    tickerSlotStartMs = 0;
  }

  const currentText = tickerMessages[tickerCurrentIndex];
  const segments = parseTickerSegments(currentText);
  const plainLength = segments.reduce((n, s) => n + s.text.length, 0);
  const stripY = outputHeight - TICKER_HEIGHT;

  const estimatedTextWidth = Math.ceil(plainLength * TICKER_FONT_SIZE * 0.6);
  const cycleWidthPx = outputWidth + estimatedTextWidth;

  const now = Date.now();
  if (!tickerSlotStartMs) tickerSlotStartMs = now;

  // Static mode: pin text to left edge so it's fully readable
  let scrollX;
  if (TICKER_SPEED <= 0) {
    scrollX = 20; // left-aligned with padding
  } else {
    const cycleDurationMs = (cycleWidthPx / TICKER_SPEED) * 1000;
    const elapsed = now - tickerSlotStartMs;

    // Advance to next slot when this one completes a full scroll cycle
    if (elapsed >= cycleDurationMs) {
      const next = findNextActive(tickerCurrentIndex + 1);
      if (next !== -1 && next !== tickerCurrentIndex) {
        tickerCurrentIndex = next;
        tickerSlotStartMs = now;
        return buildTickerSvg(); // recurse with new slot
      }
      // Single active message: reset slot clock for seamless loop
      tickerSlotStartMs = now - (elapsed % cycleDurationMs);
    }

    scrollX = Math.round(outputWidth - ((now - tickerSlotStartMs) / cycleDurationMs) * cycleWidthPx);
  }
  // textY is relative to the strip SVG's own origin (top of strip = y=0 in the mini SVG)
  const textY = Math.round((TICKER_HEIGHT + TICKER_FONT_SIZE) / 2) - 2;

  // Render each segment as a <tspan> with its own fill — they flow inline automatically.
  // Pad highlight segments with spaces on each side where the adjacent segment doesn't already provide one.
  const tspans = segments.map((s, i) => {
    const fill = s.highlight ? '#D99A1C' : 'white';
    let text = s.text;
    if (s.highlight) {
      const prev = segments[i - 1];
      const next = segments[i + 1];
      if (!text.startsWith(' ') && !(prev && prev.text.endsWith(' '))) text = '\u00A0' + text;
      if (!text.endsWith(' ') && !(next && next.text.startsWith(' '))) text = text + '\u00A0';
    }
    return `<tspan fill="${fill}">${escapeSvgText(text)}</tspan>`;
  }).join('');

  // SVG is only TICKER_HEIGHT px tall — ~20x fewer pixels for librsvg to rasterize.
  // Positioned at stripY in the output via the composite op's `top` field.
  const svg = `<svg width="${outputWidth}" height="${TICKER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${outputWidth}" height="${TICKER_HEIGHT}" fill="black"/>
  <text x="${scrollX}" y="${textY}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${TICKER_FONT_SIZE}" font-weight="400" xml:space="preserve">${tspans}</text>
</svg>`;

  // Return composite op: input SVG + output position
  return { input: Buffer.from(svg), left: 0, top: stripY };
}

/**
/**
 * Set the current TV frame buffer for compositing
 * @param {Buffer|null} buffer - PNG buffer scaled to viewport size, or null to clear
 */
function setTVFrame(buffer) {
  if (buffer === _lastTVFrameRef) return; // identical ref — no change
  currentTVFrame = buffer;
  _lastTVFrameRef = buffer;
  if (buffer === null) {
    tvContentVersion = -1;
  } else if (_tvFrameVersionMap.has(buffer)) {
    // Buffer seen before (e.g. pan animation looping back to frame 0) — reuse stable version.
    // This lets the output cache hit on the 2nd+ cycle of a pan animation.
    tvContentVersion = _tvFrameVersionMap.get(buffer);
  } else {
    tvContentVersion = _tvVersionCounter++;
    _tvFrameVersionMap.set(buffer, tvContentVersion);
  }
}

/**
 * Get the current TV frame buffer
 * @returns {Buffer|null}
 */
function getTVFrame() {
  return currentTVFrame;
}

/**
 * Get TV viewport dimensions
 * @returns {Object|null} - {x, y, width, height} or null if not available
 */
function getTVViewport() {
  return TV_VIEWPORT;
}

/**
 * Add a viewer chat message to the overlay log.
 * Trims to CHAT_MAX_MESSAGES and bumps version for cache invalidation.
 */
function addChatMessage(username, text) {
  if (!username || !text) return;
  chatMessages.push({
    username: String(username).slice(0, 20),
    text: String(text).slice(0, 120),
    addedAt: Date.now()
  });
  if (chatMessages.length > CHAT_MAX_MESSAGES) {
    chatMessages = chatMessages.slice(-CHAT_MAX_MESSAGES);
  }
  chatVersion++;
  lastOutputKey = null; // Invalidate output fast path
}

/**
 * Get current chat version, lazy-expiring stale messages.
 * Called every frame — O(8) maximum, sub-microsecond.
 */
function getChatVersion() {
  const now = Date.now();
  const before = chatMessages.length;
  chatMessages = chatMessages.filter(m => (now - m.addedAt) < CHAT_EXPIRE_MS);
  if (chatMessages.length !== before) {
    chatVersion++;
    lastOutputKey = null;
  }
  return chatVersion;
}

// Returns "HH:MM" remaining until 17:00 CET/CEST each day.
function getNextReleaseCountdown() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (t) => parseInt(parts.find(p => p.type === t).value, 10);
  const elapsed = get('hour') * 3600 + get('minute') * 60 + get('second');
  let diff = 17 * 3600 - elapsed;
  if (diff <= 0) diff += 86400;
  const hh = Math.floor(diff / 3600);
  const mm = Math.floor((diff % 3600) / 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * Build the Videos list SVG — leftmost slot (slot 1).
 * Shows all available videos with a numerical index. Not cropped.
 */
// Shared helper — builds a paged list SVG for either panel.
// currentItems = items for the visible page, nextItems = items for the incoming page (during fade).
// fadeT = 0 (fully showing current) → 1 (fully showing next).
function buildListSvg({ currentItems, nextItems, fadeT, currentOffset = 0, nextOffset = 0, glowMap, glowKey, panelX, labelText, subText, rightAligned, emojiShift = 0, countdownText = null }) {
  if (!outputWidth || !outputHeight || currentItems.length === 0) return null;

  const PANEL_W       = Math.floor(outputWidth / 4);
  const PAD_X         = 12;
  const PAD_Y         = 8;
  const MARGIN        = 4;
  const TITLE_FONT    = 21;
  const SUBTITLE_FONT = 15;
  const TITLE_H       = subText ? 54 : 32;
  const ITEM_FONT     = 11;
  const ITEM_H        = 20;
  const MAX_CHARS     = 38;

  const panelY       = MARGIN;
  const relTitleY    = PAD_Y + TITLE_FONT;
  const relSubtitleY = relTitleY + SUBTITLE_FONT + 6;
  const relDividerY  = PAD_Y + TITLE_H;
  const maxPanelH   = Math.floor(outputHeight / 4) + 4;
  const clipH       = maxPanelH - relDividerY;
  const COUNTDOWN_H = countdownText ? 26 : 0;
  const svgH        = relDividerY + clipH + COUNTDOWN_H;
  const now         = Date.now();

  const cleanTitle = (s) => s.length > MAX_CHARS ? s.slice(0, MAX_CHARS - 1) + '\u2026' : s;

  const tx      = rightAligned ? PANEL_W - PAD_X : PAD_X;
  const anchor  = rightAligned ? 'end' : 'start';

  function renderRow(item, i, offsetY, globalI) {
    const rowY   = relDividerY + offsetY + i * ITEM_H;
    const textY  = rowY + ITEM_H - 4;
    const id     = item[glowKey];
    const num    = globalI + 1; // 1-based absolute index across all pages
    const text   = rightAligned
      ? `${cleanTitle(item.title)} .${num}`
      : `${num}. ${cleanTitle(item.title)}`;
    const glowAge  = glowMap.has(id) ? now - glowMap.get(id) : GLOW_CLEANUP_MS;
    const glowT    = glowAge < GLOW_DURATION_MS    ? 1 - glowAge / GLOW_DURATION_MS    : 0; // glow: 700ms
    const plusT    = glowAge < PLUS_ONE_DURATION_MS ? 1 - glowAge / PLUS_ONE_DURATION_MS : 0; // +1: 1700ms
    const glowOp   = glowT * 0.55;
    const glow     = glowOp > 0
      ? `<rect x="0" y="${rowY}" width="${PANEL_W}" height="${ITEM_H}" fill="rgba(255,210,60,${glowOp.toFixed(3)})"/>`
      : '';
    // Single +1 particle — stays clearly next to its row, fun but contained
    const plusOne = plusT > 0
      ? (() => {
          const seed = glowMap.get(id) || 0;
          const rA = (seed * 9301    + 49297)    % 233280    / 233280;
          const rB = (seed * 1234567 + 7654321)  % 999983    / 999983;

          // Pop-in over first 120ms
          const popT     = Math.min(1, glowAge / 120);
          const fontSize = Math.round((14 + rA * 4) * (0.4 + popT * 0.6)); // 14–18px

          // Flush to the outer screen edge of the panel
          // Videos (right panel): x near PANEL_W. Roadmap (left panel): x near 0.
          // Sway goes inward only (away from screen edge) so it always reads as "on the edge".
          const edgeX  = rightAligned ? 3 : PANEL_W - 3;
          const sway   = Math.abs(Math.sin(glowAge * (0.007 + rB * 0.004) + rA * Math.PI * 2)) * (5 + rA * 7);
          const finalX = Math.round(rightAligned ? edgeX + sway : edgeX - sway);

          // Gentle float upward — max 7px, well within the row's vertical space
          const floatY = Math.round((1 - plusT) * 7);
          const finalY = textY - floatY;

          // Opacity: snappy pop-in, hold near full, then fade
          const op = Math.min(1, popT * 3) * plusT;

          const pAnchor = rightAligned ? 'start' : 'end';
          return `<text x="${finalX}" y="${finalY}" text-anchor="${pAnchor}" fill="rgba(255,220,40,${op.toFixed(3)})" font-family="DejaVu Sans, Arial, sans-serif" font-size="${fontSize}" font-weight="900" stroke="rgba(0,0,0,0.5)" stroke-width="1.5" paint-order="stroke">+1</text>`;
        })()
      : '';
    // Vote count: inline tspan before title for videos; separate right-edge element for roadmap
    const votes = item.votes != null ? item.votes : null;
    let votePrefix = '', voteExtraEl = '';
    if (votes !== null) {
      const vOp = Math.min(1, 0.75 + glowT * 0.25).toFixed(3);
      const voteStr = `(${votes} votes)`;
      if (rightAligned) {
        // Videos: separate element on the left edge of the panel
        voteExtraEl = `<text x="${PAD_X}" y="${textY}" text-anchor="start" fill="rgba(255,165,55,${vOp})" font-family="DejaVu Sans, Arial, sans-serif" font-size="${ITEM_FONT}" font-weight="600">${voteStr}</text>`;
      } else {
        // Roadmap: separate element pushed to the right edge of the panel
        voteExtraEl = `<text x="${PANEL_W - PAD_X}" y="${textY}" text-anchor="end" fill="rgba(255,165,55,${vOp})" font-family="DejaVu Sans, Arial, sans-serif" font-size="${ITEM_FONT}" font-weight="600">${voteStr}</text>`;
      }
    }
    return `${glow}${plusOne}<text x="${tx}" y="${textY}" text-anchor="${anchor}" fill="rgba(255,255,255,0.85)" font-family="DejaVu Sans, Arial, sans-serif" font-size="${ITEM_FONT}" font-weight="400">${votePrefix}${escapeSvgText(text)}</text>${voteExtraEl}`;
  }

  const currentRows = currentItems.map((item, i) => renderRow(item, i, 0, currentOffset + i)).join('');
  const nextRows    = fadeT > 0 && nextItems.length > 0
    ? nextItems.map((item, i) => renderRow(item, i, 0, nextOffset + i)).join('')
    : '';

  const curOp  = (1 - fadeT).toFixed(3);
  const nextOp = fadeT.toFixed(3);

  const lineX1 = PAD_X, lineX2 = PANEL_W - PAD_X;
  const subtitleEl = subText
    ? `<text x="${PANEL_W / 2}" y="${relSubtitleY}" text-anchor="middle" fill="rgba(255,165,55,0.75)" font-family="DejaVu Sans, Arial, sans-serif" font-size="${SUBTITLE_FONT}" font-weight="400">${escapeSvgText(subText)}</text>`
    : '';
  const titleEl = svgEmojiTitle({ text: labelText, y: relTitleY, fontSize: TITLE_FONT, fill: 'rgba(255,255,255,0.45)', fontFamily: `${FRIENDSZONE_FAMILY}DejaVu Sans, Arial, sans-serif`, centerInWidth: PANEL_W, emojiShift });
  const countdownEl = countdownText
    ? `<text x="${PANEL_W / 2}" y="${svgH - 4}" text-anchor="middle" fill="rgba(255,255,255,0.75)" font-family="${FRIENDSZONE_FAMILY}DejaVu Sans, Arial, sans-serif" font-size="15" font-weight="400" letter-spacing="0.5">${escapeSvgText('next video release in ' + countdownText)}</text>`
    : '';
  const svg = `<svg width="${PANEL_W}" height="${svgH}" xmlns="http://www.w3.org/2000/svg">
    ${FRIENDSZONE_FACE}
    ${titleEl}
    ${subtitleEl}
    <line x1="${lineX1}" y1="${relDividerY}" x2="${lineX2}" y2="${relDividerY}" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
    <g opacity="${curOp}">${currentRows}</g>
    ${nextRows ? `<g opacity="${nextOp}">${nextRows}</g>` : ''}
    ${countdownEl}
  </svg>`;

  return { input: Buffer.from(svg), left: panelX, top: panelY };
}

// Videos — right slot (slot 4)
function buildVideosListSvg() {
  if (!videosList.length) return null;
  const totalPages   = Math.max(1, Math.ceil(videosList.length / ITEMS_PER_PAGE));
  const page         = _videosPage;
  const fadeT        = _videosFadeT;
  const nextPage     = (page + 1) % totalPages;
  const currentItems = videosList.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE);
  const nextItems    = videosList.slice(nextPage * ITEMS_PER_PAGE, (nextPage + 1) * ITEMS_PER_PAGE);
  return buildListSvg({
    currentItems, nextItems, fadeT,
    currentOffset:  page * ITEMS_PER_PAGE,
    nextOffset:     nextPage * ITEMS_PER_PAGE,
    glowMap:        videosGlow,
    glowKey:        'file',
    panelX:         Math.floor(outputWidth * 3 / 4),
    labelText:      '⭐️ Videos',
    subText:        '(Vote for next release: /video 1)',
    rightAligned:   false,
    emojiShift:     4,
    countdownText:  getNextReleaseCountdown(),
  });
}

// Roadmap — left slot (slot 1), left-aligned
function buildRoadmapListSvg() {
  if (!roadmapList.length) return null;
  const totalPages   = Math.max(1, Math.ceil(roadmapList.length / ITEMS_PER_PAGE));
  const page         = _roadmapPage;
  const fadeT        = _roadmapFadeT;
  const nextPage     = (page + 1) % totalPages;
  const currentItems = roadmapList.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE);
  const nextItems    = roadmapList.slice(nextPage * ITEMS_PER_PAGE, (nextPage + 1) * ITEMS_PER_PAGE);
  return buildListSvg({
    currentItems, nextItems, fadeT,
    currentOffset: page * ITEMS_PER_PAGE,
    nextOffset:    nextPage * ITEMS_PER_PAGE,
    glowMap:       roadmapGlow,
    glowKey:       'id',
    panelX:        0,
    labelText:     '🎯 Roadmap',
    subText:       '(Vote for next implementation: /roadmap 1)',
    rightAligned:  false,
    emojiShift:    -5,
  });
}

/**
 * Build the "Queued Memes" panel SVG — inner-right slot.
 * Newest items at top; items approaching the TV edge fade out.
 * Returns { input, left, top } or null if queue is empty.
 */
function buildMemeQueueSvg() {
  if (!outputWidth || !outputHeight) return null;

  const PANEL_W       = Math.floor(outputWidth / 4);
  const PAD_X         = 12;
  const PAD_Y         = 8;
  const MARGIN        = 4;
  const TITLE_FONT    = 21;
  const SUBTITLE_FONT = 15;
  const TITLE_H       = 54;
  const ITEM_FONT     = 11;
  const ITEM_H        = 20;
  const MAX_CHARS     = 36;

  const panelX = Math.floor(outputWidth / 2);
  const panelY = MARGIN;
  const delimiterY   = (TV_VIEWPORT ? TV_VIEWPORT.y : 130) - panelY;
  const relTitleY    = PAD_Y + TITLE_FONT;
  const relSubtitleY = relTitleY + SUBTITLE_FONT + 6;
  const relDividerY  = PAD_Y + TITLE_H;

  // ── Voting mode ──────────────────────────────────────────────────────────
  if (memeVotingData && memeVotingData.state !== 'idle') {
    const { state, pool, countdownSecs, winner } = memeVotingData;
    const isRolling = state === 'rolling';

    const cdStr = (!isRolling && countdownSecs != null)
      ? ' (' + Math.floor(countdownSecs / 60) + ':' + String(countdownSecs % 60).padStart(2, '0') + ')'
      : '';
    const titleText = '😆 Meme Vote' + cdStr;

    const cleanDesc = (s) => {
      const stripped = s.trim();
      return stripped.length > MAX_CHARS ? stripped.slice(0, MAX_CHARS - 1) + '…' : stripped;
    };

    const now = Date.now();

    // ── Rolling state: show winner prominently ───────────────────────────────
    if (isRolling && winner) {
      const subtitleText = 'Rolling out winner...';
      const winnerDesc = cleanDesc(winner.description);
      const winnerVotes = '(' + winner.votes + ' vote' + (winner.votes !== 1 ? 's' : '') + ')';
      const rowY = relDividerY;
      const y = rowY + ITEM_H - 4;
      // Persistent golden glow on winner row
      const glowRect = '<rect x="0" y="' + rowY + '" width="' + PANEL_W + '" height="' + ITEM_H + '" fill="rgba(255,210,60,0.22)"/>';
      const winnerRow =
        glowRect +
        '<text x="' + PAD_X + '" y="' + y + '" text-anchor="start" fill="rgba(255,235,120,1)" font-family="DejaVu Sans, Arial, sans-serif" font-size="' + ITEM_FONT + '" font-weight="700">' + escapeSvgText('#' + winner.number + '. ' + winnerDesc) + '</text>' +
        '<text x="' + (PANEL_W - PAD_X) + '" y="' + y + '" text-anchor="end" fill="rgba(255,165,55,1)" font-family="DejaVu Sans, Arial, sans-serif" font-size="' + ITEM_FONT + '" font-weight="600">' + escapeSvgText(winnerVotes) + '</text>';
      const rollingH = Math.min(relDividerY + ITEM_H + PAD_Y, delimiterY);
      const rollingSvg = '<svg width="' + PANEL_W + '" height="' + rollingH + '" xmlns="http://www.w3.org/2000/svg">' +
        FRIENDSZONE_FACE +
        svgEmojiTitle({ text: titleText, y: relTitleY, fontSize: TITLE_FONT, fill: 'rgba(255,255,255,0.45)', fontFamily: FRIENDSZONE_FAMILY + 'DejaVu Sans, Arial, sans-serif', centerInWidth: PANEL_W, groupShift: Math.round(TITLE_FONT * 0.33) }) +
        '<text x="' + (PANEL_W / 2) + '" y="' + relSubtitleY + '" text-anchor="middle" fill="rgba(255,165,55,0.75)" font-family="DejaVu Sans, Arial, sans-serif" font-size="' + SUBTITLE_FONT + '" font-weight="400">' + escapeSvgText(subtitleText) + '</text>' +
        '<line x1="' + PAD_X + '" y1="' + relDividerY + '" x2="' + (PANEL_W - PAD_X) + '" y2="' + relDividerY + '" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>' +
        winnerRow +
        '</svg>';
      return { input: Buffer.from(rollingSvg), left: panelX, top: panelY };
    }

    // ── Voting state: paginated pool ─────────────────────────────────────────
    const subtitleText = '(/voteMeme 1, 2, 3...)';

    const renderVotePageItems = (items) => {
      const rows = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const rowY = relDividerY + i * ITEM_H;
        const y = rowY + ITEM_H - 4;
        const voteStr = '(' + item.votes + ' votes)';

        const glowAge = memeVoteGlow.has(item.number) ? now - memeVoteGlow.get(item.number) : GLOW_CLEANUP_MS;
        const glowT   = glowAge < GLOW_DURATION_MS     ? 1 - glowAge / GLOW_DURATION_MS     : 0;
        const plusT   = glowAge < PLUS_ONE_DURATION_MS ? 1 - glowAge / PLUS_ONE_DURATION_MS : 0;
        const glowOp  = glowT * 0.55;
        const glowRect = glowOp > 0
          ? '<rect x="0" y="' + rowY + '" width="' + PANEL_W + '" height="' + ITEM_H + '" fill="rgba(255,210,60,' + glowOp.toFixed(3) + ')"/>'
          : '';
        let plusOne = '';
        if (plusT > 0) {
          const seed = memeVoteGlow.get(item.number) || 0;
          const rA   = (seed * 9301    + 49297)   % 233280 / 233280;
          const rB   = (seed * 1234567 + 7654321) % 999983 / 999983;
          const popT = Math.min(1, glowAge / 120);
          const fontSize = Math.round((14 + rA * 4) * (0.4 + popT * 0.6));
          const sway = Math.abs(Math.sin(glowAge * (0.007 + rB * 0.004) + rA * Math.PI * 2)) * (5 + rA * 7);
          const rise = glowAge * (0.04 + rA * 0.03);
          const pX   = PANEL_W - PAD_X - sway;
          const pY   = y - rise;
          const pOp  = (plusT * plusT).toFixed(3);
          plusOne = '<text x="' + pX.toFixed(1) + '" y="' + pY.toFixed(1) + '" text-anchor="end" fill="rgba(255,220,40,' + pOp + ')" font-family="DejaVu Sans, Arial, sans-serif" font-size="' + fontSize + '" font-weight="900" stroke="rgba(0,0,0,0.5)" stroke-width="1.5" paint-order="stroke">+1</text>';
        }

        const vOp = Math.min(1, 0.85 + glowT * 0.15).toFixed(3);
        rows.push(
          glowRect +
          '<text x="' + PAD_X + '" y="' + y + '" text-anchor="start" fill="rgba(255,255,255,0.85)" font-family="DejaVu Sans, Arial, sans-serif" font-size="' + ITEM_FONT + '" font-weight="400">' + escapeSvgText('#' + item.number + '. ' + cleanDesc(item.description)) + '</text>' +
          '<text x="' + (PANEL_W - PAD_X) + '" y="' + y + '" text-anchor="end" fill="rgba(255,165,55,' + vOp + ')" font-family="DejaVu Sans, Arial, sans-serif" font-size="' + ITEM_FONT + '" font-weight="600">' + escapeSvgText(voteStr) + '</text>' +
          plusOne
        );
      }
      return rows.join('');
    };

    // How many items fit in the available vertical space
    const perPage = Math.max(1, Math.floor((delimiterY - relDividerY) / ITEM_H));
    const totalVotePages = Math.max(1, Math.ceil(pool.length / perPage));
    const curPage = _memeVotePage % totalVotePages;
    const nxtPage = (curPage + 1) % totalVotePages;
    const fadeT   = _memeVoteFadeT;
    const curItems = pool.slice(curPage * perPage, (curPage + 1) * perPage);
    const nxtItems = pool.slice(nxtPage * perPage, (nxtPage + 1) * perPage);

    const curGroup = '<g opacity="' + (1 - fadeT).toFixed(3) + '">' + renderVotePageItems(curItems) + '</g>';
    const nxtGroup = fadeT > 0
      ? '<g opacity="' + fadeT.toFixed(3) + '">' + renderVotePageItems(nxtItems) + '</g>'
      : '';

    const votePanelH = Math.min(relDividerY + perPage * ITEM_H + PAD_Y, delimiterY);
    const voteSvg = '<svg width="' + PANEL_W + '" height="' + votePanelH + '" xmlns="http://www.w3.org/2000/svg">' +
      FRIENDSZONE_FACE +
      svgEmojiTitle({ text: titleText, y: relTitleY, fontSize: TITLE_FONT, fill: 'rgba(255,255,255,0.45)', fontFamily: FRIENDSZONE_FAMILY + 'DejaVu Sans, Arial, sans-serif', centerInWidth: PANEL_W, groupShift: Math.round(TITLE_FONT * 0.33) }) +
      '<text x="' + (PANEL_W / 2) + '" y="' + relSubtitleY + '" text-anchor="middle" fill="rgba(255,165,55,0.75)" font-family="DejaVu Sans, Arial, sans-serif" font-size="' + SUBTITLE_FONT + '" font-weight="400">' + escapeSvgText(subtitleText) + '</text>' +
      '<line x1="' + PAD_X + '" y1="' + relDividerY + '" x2="' + (PANEL_W - PAD_X) + '" y2="' + relDividerY + '" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>' +
      curGroup + nxtGroup +
      '</svg>';
    return { input: Buffer.from(voteSvg), left: panelX, top: panelY };
  }

  // ── Normal MIMO queue ────────────────────────────────────────────────────
  const items = memeQueueItems.slice(0, 20);

  const cleanTitle = (s) => {
    const stripped = s.replace(/\s*\([^)]*\)/g, '').trim();
    return stripped.length > MAX_CHARS ? stripped.slice(0, MAX_CHARS - 1) + '…' : stripped;
  };

  let lastIdx = -1;
  for (let i = 0; i < items.length; i++) {
    if (relDividerY + i * ITEM_H >= delimiterY) break;
    lastIdx = i;
  }

  const itemRows = [];
  for (let i = 0; i <= lastIdx; i++) {
    const itemBottomRel = relDividerY + (i + 1) * ITEM_H;
    const distFromLimit = delimiterY - itemBottomRel;
    const op = (i === lastIdx)
      ? Math.min(1.0, Math.max(0.05, distFromLimit / ITEM_H))
      : 1.0;

    const y      = relDividerY + (i + 1) * ITEM_H - 4;
    const weight = i === 0 ? '600' : '400';
    const fill   = i === 0 ? '#ffffff' : 'rgba(255,255,255,0.85)';
    itemRows.push('<text x="' + PAD_X + '" y="' + y + '" fill="' + fill + '" font-family="DejaVu Sans, Arial, sans-serif" font-size="' + ITEM_FONT + '" font-weight="' + weight + '" opacity="' + op.toFixed(2) + '">' + escapeSvgText(cleanTitle(items[i].title)) + '</text>');
  }

  const panelH = Math.min(PAD_Y + TITLE_H + Math.max(items.length, 0) * ITEM_H + PAD_Y, delimiterY);

  const svgParts = [
    '<svg width="' + PANEL_W + '" height="' + panelH + '" xmlns="http://www.w3.org/2000/svg">',
    FRIENDSZONE_FACE,
    svgEmojiTitle({ text: '😆 Queued Memes', y: relTitleY, fontSize: TITLE_FONT, fill: 'rgba(255,255,255,0.45)', fontFamily: FRIENDSZONE_FAMILY + 'DejaVu Sans, Arial, sans-serif', centerInWidth: PANEL_W, groupShift: Math.round(TITLE_FONT * 0.33) }),
    '<text x="' + (PANEL_W / 2) + '" y="' + relSubtitleY + '" text-anchor="middle" fill="rgba(255,165,55,0.75)" font-family="DejaVu Sans, Arial, sans-serif" font-size="' + SUBTITLE_FONT + '" font-weight="400">(/meme your prompt)</text>',
    '<line x1="' + PAD_X + '" y1="' + relDividerY + '" x2="' + (PANEL_W - PAD_X) + '" y2="' + relDividerY + '" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>',
    itemRows.join(''),
    '</svg>'
  ];
  const svg = svgParts.join('');

  return { input: Buffer.from(svg), left: panelX, top: panelY };
}

/**
 * Build the "Community Suggestions" panel SVG — inner-left slot.
 * Newest items at top; items approaching the TV edge fade out.
 * Returns { input, left, top } or null if queue is empty.
 */
function buildSuggestionQueueSvg() {
  if (!outputWidth || !outputHeight) return null;

  const PANEL_W       = Math.floor(outputWidth / 4);
  const PAD_X         = 12;
  const PAD_Y         = 8;
  const MARGIN        = 4;
  const TITLE_FONT    = 21;
  const SUBTITLE_FONT = 15;
  const TITLE_H       = 54;
  const ITEM_FONT     = 11;
  const ITEM_H        = 20;
  const MAX_CHARS     = 40;

  const panelX = Math.floor(outputWidth / 4);
  const panelY = MARGIN;

  const delimiterY   = (TV_VIEWPORT ? TV_VIEWPORT.y : 130) - panelY;
  const relTitleY    = PAD_Y + TITLE_FONT;
  const relSubtitleY = relTitleY + SUBTITLE_FONT + 6;
  const relDividerY  = PAD_Y + TITLE_H;

  const cleanTitle = (s) => {
    const stripped = s.trim();
    return stripped.length > MAX_CHARS ? stripped.slice(0, MAX_CHARS - 1) + '\u2026' : stripped;
  };

  const items = suggestionQueueItems.slice(0, 20);

  let lastIdx = -1;
  for (let i = 0; i < items.length; i++) {
    if (relDividerY + i * ITEM_H >= delimiterY) break;
    lastIdx = i;
  }

  const itemRows = [];
  for (let i = 0; i <= lastIdx; i++) {
    const itemBottomRel = relDividerY + (i + 1) * ITEM_H;
    const distFromLimit = delimiterY - itemBottomRel;
    const op = (i === lastIdx)
      ? Math.min(1.0, Math.max(0.05, distFromLimit / ITEM_H))
      : 1.0;

    const y      = relDividerY + (i + 1) * ITEM_H - 4;
    const weight = i === 0 ? '600' : '400';
    const fill   = i === 0 ? '#ffffff' : 'rgba(255,255,255,0.85)';
    itemRows.push(`<text x="${PAD_X}" y="${y}" fill="${fill}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${ITEM_FONT}" font-weight="${weight}" opacity="${op.toFixed(2)}">${escapeSvgText(cleanTitle(items[i].title))}</text>`);
  }

  const panelH = Math.min(PAD_Y + TITLE_H + Math.max(items.length, 0) * ITEM_H + PAD_Y, delimiterY);

  const svg = `<svg width="${PANEL_W}" height="${panelH}" xmlns="http://www.w3.org/2000/svg">
    ${FRIENDSZONE_FACE}
    ${svgEmojiTitle({ text: '🌍 Suggestions', y: relTitleY, fontSize: TITLE_FONT, fill: 'rgba(255,255,255,0.45)', fontFamily: `${FRIENDSZONE_FAMILY}DejaVu Sans, Arial, sans-serif`, centerInWidth: PANEL_W, groupShift: Math.round(TITLE_FONT * 0.33) })}
    <text x="${PANEL_W / 2}" y="${relSubtitleY}" text-anchor="middle" fill="rgba(255,165,55,0.75)" font-family="DejaVu Sans, Arial, sans-serif" font-size="${SUBTITLE_FONT}" font-weight="400">(/suggestion your idea)</text>
    <line x1="${PAD_X}" y1="${relDividerY}" x2="${PANEL_W - PAD_X}" y2="${relDividerY}" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
    ${itemRows.join('')}
  </svg>`;

  return { input: Buffer.from(svg), left: panelX, top: panelY };
}

/**
 * Build chat overlay SVG (bottom-left, above caption area).
 * Returns Buffer or null if no messages.
 */
function buildChatOverlaySvg() {
  if (!outputWidth || !outputHeight || chatMessages.length === 0) {
    return null;
  }

  const now = Date.now();
  const fontSize = 18;
  const lineHeight = 27;
  const paddingX = 12;
  const paddingY = 10;
  const maxWidth = 420;
  const bottomReserve = 140; // Space for caption
  const margin = 16;

  const bannerWidth = maxWidth + paddingX * 2;
  const bannerHeight = chatMessages.length * lineHeight + paddingY * 2;
  const bannerX = margin;
  const bannerY = outputHeight - bottomReserve - bannerHeight;

  // Coordinates relative to SVG origin (bannerX, bannerY in output)
  const lines = chatMessages.map((msg, i) => {
    const age = now - msg.addedAt;
    const lifeRatio = age / CHAT_EXPIRE_MS;
    // Full opacity for first 65% of lifetime, fade to 0.2 over remaining 35%
    const opacity = lifeRatio < 0.65 ? 1.0 : Math.max(0.2, 1.0 - ((lifeRatio - 0.65) / 0.35) * 0.8);
    const y = paddingY + fontSize + i * lineHeight; // relative to SVG top
    const name = msg.username;
    return `<g opacity="${opacity.toFixed(2)}">` +
      `<text x="${paddingX}" y="${y}" font-size="${fontSize}" font-weight="700" fill="#a78bfa" font-family="DejaVu Sans, Arial, sans-serif">${escapeSvgText(name)}:</text>` +
      `<text x="${paddingX + name.length * fontSize * 0.65 + fontSize * 0.4}" y="${y}" font-size="${fontSize}" font-weight="400" fill="#ffffff" font-family="DejaVu Sans, Arial, sans-serif">${escapeSvgText(msg.text)}</text>` +
      `</g>`;
  }).join('');

  // SVG is only the chat banner area — much smaller than full 1280×720 output
  const svg = `
    <svg width="${bannerWidth}" height="${bannerHeight}" xmlns="http://www.w3.org/2000/svg">
      ${lines}
    </svg>
  `;

  return { input: Buffer.from(svg), left: bannerX, top: bannerY };
}

/**
 * Assemble the full layer list for the static base:
 * staticLayerEntries + lighting layers (with opacity) + current fire frame
 */
/**
 * Cheap base build: lowerStaticBase (Fondo, raw RGBA) + lighting ops + fire ops + upperStaticBuffer.
 * Only ~6 Sharp composite ops regardless of how many static layers exist.
 * Called both from preloadLayers (direct await) and _rebuildStaticBase (hot path).
 */
async function _buildBaseFromParts(fireFrame = fireState.frame, tvOffY = Math.round(tvSlide.offsetY / 5) * 5) {
  if (!lowerStaticBase || !outputWidth) return staticBaseBuffer; // Not ready yet

  // Cache key includes TV offset (5px steps) so slide animation frames don't thrash the cache
  const baseCacheKey = tvOffY === 0 ? `${fireFrame}` : `${fireFrame}-tv${tvOffY}`;
  const cached = fireFrameBaseCache[baseCacheKey];
  if (cached) return cached;

  const ops = [];

  // Resolve night/day opacities — cycle overrides manual sliders when enabled.
  let nightOpacity = lightingState.nightOpacity;
  let dayOpacity   = lightingState.dayOpacity;
  if (dayCycleState.enabled) {
    const dayFrac = (1 - Math.cos(dayCycleState.angle)) / 2;
    dayOpacity   = dayFrac;
    nightOpacity = 1 - dayFrac;
  }

  // Lighting layers in intended render order: No_Light (base) → Night_Light → Day_Light.
  // We hardcode this order rather than relying on manifest zIndex, because the PSD may have
  // Night_Light below No_Light in z-order (the pre-req swap may not have been done).
  const lightingRenderOrder = [
    { id: 'No_Light',    opacity: 1.0 },
    { id: 'Night_Light', opacity: nightOpacity },
    { id: 'Day_Light',   opacity: dayOpacity },
  ];

  for (const { id, opacity } of lightingRenderOrder) {
    const lb = lightingLayerBuffers[id];
    if (!lb || opacity <= 0) continue;

    let buf;
    if (opacity >= 0.999) {
      buf = lb.buffer;
    } else {
      const rounded = Math.round(opacity * 100) / 100;
      const cached = lightingOpacityCache[id];
      if (cached && cached.opacity === rounded) {
        buf = cached.buffer;
      } else {
        buf = await applyOpacityToBuffer(lb.buffer, { width: lb.scaledWidth, height: lb.scaledHeight }, opacity);
        lightingOpacityCache[id] = { opacity: rounded, buffer: buf };
      }
    }

    ops.push({ input: buf, left: Math.round(lb.x * OUTPUT_SCALE), top: Math.round(lb.y * OUTPUT_SCALE), blend: 'over' });
  }

  // Fire frame — use the explicitly passed frame index so callers can target a specific
  // frame without racing against the global fireState.frame advancing mid-build.
  if (fireState.playing && fireFramePairs.length === 5) {
    const pair = fireFramePairs[fireFrame];
    if (pair?.reflection) {
      ops.push({ input: pair.reflection.buffer, left: Math.round(pair.reflection.x * OUTPUT_SCALE), top: Math.round(pair.reflection.y * OUTPUT_SCALE), blend: 'over' });
    }
    if (pair?.fire) {
      ops.push({ input: pair.fire.buffer, left: Math.round(pair.fire.x * OUTPUT_SCALE), top: Math.round(pair.fire.y * OUTPUT_SCALE), blend: 'over' });
    }
  }

  if (tvOffY < TV_SLIDE_DIST) {
    // TV physical frame — z=14, between fire (z≤13) and characters/props (z≥17)
    if (tvFrameLayerBuffer) {
      ops.push({ input: tvFrameLayerBuffer, left: 0, top: tvOffY + TV_Y_OFFSET, blend: 'over' });
    }
    // TV reflection — z=16, above TV frame, below characters
    if (tvReflectionBuffer) {
      ops.push({ input: tvReflectionBuffer, left: tvReflectionPos.x, top: tvReflectionPos.y + tvOffY + TV_Y_OFFSET, blend: 'over' });
    }
  }

  // Upper static (characters + props, without TV) as a single pre-composited transparent PNG
  if (upperStaticBuffer) {
    ops.push({ input: upperStaticBuffer, left: 0, top: 0, blend: 'over' });
  }

  const result = await sharp(lowerStaticBase.data, {
    raw: { width: lowerStaticBase.info.width, height: lowerStaticBase.info.height, channels: lowerStaticBase.info.channels }
  })
    .composite(ops)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const base = { data: result.data, info: result.info };
  fireFrameBaseCache[baseCacheKey] = base;
  return base;
}

/**
 * Rebuild staticBaseBuffer from current fire/lighting state (hot path for fire timer).
 * Coalescing: if a rebuild is already in flight, marks dirty so it runs once more after.
 */
async function _rebuildStaticBase() {
  if (_baseRebuildInFlight) {
    _baseRebuildDirty = true;
    return;
  }
  _baseRebuildInFlight = true;
  _baseRebuildDirty = false;
  // Clear fire-frame base cache before build so we don't return stale frames
  fireFrameBaseCache = {};
  try {
    const newBase = await _buildBaseFromParts();
    if (newBase) {
      staticBaseBuffer = newBase;
      staticBaseVersion += 1;
      // Do NOT clear committedExprBaseBuffer or frameCache.
      // The committed-base pattern keeps the old base serving frames while the new L1 builds.
    }
  } catch (err) {
    console.warn('[Compositor] Base rebuild failed:', err.message);
  } finally {
    _baseRebuildInFlight = false;
    if (_baseRebuildDirty) {
      _baseRebuildDirty = false;
      setImmediate(_rebuildStaticBase);
    }
  }
}

/**
 * Update fire animation state (playing, mode, fps).
 * Does NOT advance the frame — that is driven by the timer in server.js.
 */
function setFireState(config) {
  Object.assign(fireState, config);
  setImmediate(_rebuildStaticBase);
}

/**
 * Update background lighting opacities.
 */
function setLightingState(config) {
  Object.assign(lightingState, config);
  setImmediate(_rebuildStaticBase);
}

/**
 * Advance the fire animation frame by one step (called by fire timer in server.js).
 * Does NOT trigger a static-base rebuild — the fire frame is now encoded in the L1 cache
 * key (v${staticBaseVersion}-f${fireFrame}-${exprKey}), so the next compositeFrame call
 * that requests the new fire frame will get a cache miss, build its own base via
 * _buildBaseFromParts(fireFrame), and cache it. After one full animation cycle all 5
 * per-frame L1 entries are warm and subsequent frames are pure cache hits.
 */
function advanceFireFrame() {
  if (fireState.mode === 'circular') {
    fireState.frame = (fireState.frame + 1) % 5;
  } else if (fireState.mode === 'pingpong') {
    fireState.frame += fireState.pingPongDir;
    if (fireState.frame >= 4) {
      fireState.frame = 4;
      fireState.pingPongDir = -1;
    } else if (fireState.frame <= 0) {
      fireState.frame = 0;
      fireState.pingPongDir = 1;
    }
  } else if (fireState.mode === 'random') {
    if (fireFramePairs.length > 1) {
      let next;
      do { next = Math.floor(Math.random() * 5); } while (next === fireState.frame);
      fireState.frame = next;
    }
  }
}

/**
 * Configure the day/night auto cycle (enable/disable, set RPM, set starting angle).
 */
function setDayCycle(config) {
  if (config.enabled !== undefined) {
    const enabling = Boolean(config.enabled);
    if (enabling && !dayCycleState.enabled) {
      // Reset lastTickMs so the first tick doesn't jump
      dayCycleState.lastTickMs = 0;
    }
    dayCycleState.enabled = enabling;
  }
  if (typeof config.rpm === 'number') dayCycleState.rpm = Math.max(0.1, Math.min(60, config.rpm));
  if (typeof config.angle === 'number') dayCycleState.angle = config.angle % (2 * Math.PI);
  setImmediate(_rebuildStaticBase);
}

/**
 * Advance the day/night cycle by elapsed time. Called by server.js on a fast interval.
 * Only acts when dayCycleState.enabled is true.
 * Only triggers a static-base rebuild when the quantized opacity actually changes (1% steps),
 * not on every tick — prevents flooding the compositor with 5 rebuilds/sec.
 */
function tickDayCycle() {
  if (!dayCycleState.enabled) return;
  const now = Date.now();
  if (dayCycleState.lastTickMs > 0) {
    const elapsed = (now - dayCycleState.lastTickMs) / 1000; // seconds
    const oldAngle = dayCycleState.angle;
    const newAngle = (oldAngle + dayCycleState.rpm * Math.PI / 60 * elapsed) % (2 * Math.PI);

    // Only trigger a rebuild when the visually-quantized day fraction changes (≥1% step).
    // lightingOpacityCache already rounds to 0.01 precision, so rebuilding more often
    // just produces identical buffers and wasted L1 invalidations.
    const oldFrac = Math.round(((1 - Math.cos(oldAngle)) / 2) * 100);
    const newFrac = Math.round(((1 - Math.cos(newAngle)) / 2) * 100);

    dayCycleState.angle = newAngle;

    if (oldFrac !== newFrac) {
      setImmediate(_rebuildStaticBase);
    }
  }
  dayCycleState.lastTickMs = now;
}

/**
 * Return current fire + lighting + cycle state snapshot (for API responses and persistence).
 */
function getSceneState() {
  const dayFrac = (1 - Math.cos(dayCycleState.angle)) / 2;
  return {
    fire: { ...fireState },
    lighting: { ...lightingState },
    cycle: {
      enabled: dayCycleState.enabled,
      rpm: dayCycleState.rpm,
      angle: dayCycleState.angle,
      // Live opacities driven by cycle (null when cycle is off — manual sliders apply instead)
      dayFrac: dayCycleState.enabled ? dayFrac : null,
    }
  };
}

async function buildStaticBaseFromEntries(entries) {
  const sorted = [...entries].sort((a, b) => a.zIndex - b.zIndex);
  const staticOps = sorted.map(layer => ({
    input: layer.buffer,
    left: Math.round(layer.x * OUTPUT_SCALE),
    top: Math.round(layer.y * OUTPUT_SCALE),
    blend: 'over',
    opacity: 1
  }));

  const result = await sharp({
    create: {
      width: outputWidth,
      height: outputHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 }
    }
  })
  .composite(staticOps)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

  return { data: result.data, info: result.info };
}

async function applyOpacityToBuffer(baseBuffer, meta, opacity) {
  if (!meta) return baseBuffer;
  if (opacity >= 0.999) return baseBuffer;
  const { data } = await sharp(baseBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let i = 3; i < data.length; i += 4) {
    data[i] = Math.round(data[i] * opacity);
  }

  return sharp(data, {
    raw: {
      width: meta.width,
      height: meta.height,
      channels: 4
    }
  })
  .png()
  .toBuffer();
}

/**
 * Composite a frame with both characters visible
 * Uses caching for common frame states (most frames are identical)
 * TV content is composited before character layers (appears behind them)
 */
async function buildExpressionBase(exprBaseCacheKey, exprSnapshot, fireFrame = fireState.frame, tvOffY = 0) {
  // Build expression layer composite ops
  const l1Start = Date.now();
  const sortedExprLayers = [...expressionLayerEntries].sort((a, b) => a.zIndex - b.zIndex);
  const layerTasks = [];  // { index, exprLayer, type, cacheKey, taskFn } or { index, op }

  for (let i = 0; i < sortedExprLayers.length; i++) {
    const exprLayer = sortedExprLayers[i];
    const mapping = EXPRESSION_LAYER_MAP[exprLayer.id];
    if (mapping === undefined) continue;
    const offset = mapping
      ? (exprSnapshot[mapping.character]?.[mapping.feature] || { x: 0, y: 0 })
      : { x: 0, y: 0 };

    // Eyebrow layers: vertical-only with rotation
    if (exprLayer.eyebrowSide && exprLayer.croppedBuffer && exprLayer.contentBounds) {
      let dy = Math.round(offset.y);
      let rotation = Number(offset.rotation) || 0;
      if (offset.left && offset.right) {
        const sideData = exprLayer.eyebrowSide === 'left' ? offset.left : offset.right;
        if (sideData) {
          dy = Math.round(sideData.y ?? dy);
          rotation = Number(sideData.rotation ?? rotation) || 0;
        }
      }
      rotation = Math.round(rotation * 10) / 10;

      if (dy === 0 && rotation === 0) {
        layerTasks.push({ index: i, op: { input: exprLayer.buffer, left: 0, top: 0, blend: 'over' } });
      } else {
        const browCacheKey = `brow_${exprLayer.id}_${dy}_${rotation}`;
        const cached = exprLayerCache[browCacheKey];
        if (cached) {
          layerTasks.push({ index: i, op: { input: cached.input, left: cached.left, top: cached.top, blend: 'over' } });
        } else {
          // Queue async task for parallel execution
          const bounds = exprLayer.contentBounds;
          const centerX = bounds.left + bounds.width / 2;
          const centerY = bounds.top + bounds.height / 2;
          const angle = exprLayer.eyebrowSide === 'left' ? rotation : -rotation;

          layerTasks.push({
            index: i,
            type: 'brow',
            cacheKey: browCacheKey,
            taskFn: async () => {
              const rotated = await sharp(exprLayer.croppedBuffer)
                .rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .png()
                .toBuffer();

              const rad = Math.abs(angle) * Math.PI / 180;
              const cosA = Math.cos(rad);
              const sinA = Math.sin(rad);
              const newW = Math.ceil(bounds.width * cosA + bounds.height * sinA);
              const newH = Math.ceil(bounds.width * sinA + bounds.height * cosA);

              let placeLeft = Math.round(centerX - newW / 2);
              let placeTop = Math.round(centerY - newH / 2 + dy);

              let finalBuffer = rotated;
              if (placeLeft < 0 || placeTop < 0) {
                const trimLeft = Math.max(0, -placeLeft);
                const trimTop = Math.max(0, -placeTop);
                const trimW = Math.min(newW - trimLeft, outputWidth);
                const trimH = Math.min(newH - trimTop, outputHeight);
                if (trimW > 0 && trimH > 0) {
                  finalBuffer = await sharp(rotated)
                    .extract({ left: trimLeft, top: trimTop, width: trimW, height: trimH })
                    .png()
                    .toBuffer();
                }
                placeLeft = Math.max(0, placeLeft);
                placeTop = Math.max(0, placeTop);
              }

              return { input: finalBuffer, left: placeLeft, top: placeTop };
            }
          });
        }
      }
      continue;
    }

    // Eye layers and eye_cover: translate via extract+extend
    const dx = Math.round(offset.x);
    const dy = Math.round(offset.y);

    if (dx === 0 && dy === 0) {
      layerTasks.push({ index: i, op: { input: exprLayer.buffer, left: 0, top: 0, blend: 'over' } });
    } else {
      const eyeCacheKey = `eye_${exprLayer.id}_${dx}_${dy}`;
      const cached = exprLayerCache[eyeCacheKey];
      if (cached) {
        layerTasks.push({ index: i, op: { input: cached, left: 0, top: 0, blend: 'over' } });
      } else {
        const layerW = exprLayer.scaledWidth;
        const layerH = exprLayer.scaledHeight;
        const extractLeft = Math.max(0, -dx);
        const extractTop = Math.max(0, -dy);
        const extractWidth = layerW - Math.abs(dx);
        const extractHeight = layerH - Math.abs(dy);

        if (extractWidth > 0 && extractHeight > 0) {
          layerTasks.push({
            index: i,
            type: 'eye',
            cacheKey: eyeCacheKey,
            taskFn: async () => {
              return sharp(exprLayer.buffer)
                .extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight })
                .extend({
                  top: Math.max(0, dy),
                  bottom: Math.max(0, -dy),
                  left: Math.max(0, dx),
                  right: Math.max(0, -dx),
                  background: { r: 0, g: 0, b: 0, alpha: 0 }
                })
                .png()
                .toBuffer();
            }
          });
        } else {
          layerTasks.push({ index: i, op: { input: exprLayer.buffer, left: 0, top: 0, blend: 'over' } });
        }
      }
    }
  }

  // Run all pending transforms in parallel
  const pendingTasks = layerTasks.filter(t => t.taskFn);
  if (pendingTasks.length > 0) {
    const results = await Promise.all(pendingTasks.map(t => t.taskFn()));
    for (let j = 0; j < pendingTasks.length; j++) {
      const task = pendingTasks[j];
      const result = results[j];
      // Cache the result
      const keys = Object.keys(exprLayerCache);
      if (keys.length >= EXPR_LAYER_CACHE_MAX) {
        for (let k = 0; k < 20; k++) delete exprLayerCache[keys[k]];
      }
      if (task.type === 'brow') {
        exprLayerCache[task.cacheKey] = result;
        task.op = { input: result.input, left: result.left, top: result.top, blend: 'over' };
      } else {
        exprLayerCache[task.cacheKey] = result;
        task.op = { input: result, left: 0, top: 0, blend: 'over' };
      }
    }
  }

  // Build exprOps array in z-order
  const exprOps = layerTasks
    .sort((a, b) => a.index - b.index)
    .map(t => t.op)
    .filter(Boolean);

  // Nose layers (above eye_cover, part of expression base)
  const sortedNoseLayers = [...noseLayerEntries].sort((a, b) => a.zIndex - b.zIndex);
  for (const noseLayer of sortedNoseLayers) {
    exprOps.push({
      input: noseLayer.buffer,
      left: noseLayer.scaledX,
      top: noseLayer.scaledY,
      blend: 'over'
    });
  }

  // Build scene base with the exact fire frame captured at dispatch time.
  // Using _buildBaseFromParts(fireFrame) rather than the global staticBaseBuffer prevents
  // a race where fireState.frame advances between the L1 cache-key generation and this build,
  // which would cache a frame-N+1 buffer under a frame-N key and stall the fire animation.
  const sceneBase = await _buildBaseFromParts(fireFrame, tvOffY);
  if (!sceneBase) return null;

  // Composite Level 1: sceneBase (raw RGBA) + expression layers + nose → raw RGBA buffer
  const exprBaseResult = await sharp(sceneBase.data, {
    raw: { width: sceneBase.info.width, height: sceneBase.info.height, channels: sceneBase.info.channels }
  })
    .composite(exprOps)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const exprBaseRaw = { data: exprBaseResult.data, info: exprBaseResult.info };

  // Cache expression base (evict if full)
  const exprBaseKeys = Object.keys(exprBaseCache);
  if (exprBaseKeys.length >= EXPR_BASE_CACHE_MAX) {
    for (let k = 0; k < 5; k++) delete exprBaseCache[exprBaseKeys[k]];
  }
  exprBaseCache[exprBaseCacheKey] = exprBaseRaw;
  lastExprBaseKey = exprBaseCacheKey;
  lastExprBaseBuffer = exprBaseRaw;

  const l1Time = Date.now() - l1Start;
  if (l1Time > 30) {
    console.log(`[Compositor] L1 cache miss: ${l1Time}ms (${pendingTasks.length} transforms)`);
  }

  // Fire L2 pre-warming in the background (never blocks frame loop).
  // For speech: pre-warm all 6 phonemes for the speaking character.
  // For idle: pre-warm just the A-A-0-0 (closed mouth, no blink) entry before swapping
  //   the committed base — avoids an L2 miss on the first frame that uses the new base.
  const speakChar = currentSpeakingCharacter;
  if (speakChar) {
    setImmediate(() => preWarmL2(exprBaseCacheKey, exprBaseRaw, speakChar));
  } else {
    setImmediate(async () => {
      try {
        const idleKey = `${exprBaseCacheKey}-A-A-0-0`;
        if (!frameCache[idleKey]) {
          const m = loadManifest();
          const mouthOps = [];
          for (const layer of m.layers) {
            if (layer.type === 'mouth' && layer.phoneme === 'A') {
              const buffer = scaledLayerBuffers[layer.id];
              if (buffer) {
                mouthOps.push({
                  input: buffer,
                  left: Math.round(layer.x * OUTPUT_SCALE),
                  top: Math.round(layer.y * OUTPUT_SCALE),
                  blend: 'over'
                });
              }
            }
          }
          const charBuf = await sharp(exprBaseRaw.data, {
            raw: { width: exprBaseRaw.info.width, height: exprBaseRaw.info.height, channels: exprBaseRaw.info.channels }
          })
            .composite(mouthOps)
            .raw()
            .toBuffer();
          const frameCacheKeys = Object.keys(frameCache);
          if (frameCacheKeys.length >= FRAME_CACHE_MAX) {
            for (let i = 0; i < 20; i++) delete frameCache[frameCacheKeys[i]];
          }
          frameCache[idleKey] = charBuf;
        }
      } catch (err) {
        console.warn('[Compositor] Idle L2 pre-warm error:', err.message);
      }
      // Swap committed base only after idle L2 is warm
      committedExprBaseKey = exprBaseCacheKey;
      committedExprBaseBuffer = exprBaseRaw;
    });
  }

  return exprBaseRaw;
}

/**
 * Set the currently speaking character (used to decide which phonemes to pre-warm)
 */
function setSpeakingCharacter(char) {
  currentSpeakingCharacter = char || null;
}

/**
 * Pre-warm L2 cache entries for common phoneme combinations.
 * Called via setImmediate after buildExpressionBase completes — never blocks the frame loop.
 * For the speaking character we pre-warm phonemes A-F (most common during speech);
 * the other character stays at 'A', blink=false.
 *
 * Latest-wins concurrency guard: at most one batch in flight + one pending.
 * Prevents stacking 6-op Sharp batches during heavy speech expression changes.
 */
function preWarmL2(exprBaseCacheKey, exprBaseRaw, speakingChar) {
  if (_preWarmL2InFlight) {
    // Queue only the latest request — intermediate states are fine to skip
    _preWarmL2Pending = { exprBaseCacheKey, exprBaseRaw, speakingChar };
    return;
  }
  _runPreWarmL2(exprBaseCacheKey, exprBaseRaw, speakingChar);
}

function _runPreWarmL2(exprBaseCacheKey, exprBaseRaw, speakingChar) {
  _preWarmL2InFlight = true;
  const m = loadManifest();
  const phonemes = ['A', 'B', 'C', 'D', 'E', 'F'];

  const tasks = phonemes.map(async (ph) => {
    const chadPh = speakingChar === 'chad' ? ph : 'A';
    const virgPh = speakingChar === 'virgin' ? ph : 'A';
    const charCacheKey = `${exprBaseCacheKey}-${chadPh}-${virgPh}-0-0`;

    if (frameCache[charCacheKey]) return; // already cached

    const charOps = [];
    const sortedLayers = [...m.layers]
      .filter(l => l.type === 'mouth' || l.type === 'blink')
      .sort((a, b) => a.zIndex - b.zIndex);

    for (const layer of sortedLayers) {
      let shouldInclude = false;
      if (layer.type === 'mouth') {
        if (layer.character === 'chad' && layer.phoneme === chadPh) shouldInclude = true;
        else if (layer.character === 'virgin' && layer.phoneme === virgPh) shouldInclude = true;
      }
      // blink=false for pre-warm, skip blink layers
      if (!shouldInclude) continue;
      const buffer = scaledLayerBuffers[layer.id];
      if (buffer) {
        charOps.push({
          input: buffer,
          left: Math.round(layer.x * OUTPUT_SCALE),
          top: Math.round(layer.y * OUTPUT_SCALE),
          blend: 'over'
        });
      }
    }

    // Composite Level 2 from raw RGBA expression base → raw RGBA
    const charBuffer = await sharp(exprBaseRaw.data, {
      raw: { width: exprBaseRaw.info.width, height: exprBaseRaw.info.height, channels: exprBaseRaw.info.channels }
    })
      .composite(charOps)
      .raw()
      .toBuffer();

    // Store in L2 cache
    const frameCacheKeys = Object.keys(frameCache);
    if (frameCacheKeys.length >= FRAME_CACHE_MAX) {
      for (let i = 0; i < 20; i++) delete frameCache[frameCacheKeys[i]];
    }
    frameCache[charCacheKey] = charBuffer;
  });

  Promise.all(tasks).then(() => {
    _preWarmL2InFlight = false;
    // Atomically swap committed base now that L2 entries are pre-warmed
    committedExprBaseKey = exprBaseCacheKey;
    committedExprBaseBuffer = exprBaseRaw;
    // Run the latest pending request if one queued up during this batch
    const pending = _preWarmL2Pending;
    _preWarmL2Pending = null;
    if (pending) _runPreWarmL2(pending.exprBaseCacheKey, pending.exprBaseRaw, pending.speakingChar);
  }).catch(err => {
    _preWarmL2InFlight = false;
    const pending = _preWarmL2Pending;
    _preWarmL2Pending = null;
    if (pending) _runPreWarmL2(pending.exprBaseCacheKey, pending.exprBaseRaw, pending.speakingChar);
    console.warn('[Compositor] L2 pre-warm error:', err.message);
  });
}

async function compositeFrame(state) {
  stepExpressionOffsets(Date.now());
  // Tick TV slide once per frame — capture offset before any cache key computation
  // so the frame layer (in base) and overlay layers (content/reflection) use identical offsetY.
  const hasActiveTVSlide = _tickTVSlide();
  const tvOffsetY = tvSlide.offsetY;

  const {
    chadPhoneme = 'A',
    virginPhoneme = 'A',
    chadBlinking = false,
    virginBlinking = false,
    caption = null,
    tvFrameIndex = -1
  } = state;

  const hasTv = currentTVFrame ? 1 : 0;
  const captionKey = caption ? caption.slice(0, 40) : '';
  const exprSnapshot = JSON.parse(JSON.stringify(expressionOffsets));

  // Expression key for L1 cache lookup — quantized to match Math.round() precision used in rendering.
  // Raw tween floats (e.g. 0.371) would create unique keys for every sub-pixel step,
  // thrashing the cache even though the rendered output is identical.
  const re = v => Math.round(v);           // integer pixels (eye/eyebrow position)
  const rr = v => Math.round(v * 10) / 10; // 0.1° rotation precision
  const exprKey = `ce${re(exprSnapshot.chad.eyes.x)},${re(exprSnapshot.chad.eyes.y)}`
    + `cbl${re(exprSnapshot.chad.eyebrows.left.y)}r${rr(exprSnapshot.chad.eyebrows.left.rotation)}`
    + `cbr${re(exprSnapshot.chad.eyebrows.right.y)}r${rr(exprSnapshot.chad.eyebrows.right.rotation)}`
    + `ve${re(exprSnapshot.virgin.eyes.x)},${re(exprSnapshot.virgin.eyes.y)}`
    + `vbl${re(exprSnapshot.virgin.eyebrows.left.y)}r${rr(exprSnapshot.virgin.eyebrows.left.rotation)}`
    + `vbr${re(exprSnapshot.virgin.eyebrows.right.y)}r${rr(exprSnapshot.virgin.eyebrows.right.rotation)}`;
  // === Two-level compositing ===
  // Level 1: Expression base (staticBase + expression layers + nose) — cached by exprKey.
  //   Only recomputes when expression offsets change (~3-5x/sec).
  // Level 2: Character frame (expression base + mouth + blink) — cached
  //   by phoneme+blink per expression base. Composites only a few layers.
  //   On phoneme changes, the expensive expression base is served from Level 1 cache.

  // Capture fire frame at key-generation time so the L1 build uses the same frame
  // the key was generated for — prevents caching a wrong-frame buffer under a stale key.
  const capturedFireFrame = fireState.frame;
  const _tvOffYQ = Math.round(tvOffsetY / 5) * 5; // 5px steps — limits rebuild count during animation
  const exprBaseCacheKey = _tvOffYQ === 0 ? `v${staticBaseVersion}-f${capturedFireFrame}-${exprKey}` : `v${staticBaseVersion}-f${capturedFireFrame}-tv${_tvOffYQ}-${exprKey}`;
  const l1Hit = exprBaseCache[exprBaseCacheKey]; // { data, info } raw RGBA or undefined
  let exprBaseRaw;
  let effectiveExprBaseKey;

  if (!l1Hit) {
    // L1 miss — fire background build (+ pre-warm → committed swap)
    if (!exprBaseInFlight.has(exprBaseCacheKey)) {
      const snapshot = JSON.parse(JSON.stringify(exprSnapshot));
      const task = buildExpressionBase(exprBaseCacheKey, snapshot, capturedFireFrame, _tvOffYQ)
        .catch(err => {
          console.warn('[Compositor] L1 build failed:', err.message);
        })
        .finally(() => {
          exprBaseInFlight.delete(exprBaseCacheKey);
        });
      exprBaseInFlight.set(exprBaseCacheKey, task);
    }
  }

  // Decide which base to render with.
  // When speaking: ALWAYS use the committed base so frames don't alternate between
  // old-committed and new-but-not-yet-committed expression states (twitching).
  // When idle: use L1 hit directly for responsive expressions, and update committed.
  if (currentSpeakingCharacter && committedExprBaseBuffer) {
    // During speech — locked to committed base (smooth progression, no twitching)
    exprBaseRaw = committedExprBaseBuffer;
    effectiveExprBaseKey = committedExprBaseKey;
  } else if (l1Hit) {
    // Idle with L1 hit — use directly and update committed
    exprBaseRaw = l1Hit;
    effectiveExprBaseKey = exprBaseCacheKey;
    committedExprBaseKey = exprBaseCacheKey;
    committedExprBaseBuffer = l1Hit;
  } else if (committedExprBaseBuffer) {
    exprBaseRaw = committedExprBaseBuffer;
    effectiveExprBaseKey = committedExprBaseKey;
  } else if (lastExprBaseBuffer) {
    exprBaseRaw = lastExprBaseBuffer;
    effectiveExprBaseKey = lastExprBaseKey || exprBaseCacheKey;
  } else {
    // First frame ever — must await
    const result = await exprBaseInFlight.get(exprBaseCacheKey);
    if (result) {
      exprBaseRaw = result;
      effectiveExprBaseKey = exprBaseCacheKey;
    }
  }

  // If all fallbacks failed (shouldn't happen), bail with null
  if (!exprBaseRaw) return lastOutputBuffer || null;

  // Build output key using the EFFECTIVE base key (not requested expression offsets)
  // so the fast path correctly reflects what was actually rendered
  const currentChatVersion = getChatVersion();
  const hasActiveTicker = tickerMessages.some(m => m);
  const now = Date.now();

  // Clean up after the longest of glow or +1 duration
  for (const [k, t] of videosGlow) if (now - t >= GLOW_CLEANUP_MS) videosGlow.delete(k);
  for (const [k, t] of roadmapGlow) if (now - t >= GLOW_CLEANUP_MS) roadmapGlow.delete(k);
  for (const [k, t] of memeVoteGlow) if (now - t >= GLOW_CLEANUP_MS) memeVoteGlow.delete(k);
  const hasActiveGlow = videosGlow.size > 0 || roadmapGlow.size > 0 || memeVoteGlow.size > 0;

  // Tick page state — advances phase timers, resolves current page + fadeT
  { const r = tickPage(_pageState.videos,   videosList.length,                videosListVersion);  _videosPage   = r.page; _videosFadeT   = r.fadeT; }
  { const r = tickPage(_pageState.roadmap,  roadmapList.length,               roadmapListVersion); _roadmapPage  = r.page; _roadmapFadeT  = r.fadeT; }
  { const _mvDelimiterY = (TV_VIEWPORT ? TV_VIEWPORT.y : 130) - 4; const _mvPerPage = Math.max(1, Math.floor((_mvDelimiterY - 62) / 20)); const r = tickPage(_pageState.memeVote, memeVotingData?.pool?.length || 0, memeVotingData?.pool?.length ?? -1, _mvPerPage); _memeVotePage = r.page; _memeVoteFadeT = r.fadeT; }

  // Quantise fadeT to 0.05 steps → limits pre-raster updates to ≤20 per fade transition
  const vFadeQ = Math.round(_videosFadeT   / 0.05);
  const rFadeQ = Math.round(_roadmapFadeT  / 0.05);
  const mFadeQ = Math.round(_memeVoteFadeT / 0.05);
  const hasActiveFade = _videosFadeT > 0 || _roadmapFadeT > 0 || _memeVoteFadeT > 0;

  // Kick off async panel pre-rasterization when content changes.
  // Skipped during glow (glow path uses SVG directly for per-frame accuracy).
  if (!hasActiveGlow) {
    _maybeUpdatePanelRaster('videos',  buildVideosListSvg,  `vl${videosListVersion}-p${_videosPage}-f${vFadeQ}-t${Math.floor(Date.now() / 60000)}`);
    _maybeUpdatePanelRaster('roadmap', buildRoadmapListSvg, `rl${roadmapListVersion}-p${_roadmapPage}-f${rFadeQ}`);
    _maybeUpdatePanelRaster('socialStats', buildSocialStatsSvg, `ss${_tokenStatsVersion}`);
    _maybeUpdatePanelRaster('tradeStats',  buildTradeStatsSvg,  `ts${_tokenStatsVersion}`);
  }

  // TV slide: check if animation is in progress (without ticking — tick happens in overlay section)
  const hasActiveTVSlidePending = tvSlide.animFromY !== tvSlide.animToY;

  // outputKey tracks page + quantised fade so the fast path fires correctly between transitions.
  const _videoMinute = videosList.length > 0 ? Math.floor(Date.now() / 60000) : 0;
  const _tvSlideKey = tvSlide.visible ? 0 : 1; // changes when fully settled
  const outputKey = `${effectiveExprBaseKey}-${chadPhoneme}-${virginPhoneme}-${chadBlinking ? 1 : 0}-${virginBlinking ? 1 : 0}-tv${tvContentVersion}-tvs${_tvSlideKey}-c${captionKey}-ch${currentChatVersion}-mq${memeQueueVersion}-sq${suggestionQueueVersion}-vl${videosListVersion}-vp${_videosPage}-vf${vFadeQ}-vm${_videoMinute}-rl${roadmapListVersion}-rp${_roadmapPage}-rf${rFadeQ}-mvp${_memeVotePage}-mvf${mFadeQ}-tkv${_tokenStatsVersion}`;

  // Fast path: skip all compositing if nothing changed and no animated overlays running.
  // hasActiveFade/TVSlide bypass it during their animations.
  if (!hasActiveTicker && !hasActiveGlow && !hasActiveFade && !hasActiveTVSlidePending && outputKey === lastOutputKey && lastOutputBuffer) {
    return lastOutputBuffer;
  }

  const charCacheKey = `${effectiveExprBaseKey}-${chadPhoneme}-${virginPhoneme}-${chadBlinking ? 1 : 0}-${virginBlinking ? 1 : 0}`;
  let charBuffer = frameCache[charCacheKey];

  if (!charBuffer) {
    const m = loadManifest();
    const charOps = [];

    const sortedLayers = [...m.layers]
      .filter(l => l.type === 'mouth' || l.type === 'blink')
      .sort((a, b) => a.zIndex - b.zIndex);

    for (const layer of sortedLayers) {
      let shouldInclude = false;

      if (layer.type === 'mouth') {
        if (layer.character === 'chad' && layer.phoneme === chadPhoneme) {
          shouldInclude = true;
        } else if (layer.character === 'virgin' && layer.phoneme === virginPhoneme) {
          shouldInclude = true;
        }
      }
      else if (layer.type === 'blink') {
        if (layer.character === 'chad' && chadBlinking) {
          shouldInclude = true;
        } else if (layer.character === 'virgin' && virginBlinking) {
          shouldInclude = true;
        }
      }

      if (!shouldInclude) continue;

      const buffer = scaledLayerBuffers[layer.id];
      if (buffer) {
        charOps.push({
          input: buffer,
          left: Math.round(layer.x * OUTPUT_SCALE),
          top: Math.round(layer.y * OUTPUT_SCALE),
          blend: 'over'
        });
      }
    }

    // Composite Level 2: expression base (raw RGBA) + mouth/blink → raw RGBA
    charBuffer = await sharp(exprBaseRaw.data, {
      raw: { width: exprBaseRaw.info.width, height: exprBaseRaw.info.height, channels: exprBaseRaw.info.channels }
    })
      .composite(charOps)
      .raw()
      .toBuffer();

    // Cache character frame (evict if full)
    const frameCacheKeys = Object.keys(frameCache);
    if (frameCacheKeys.length >= FRAME_CACHE_MAX) {
      for (let i = 0; i < 20; i++) delete frameCache[frameCacheKeys[i]];
    }
    frameCache[charCacheKey] = charBuffer;
  }

  // Overlays: TV content, captions, leaderboard, chat
  const overlayOps = [];

  // TV content — slides with frame/reflection (both in _buildBaseFromParts at correct z)
  if (currentTVFrame && TV_VIEWPORT && tvOffsetY < TV_SLIDE_DIST) {
    overlayOps.push({
      input: currentTVFrame,
      left: TV_VIEWPORT.x,
      top: TV_VIEWPORT.y + tvOffsetY,
      blend: 'over'
    });
  }

  // SVG builders return { input, left, top } positioned to their content bounds.
  // This reduces librsvg rasterization area vs full 1280×720 SVGs.
  const captionOp = caption ? buildCaptionSvg(caption) : null;
  if (captionOp) overlayOps.push({ ...captionOp, blend: 'over' });

  const chatOp = buildChatOverlaySvg();
  if (chatOp) overlayOps.push({ ...chatOp, blend: 'over' });

  // Videos + Roadmap panels: use pre-rasterized RGBA when available (avoids per-frame librsvg call).
  // During glow events, fall back to SVG so the per-frame glow animation renders correctly.
  {
    const vr = _panelRaster.videos;
    if (!hasActiveGlow && vr.rgba) {
      overlayOps.push({ input: vr.rgba, raw: { width: vr.width, height: vr.height, channels: 4 }, left: vr.left, top: vr.top, blend: 'over' });
    } else {
      const op = buildVideosListSvg();
      if (op) overlayOps.push({ ...op, blend: 'over' });
    }
  }
  {
    const rr = _panelRaster.roadmap;
    if (!hasActiveGlow && rr.rgba) {
      overlayOps.push({ input: rr.rgba, raw: { width: rr.width, height: rr.height, channels: 4 }, left: rr.left, top: rr.top, blend: 'over' });
    } else {
      const op = buildRoadmapListSvg();
      if (op) overlayOps.push({ ...op, blend: 'over' });
    }
  }

  // Token stat panels (social left, trade right) — use pre-rasterized RGBA
  {
    const sr = _panelRaster.socialStats;
    if (sr.rgba) {
      overlayOps.push({ input: sr.rgba, raw: { width: sr.width, height: sr.height, channels: 4 }, left: sr.left, top: sr.top, blend: 'over' });
    } else {
      const op = buildSocialStatsSvg();
      if (op) overlayOps.push({ ...op, blend: 'over' });
    }
  }
  {
    const tr = _panelRaster.tradeStats;
    if (tr.rgba) {
      overlayOps.push({ input: tr.rgba, raw: { width: tr.width, height: tr.height, channels: 4 }, left: tr.left, top: tr.top, blend: 'over' });
    } else {
      const op = buildTradeStatsSvg();
      if (op) overlayOps.push({ ...op, blend: 'over' });
    }
  }

  const memeQueueOp = buildMemeQueueSvg();
  if (memeQueueOp) overlayOps.push({ ...memeQueueOp, blend: 'over' });

  const suggestionQueueOp = buildSuggestionQueueSvg();
  if (suggestionQueueOp) overlayOps.push({ ...suggestionQueueOp, blend: 'over' });

  // Ticker: correctly-sized SVG (1280×TICKER_HEIGHT = 36px, ~20× less than full frame).
  // Composited in the same single pass — rasterization cost is negligible at this size.
  if (hasActiveTicker) {
    const tickerOp = buildTickerSvg();
    if (tickerOp) overlayOps.push({ ...tickerOp, blend: 'over' });
  }

  // Check output cache — skip during ticker/glow/fade
  let result;
  if (!hasActiveTicker && !hasActiveGlow && !hasActiveFade && !hasActiveTVSlide) {
    result = outputCache[outputKey];
  }

  if (!result) {
    if (overlayOps.length > 0) {
      result = await sharp(charBuffer, { raw: { width: outputWidth, height: outputHeight, channels: 4 } })
        .composite(overlayOps)
        .raw()
        .toBuffer();
    } else {
      result = charBuffer;
    }

    if (!hasActiveTicker) {
      const outKeys = Object.keys(outputCache);
      if (outKeys.length >= OUTPUT_CACHE_MAX) {
        for (let i = 0; i < 15; i++) delete outputCache[outKeys[i]];
      }
      outputCache[outputKey] = result;
    }
  }

  lastOutputKey = outputKey;
  lastOutputBuffer = result;

  return result;
}

function clearCache() {
  scaledLayerBuffers = {};
  staticBaseBuffer = null;
  frameCache = {};
  exprLayerCache = {};
  exprBaseCache = {};
  outputCache = {};
  lastOutputKey = null;
  lastOutputBuffer = null;
  committedExprBaseKey = null;
  committedExprBaseBuffer = null;
  lastExprBaseKey = null;
  lastExprBaseBuffer = null;
  _lastTVFrameRef = null; // force re-registration on next setTVFrame
}

function getManifestDimensions() {
  const m = loadManifest();
  return {
    width: Math.round(m.width * OUTPUT_SCALE),
    height: Math.round(m.height * OUTPUT_SCALE),
    originalWidth: m.width,
    originalHeight: m.height,
    scale: OUTPUT_SCALE
  };
}

/**
 * Set expression offsets for a character
 * @param {string} character - 'chad' or 'virgin'
 * @param {string} feature - 'eyes' or 'eyebrows'
 * @param {number} x - X offset in pixels (at output scale)
 * @param {number} y - Y offset in pixels (at output scale)
 */
function setExpressionOffset(character, feature, x, y) {
  if (!expressionOffsets[character]) {
    console.warn(`[Compositor] Unknown character: ${character}`);
    return;
  }
  if (!expressionOffsets[character][feature]) {
    console.warn(`[Compositor] Unknown feature: ${feature}`);
    return;
  }

  let clampedX = Number(x) || 0;
  let clampedY = Number(y) || 0;

  // Eyebrows: vertical movement only (rotation handled in compositeFrame)
  if (feature === 'eyebrows') clampedX = 0;

  // Clamp to calibrated limits if they exist
  if (expressionLimits && expressionLimits[character] && expressionLimits[character][feature]) {
    const lim = expressionLimits[character][feature];
    clampedX = Math.max(lim.minX, Math.min(lim.maxX, clampedX));
    clampedY = Math.max(lim.minY, Math.min(lim.maxY, clampedY));
  }

  if (feature === 'eyebrows') {
    const brow = expressionOffsets[character][feature];
    brow.x = clampedX;
    brow.y = clampedY;
    const leftY = clampEyebrowY(character, clampedY + (brow.bias?.leftY || 0));
    const rightY = clampEyebrowY(character, clampedY + (brow.bias?.rightY || 0));
    brow.left.y = leftY;
    brow.right.y = rightY;
    expressionRotationTargets[character].left = computeEyebrowRotation(character, leftY);
    expressionRotationTargets[character].right = computeEyebrowRotation(character, rightY);
  } else {
    expressionOffsets[character][feature] = { x: clampedX, y: clampedY };
  }

  // Invalidate last-output fast path (charCacheKey includes expression values
  // so full-frame cache entries naturally miss on new offsets)
  lastOutputKey = null;
  lastOutputBuffer = null;
}

function computeEyebrowRotation(character, y) {
  const lim = expressionLimits?.[character]?.eyebrows || {};
  const rotUp = Number.isFinite(Number(lim.rotUp)) ? Number(lim.rotUp) : DEFAULT_EYEBROW_ROTATION_UP;
  const rotDown = Number.isFinite(Number(lim.rotDown)) ? Number(lim.rotDown) : DEFAULT_EYEBROW_ROTATION_DOWN;
  const minY = Number.isFinite(Number(lim.minY)) ? Number(lim.minY) : -DEFAULT_EXPRESSION_RANGE;
  const maxY = Number.isFinite(Number(lim.maxY)) ? Number(lim.maxY) : DEFAULT_EXPRESSION_RANGE;

  let rotation = 0;
  if (y < 0) {
    const denom = Math.abs(minY) || DEFAULT_EXPRESSION_RANGE;
    const t = Math.min(1, Math.abs(y) / denom);
    rotation = t * rotUp;
  }
  if (y > 0) {
    const denom = Math.abs(maxY) || DEFAULT_EXPRESSION_RANGE;
    const t = Math.min(1, Math.abs(y) / denom);
    rotation = -t * rotDown;
  }
  if (character === 'virgin') {
    rotation = -rotation;
  }
  return rotation;
}

function clampEyebrowY(character, y) {
  if (expressionLimits && expressionLimits[character] && expressionLimits[character].eyebrows) {
    const lim = expressionLimits[character].eyebrows;
    const minY = Number.isFinite(Number(lim.minY)) ? Number(lim.minY) : -DEFAULT_EXPRESSION_RANGE;
    const maxY = Number.isFinite(Number(lim.maxY)) ? Number(lim.maxY) : DEFAULT_EXPRESSION_RANGE;
    return Math.max(minY, Math.min(maxY, y));
  }
  return Math.max(-DEFAULT_EXPRESSION_RANGE, Math.min(DEFAULT_EXPRESSION_RANGE, y));
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function stepExpressionOffsets(now) {
  lastExpressionUpdate = now;
  // Snap rotation directly to target — the expression evaluator already provides
  // smooth integer-step browY transitions, so easing here is redundant and produces
  // unique float cache keys every frame, defeating the charCacheKey cache entirely.
  for (const char of Object.keys(expressionOffsets)) {
    const current = expressionOffsets[char].eyebrows;
    const targets = expressionRotationTargets[char] || { left: 0, right: 0 };
    current.left.rotation = Math.round(targets.left * 10) / 10;
    current.right.rotation = Math.round(targets.right * 10) / 10;
  }
}

function setEyebrowRotationLimits(character, rotUp, rotDown) {
  if (!expressionLimits) {
    expressionLimits = { chad: {}, virgin: {} };
  }
  if (!expressionLimits[character]) {
    expressionLimits[character] = {};
  }
  if (!expressionLimits[character].eyebrows) {
    expressionLimits[character].eyebrows = {
      minX: -DEFAULT_EXPRESSION_RANGE,
      maxX: DEFAULT_EXPRESSION_RANGE,
      minY: -DEFAULT_EXPRESSION_RANGE,
      maxY: DEFAULT_EXPRESSION_RANGE
    };
  }
  const lim = expressionLimits[character].eyebrows;
  lim.rotUp = Number(rotUp);
  lim.rotDown = Number(rotDown);

  if (fs.existsSync(EXPRESSION_LIMITS_PATH)) {
    fs.writeFileSync(EXPRESSION_LIMITS_PATH, JSON.stringify(expressionLimits, null, 2), 'utf8');
  }

  if (expressionOffsets[character]?.eyebrows) {
    const brow = expressionOffsets[character].eyebrows;
    const leftY = brow.left?.y ?? brow.y ?? 0;
    const rightY = brow.right?.y ?? brow.y ?? 0;
    expressionRotationTargets[character].left = computeEyebrowRotation(character, leftY);
    expressionRotationTargets[character].right = computeEyebrowRotation(character, rightY);
    frameCache = {};
    lastOutputKey = null;
    lastOutputBuffer = null;
  }
}

/**
 * Get current expression offsets
 */
function getExpressionOffsets() {
  return JSON.parse(JSON.stringify(expressionOffsets)); // Deep copy
}

/**
 * Reset expression offsets to neutral (0, 0)
 */
function resetExpressionOffsets(character) {
  if (character) {
    if (expressionOffsets[character]) {
      expressionOffsets[character].eyes = { x: 0, y: 0 };
      expressionOffsets[character].eyebrows = {
        x: 0,
        y: 0,
        rotation: 0,
        left: { y: 0, rotation: 0 },
        right: { y: 0, rotation: 0 },
        bias: { leftY: 0, rightY: 0 }
      };
      expressionRotationTargets[character] = { left: 0, right: 0 };
    }
  } else {
    // Reset all
    for (const char of Object.keys(expressionOffsets)) {
      expressionOffsets[char].eyes = { x: 0, y: 0 };
      expressionOffsets[char].eyebrows = {
        x: 0,
        y: 0,
        rotation: 0,
        left: { y: 0, rotation: 0 },
        right: { y: 0, rotation: 0 },
        bias: { leftY: 0, rightY: 0 }
      };
      expressionRotationTargets[char] = { left: 0, right: 0 };
    }
  }
  frameCache = {};
  lastOutputKey = null;
  lastOutputBuffer = null;
}

/**
 * Get current expression limits (null if not calibrated)
 */
function getExpressionLimits() {
  return expressionLimits ? JSON.parse(JSON.stringify(expressionLimits)) : null;
}

/**
 * Save expression limits to file and set in memory
 * @param {Object} limits - limits object with chad/virgin > eyes/eyebrows > minX/maxX/minY/maxY
 * @returns {boolean} true if saved
 */
function saveExpressionLimits(limits) {
  expressionLimits = JSON.parse(JSON.stringify(limits));
  fs.writeFileSync(EXPRESSION_LIMITS_PATH, JSON.stringify(limits, null, 2), 'utf8');
  console.log('[Compositor] Saved expression limits to', EXPRESSION_LIMITS_PATH);
  return true;
}

function setEyebrowAsymmetry(character, leftY, rightY) {
  const brow = expressionOffsets[character]?.eyebrows;
  if (!brow) {
    console.warn(`[Compositor] Unknown character for eyebrow asymmetry: ${character}`);
    return;
  }
  brow.bias.leftY = Number(leftY) || 0;
  brow.bias.rightY = Number(rightY) || 0;

  const baseY = brow.y || 0;
  brow.left.y = clampEyebrowY(character, baseY + brow.bias.leftY);
  brow.right.y = clampEyebrowY(character, baseY + brow.bias.rightY);
  expressionRotationTargets[character].left = computeEyebrowRotation(character, brow.left.y);
  expressionRotationTargets[character].right = computeEyebrowRotation(character, brow.right.y);

  lastOutputKey = null;
  lastOutputBuffer = null;
}

module.exports = {
  compositeFrame,
  loadManifest,
  preloadLayers,
  clearCache,
  getManifestDimensions,
  setTVFrame,
  getTVFrame,
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
  setFireState,
  setLightingState,
  advanceFireFrame,
  setDayCycle,
  tickDayCycle,
  getSceneState,
  setTickerMessages: (msgs) => {
    tickerMessages = (msgs || []).map(m => (m || '').trim());
    tickerCurrentIndex = 0;
    tickerSlotStartMs = 0;
    try {
      fs.writeFileSync(TICKER_SETTINGS_PATH, JSON.stringify({ messages: tickerMessages }, null, 2), 'utf8');
    } catch (err) {
      console.warn('[Compositor] Failed to save ticker settings:', err.message);
    }
  },
  getTickerMessages: () => [...tickerMessages],
  getTickerCurrentIndex: () => tickerCurrentIndex,
  setMemeQueue: (items) => {
    memeQueueItems = Array.isArray(items) ? items : [];
    memeQueueVersion++;
    lastOutputKey = null;
  },
  setMemeVotingData: (data) => {
    memeVotingData = data || null;
    memeQueueVersion++;
    lastOutputKey = null;
  },
  setSuggestionQueue: (items) => {
    suggestionQueueItems = Array.isArray(items) ? items : [];
    suggestionQueueVersion++;
    lastOutputKey = null;
  },
  setVideosList: (items) => {
    videosList = Array.isArray(items) ? items : [];
    videosListVersion++;
    lastOutputKey = null;
  },
  setRoadmapList: (items) => {
    roadmapList = Array.isArray(items) ? items : [];
    roadmapListVersion++;
    lastOutputKey = null;
  },
  triggerGlow: (list, id) => {
    if (list === 'video') videosGlow.set(id, Date.now());
    else if (list === 'roadmap') roadmapGlow.set(id, Date.now());
    else if (list === 'memeVote') memeVoteGlow.set(id, Date.now());
    lastOutputKey = null;
  },
  triggerMemeVoteGlow: (number) => {
    memeVoteGlow.set(number, Date.now());
    lastOutputKey = null;
  },
  setTokenStats: (social, trade) => {
    _tokenStatsPanelData = { social: social || null, trade: trade || null };
    _tokenStatsVersion++;
    lastOutputKey = null;
  }
};
