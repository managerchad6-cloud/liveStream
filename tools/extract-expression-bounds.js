const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT_DIR = path.resolve(__dirname, '..');
const LAYERS_DIR = path.join(ROOT_DIR, 'exported-layers');
const MANIFEST_PATH = path.join(LAYERS_DIR, 'manifest.json');
const OUTPUT_PATH = path.join(ROOT_DIR, 'expression-bounds.json');

/**
 * Extract bounding box of opaque pixels from an image
 * Returns the "real" center and bounds of the visible content
 */
async function extractBounds(imagePath) {
  try {
    const image = sharp(imagePath);
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    let minX = width, minY = height, maxX = 0, maxY = 0;
    let hasOpaque = false;

    // Find bounding box of opaque pixels (alpha > 10)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * channels;
        const alpha = channels === 4 ? data[idx + 3] : 255;

        if (alpha > 10) {
          hasOpaque = true;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (!hasOpaque) {
      return null;
    }

    const bounds = {
      left: minX,
      top: minY,
      right: maxX,
      bottom: maxY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      centerX: Math.round((minX + maxX) / 2),
      centerY: Math.round((minY + maxY) / 2)
    };

    return bounds;
  } catch (err) {
    console.error(`Error processing ${imagePath}:`, err.message);
    return null;
  }
}

async function main() {
  console.log('Extracting expression layer bounding boxes...\n');

  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('ERROR: manifest.json not found. Run npm run export-psd first.');
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

  // Find eye and eyebrow layers
  const expressionLayers = manifest.layers.filter(layer => {
    const name = layer.name.toLowerCase();
    return (name.includes('eye') || name.includes('eyebrow')) &&
           !name.includes('mouth') &&
           layer.character;
  });

  console.log(`Found ${expressionLayers.length} expression layers:\n`);

  const bounds = {};

  for (const layer of expressionLayers) {
    const fullPath = path.join(LAYERS_DIR, ...layer.path.split('/'));
    console.log(`Processing: ${layer.character}/${layer.name}`);

    const layerBounds = await extractBounds(fullPath);

    if (layerBounds) {
      bounds[layer.id] = {
        ...layerBounds,
        character: layer.character,
        name: layer.name,
        layerId: layer.id
      };

      console.log(`  ✓ Bounds: ${layerBounds.width}x${layerBounds.height} at (${layerBounds.left}, ${layerBounds.top})`);
      console.log(`  ✓ Center: (${layerBounds.centerX}, ${layerBounds.centerY})\n`);
    } else {
      console.log(`  ⚠ No opaque pixels found\n`);
    }
  }

  // Group by character for easy reference
  const grouped = {
    chad: {
      eyes: {},
      eyebrows: {}
    },
    virgin: {
      eyes: {},
      eyebrows: {}
    }
  };

  for (const [layerId, data] of Object.entries(bounds)) {
    const char = data.character;
    const name = data.name.toLowerCase();

    if (name.includes('eyebrow')) {
      grouped[char].eyebrows[layerId] = data;
    } else if (name.includes('eye')) {
      grouped[char].eyes[layerId] = data;
    }
  }

  const output = {
    timestamp: new Date().toISOString(),
    sceneSize: {
      width: manifest.width,
      height: manifest.height
    },
    bounds: bounds,
    grouped: grouped
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));

  console.log(`\n✅ Bounding boxes saved to: ${OUTPUT_PATH}`);
  console.log(`\nSummary:`);
  console.log(`  Chad eyes: ${Object.keys(grouped.chad.eyes).length}`);
  console.log(`  Chad eyebrows: ${Object.keys(grouped.chad.eyebrows).length}`);
  console.log(`  Virgin eyes: ${Object.keys(grouped.virgin.eyes).length}`);
  console.log(`  Virgin eyebrows: ${Object.keys(grouped.virgin.eyebrows).length}`);
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
