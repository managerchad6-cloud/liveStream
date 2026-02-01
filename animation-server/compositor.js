const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Libvips thread pool: default 2 (VPS-friendly). Override with SHARP_CONCURRENCY env (e.g. 4 on Windows).
const sharpConcurrency = parseInt(process.env.SHARP_CONCURRENCY, 10);
sharp.concurrency(Number.isFinite(sharpConcurrency) && sharpConcurrency > 0 ? sharpConcurrency : 2);

const ROOT_DIR = path.resolve(__dirname, '..');
const LAYERS_DIR = path.join(ROOT_DIR, 'exported-layers');
const MANIFEST_PATH = path.join(LAYERS_DIR, 'manifest.json');
const MASK_PATH = path.join(LAYERS_DIR, 'mask.png');

let manifest = null;
let scaledLayerBuffers = {};
let staticBaseBuffer = null; // Pre-composited static layers
let frameCache = {};          // Cache for character state (JPEG buffers)
let lastOutputKey = null;     // Key of the last full output frame
let lastOutputBuffer = null;  // Last complete JPEG output buffer
const OUTPUT_SCALE = 1/3; // Render at 1280x720 instead of 3840x2160
const JPEG_QUALITY = 80;  // Reduced from 90 for faster encoding
let outputWidth = 0;
let outputHeight = 0;
let staticLayerEntries = [];
let staticBaseVersion = 0;

// TV viewport bounds (extracted from mask.png, scaled to output resolution)
let TV_VIEWPORT = null;
let currentTVFrame = null; // Current TV frame buffer for compositing
let tvReflectionBuffer = null; // TV reflection layer (composited above TV content)
let tvReflectionPos = { x: 0, y: 0 }; // Position of TV reflection layer
let foregroundEmissionBuffer = null; // Foreground LED emission (composited above all)
let foregroundEmissionPos = { x: 0, y: 0 };
let foregroundEmissionLayerId = null;
let lightsOnBuffer = null;
let lightsOnPos = { x: 0, y: 0 };
let lightsOnOpacity = 1;
let lightsMode = 'on'; // 'on' or 'off'
let emissionOpacity = 1;
let emissionBaseBuffers = {};
let emissionLayerMeta = {};
let emissionLayerBlend = {};
let lightingHue = 0;
let lightingUpdateId = 0;
let lightingBaseBuffers = {};
let lightingLayerMeta = {};

const EMISSION_LAYER_KEYS = {
  foreground: 'LED light Emission (Foreground)',
  middleground: 'LED light Emission (Middleground)',
  background: 'LED light Emission (Background)'
};
let emissionLayerEnabled = {
  [EMISSION_LAYER_KEYS.foreground]: true,
  [EMISSION_LAYER_KEYS.middleground]: true,
  [EMISSION_LAYER_KEYS.background]: true
};
const EMISSION_LAYER_NAMES = new Set([
  EMISSION_LAYER_KEYS.foreground,
  EMISSION_LAYER_KEYS.middleground,
  EMISSION_LAYER_KEYS.background
]);
const LIGHTING_LAYER_NAMES = new Set([
  EMISSION_LAYER_KEYS.foreground,
  EMISSION_LAYER_KEYS.middleground,
  EMISSION_LAYER_KEYS.background,
  'LED Strip',
  'Chad Sculpture'
]);

