import fs from 'fs';
import { readPsd } from 'ag-psd';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node psd_tree.mjs <file>');
  process.exit(1);
}

const buffer = fs.readFileSync(file);
const psd = readPsd(buffer, {
  skipCompositeImageData: true,
  skipLayerImageData: true,
  skipThumbnail: true
});

function walk(layers, indent = 0) {
  let out = '';
  for (const layer of layers || []) {
    const name = layer.name || '(unnamed)';
    out += `${' '.repeat(indent)}- ${name}\n`;
    if (layer.children) out += walk(layer.children, indent + 2);
  }
  return out;
}

process.stdout.write(walk(psd.children));
