const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT_DIR = path.resolve(__dirname, '..');
const LAYERS_DIR = path.join(ROOT_DIR, 'exported-layers');
const MANIFEST_PATH = path.join(LAYERS_DIR, 'manifest.json');

let manifest = null;
let layerBuffers = {};

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
      layerBuffers[layer.id] = await sharp(layerPath).png().toBuffer();
    } catch (err) {
      console.warn(`Warning: Could not load ${layer.id}:`, err.message);
    }
  }

  console.log(`Preloaded ${Object.keys(layerBuffers).length} layers`);
}

async function compositeFrame(character, phoneme, isBlinking) {
  const m = loadManifest();

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

    // Get layer buffer
    const buffer = layerBuffers[layer.id];
    if (!buffer) {
      // Try to load on-demand
      const layerPath = path.join(LAYERS_DIR, ...layer.path.split('/'));
      if (!fs.existsSync(layerPath)) continue;

      try {
        layerBuffers[layer.id] = await sharp(layerPath).png().toBuffer();
      } catch (err) {
        continue;
      }
    }

    if (layerBuffers[layer.id]) {
      compositeOps.push({
        input: layerBuffers[layer.id],
        left: Math.round(layer.x),
        top: Math.round(layer.y),
        blend: 'over'
      });
    }
  }

  // Composite all layers onto canvas
  const result = await sharp({
    create: {
      width: m.width,
      height: m.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 }
    }
  })
  .composite(compositeOps)
  .png()
  .toBuffer();

  return result;
}

function clearCache() {
  layerBuffers = {};
}

function getManifestDimensions() {
  const m = loadManifest();
  return { width: m.width, height: m.height };
}

module.exports = {
  compositeFrame,
  loadManifest,
  preloadLayers,
  clearCache,
  getManifestDimensions
};
