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

// TV viewport bounds (extracted from mask.png, scaled to output resolution)
let TV_VIEWPORT = null;
let currentTVFrame = null; // Current TV frame buffer for compositing
let tvContentVersion = 0;  // Stable content version: same buffer ref → same version (WeakMap-based)
let _lastTVFrameRef = null; // Last buffer passed to setTVFrame
const _tvFrameVersionMap = new WeakMap(); // Buffer → stable version number (GC-safe)
let _tvVersionCounter = 0; // Monotonic counter for assigning new version numbers
let tvReflectionBuffer = null; // TV reflection layer (composited above TV content)
let tvReflectionPos = { x: 0, y: 0 }; // Position of TV reflection layer

// Chat overlay state (Twitch-style message log)
let chatMessages = [];       // Array of { character, text, addedAt }
let chatVersion = 0;         // Bumped on add/expire (cache invalidation)
const CHAT_MAX_MESSAGES = 8;
const CHAT_EXPIRE_MS = 45000; // 45 seconds

// Ticker state — scrolling bottom strip (multi-slot playlist)
let tickerMessages = [];       // array of strings, plays in order
let tickerCurrentIndex = 0;    // index into tickerMessages of currently playing slot
let tickerSlotStartMs = 0;     // when the current slot started scrolling
const TICKER_SPEED = 120;     // px/sec, right to left
const TICKER_FONT_SIZE = 20;  // px
const TICKER_HEIGHT = 36;     // px (≈5% of 720p)

