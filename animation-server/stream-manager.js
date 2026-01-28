// Live stream manager - continuous HLS output with FFmpeg

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { FFMPEG_PATH } = require('./platform');

class StreamManager {
  constructor(streamsDir, fps = 30) {
    this.streamsDir = streamsDir;
    this.fps = fps;
    this.ffmpegProcess = null;
    this.isRunning = false;
    this.frameInterval = 1000 / fps;
    this.onFrameRequest = null; // Callback to get next frame
    this.frameCount = 0;
    this.currentAudioPath = null;
    this.audioProcess = null;
  }

  start(onFrameRequest) {
    if (this.isRunning) return;

    this.onFrameRequest = onFrameRequest;
    this.isRunning = true;

    // Ensure stream directory exists
    const liveDir = path.join(this.streamsDir, 'live');
    fs.mkdirSync(liveDir, { recursive: true });

    // Clean old segments
    try {
      const files = fs.readdirSync(liveDir);
      for (const file of files) {
        fs.unlinkSync(path.join(liveDir, file));
      }
    } catch (e) {}

    this.startFFmpeg(liveDir);
    this.startFrameLoop();

    console.log('[StreamManager] Live stream started');
  }

  startFFmpeg(liveDir) {
    const outputPath = path.join(liveDir, 'stream.m3u8');
    const segmentPath = path.join(liveDir, 'segment_%03d.ts');

    // FFmpeg args for live HLS from pipe input
    const args = [
      '-y',
      '-f', 'image2pipe',
      '-framerate', String(this.fps),
      '-i', '-',  // Read frames from stdin
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p',
      '-g', String(this.fps), // Keyframe every second
      '-sc_threshold', '0',
      '-f', 'hls',
      '-hls_time', '1',
      '-hls_list_size', '5',
      '-hls_flags', 'delete_segments+append_list',
      '-hls_segment_filename', segmentPath,
      outputPath
    ];

    this.ffmpegProcess = spawn(FFMPEG_PATH, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.ffmpegProcess.stderr.on('data', (data) => {
      // Uncomment for debugging:
      // console.log('[FFmpeg]', data.toString());
    });

    this.ffmpegProcess.on('error', (err) => {
      console.error('[StreamManager] FFmpeg error:', err.message);
      this.isRunning = false;
    });

    this.ffmpegProcess.on('close', (code) => {
      console.log('[StreamManager] FFmpeg closed with code:', code);
      if (this.isRunning) {
        // Restart if unexpected close
        console.log('[StreamManager] Restarting FFmpeg...');
        setTimeout(() => this.startFFmpeg(liveDir), 1000);
      }
    });
  }

  startFrameLoop() {
    const loop = async () => {
      if (!this.isRunning) return;

      try {
        if (this.onFrameRequest && this.ffmpegProcess && this.ffmpegProcess.stdin.writable) {
          const frameBuffer = await this.onFrameRequest(this.frameCount);
          if (frameBuffer && this.ffmpegProcess.stdin.writable) {
            this.ffmpegProcess.stdin.write(frameBuffer);
          }
          this.frameCount++;
        }
      } catch (err) {
        console.error('[StreamManager] Frame error:', err.message);
      }

      if (this.isRunning) {
        setTimeout(loop, this.frameInterval);
      }
    };

    loop();
  }

  // Play audio through a separate stream (for now, audio handled by frontend)
  setAudio(audioPath) {
    this.currentAudioPath = audioPath;
    // Audio will be served separately and synced by frontend
  }

  stop() {
    this.isRunning = false;
    if (this.ffmpegProcess) {
      this.ffmpegProcess.stdin.end();
      this.ffmpegProcess.kill('SIGTERM');
      this.ffmpegProcess = null;
    }
    console.log('[StreamManager] Stream stopped');
  }

  getStreamUrl() {
    return '/streams/live/stream.m3u8';
  }
}

module.exports = StreamManager;
