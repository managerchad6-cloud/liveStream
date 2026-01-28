// Audio decoder - converts audio files to raw PCM samples for real-time processing

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { FFMPEG_PATH } = require('./platform');

/**
 * Decode audio file to raw PCM samples using pipe (no temp file)
 * @param {string} audioPath - Path to audio file (mp3, wav, etc.)
 * @param {number} sampleRate - Target sample rate (default 16000)
 * @returns {Promise<{samples: Float32Array, sampleRate: number, duration: number}>}
 */
async function decodeAudio(audioPath, sampleRate = 16000) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    // Use pipe output instead of temp file - much faster
    const ffmpeg = spawn(FFMPEG_PATH, [
      '-i', audioPath,
      '-ar', String(sampleRate),
      '-ac', '1',
      '-f', 's16le',
      'pipe:1'  // Output to stdout
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    ffmpeg.stdout.on('data', (chunk) => {
      chunks.push(chunk);
    });

    ffmpeg.stderr.on('data', () => {}); // Ignore stderr

    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`FFmpeg exited with code ${code}`));
        return;
      }

      // Combine chunks
      const buffer = Buffer.concat(chunks);

      // Convert to Float32Array (normalize to -1.0 to 1.0)
      const int16Array = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
      const samples = new Float32Array(int16Array.length);

      for (let i = 0; i < int16Array.length; i++) {
        samples[i] = int16Array[i] / 32768.0;
      }

      const duration = samples.length / sampleRate;
      resolve({ samples, sampleRate, duration });
    });

    ffmpeg.on('error', (err) => {
      reject(new Error(`Audio decode failed: ${err.message}`));
    });
  });
}

/**
 * Get audio duration without full decode
 */
async function getAudioDuration(audioPath) {
  const cmd = `${FFMPEG_PATH} -i "${audioPath}" 2>&1 | grep Duration`;
  try {
    const { stdout } = await execAsync(cmd, { timeout: 10000 });
    const match = stdout.match(/Duration: (\d+):(\d+):(\d+)\.(\d+)/);
    if (match) {
      const hours = parseInt(match[1]);
      const minutes = parseInt(match[2]);
      const seconds = parseInt(match[3]);
      const ms = parseInt(match[4]) * 10;
      return hours * 3600 + minutes * 60 + seconds + ms / 1000;
    }
  } catch (e) {}
  return 0;
}

/**
 * Stream-friendly chunked decoder
 * Returns an async generator that yields audio chunks
 */
async function* decodeAudioChunked(audioPath, sampleRate = 16000, chunkSize = 533) {
  const { samples } = await decodeAudio(audioPath, sampleRate);

  for (let i = 0; i < samples.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, samples.length);
    yield samples.slice(i, end);
  }
}

module.exports = { decodeAudio, getAudioDuration, decodeAudioChunked };
