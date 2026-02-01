const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT_DIR = path.resolve(__dirname, '..');
const LAYERS_DIR = path.join(ROOT_DIR, 'exported-layers');
const BOUNDS_PATH = path.join(ROOT_DIR, 'expression-bounds.json');
const OUTPUT_DIR = path.join(ROOT_DIR, 'expression-bounds-debug');

/**
 * Create SVG overlay with bounding box and center point
 */
function createOverlaySVG(bounds, imageWidth, imageHeight) {
  const { left, top, width, height, centerX, centerY } = bounds;

  // Scale to output size (1/3 of original)
  const scale = 1/3;
  const scaledLeft = Math.round(left * scale);
  const scaledTop = Math.round(top * scale);
  const scaledWidth = Math.round(width * scale);
  const scaledHeight = Math.round(height * scale);
  const scaledCenterX = Math.round(centerX * scale);
  const scaledCenterY = Math.round(centerY * scale);
  const scaledImageWidth = Math.round(imageWidth * scale);
  const scaledImageHeight = Math.round(imageHeight * scale);

  // Draw bounding box (green rectangle) and center point (red crosshair)
  const svg = `
    <svg width="${scaledImageWidth}" height="${scaledImageHeight}">
      <!-- Bounding box -->
      <rect
        x="${scaledLeft}"
        y="${scaledTop}"
        width="${scaledWidth}"
        height="${scaledHeight}"
        fill="none"
        stroke="lime"
        stroke-width="2"
      />

      <!-- Bounding box corners (dots) -->
      <circle cx="${scaledLeft}" cy="${scaledTop}" r="3" fill="lime"/>
      <circle cx="${scaledLeft + scaledWidth}" cy="${scaledTop}" r="3" fill="lime"/>
      <circle cx="${scaledLeft}" cy="${scaledTop + scaledHeight}" r="3" fill="lime"/>
      <circle cx="${scaledLeft + scaledWidth}" cy="${scaledTop + scaledHeight}" r="3" fill="lime"/>

      <!-- Center point (crosshair) -->
      <line
        x1="${scaledCenterX - 10}"
        y1="${scaledCenterY}"
        x2="${scaledCenterX + 10}"
        y2="${scaledCenterY}"
        stroke="red"
        stroke-width="2"
      />
      <line
        x1="${scaledCenterX}"
        y1="${scaledCenterY - 10}"
        x2="${scaledCenterX}"
        y2="${scaledCenterY + 10}"
        stroke="red"
        stroke-width="2"
      />
      <circle cx="${scaledCenterX}" cy="${scaledCenterY}" r="5" fill="none" stroke="red" stroke-width="2"/>

      <!-- Labels -->
      <text
        x="${scaledLeft}"
        y="${scaledTop - 5}"
        font-family="Arial"
        font-size="12"
        fill="lime"
      >Bounds: ${width}x${height}</text>

      <text
        x="${scaledCenterX + 15}"
        y="${scaledCenterY - 5}"
        font-family="Arial"
        font-size="12"
        fill="red"
      >Center: (${centerX}, ${centerY})</text>
    </svg>
  `;

  return Buffer.from(svg);
}

async function visualizeLayer(layerId, bounds, imageWidth, imageHeight) {
  const imagePath = path.join(LAYERS_DIR, ...bounds.name.includes('virgin')
    ? ['virgin', `${layerId}.png`]
    : bounds.name.includes('chad')
    ? ['chad', `${layerId}.png`]
    : [`${layerId}.png`]);

  if (!fs.existsSync(imagePath)) {
    console.error(`  ❌ Image not found: ${imagePath}`);
    return;
  }

  // Scale down to 1/3 for easier viewing (1280x720 instead of 3840x2160)
  const scaledWidth = Math.round(imageWidth / 3);
  const scaledHeight = Math.round(imageHeight / 3);

  // Create overlay SVG
  const overlaySVG = createOverlaySVG(bounds, imageWidth, imageHeight);

  // Composite the image with the overlay
  const outputPath = path.join(OUTPUT_DIR, `${layerId}_debug.png`);

  await sharp(imagePath)
    .resize(scaledWidth, scaledHeight)
    .composite([
      {
        input: overlaySVG,
        top: 0,
        left: 0
      }
    ])
    .png()
    .toFile(outputPath);

  console.log(`  ✓ Created: ${path.basename(outputPath)}`);
}

async function main() {
  console.log('Visualizing expression bounding boxes...\n');

  if (!fs.existsSync(BOUNDS_PATH)) {
    console.error('ERROR: expression-bounds.json not found.');
    console.error('Run: npm run extract-expression-bounds');
    process.exit(1);
  }

  // Create output directory
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const data = JSON.parse(fs.readFileSync(BOUNDS_PATH, 'utf8'));
  const { bounds, sceneSize } = data;

  console.log(`Scene size: ${sceneSize.width}x${sceneSize.height}`);
  console.log(`Generating visualizations at 1/3 scale (${Math.round(sceneSize.width/3)}x${Math.round(sceneSize.height/3)})...\n`);

  for (const [layerId, layerBounds] of Object.entries(bounds)) {
    console.log(`Processing: ${layerBounds.character}/${layerBounds.name}`);
    await visualizeLayer(layerId, layerBounds, sceneSize.width, sceneSize.height);
  }

  console.log(`\n✅ Visualizations saved to: ${OUTPUT_DIR}`);
  console.log('\nLegend:');
  console.log('  🟢 Green rectangle = Bounding box of opaque pixels');
  console.log('  🔴 Red crosshair = Center point of bounding box');
  console.log('\nReview the images to ensure there are no stray pixels!');
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
