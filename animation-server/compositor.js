const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT_DIR = path.resolve(__dirname, '..');
const LAYERS_DIR = path.join(ROOT_DIR, 'exported-layers');
const MANIFEST_PATH = path.join(LAYERS_DIR, 'manifest.json');

let manifest = null;
let scaledLayerBuffers = {};
let staticBaseBuffer = null; // Pre-composited static layers
let frameCache = {};          // Cache for common frame states
const OUTPUT_SCALE = 1/3; // Render at 1280x720 instead of 3840x2160
const JPEG_QUALITY = 80;  // Reduced from 90 for faster encoding

function loadManifest() {
  if (!manifest) {
    if (!fs.existsSync(MANIFEST_PATH)) {
      throw new Error(`Manifest not found: ${MANIFEST_PATH}. Run 'node tools/export-psd.js' first.`);
    }
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
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

async function preloadLayers() {
  const m = loadManifest();
  const outputWidth = Math.round(m.width * OUTPUT_SCALE);
  const outputHeight = Math.round(m.height * OUTPUT_SCALE);

  console.log('Preloading layer images...');

  // Separate static and dynamic layers
  const staticLayers = [];
  const dynamicLayers = [];

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
        if (layer.type === 'static' && layer.visible !== false) {
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
  staticLayers.sort((a, b) => a.zIndex - b.zIndex);

  const staticOps = staticLayers.map(layer => ({
    input: layer.buffer,
    left: Math.round(layer.x * OUTPUT_SCALE),
    top: Math.round(layer.y * OUTPUT_SCALE),
    blend: 'over'
  }));

  staticBaseBuffer = await sharp({
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

  console.log(`Preloaded ${Object.keys(scaledLayerBuffers).length} layers, static base ready`);
}

/**
 * Composite a frame with both characters visible
 * Uses caching for common frame states (most frames are identical)
 */
async function compositeFrame(state) {
  const {
    chadPhoneme = 'A',
    virginPhoneme = 'A',
    chadBlinking = false,
    virginBlinking = false
  } = state;

  // Create cache key from state
  const cacheKey = `${chadPhoneme}-${virginPhoneme}-${chadBlinking ? 1 : 0}-${virginBlinking ? 1 : 0}`;

  // Return cached frame if available
  if (frameCache[cacheKey]) {
    return frameCache[cacheKey];
  }

  const m = loadManifest();

  // Start with static base
  const compositeOps = [];

  // Only add dynamic layers (mouths and blinks)
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

  // Composite: static base + dynamic layers
  const result = await sharp(staticBaseBuffer)
    .composite(compositeOps)
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();

  // Cache the result (limit cache size to prevent memory bloat)
  if (Object.keys(frameCache).length < 100) {
    frameCache[cacheKey] = result;
  }

  return result;
}

function clearCache() {
  scaledLayerBuffers = {};
  staticBaseBuffer = null;
  frameCache = {};
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

module.exports = {
  compositeFrame,
  loadManifest,
  preloadLayers,
  clearCache,
  getManifestDimensions
};
