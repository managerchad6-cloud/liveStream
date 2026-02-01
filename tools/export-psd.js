const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');

// Cross-platform paths
const ROOT_DIR = path.resolve(__dirname, '..');
const PSD_PATH = path.join(ROOT_DIR, 'Stream.psd');
const OUTPUT_DIR = path.join(ROOT_DIR, 'exported-layers');
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json');

async function main() {
  // Dynamic imports for ES modules
  const agPsd = await import('ag-psd');
  const { readPsd, initializeCanvas } = agPsd;
  const sharp = (await import('sharp')).default;

  // Initialize ag-psd with node-canvas
  initializeCanvas(createCanvas);

  const manifest = {
    width: 0,
    height: 0,
    layers: []
  };

  const nameCount = {};

  function getUniqueName(name) {
    const cleanName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!nameCount[cleanName]) {
      nameCount[cleanName] = 0;
      return cleanName;
    }
    nameCount[cleanName]++;
    return `${cleanName}_${nameCount[cleanName]}`;
  }

  function getLayerType(name, parentPath) {
    const lowerName = name.toLowerCase();
    if (lowerName.includes('mouth_')) return 'mouth';
    if (lowerName.includes('blink')) return 'blink';
    return 'static';
  }

  function getCharacter(parentPath) {
    const lower = parentPath.toLowerCase();
    if (lower.includes('chad')) return 'chad';
    if (lower.includes('virgin')) return 'virgin';
    return null;
  }

  function getPhoneme(name) {
    const match = name.match(/mouth_(?:chad|virgin)_([A-H]|smile|surprise)/i);
    return match ? match[1].toUpperCase() : null;
  }

  async function exportLayer(layer, parentPath, zIndex) {
    if (!layer.canvas) return zIndex;

    const uniqueName = getUniqueName(layer.name);
    const layerType = getLayerType(layer.name, parentPath);
    const character = getCharacter(parentPath);

    let outputPath;
    if (layerType === 'mouth' && character) {
      outputPath = path.join(OUTPUT_DIR, character, 'mouth', `${uniqueName}.png`);
    } else if (character) {
      outputPath = path.join(OUTPUT_DIR, character, `${uniqueName}.png`);
    } else {
      outputPath = path.join(OUTPUT_DIR, `${uniqueName}.png`);
    }

    // Ensure directory exists
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    // Export layer at full canvas size to maintain consistent positioning.
    // Some PSDs (e.g. from Photoshop) trim layers to their painted bounds,
    // giving a smaller canvas with non-zero left/top. We always place the
    // layer's pixels onto a full-size canvas so every exported PNG is
    // psd.width x psd.height with x=0, y=0.
    const canvas = layer.canvas;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const layerLeft = layer.left || 0;
    const layerTop = layer.top || 0;

    const layerBuffer = await sharp(Buffer.from(imageData.data), {
      raw: {
        width: canvas.width,
        height: canvas.height,
        channels: 4
      }
    })
    .png()
    .toBuffer();

    // If layer is already full canvas size at (0,0), write directly
    if (canvas.width === manifest.width && canvas.height === manifest.height && layerLeft === 0 && layerTop === 0) {
      await sharp(layerBuffer).toFile(outputPath);
    } else {
      // Place trimmed layer onto a full-size transparent canvas
      await sharp({
        create: {
          width: manifest.width,
          height: manifest.height,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        }
      })
      .composite([{
        input: layerBuffer,
        left: layerLeft,
        top: layerTop,
        blend: 'over'
      }])
      .png()
      .toFile(outputPath);
      console.log(`  -> Expanded ${canvas.width}x${canvas.height} at (${layerLeft},${layerTop}) to ${manifest.width}x${manifest.height}`);
    }

    // Add to manifest with forward slashes for consistency
    const relativePath = path.relative(OUTPUT_DIR, outputPath).split(path.sep).join('/');

    const layerInfo = {
      id: uniqueName,
      name: layer.name,
      path: relativePath,
      x: 0,
      y: 0,
      width: manifest.width,
      height: manifest.height,
      opacity: (layer.opacity || 255) / 255,
      visible: layer.hidden !== true,
      zIndex: zIndex,
      type: layerType
    };

    if (character) layerInfo.character = character;
    if (layerType === 'mouth') layerInfo.phoneme = getPhoneme(layer.name);

    manifest.layers.push(layerInfo);
    console.log(`Exported: ${uniqueName} (z:${zIndex})`);

    return zIndex + 1;
  }

  async function processLayers(layers, parentPath = '', zIndex = 0) {
    for (const layer of layers) {
      const currentPath = parentPath ? `${parentPath}/${layer.name}` : layer.name;

      if (layer.children) {
        zIndex = await processLayers(layer.children, currentPath, zIndex);
      } else {
        zIndex = await exportLayer(layer, parentPath, zIndex);
      }
    }
    return zIndex;
  }

  console.log('Reading PSD file:', PSD_PATH);

  if (!fs.existsSync(PSD_PATH)) {
    console.error('ERROR: Stream.psd not found at', PSD_PATH);
    process.exit(1);
  }

  const buffer = fs.readFileSync(PSD_PATH);
  const psd = readPsd(buffer, {
    skipCompositeImageData: false,
    skipLayerImageData: false,
    skipThumbnail: true
  });

  manifest.width = psd.width;
  manifest.height = psd.height;

  console.log(`PSD dimensions: ${psd.width}x${psd.height}`);
  console.log('Exporting layers...');

  // Create output directory
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  if (psd.children) {
    await processLayers(psd.children);
  }

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`\nManifest saved to: ${MANIFEST_PATH}`);
  console.log(`Total layers exported: ${manifest.layers.length}`);
}

main().catch(err => {
  console.error('Export failed:', err);
  process.exit(1);
});
