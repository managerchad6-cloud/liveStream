const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT_DIR = path.resolve(__dirname, '..');
const LAYERS_DIR = path.join(ROOT_DIR, 'exported-layers');
const MANIFEST_PATH = path.join(LAYERS_DIR, 'manifest.json');

let manifest = null;
let layerBuffers = {};
let scaledLayerBuffers = {};
const OUTPUT_SCALE = 1/3; // Render at 1280x720 instead of 3840x2160

function loadManifest() {
  if (!manifest) {
    if (!fs.existsSync(MANIFEST_PATH)) {
      throw new Error(`Manifest not found: ${MANIFEST_PATH}. Run 'node tools/export-psd.js' first.`);
    }
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    console.log(`Loaded manifest: ${manifest.layers.length} layers, ${manifest.width}x${manifest.height}`);
  }
  return manifest;
}

async function preloadLayers() {
  const m = loadManifest();
  console.log('Preloading layer images...');

  for (const layer of m.layers) {
    // Convert forward slashes from manifest to platform path
    const layerPath = path.join(LAYERS_DIR, ...layer.path.split('/'));

    if (!fs.existsSync(layerPath)) {
      console.warn(`Warning: Layer not found: ${layerPath}`);
      continue;
    }

    try {
      // Load and pre-scale layer for faster compositing
      const scaledWidth = Math.round(layer.width * OUTPUT_SCALE);
      const scaledHeight = Math.round(layer.height * OUTPUT_SCALE);

      if (scaledWidth > 0 && scaledHeight > 0) {
        scaledLayerBuffers[layer.id] = await sharp(layerPath)
          .resize(scaledWidth, scaledHeight)
          .png()
          .toBuffer();
      }
    } catch (err) {
      console.warn(`Warning: Could not load ${layer.id}:`, err.message);
    }
  }

  console.log(`Preloaded ${Object.keys(scaledLayerBuffers).length} layers at ${OUTPUT_SCALE * 100}% scale`);
}

async function compositeFrame(character, phoneme, isBlinking) {
  const m = loadManifest();
  const outputWidth = Math.round(m.width * OUTPUT_SCALE);
  const outputHeight = Math.round(m.height * OUTPUT_SCALE);

  // Sort layers by zIndex
  const sortedLayers = [...m.layers].sort((a, b) => a.zIndex - b.zIndex);

  const compositeOps = [];

  for (const layer of sortedLayers) {
    // Skip based on visibility rules
    if (!layer.visible && layer.type === 'static') continue;

    // Mouth layers: only show matching character + phoneme
    if (layer.type === 'mouth') {
      if (layer.character !== character) continue;
      if (layer.phoneme !== phoneme) continue;
    }

    // Blink layers: only show if blinking and matching character
    if (layer.type === 'blink') {
      if (layer.character !== character) continue;
      if (!isBlinking) continue;
    }

    // Get pre-scaled layer buffer
    let buffer = scaledLayerBuffers[layer.id];
    if (!buffer) {
      // Try to load on-demand
      const layerPath = path.join(LAYERS_DIR, ...layer.path.split('/'));
      if (!fs.existsSync(layerPath)) continue;

      try {
        const scaledWidth = Math.round(layer.width * OUTPUT_SCALE);
        const scaledHeight = Math.round(layer.height * OUTPUT_SCALE);
        if (scaledWidth > 0 && scaledHeight > 0) {
          buffer = await sharp(layerPath).resize(scaledWidth, scaledHeight).png().toBuffer();
          scaledLayerBuffers[layer.id] = buffer;
        }
      } catch (err) {
        continue;
      }
    }

    if (buffer) {
      compositeOps.push({
        input: buffer,
        left: Math.round(layer.x * OUTPUT_SCALE),
        top: Math.round(layer.y * OUTPUT_SCALE),
        blend: 'over'
      });
    }
  }

  // Composite all layers onto scaled canvas
  const result = await sharp({
    create: {
      width: outputWidth,
      height: outputHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 }
    }
  })
  .composite(compositeOps)
  .jpeg({ quality: 80 })
  .toBuffer();

  return result;
}

function clearCache() {
  layerBuffers = {};
  scaledLayerBuffers = {};
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