// Meme queue overlay (top-right corner)
let memeQueueItems = [];  // Array of { segmentId, title }
let memeQueueVersion = 0; // Bumped on change (cache invalidation)

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

  // Extract TV viewport bounds from mask.png
  TV_VIEWPORT = await extractTVViewport();

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
        // TV Reflection is handled separately (composited above TV content)
        if (layer.id === 'TV_Reflection_') {
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
  const cycleDurationMs = (cycleWidthPx / TICKER_SPEED) * 1000;

  const now = Date.now();
  if (!tickerSlotStartMs) tickerSlotStartMs = now;
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

  const scrollX = Math.round(outputWidth - ((now - tickerSlotStartMs) / cycleDurationMs) * cycleWidthPx);
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
  <text x="${scrollX}" y="${textY}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${TICKER_FONT_SIZE}" font-weight="600" xml:space="preserve">${tspans}</text>
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

/**
 * Build the "Queued Memes" panel SVG — top-right corner.
 * Shows up to 10 meme titles; last two fade to signal more may exist.
 * Returns Buffer or null if queue is empty.
 */
function buildMemeQueueSvg() {
  if (!outputWidth || !outputHeight || memeQueueItems.length === 0) return null;

  const items = memeQueueItems.slice(0, 10);
  const PANEL_W = 264;
  const PAD_X   = 12;
  const PAD_Y   = 8;
  const MARGIN  = 16;
  const TITLE_FONT = 11;
  const TITLE_H    = 22; // height of the title row (text + gap below)
  const ITEM_FONT  = 13;
  const ITEM_H     = 20;
  const MAX_CHARS  = 30; // truncate titles longer than this

  const panelH = PAD_Y + TITLE_H + items.length * ITEM_H + PAD_Y;
  const panelX = outputWidth - MARGIN - PANEL_W; // right-aligned
  const panelY = MARGIN;

  // Strip parenthetical labels like "(wise, old)" and truncate
  const cleanTitle = (s) => {
    const stripped = s.replace(/\s*\([^)]*\)/g, '').trim();
    return stripped.length > MAX_CHARS ? stripped.slice(0, MAX_CHARS - 1) + '\u2026' : stripped;
  };

  // Fade last 2 items only when there are 3+ items, to hint the list continues
  const getOpacity = (i, total) => {
    if (total <= 2) return 1.0;
    if (i === total - 1) return 0.18;
    if (i === total - 2) return 0.5;
    return 1.0;
  };

  // Coordinates relative to the SVG's own origin (top-left = panelX, panelY in output)
  const relTextX = PAD_X;
  const relTitleY = PAD_Y + TITLE_FONT;
  const relDividerY = PAD_Y + TITLE_H;

  const itemRows = items.map((item, i) => {
    const y = relDividerY + (i + 1) * ITEM_H - 4;
    const op = getOpacity(i, items.length);
    const weight = i === 0 ? '600' : '400';
    const fill = i === 0 ? '#ffffff' : 'rgba(255,255,255,0.85)';
    return `<text x="${relTextX}" y="${y}" fill="${fill}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${ITEM_FONT}" font-weight="${weight}" opacity="${op.toFixed(2)}">${escapeSvgText(cleanTitle(item.title))}</text>`;
  }).join('');

  // SVG is only PANEL_W × panelH — much smaller than full 1280×720 output
  const svg = `<svg width="${PANEL_W}" height="${panelH}" xmlns="http://www.w3.org/2000/svg">
    <line x1="${PAD_X}" y1="${relDividerY}" x2="${PANEL_W - PAD_X}" y2="${relDividerY}" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
    <text x="${relTextX}" y="${relTitleY}" fill="rgba(255,255,255,0.45)" font-family="DejaVu Sans, Arial, sans-serif" font-size="${TITLE_FONT}" font-weight="700" letter-spacing="1.5">QUEUED MEMES</text>
    ${itemRows}
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
async function _buildBaseFromParts(fireFrame = fireState.frame) {
  if (!lowerStaticBase || !outputWidth) return staticBaseBuffer; // Not ready yet

  // Cache hit: same fire frame already built for this staticBaseVersion
  const cached = fireFrameBaseCache[fireFrame];
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

  // Upper static (TV + characters + props) as a single pre-composited transparent PNG
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
  // Cache by fire frame — valid until next _rebuildStaticBase clears it
  fireFrameBaseCache[fireFrame] = base;
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
async function buildExpressionBase(exprBaseCacheKey, exprSnapshot, fireFrame = fireState.frame) {
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
  const sceneBase = await _buildBaseFromParts(fireFrame);
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
  const exprBaseCacheKey = `v${staticBaseVersion}-f${capturedFireFrame}-${exprKey}`;
  const l1Hit = exprBaseCache[exprBaseCacheKey]; // { data, info } raw RGBA or undefined
  let exprBaseRaw;
  let effectiveExprBaseKey;

  if (!l1Hit) {
    // L1 miss — fire background build (+ pre-warm → committed swap)
    if (!exprBaseInFlight.has(exprBaseCacheKey)) {
      const snapshot = JSON.parse(JSON.stringify(exprSnapshot));
      const task = buildExpressionBase(exprBaseCacheKey, snapshot, capturedFireFrame)
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
  const outputKey = `${effectiveExprBaseKey}-${chadPhoneme}-${virginPhoneme}-${chadBlinking ? 1 : 0}-${virginBlinking ? 1 : 0}-tv${tvContentVersion}-c${captionKey}-ch${currentChatVersion}-mq${memeQueueVersion}`;

  // Fast path: skip all compositing if nothing changed and ticker is inactive
  if (!hasActiveTicker && outputKey === lastOutputKey && lastOutputBuffer) {
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

  if (currentTVFrame && TV_VIEWPORT) {
    overlayOps.push({
      input: currentTVFrame,
      left: TV_VIEWPORT.x,
      top: TV_VIEWPORT.y,
      blend: 'over'
    });

    if (tvReflectionBuffer) {
      overlayOps.push({
        input: tvReflectionBuffer,
        left: tvReflectionPos.x,
        top: tvReflectionPos.y,
        blend: 'over'
      });
    }
  }

  // SVG builders return { input, left, top } positioned to their content bounds.
  // This reduces librsvg rasterization area vs full 1280×720 SVGs.
  const captionOp = caption ? buildCaptionSvg(caption) : null;
  if (captionOp) overlayOps.push({ ...captionOp, blend: 'over' });

  const chatOp = buildChatOverlaySvg();
  if (chatOp) overlayOps.push({ ...chatOp, blend: 'over' });

  const memeQueueOp = buildMemeQueueSvg();
  if (memeQueueOp) overlayOps.push({ ...memeQueueOp, blend: 'over' });

  // Ticker: correctly-sized SVG (1280×TICKER_HEIGHT = 36px, ~20× less than full frame).
  // Composited in the same single pass — rasterization cost is negligible at this size.
  if (hasActiveTicker) {
    const tickerOp = buildTickerSvg();
    if (tickerOp) overlayOps.push({ ...tickerOp, blend: 'over' });
  }

  // Check output cache (non-ticker frames only — ticker output scrolls every frame)
  let result;
  if (!hasActiveTicker) {
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
    lastOutputKey = null; // invalidate output fast path
  }
};
