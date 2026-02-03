const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const isWindows = os.platform() === 'win32';
const isLinux = os.platform() === 'linux';
const isMac = os.platform() === 'darwin';

// Find Rhubarb executable
function findRhubarb() {
  const possiblePaths = isWindows
    ? [
        path.join(process.env.LOCALAPPDATA || '', 'Rhubarb-Lip-Sync', 'rhubarb.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Rhubarb-Lip-Sync', 'rhubarb.exe'),
        path.join(__dirname, '..', 'bin', 'rhubarb.exe'),
        path.join(__dirname, 'bin', 'rhubarb.exe'),
        'rhubarb.exe'
      ]
    : [
        '/usr/local/bin/rhubarb',
        '/usr/bin/rhubarb',
        path.join(__dirname, '..', 'bin', 'rhubarb'),
        path.join(__dirname, 'bin', 'rhubarb'),
        'rhubarb'
      ];

  for (const p of possiblePaths) {
    try {
      if (fs.existsSync(p)) {
        return p;
      }
    } catch (e) {}
  }

  // Try to find in PATH
  try {
    const cmd = isWindows ? 'where rhubarb' : 'which rhubarb';
    const result = execSync(cmd, { encoding: 'utf8' }).trim().split('\n')[0];
    if (result && fs.existsSync(result)) {
      return result;
    }
  } catch (e) {}

  return isWindows ? 'rhubarb.exe' : 'rhubarb';
}

// Find FFmpeg executable
function findFFmpeg() {
  if (process.env.FFMPEG_PATH) {
    const envPath = process.env.FFMPEG_PATH;
    try {
      if (fs.existsSync(envPath)) {
        return envPath;
      }
    } catch (e) {}
  }

  // Try to find in PATH first
  try {
    const cmd = isWindows ? 'where ffmpeg' : 'which ffmpeg';
    const result = execSync(cmd, { encoding: 'utf8' }).trim().split('\n')[0];
    if (result && fs.existsSync(result)) {
      return result;
    }
  } catch (e) {}

  const possiblePaths = isWindows
    ? [
        path.join(process.env.LOCALAPPDATA || '', 'ffmpeg', 'bin', 'ffmpeg.exe'),
        path.join(process.env.PROGRAMFILES || '', 'ffmpeg', 'bin', 'ffmpeg.exe'),
        path.join(__dirname, '..', 'bin', 'ffmpeg.exe'),
        'ffmpeg.exe'
      ]
    : [
        '/usr/bin/ffmpeg',
        '/usr/local/bin/ffmpeg',
        'ffmpeg'
      ];

  for (const p of possiblePaths) {
    try {
      if (fs.existsSync(p)) {
        return p;
      }
    } catch (e) {}
  }

  return isWindows ? 'ffmpeg.exe' : 'ffmpeg';
}

// Get temp directory
function getTempDir() {
  return os.tmpdir();
}

// Normalize path for the current platform
function normalizePath(p) {
  return path.normalize(p);
}

// Convert path to forward slashes (for manifest/JSON consistency)
function toForwardSlashes(p) {
  return p.split(path.sep).join('/');
}

module.exports = {
  isWindows,
  isLinux,
  isMac,
  findRhubarb,
  findFFmpeg,
  getTempDir,
  normalizePath,
  toForwardSlashes,
  RHUBARB_PATH: findRhubarb(),
  FFMPEG_PATH: findFFmpeg()
};
