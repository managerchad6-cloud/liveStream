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
    this.onFrameRequest = null;
    this.frameCount = 0;
    this.lastFrameTime = 0;
    this.frameQueue = [];
    this.maxQueueSize = 3; // Smaller buffer for lower latency
    this.isRendering = false;
    this.lastFrameBuffer = null;
  }

  start(onFrameRequest) {
    if (this.isRunning) return;

    this.onFrameRequest = onFrameRequest;
    this.isRunning = true;
    this.lastFrameTime = Date.now();

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
    this.startRenderLoop();
    this.startOutputLoop();

    console.log('[StreamManager] Live stream started');
  }

  startFFmpeg(liveDir) {
    const outputPath = path.join(liveDir, 'stream.m3u8');
    const segmentPath = path.join(liveDir, 'segment_%03d.ts');

    const args = [
      '-y',
      '-f', 'image2pipe',
      '-framerate', String(this.fps),
      '-i', '-',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p',
      '-crf', '23',
      '-r', String(this.fps),
      '-g', String(this.fps),
      '-sc_threshold', '0',
      '-vsync', 'cfr',
      '-f', 'hls',
      '-hls_time', '1',
      '-hls_list_size', '3',
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
        console.log('[StreamManager] Restarting FFmpeg...');
        setTimeout(() => this.startFFmpeg(liveDir), 1000);
      }
    });
  }

  // Render frames as fast as possible into queue
  startRenderLoop() {
    const render = async () => {
      if (!this.isRunning) return;

      const canRender = this.frameQueue.length < this.maxQueueSize && this.onFrameRequest;
      if (canRender) {
        try {
          const frameBuffer = await this.onFrameRequest(this.frameCount);
          if (frameBuffer) {
            this.frameQueue.push(frameBuffer);
            this.lastFrameBuffer = frameBuffer;
            this.frameCount++;
          }
        } catch (err) {
          console.error('[StreamManager] Render error:', err.message);
        }
      }

      if (this.isRunning) {
        if (canRender) {
          setImmediate(render);
        } else {
          setTimeout(render, Math.max(5, Math.floor(this.frameInterval / 4)));
        }
      }
    };

    render();
  }

  // Output frames at consistent FPS
  startOutputLoop() {
    const output = () => {
      if (!this.isRunning) return;

      const now = Date.now();
      const elapsed = now - this.lastFrameTime;

      if (elapsed >= this.frameInterval) {
        if (this.ffmpegProcess && this.ffmpegProcess.stdin.writable) {
          if (this.frameQueue.length > 0) {
            const frame = this.frameQueue.shift();
            this.ffmpegProcess.stdin.write(frame);
          } else if (this.lastFrameBuffer) {
            this.ffmpegProcess.stdin.write(this.lastFrameBuffer);
          }
        }
        this.lastFrameTime = now - (elapsed % this.frameInterval); // Maintain rhythm
      }

      if (this.isRunning) {
        setTimeout(output, Math.max(1, this.frameInterval - (Date.now() - now)));
      }
    };

    output();
  }

  stop() {
    this.isRunning = false;
    this.frameQueue = [];
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

  getQueueSize() {
    return this.frameQueue.length;
  }
}

module.exports = StreamManager;
