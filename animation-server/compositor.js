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
let outputWidth = 0;
let outputHeight = 0;

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

async function preloadLayers() {
  const m = loadManifest();
  outputWidth = Math.round(m.width * OUTPUT_SCALE);
  outputHeight = Math.round(m.height * OUTPUT_SCALE);

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
 * Composite a frame with both characters visible
 * Uses caching for common frame states (most frames are identical)
 */
async function compositeFrame(state) {
  const {
    chadPhoneme = 'A',
    virginPhoneme = 'A',
    chadBlinking = false,
    virginBlinking = false,
    caption = null
  } = state;

  // Create cache key from state
  const cacheKey = `${chadPhoneme}-${virginPhoneme}-${chadBlinking ? 1 : 0}-${virginBlinking ? 1 : 0}`;

  let baseBuffer = frameCache[cacheKey];

  if (!baseBuffer) {
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
    baseBuffer = await sharp(staticBaseBuffer)
      .composite(compositeOps)
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();

    // Cache the result (limit cache size to prevent memory bloat)
    if (Object.keys(frameCache).length < 100) {
      frameCache[cacheKey] = baseBuffer;
    }
  }

  if (!caption) {
    return baseBuffer;
  }

  const captionSvg = buildCaptionSvg(caption);
  if (!captionSvg) {
    return baseBuffer;
  }

  const withCaption = await sharp(baseBuffer)
    .composite([{ input: captionSvg, left: 0, top: 0, blend: 'over' }])
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();

  return withCaption;
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
