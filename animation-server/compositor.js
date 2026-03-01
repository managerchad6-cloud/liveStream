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

let manifest = null;
let scaledLayerBuffers = {};
let staticBaseBuffer = null; // Pre-composited static layers { data, info } raw RGBA
let frameCache = {};          // Cache for character state (JPEG buffers) - Level 2
const FRAME_CACHE_MAX = 200;  // Level 2 cache: expression base + phoneme + blink
let lastOutputKey = null;     // Key of the last full output frame
let lastOutputBuffer = null;  // Last complete JPEG output buffer
let outputCache = {};         // Cache for full output frames (charBuffer + caption/TV overlay)
const OUTPUT_CACHE_MAX = 60;  // Max cached output frames
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
let tvReflectionBuffer = null; // TV reflection layer (composited above TV content)
let tvReflectionPos = { x: 0, y: 0 }; // Position of TV reflection layer

// Leaderboard state
let currentLeaderboard = null; // Array of {command, count} or null
let leaderboardVersion = 0;     // Incremented when leaderboard changes
let leaderboardTimer = { remainingSeconds: 180, isIdle: false, winner: null }; // Timer state

// Chat overlay state (Twitch-style message log)
let chatMessages = [];       // Array of { character, text, addedAt }
let chatVersion = 0;         // Bumped on add/expire (cache invalidation)
const CHAT_MAX_MESSAGES = 8;
const CHAT_EXPIRE_MS = 45000; // 45 seconds

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

  // Pre-composite static layers into base image
  console.log('Pre-compositing static base image...');
  staticLayerEntries = staticLayers;
  staticBaseBuffer = await buildStaticBaseFromEntries(staticLayerEntries);
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

  const textLines = lines.map((line, index) => {
    const y = textY + index * lineHeight;
    return `<text x="${textX}" y="${y}">${escapeSvgText(line)}</text>`;
  }).join('');

  const svg = `
    <svg width="${outputWidth}" height="${outputHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect x="${bannerX}" y="${bannerY}" width="${bannerWidth}" height="${bannerHeight}" rx="16" ry="16" fill="rgba(0,0,0,0.6)"/>
      <g fill="#ffffff" font-family="DejaVu Sans, Arial, sans-serif" font-size="${fontSize}" font-weight="600">
        ${textLines}
      </g>
    </svg>
  `;

  return Buffer.from(svg);
}

/**
 * Build timer SVG overlay (top-center, slightly right)
 * @returns {Buffer|null} - SVG buffer or null
 */
