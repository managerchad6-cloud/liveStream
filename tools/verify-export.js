const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'exported-layers', 'manifest.json');

console.log('Verifying export...\n');

// Check manifest exists
if (!fs.existsSync(MANIFEST)) {
  console.error('❌ manifest.json not found!');
  console.error('   Run: npm run export-psd');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
console.log(`✓ Manifest loaded: ${manifest.layers.length} layers`);

// Check dimensions
if (manifest.width !== 3840 || manifest.height !== 2160) {
  console.warn(`⚠ Unexpected dimensions: ${manifest.width}x${manifest.height}`);
} else {
  console.log(`✓ Dimensions: 3840x2160`);
}

// Count layer types
const types = {};
manifest.layers.forEach(l => {
  types[l.type] = (types[l.type] || 0) + 1;
});
console.log(`✓ Layer types:`, types);

// Check character layers
const chad = manifest.layers.filter(l => l.character === 'chad');
const virgin = manifest.layers.filter(l => l.character === 'virgin');
console.log(`✓ Chad layers: ${chad.length}`);
console.log(`✓ Virgin layers: ${virgin.length}`);

// Check mouth shapes
const chadMouths = chad.filter(l => l.type === 'mouth').map(l => l.phoneme);
const virginMouths = virgin.filter(l => l.type === 'mouth').map(l => l.phoneme);
const requiredPhonemes = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'SMILE', 'SURPRISE'];

console.log(`\nChad mouth shapes: ${chadMouths.join(', ')}`);
console.log(`Virgin mouth shapes: ${virginMouths.join(', ')}`);

const chadMissing = requiredPhonemes.filter(p => !chadMouths.includes(p));
const virginMissing = requiredPhonemes.filter(p => !virginMouths.includes(p));

if (chadMissing.length > 0) {
  console.error(`❌ Chad missing phonemes: ${chadMissing.join(', ')}`);
} else {
  console.log('✓ All chad phonemes present');
}

if (virginMissing.length > 0) {
  console.error(`❌ Virgin missing phonemes: ${virginMissing.join(', ')}`);
} else {
  console.log('✓ All virgin phonemes present');
}

// Check blink layers
const chadBlink = chad.filter(l => l.type === 'blink');
const virginBlink = virgin.filter(l => l.type === 'blink');
if (chadBlink.length === 0) {
  console.error('❌ Chad blink layer missing');
} else {
  console.log('✓ Chad blink layer present');
}
if (virginBlink.length === 0) {
  console.error('❌ Virgin blink layer missing');
} else {
  console.log('✓ Virgin blink layer present');
}

// Check critical static layers
const criticalLayers = ['TV', 'TV_Reflection_', 'mask', 'Table', 'Background_'];
criticalLayers.forEach(name => {
  const found = manifest.layers.find(l => l.name === name || l.id === name);
  if (!found) {
    console.error(`❌ Critical layer missing: ${name}`);
  } else {
    console.log(`✓ Critical layer found: ${name}`);
  }
});

// Check file existence
console.log(`\nChecking file existence...`);
let missing = 0;
manifest.layers.forEach(l => {
  const fullPath = path.join(ROOT, 'exported-layers', l.path);
  if (!fs.existsSync(fullPath)) {
    console.error(`❌ Missing: ${l.path}`);
    missing++;
  }
});

if (missing > 0) {
  console.error(`\n❌ ${missing} files missing! Re-run: npm run export-psd`);
  process.exit(1);
} else {
  console.log(`✓ All ${manifest.layers.length} layer files exist\n`);
  console.log('✅ Export verification complete! Your assets are ready.');
}
