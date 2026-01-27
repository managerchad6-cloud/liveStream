#!/usr/bin/env node

/**
 * Cross-platform setup script for LiveStream Animation System
 * Works on Windows, Linux, and macOS
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const isWindows = os.platform() === 'win32';
const isLinux = os.platform() === 'linux';
const isMac = os.platform() === 'darwin';

const ROOT_DIR = __dirname;
const BIN_DIR = path.join(ROOT_DIR, 'bin');

console.log('='.repeat(60));
console.log('LiveStream Animation System Setup');
console.log(`Platform: ${os.platform()} (${os.arch()})`);
console.log('='.repeat(60));
console.log('');

function run(cmd, options = {}) {
  console.log(`> ${cmd}`);
  try {
    execSync(cmd, { stdio: 'inherit', ...options });
    return true;
  } catch (e) {
    if (!options.ignoreError) {
      console.error(`Command failed: ${e.message}`);
    }
    return false;
  }
}

function checkCommand(cmd) {
  try {
    execSync(isWindows ? `where ${cmd}` : `which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch (e) {
    return false;
  }
}

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Follow redirect
        https.get(response.headers.location, (res) => {
          res.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve();
          });
        });
      } else {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      }
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function setup() {
  // Create directories
  console.log('\n[1/6] Creating directories...');
  const dirs = [
    'exported-layers/chad/mouth',
    'exported-layers/virgin/mouth',
    'animation-server/temp',
    'frontend',
    'streams',
    'tools',
    'bin'
  ];
  dirs.forEach(dir => {
    const fullPath = path.join(ROOT_DIR, dir);
    fs.mkdirSync(fullPath, { recursive: true });
    console.log(`  Created: ${dir}`);
  });

  // Install main dependencies
  console.log('\n[2/6] Installing main dependencies...');
  run('npm install');

  // Install animation-server dependencies
  console.log('\n[3/6] Installing animation-server dependencies...');
  run('npm install', { cwd: path.join(ROOT_DIR, 'animation-server') });

  // Check FFmpeg
  console.log('\n[4/6] Checking FFmpeg...');
  if (checkCommand('ffmpeg')) {
    console.log('  FFmpeg is installed');
  } else {
    console.log('  FFmpeg not found!');
    if (isWindows) {
      console.log('  Download from: https://ffmpeg.org/download.html');
      console.log('  Or install via: winget install ffmpeg');
    } else if (isLinux) {
      console.log('  Install via: sudo apt install ffmpeg');
    } else if (isMac) {
      console.log('  Install via: brew install ffmpeg');
    }
  }

  // Check Rhubarb
  console.log('\n[5/6] Checking Rhubarb Lip Sync...');
  if (checkCommand('rhubarb')) {
    console.log('  Rhubarb is installed');
  } else {
    console.log('  Rhubarb not found!');
    console.log('  Download from: https://github.com/DanielSWolf/rhubarb-lip-sync/releases');
    if (isWindows) {
      console.log('  Extract to C:\\Program Files\\Rhubarb-Lip-Sync and add to PATH');
      console.log('  Or place rhubarb.exe in the bin/ folder');
    } else {
      console.log('  Extract and copy rhubarb to /usr/local/bin/');
      console.log('  Or place rhubarb in the bin/ folder');
    }
  }

  // Check for .env
  console.log('\n[6/6] Checking configuration...');
  const envPath = path.join(ROOT_DIR, '.env');
  if (fs.existsSync(envPath)) {
    console.log('  .env file exists');
  } else {
    console.log('  Creating .env template...');
    const envTemplate = `# API Keys
OPENAI_API_KEY=your_openai_key_here
ELEVENLABS_API_KEY=your_elevenlabs_key_here

# Optional
MODEL=gpt-4o-mini
PORT=3002
ANIMATION_PORT=3003
`;
    fs.writeFileSync(envPath, envTemplate);
    console.log('  Created .env - please add your API keys');
  }

  // Check for PSD
  const psdPath = path.join(ROOT_DIR, 'Stream.psd');
  if (fs.existsSync(psdPath)) {
    console.log('  Stream.psd found');
  } else {
    console.log('  WARNING: Stream.psd not found - animation will not work');
  }

  console.log('\n' + '='.repeat(60));
  console.log('Setup complete!');
  console.log('='.repeat(60));
  console.log('');
  console.log('Next steps:');
  console.log('  1. Add your API keys to .env');
  console.log('  2. Place Stream.psd in the project root');
  console.log('  3. Run: node tools/export-psd.js');
  console.log('  4. Start servers:');
  console.log('     - Chat API: npm start');
  console.log('     - Animation: cd animation-server && npm start');
  console.log('');
  console.log('Or open frontend/index.html directly in your browser');
  console.log('');
}

setup().catch(console.error);