const LIGHTS_ON_MASK_THRESHOLD = 55;

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
  foregroundEmissionBuffer = null;
  foregroundEmissionPos = { x: 0, y: 0 };
  foregroundEmissionLayerId = null;
  lightsOnBuffer = null;
  lightsOnPos = { x: 0, y: 0 };
  emissionBaseBuffers = {};
  emissionLayerMeta = {};
  emissionLayerBlend = {
    [EMISSION_LAYER_KEYS.foreground]: emissionLayerBlend[EMISSION_LAYER_KEYS.foreground] || 'soft-light',
    [EMISSION_LAYER_KEYS.middleground]: emissionLayerBlend[EMISSION_LAYER_KEYS.middleground] || 'soft-light',
    [EMISSION_LAYER_KEYS.background]: emissionLayerBlend[EMISSION_LAYER_KEYS.background] || 'soft-light'
  };
  lightingBaseBuffers = {};
  lightingLayerMeta = {};

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
        } else if (layer.name === 'Lights On') {
          const { data } = await sharp(buffer)
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

          for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
            if (max <= LIGHTS_ON_MASK_THRESHOLD) {
              data[i + 3] = 0;
            }
          }

          lightsOnBuffer = await sharp(data, {
            raw: {
              width: scaledWidth,
              height: scaledHeight,
              channels: 4
            }
          })
          .png()
          .toBuffer();
          lightsOnPos = {
            x: Math.round(layer.x * OUTPUT_SCALE),
            y: Math.round(layer.y * OUTPUT_SCALE)
          };
        } else if (layer.name === EMISSION_LAYER_KEYS.foreground) {
          foregroundEmissionBuffer = buffer;
          foregroundEmissionLayerId = layer.id;
          foregroundEmissionPos = {
            x: Math.round(layer.x * OUTPUT_SCALE),
            y: Math.round(layer.y * OUTPUT_SCALE)
          };
          emissionBaseBuffers[layer.id] = buffer;
          emissionLayerMeta[layer.id] = { width: scaledWidth, height: scaledHeight, name: layer.name };
          lightingBaseBuffers[layer.id] = buffer;
          lightingLayerMeta[layer.id] = { width: scaledWidth, height: scaledHeight, name: layer.name };
        } else if (layer.type === 'static' && layer.visible !== false) {
          if (EMISSION_LAYER_NAMES.has(layer.name)) {
            emissionBaseBuffers[layer.id] = buffer;
            emissionLayerMeta[layer.id] = { width: scaledWidth, height: scaledHeight, name: layer.name };
          }
          if (LIGHTING_LAYER_NAMES.has(layer.name)) {
            lightingBaseBuffers[layer.id] = buffer;
            lightingLayerMeta[layer.id] = { width: scaledWidth, height: scaledHeight, name: layer.name };
          }
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
  staticBaseBuffer = await buildStaticBaseFromEntries(staticLayerEntries, emissionLayerBlend);
  staticBaseVersion += 1;
  frameCache = {};
  lastOutputKey = null;
  lastOutputBuffer = null;

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

async function buildStaticBaseFromEntries(entries, layerBlendMap) {
  const sorted = [...entries]
    .filter(layer => layer.name !== 'Lights On' && layer.id !== 'Lights_On')
    .sort((a, b) => a.zIndex - b.zIndex);
  const staticOps = sorted.map(layer => ({
    input: layer.buffer,
    left: Math.round(layer.x * OUTPUT_SCALE),
    top: Math.round(layer.y * OUTPUT_SCALE),
    blend: EMISSION_LAYER_NAMES.has(layer.name)
      ? (layerBlendMap[layer.name] || 'soft-light')
      : 'over',
    opacity: 1
  }));

  return sharp({
    create: {
      width: outputWidth,
      height: outputHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 }
    }
  })
  .composite(staticOps)
  .png()
  .toBuffer();
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
async function compositeFrame(state) {
  const {
    chadPhoneme = 'A',
    virginPhoneme = 'A',
    chadBlinking = false,
    virginBlinking = false,
    caption = null
  } = state;

  // Build a full output key that includes ALL visual state
  const hasTv = currentTVFrame ? 1 : 0;
  const captionKey = caption ? caption.slice(0, 40) : '';
  const outputKey = `${staticBaseVersion}-${chadPhoneme}-${virginPhoneme}-${chadBlinking ? 1 : 0}-${virginBlinking ? 1 : 0}-tv${hasTv}-c${captionKey}`;

  // Fast path: if nothing changed since last frame, return last output directly (0 pipelines)
  if (outputKey === lastOutputKey && lastOutputBuffer && !hasTv) {
    return lastOutputBuffer;
  }

  // Character frame cache includes: static base + mouths + blinks + emission + lights
  // This means idle frames (no TV, no caption) need 0 overlay pipelines
  const charCacheKey = `${staticBaseVersion}-${chadPhoneme}-${virginPhoneme}-${chadBlinking ? 1 : 0}-${virginBlinking ? 1 : 0}`;
  let charBuffer = frameCache[charCacheKey];

  if (!charBuffer) {
    const m = loadManifest();

    // Dynamic layers: mouths and blinks
    const compositeOps = [];
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
        compositeOps.push({
          input: buffer,
          left: Math.round(layer.x * OUTPUT_SCALE),
          top: Math.round(layer.y * OUTPUT_SCALE),
          blend: 'over'
        });
      }
    }

    // Bake foreground emission into character frame (above mouths/blinks)
    if (foregroundEmissionBuffer && emissionLayerEnabled[EMISSION_LAYER_KEYS.foreground]) {
      compositeOps.push({
        input: foregroundEmissionBuffer,
        left: foregroundEmissionPos.x,
        top: foregroundEmissionPos.y,
        blend: emissionLayerBlend[EMISSION_LAYER_KEYS.foreground] || 'soft-light'
      });
    }

    // Bake lights into character frame (above emission)
    if (lightsMode === 'on' && lightsOnBuffer) {
      compositeOps.push({
        input: lightsOnBuffer,
        left: lightsOnPos.x,
        top: lightsOnPos.y,
        blend: 'over'
      });
    }

    // Composite: static base + mouths + blinks + emission + lights → JPEG
    charBuffer = await sharp(staticBaseBuffer)
      .composite(compositeOps)
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();

    // Cache the result
    if (Object.keys(frameCache).length < 100) {
      frameCache[charCacheKey] = charBuffer;
    }
  }

  // Overlays: only TV content and captions (emission + lights are baked into charBuffer)
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

  let result;
  if (overlayOps.length > 0) {
    result = await sharp(charBuffer)
      .composite(overlayOps)
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
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
  lastOutputKey = null;
  lastOutputBuffer = null;
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

async function setEmissionOpacity(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return emissionOpacity;
  const nextOpacity = Math.max(0, Math.min(1, parsed));
  if (nextOpacity === emissionOpacity) return emissionOpacity;

  const updatedBuffers = {};
  for (const layerId of Object.keys(emissionBaseBuffers)) {
    const base = emissionBaseBuffers[layerId];
    const meta = emissionLayerMeta[layerId];
    if (!meta) continue;
    updatedBuffers[layerId] = await applyOpacityToBuffer(base, meta, nextOpacity);
  }

  const updatedScaled = { ...scaledLayerBuffers, ...updatedBuffers };
  const updatedEntries = staticLayerEntries.map(entry => ({
    ...entry,
    buffer: updatedScaled[entry.id] || entry.buffer
  }));

  const nextBase = await buildStaticBaseFromEntries(updatedEntries, emissionLayerBlend);

  scaledLayerBuffers = updatedScaled;
  staticLayerEntries = updatedEntries;
  staticBaseBuffer = nextBase;
  staticBaseVersion += 1;
  frameCache = {};
  lastOutputKey = null;
  lastOutputBuffer = null;
  emissionOpacity = nextOpacity;
  if (foregroundEmissionLayerId && updatedScaled[foregroundEmissionLayerId]) {
    foregroundEmissionBuffer = updatedScaled[foregroundEmissionLayerId];
  }
  return emissionOpacity;
}

async function setEmissionLayerBlend(name, blend) {
  const allowed = new Set([
    'over',
    'multiply',
    'screen',
    'overlay',
    'darken',
    'lighten',
    'hard-light',
    'soft-light',
    'difference',
    'exclusion',
    'add',
    'subtract',
    'divide'
  ]);
  if (!EMISSION_LAYER_NAMES.has(name)) return emissionLayerBlend;
  if (!allowed.has(blend)) return emissionLayerBlend;
  emissionLayerBlend[name] = blend;
  const nextBase = await buildStaticBaseFromEntries(staticLayerEntries, emissionLayerBlend);
  staticBaseBuffer = nextBase;
  staticBaseVersion += 1;
  frameCache = {};
  lastOutputKey = null;
  lastOutputBuffer = null;
  return emissionLayerBlend;
}

function getEmissionLayerBlend() {
  return { ...emissionLayerBlend };
}

function getEmissionOpacity() {
  return emissionOpacity;
}

function setLightsOnOpacity(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return lightsOnOpacity;
  lightsOnOpacity = Math.max(0, Math.min(1, parsed));
  return lightsOnOpacity;
}

function getLightsOnOpacity() {
  return lightsOnOpacity;
}

function setLightsMode(mode) {
  if (mode !== 'on' && mode !== 'off') return lightsMode;
  lightsMode = mode;
  return lightsMode;
}

function getLightsMode() {
  return lightsMode;
}

async function setLightingHue(hue) {
  const parsed = Number(hue);
  if (!Number.isFinite(parsed)) return lightingHue;
  const nextHue = Math.max(-180, Math.min(180, parsed));
  if (nextHue === lightingHue) return lightingHue;

  const updateId = ++lightingUpdateId;
  const hueForSharp = Math.round(((nextHue % 360) + 360) % 360);
  const updatedLighting = {};

  for (const layerId of Object.keys(lightingBaseBuffers)) {
    const base = lightingBaseBuffers[layerId];
    const updated = nextHue === 0
      ? base
      : await sharp(base).modulate({ hue: hueForSharp }).png().toBuffer();
    if (updateId !== lightingUpdateId) {
      return lightingHue;
    }
    updatedLighting[layerId] = updated;
  }

  const updatedScaled = { ...scaledLayerBuffers };
  const updatedEntries = staticLayerEntries.map(entry => ({ ...entry }));
  const updatedEmissionBase = { ...emissionBaseBuffers };
  let updatedForegroundBuffer = foregroundEmissionBuffer;

  for (const layerId of Object.keys(updatedLighting)) {
    const meta = lightingLayerMeta[layerId];
    const name = meta?.name;
    const updated = updatedLighting[layerId];
    if (name && EMISSION_LAYER_NAMES.has(name)) {
      updatedEmissionBase[layerId] = updated;
      const withOpacity = await applyOpacityToBuffer(updated, emissionLayerMeta[layerId], emissionOpacity);
      updatedScaled[layerId] = withOpacity;
      if (foregroundEmissionLayerId === layerId) {
        updatedForegroundBuffer = withOpacity;
      }
    } else {
      updatedScaled[layerId] = updated;
    }
  }

  for (const entry of updatedEntries) {
    if (updatedScaled[entry.id]) {
      entry.buffer = updatedScaled[entry.id];
    }
  }

  const nextBase = await buildStaticBaseFromEntries(updatedEntries, emissionLayerBlend);
  if (updateId !== lightingUpdateId) {
    return lightingHue;
  }

  scaledLayerBuffers = updatedScaled;
  staticLayerEntries = updatedEntries;
  emissionBaseBuffers = updatedEmissionBase;
  foregroundEmissionBuffer = updatedForegroundBuffer;
  staticBaseBuffer = nextBase;
  staticBaseVersion += 1;
  frameCache = {};
  lastOutputKey = null;
  lastOutputBuffer = null;
  lightingHue = nextHue;
  return lightingHue;
}

function getLightingHue() {
  return lightingHue;
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
  setEmissionOpacity,
  getEmissionOpacity,
  setEmissionLayerBlend,
  getEmissionLayerBlend,
  setLightsOnOpacity,
  getLightsOnOpacity,
  setLightsMode,
  getLightsMode,
  setLightingHue,
  getLightingHue
};
