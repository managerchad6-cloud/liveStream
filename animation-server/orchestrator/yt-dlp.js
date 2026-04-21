// yt-dlp wrapper — thin shell around the yt-dlp CLI
// Requires yt-dlp to be installed and on PATH (or set YTDLP_PATH env var)

const { spawn } = require('child_process');
const path = require('path');

const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';

function buildArgs(args) {
  const cookies = process.env.YTDLP_COOKIES || null; // read dynamically — may be set after startup
  return cookies ? ['--cookies', cookies, ...args] : args;
}

function run(args, { timeout = 60000 } = {}) {
  args = buildArgs(args);
  return new Promise((resolve, reject) => {
    const chunks = [];
    const errChunks = [];
    const proc = spawn(YTDLP_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill();
      reject(new Error(`yt-dlp timed out after ${timeout}ms`));
    }, timeout);

    proc.stdout.on('data', d => chunks.push(d));
    proc.stderr.on('data', d => errChunks.push(d));

    proc.on('error', err => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new Error('yt-dlp not found. Install it: https://github.com/yt-dlp/yt-dlp#installation'));
      } else {
        reject(new Error(`yt-dlp error: ${err.message}`));
      }
    });

    proc.on('close', code => {
      clearTimeout(timer);
      if (killed) return;
      const stdout = Buffer.concat(chunks).toString('utf8');
      const stderr = Buffer.concat(errChunks).toString('utf8');
      if (code !== 0) {
        const detail = stderr.slice(-300).trim();
        reject(new Error(`yt-dlp exited ${code}: ${detail}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Fetch metadata for a YouTube URL without downloading.
 * @param {string} url
 * @returns {Promise<{id, title, description, duration, thumbnail}>}
 */
async function getVideoInfo(url) {
  const stdout = await run([
    '--dump-json',
    '--no-playlist',
    '--no-download',
    url
  ], { timeout: 30000 });

  const info = JSON.parse(stdout.trim());
  return {
    id: info.id,
    title: info.title || 'Untitled',
    description: (info.description || '').slice(0, 500),
    duration: info.duration || 0,
    thumbnail: info.thumbnail || null,
    uploader: info.uploader || info.channel || null
  };
}

/**
 * Download a YouTube video (best quality mp4 with audio) to outputPath.
 * @param {string} url
 * @param {string} outputPath  - Absolute path including filename (.mp4)
 * @param {Function} [onProgress] - Optional (percent: number) => void
 * @returns {Promise<void>}
 */
function downloadVideo(url, outputPath, onProgress) {
  return new Promise((resolve, reject) => {
    const errChunks = [];
    const proc = spawn(YTDLP_PATH, buildArgs([
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '-o', outputPath,
      url
    ]), { stdio: ['ignore', 'pipe', 'pipe'] });

    let killed = false;
    // 30-minute download timeout
    const timer = setTimeout(() => {
      killed = true;
      proc.kill();
      reject(new Error('yt-dlp download timed out (30min)'));
    }, 30 * 60 * 1000);

    proc.stdout.on('data', d => {
      if (onProgress) {
        const match = d.toString().match(/(\d+\.?\d*)%/);
        if (match) onProgress(parseFloat(match[1]));
      }
    });
    proc.stderr.on('data', d => errChunks.push(d));

    proc.on('error', err => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new Error('yt-dlp not found. Install it: https://github.com/yt-dlp/yt-dlp#installation'));
      } else {
        reject(new Error(`yt-dlp download error: ${err.message}`));
      }
    });

    proc.on('close', code => {
      clearTimeout(timer);
      if (killed) return;
      if (code !== 0) {
        const detail = Buffer.concat(errChunks).toString('utf8').slice(-300).trim();
        reject(new Error(`yt-dlp download failed (exit ${code}): ${detail}`));
      } else {
        resolve();
      }
    });
  });
}

module.exports = { getVideoInfo, downloadVideo };
