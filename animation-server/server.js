const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');

const { isWindows, FFMPEG_PATH } = require('./platform');
const { analyzeLipSync, getPhonemeAtTime } = require('./lipsync');
const BlinkController = require('./blink-controller');
const { compositeFrame, loadManifest, preloadLayers, getManifestDimensions } = require('./compositor');

// Set FFmpeg path
ffmpeg.setFfmpegPath(FFMPEG_PATH);

const app = express();
const port = process.env.ANIMATION_PORT || 3003;

const ROOT_DIR = path.resolve(__dirname, '..');
const STREAMS_DIR = path.join(ROOT_DIR, 'streams');
const TEMP_DIR = path.join(__dirname, 'temp');

// Ensure directories exist
fs.mkdirSync(STREAMS_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

app.use(cors());

// Configure multer
const upload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Render endpoint
app.post('/render', upload.single('audio'), async (req, res) => {
  const sessionId = uuidv4();
  const character = req.body.character || 'chad';

  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' });
  }

  const audioPath = req.file.path;
  const audioMp3Path = audioPath + '.mp3';
  const sessionDir = path.join(STREAMS_DIR, sessionId);
  const framesDir = path.join(sessionDir, 'frames');

  fs.mkdirSync(framesDir, { recursive: true });

  try {
    // Rename to .mp3
    fs.renameSync(audioPath, audioMp3Path);

    console.log(`[${sessionId}] Analyzing lip sync for ${character}...`);
    const lipSyncCues = await analyzeLipSync(audioMp3Path);

    console.log(`[${sessionId}] Rendering frames...`);
    const fps = 30;
    const blinkController = new BlinkController(fps);

    // Get audio duration from cues
    const audioDuration = lipSyncCues.length > 0
      ? Math.max(...lipSyncCues.map(c => c.end))
      : 5;

    const totalFrames = Math.ceil(audioDuration * fps);
    console.log(`[${sessionId}] Total frames: ${totalFrames} (${audioDuration.toFixed(2)}s)`);

    // Render each frame
    for (let frame = 0; frame < totalFrames; frame++) {
      const timeInSeconds = frame / fps;
      const phoneme = getPhonemeAtTime(lipSyncCues, timeInSeconds);
      const isSpeaking = phoneme !== 'A';
      const isBlinking = blinkController.update(frame, isSpeaking);

      const frameBuffer = await compositeFrame(character, phoneme, isBlinking);
      const framePath = path.join(framesDir, `frame_${String(frame).padStart(5, '0')}.png`);
      fs.writeFileSync(framePath, frameBuffer);

      if (frame % 30 === 0) {
        console.log(`[${sessionId}] Frame ${frame}/${totalFrames} (phoneme: ${phoneme})`);
      }
    }

    console.log(`[${sessionId}] Encoding video...`);

    const outputPath = path.join(sessionDir, 'stream.m3u8');
    const framePattern = path.join(framesDir, 'frame_%05d.png');
    const segmentPattern = path.join(sessionDir, 'segment_%03d.ts');

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(framePattern)
        .inputFPS(fps)
        .input(audioMp3Path)
        .outputOptions([
          '-c:v libx264',
          '-preset ultrafast',
          '-tune stillimage',
          '-c:a aac',
          '-b:a 128k',
          '-pix_fmt yuv420p',
          '-shortest',
          '-hls_time 2',
          '-hls_list_size 0',
          '-hls_segment_filename', segmentPattern
        ])
        .output(outputPath)
        .on('start', cmd => console.log(`[${sessionId}] FFmpeg: ${cmd}`))
        .on('end', () => {
          console.log(`[${sessionId}] Encoding complete`);
          resolve();
        })
        .on('error', (err) => {
          console.error(`[${sessionId}] FFmpeg error:`, err.message);
          reject(err);
        })
        .run();
    });

    // Clean up temp files
    try {
      fs.unlinkSync(audioMp3Path);
      fs.rmSync(framesDir, { recursive: true });
    } catch (e) {}

    const streamUrl = `/streams/${sessionId}/stream.m3u8`;
    console.log(`[${sessionId}] Stream ready: ${streamUrl}`);

    res.json({ streamUrl, sessionId });

  } catch (error) {
    console.error(`[${sessionId}] Error:`, error);
    res.status(500).json({ error: error.message });

    // Clean up on error
    try {
      fs.unlinkSync(audioMp3Path);
      fs.rmSync(sessionDir, { recursive: true });
    } catch (e) {}
  }
});

// Serve HLS streams
app.use('/streams', express.static(STREAMS_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    } else if (filePath.endsWith('.ts')) {
      res.setHeader('Content-Type', 'video/mp2t');
    }
  }
}));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    platform: process.platform,
    ffmpeg: FFMPEG_PATH
  });
});

// Start server
async function start() {
  try {
    loadManifest();
    console.log('Preloading layers...');
    await preloadLayers();
  } catch (err) {
    console.warn('Warning:', err.message);
    console.warn('Run "node tools/export-psd.js" to generate layers from PSD');
  }

  app.listen(port, () => {
    console.log(`Animation server running on http://localhost:${port}`);
    console.log(`Platform: ${process.platform}`);
  });
}

start();