function buildTimerSvg() {
  if (!outputWidth || !outputHeight) {
    return null;
  }

  const baseTimerFontSize = 48;
  const margin = 20;
  const rightOffset = 60; // Shift right from center

  // Timer display text
  let timerText = '';
  let fontSize = baseTimerFontSize;

  if (leaderboardTimer.isIdle && leaderboardTimer.winner) {
    // During idle minute, show winner name at half size
    timerText = String(leaderboardTimer.winner).slice(0, 50);
    fontSize = baseTimerFontSize / 2;
  } else if (leaderboardTimer.isIdle) {
    // Idle with no winner (no memes submitted) - show nothing
    return null;
  } else {
    // During countdown, show timer at full size
    const minutes = Math.floor(leaderboardTimer.remainingSeconds / 60);
    const seconds = leaderboardTimer.remainingSeconds % 60;
    timerText = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  // Center positioning with right offset
  const textWidth = timerText.length * fontSize * 0.55; // Rough approximation
  const textX = (outputWidth - textWidth) / 2 + rightOffset;
  const textY = margin + fontSize;

  const svg = `
    <svg width="${outputWidth}" height="${outputHeight}" xmlns="http://www.w3.org/2000/svg">
      <g fill="#ffffff" font-family="DejaVu Sans, Arial, sans-serif" font-size="${fontSize}" font-weight="700">
        <text x="${textX}" y="${textY}">${escapeSvgText(timerText)}</text>
      </g>
    </svg>
  `;

  return Buffer.from(svg);
}

/**
 * Build leaderboard SVG overlay (top-right corner)
 * @param {Array} entries - Array of {command, count} objects
 * @returns {Buffer|null} - SVG buffer or null if no entries
 */
function buildLeaderboardSvg(entries) {
  if (!outputWidth || !outputHeight) {
    return null;
  }

  const margin = 20;
  const fontSize = 16;
  const titleFontSize = 18;
  const subtitleFontSize = 10;
  const lineHeight = Math.round(fontSize * 1.4);
  const titleLineHeight = Math.round(titleFontSize * 1.3);
  const subtitleLineHeight = Math.round(subtitleFontSize * 1.3);
  const paddingX = 14;
  const paddingY = 10;
  const maxEntries = Math.min(3, entries.length);

  const title = "NEXT MEME CONTENDER";
  const subtitle = "Type /your_meme_idea to submit or vote";

  // Build text lines: "🏆 /command: 42"
  const lines = (entries && Array.isArray(entries) && entries.length > 0)
    ? entries.slice(0, maxEntries).map((entry, idx) => {
        const emoji = idx === 0 ? '🏆' : (idx === 1 ? '🥈' : '🥉');
        const cmd = String(entry.command || '').slice(0, 30);
        const count = Number(entry.count) || 0;
        return `${emoji} ${cmd}: ${count}`;
      })
    : [];

  const textBlockHeight = titleLineHeight + subtitleLineHeight + (lines.length * lineHeight);
  const bannerHeight = textBlockHeight + paddingY * 2;
  const bannerWidth = Math.min(280, outputWidth - margin * 2);
  const bannerX = outputWidth - margin - bannerWidth;
  const bannerY = margin;
  const textX = bannerX + paddingX;
  let currentY = bannerY + paddingY + titleFontSize;

  // Title
  const titleText = `<text x="${textX}" y="${currentY}" font-size="${titleFontSize}" font-weight="700" letter-spacing="0.5">${escapeSvgText(title)}</text>`;
  currentY += titleLineHeight;

  // Subtitle
  const subtitleText = `<text x="${textX}" y="${currentY}" font-size="${subtitleFontSize}" font-weight="400" opacity="0.8">${escapeSvgText(subtitle)}</text>`;
  currentY += subtitleLineHeight + 4;

  // Leaderboard lines
  const textLines = lines.map((line, index) => {
    const y = currentY + index * lineHeight;
    return `<text x="${textX}" y="${y}" font-size="${fontSize}">${escapeSvgText(line)}</text>`;
  }).join('');

  const svg = `
    <svg width="${outputWidth}" height="${outputHeight}" xmlns="http://www.w3.org/2000/svg">
      <g fill="#ffffff" font-family="DejaVu Sans, Arial, sans-serif" font-weight="500">
        ${titleText}
        ${subtitleText}
        ${textLines}
      </g>
    </svg>
  `;

  return Buffer.from(svg);
}

/**
 * Set the current TV frame buffer for compositing
 * @param {Buffer|null} buffer - PNG buffer scaled to viewport size, or null to clear
 */
function setTVFrame(buffer) {
  currentTVFrame = buffer;
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
 * Set the current leaderboard data for overlay
 * @param {Array|null} entries - Array of {command, count} objects, or null to clear
 */
function setLeaderboard(entries) {
  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    if (currentLeaderboard !== null) {
      currentLeaderboard = null;
      leaderboardVersion++;
    }
    return;
  }

  // Check if data actually changed (avoid version bumps on identical data)
  const newHash = JSON.stringify(entries.slice(0, 3).map(e => ({ c: e.command, n: e.count })));
  const oldHash = currentLeaderboard
    ? JSON.stringify(currentLeaderboard.slice(0, 3).map(e => ({ c: e.command, n: e.count })))
    : '';

  if (newHash !== oldHash) {
    currentLeaderboard = entries.slice(0, 3); // Keep top 3
    leaderboardVersion++;
  }
}

/**
 * Get current leaderboard data
 * @returns {Array|null}
 */
function getLeaderboard() {
  return currentLeaderboard;
}

/**
 * Get current leaderboard version (for cache key)
 * @returns {number}
 */
function getLeaderboardVersion() {
  return leaderboardVersion;
}

/**
 * Set the leaderboard timer state
 * @param {number} remainingSeconds - Seconds remaining in countdown
 * @param {boolean} isIdle - Whether timer is in idle/winner display mode
 * @param {string|null} winner - Winner command to display during idle
 */
function setLeaderboardTimer(remainingSeconds, isIdle, winner) {
  const changed = leaderboardTimer.remainingSeconds !== remainingSeconds ||
                  leaderboardTimer.isIdle !== isIdle ||
                  leaderboardTimer.winner !== winner;

  if (changed) {
    leaderboardTimer = { remainingSeconds, isIdle, winner };
    leaderboardVersion++; // Force cache update when timer changes
  }
}

/**
 * Get current leaderboard timer state
 * @returns {Object} - {remainingSeconds, isIdle, winner}
 */
function getLeaderboardTimer() {
  return { ...leaderboardTimer };
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

  const bannerHeight = chatMessages.length * lineHeight + paddingY * 2;
  const bannerX = margin;
  const bannerY = outputHeight - bottomReserve - bannerHeight;

  const lines = chatMessages.map((msg, i) => {
    const age = now - msg.addedAt;
    const lifeRatio = age / CHAT_EXPIRE_MS;
    // Full opacity for first 65% of lifetime, fade to 0.2 over remaining 35%
    const opacity = lifeRatio < 0.65 ? 1.0 : Math.max(0.2, 1.0 - ((lifeRatio - 0.65) / 0.35) * 0.8);
    const y = bannerY + paddingY + fontSize + i * lineHeight;
    const name = msg.username;
    return `<g opacity="${opacity.toFixed(2)}">` +
      `<text x="${bannerX + paddingX}" y="${y}" font-size="${fontSize}" font-weight="700" fill="#a78bfa" font-family="DejaVu Sans, Arial, sans-serif">${escapeSvgText(name)}:</text>` +
      `<text x="${bannerX + paddingX + name.length * fontSize * 0.65 + fontSize * 0.4}" y="${y}" font-size="${fontSize}" font-weight="400" fill="#ffffff" font-family="DejaVu Sans, Arial, sans-serif">${escapeSvgText(msg.text)}</text>` +
      `</g>`;
  }).join('');

  const svg = `
    <svg width="${outputWidth}" height="${outputHeight}" xmlns="http://www.w3.org/2000/svg">
      ${lines}
    </svg>
  `;

  return Buffer.from(svg);
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
async function buildExpressionBase(exprBaseCacheKey, exprSnapshot) {
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

  // Composite Level 1: staticBase (raw RGBA) + expression layers + nose → raw RGBA buffer
  const exprBaseResult = await sharp(staticBaseBuffer.data, {
    raw: { width: staticBaseBuffer.info.width, height: staticBaseBuffer.info.height, channels: staticBaseBuffer.info.channels }
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

  // Fire L2 pre-warming in the background (never blocks frame loop)
  const speakChar = currentSpeakingCharacter;
  if (speakChar) {
    setImmediate(() => preWarmL2(exprBaseCacheKey, exprBaseRaw, speakChar));
  } else {
    // No one speaking — just swap committed base directly
    committedExprBaseKey = exprBaseCacheKey;
    committedExprBaseBuffer = exprBaseRaw;
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
 */
function preWarmL2(exprBaseCacheKey, exprBaseRaw, speakingChar) {
  const m = loadManifest();
  const phonemes = ['A', 'B', 'C', 'D', 'E', 'F'];
  const otherChar = speakingChar === 'chad' ? 'virgin' : 'chad';

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

    // Composite Level 2 from raw RGBA expression base
    const charBuffer = await sharp(exprBaseRaw.data, {
      raw: { width: exprBaseRaw.info.width, height: exprBaseRaw.info.height, channels: exprBaseRaw.info.channels }
    })
      .composite(charOps)
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();

    // Store in L2 cache
    const frameCacheKeys = Object.keys(frameCache);
    if (frameCacheKeys.length >= FRAME_CACHE_MAX) {
      for (let i = 0; i < 20; i++) delete frameCache[frameCacheKeys[i]];
    }
    frameCache[charCacheKey] = charBuffer;
  });

  Promise.all(tasks).then(() => {
    // Atomically swap committed base now that L2 entries are pre-warmed
    committedExprBaseKey = exprBaseCacheKey;
    committedExprBaseBuffer = exprBaseRaw;
    console.log(`[Compositor] L2 pre-warm complete for ${exprBaseCacheKey} (${phonemes.length} entries)`);
  }).catch(err => {
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

  // Expression key for L1 cache lookup (based on current expression offsets)
  const exprKey = `ce${exprSnapshot.chad.eyes.x},${exprSnapshot.chad.eyes.y}`
    + `cbl${exprSnapshot.chad.eyebrows.left.y}r${exprSnapshot.chad.eyebrows.left.rotation}`
    + `cbr${exprSnapshot.chad.eyebrows.right.y}r${exprSnapshot.chad.eyebrows.right.rotation}`
    + `ve${exprSnapshot.virgin.eyes.x},${exprSnapshot.virgin.eyes.y}`
    + `vbl${exprSnapshot.virgin.eyebrows.left.y}r${exprSnapshot.virgin.eyebrows.left.rotation}`
    + `vbr${exprSnapshot.virgin.eyebrows.right.y}r${exprSnapshot.virgin.eyebrows.right.rotation}`;
  // === Two-level compositing ===
  // Level 1: Expression base (staticBase + expression layers + nose) — cached by exprKey.
  //   Only recomputes when expression offsets change (~3-5x/sec).
  // Level 2: Character frame (expression base + mouth + blink) — cached
  //   by phoneme+blink per expression base. Composites only a few layers.
  //   On phoneme changes, the expensive expression base is served from Level 1 cache.

  const exprBaseCacheKey = `${staticBaseVersion}-${exprKey}`;
  const l1Hit = exprBaseCache[exprBaseCacheKey]; // { data, info } raw RGBA or undefined
  let exprBaseRaw;
  let effectiveExprBaseKey;

  if (!l1Hit) {
    // L1 miss — fire background build (+ pre-warm → committed swap)
    if (!exprBaseInFlight.has(exprBaseCacheKey)) {
      const snapshot = JSON.parse(JSON.stringify(exprSnapshot));
      const task = buildExpressionBase(exprBaseCacheKey, snapshot)
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
  let outputKey = `${effectiveExprBaseKey}-${chadPhoneme}-${virginPhoneme}-${chadBlinking ? 1 : 0}-${virginBlinking ? 1 : 0}-tv${tvFrameIndex}-c${captionKey}-lb${leaderboardVersion}-ch${currentChatVersion}`;

  // Fast path: if nothing changed since last frame, return last output directly (0 pipelines)
  if (outputKey === lastOutputKey && lastOutputBuffer) {
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

    // Composite Level 2: expression base (raw RGBA) + mouth/blink → JPEG
    charBuffer = await sharp(exprBaseRaw.data, {
      raw: { width: exprBaseRaw.info.width, height: exprBaseRaw.info.height, channels: exprBaseRaw.info.channels }
    })
      .composite(charOps)
      .jpeg({ quality: JPEG_QUALITY })
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

  const captionSvg = caption ? buildCaptionSvg(caption) : null;
  if (captionSvg) {
    overlayOps.push({
      input: captionSvg,
      left: 0,
      top: 0,
      blend: 'over'
    });
  }

  const timerSvg = buildTimerSvg();
  if (timerSvg) {
    overlayOps.push({
      input: timerSvg,
      left: 0,
      top: 0,
      blend: 'over'
    });
  }

  const leaderboardSvg = currentLeaderboard ? buildLeaderboardSvg(currentLeaderboard) : null;
  if (leaderboardSvg) {
    overlayOps.push({
      input: leaderboardSvg,
      left: 0,
      top: 0,
      blend: 'over'
    });
  }

  const chatSvg = buildChatOverlaySvg();
  if (chatSvg) {
    overlayOps.push({
      input: chatSvg,
      left: 0,
      top: 0,
      blend: 'over'
    });
  }

  let result;
  if (overlayOps.length > 0) {
    // Check output cache before running overlay composite
    result = outputCache[outputKey];
    if (!result) {
      result = await sharp(charBuffer)
        .composite(overlayOps)
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer();
      // Cache output (tvFrameIndex in key ensures TV frames are distinct)
      const outKeys = Object.keys(outputCache);
      if (outKeys.length >= OUTPUT_CACHE_MAX) {
        for (let i = 0; i < 15; i++) delete outputCache[outKeys[i]];
      }
      outputCache[outputKey] = result;
    }
  } else {
    // No TV, no caption — cached JPEG includes everything (0 pipelines)
    result = charBuffer;
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
  setLeaderboard,
  getLeaderboard,
  getLeaderboardVersion,
  setLeaderboardTimer,
  getLeaderboardTimer,
  addChatMessage
};
