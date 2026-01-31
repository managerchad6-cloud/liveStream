// Synchronized stream manager - muxes audio + video into HLS
// Audio and video leave the server ALREADY SYNCED

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { FFMPEG_PATH } = require('./platform');

class SyncedStreamManager {
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
    this.maxQueueSize = 3;

    // Audio state
    this.currentAudioPath = null;
    this.audioFrameCount = 0;  // Total frames for current audio
    this.audioFrameIndex = 0;  // Current frame within audio
    this.isPlayingAudio = false;
    this.liveDir = null;

    // Callback when audio finishes
    this.onAudioComplete = null;

    // Flag to prevent auto-restart during intentional switch
    this.isSwitching = false;
  }

  start(onFrameRequest) {
    if (this.isRunning) return;

    this.onFrameRequest = onFrameRequest;
    this.isRunning = true;
    this.lastFrameTime = Date.now();

    this.liveDir = path.join(this.streamsDir, 'live');
    fs.mkdirSync(this.liveDir, { recursive: true });

    // Clean old segments
    this.cleanSegments();

    // Start with silent video stream (no need to stop first on initial start)
    this.spawnFFmpegSilent();
    this.startRenderLoop();
    this.startOutputLoop();

    console.log('[SyncedStreamManager] Live stream started (silent mode)');
  }

  cleanSegments() {
    try {
      const files = fs.readdirSync(this.liveDir);
      for (const file of files) {
        fs.unlinkSync(path.join(this.liveDir, file));
      }
    } catch (e) {}
  }

  // Start FFmpeg WITHOUT audio (idle/silent mode)
  async startFFmpegSilent() {
    await this.stopFFmpeg();
    this.spawnFFmpegSilent();
  }

  // Spawn FFmpeg for silent mode (no stop, used for restarts)
  spawnFFmpegSilent() {
    const outputPath = path.join(this.liveDir, 'stream.m3u8');
    const segmentPath = path.join(this.liveDir, 'segment_%03d.ts');

    const args = [
      '-y',
      // Video input from pipe
      '-f', 'image2pipe',
      '-framerate', String(this.fps),
      '-i', '-',
      // Generate silent audio track
      '-f', 'lavfi',
      '-i', 'anullsrc=r=44100:cl=stereo',
      // Video encoding
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p',
      '-crf', '23',
      '-g', String(this.fps),
      '-sc_threshold', '0',
      // Audio encoding
      '-c:a', 'aac',
      '-b:a', '128k',
      // Output
      '-f', 'hls',
      '-hls_time', '1',
      '-hls_list_size', '3',
      '-hls_flags', 'delete_segments+append_list',
      '-hls_segment_filename', segmentPath,
      outputPath
    ];

    this.spawnFFmpeg(args);
    console.log('[SyncedStreamManager] FFmpeg started (silent mode)');
  }

  // Start FFmpeg WITH audio file (speaking mode)
  async startFFmpegWithAudio(audioPath, audioDuration) {
    await this.stopFFmpeg();

    const outputPath = path.join(this.liveDir, 'stream.m3u8');
    const segmentPath = path.join(this.liveDir, 'segment_%03d.ts');

    // Calculate expected frames
    this.audioFrameCount = Math.ceil(audioDuration * this.fps);
    this.audioFrameIndex = 0;
    this.isPlayingAudio = true;
    this.currentAudioPath = audioPath;

    const args = [
      '-y',
      // Video input from pipe
      '-f', 'image2pipe',
      '-framerate', String(this.fps),
      '-i', '-',
      // Audio input from file
      '-i', audioPath,
      // Map: video from first input, audio from second
      '-map', '0:v',
      '-map', '1:a',
      // Video encoding
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p',
      '-crf', '23',
      '-g', String(this.fps),
      '-sc_threshold', '0',
      // Audio encoding
      '-c:a', 'aac',
      '-b:a', '128k',
      // Don't stop at shortest - we control frame count
      // Output
      '-f', 'hls',
      '-hls_time', '1',
      '-hls_list_size', '3',
      '-hls_flags', 'delete_segments+append_list',
      '-hls_segment_filename', segmentPath,
      outputPath
    ];

    this.spawnFFmpeg(args);
    console.log(`[SyncedStreamManager] FFmpeg started with audio: ${audioDuration.toFixed(2)}s, ${this.audioFrameCount} frames`);
  }

  spawnFFmpeg(args) {
    this.ffmpegProcess = spawn(FFMPEG_PATH, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.ffmpegProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      // Only log errors, not progress
      if (msg.includes('Error') || msg.includes('error') || msg.includes('Invalid')) {
        console.error('[FFmpeg]', msg.trim());
      }
    });

    this.ffmpegProcess.on('error', (err) => {
      console.error('[SyncedStreamManager] FFmpeg error:', err.message);
    });

    this.ffmpegProcess.on('close', (code) => {
      console.log('[SyncedStreamManager] FFmpeg closed with code:', code);

      // Don't auto-restart if we're intentionally switching modes
      if (this.isSwitching) {
        console.log('[SyncedStreamManager] Intentional switch, not auto-restarting');
        this.isSwitching = false;
        return;
      }

      // If we were playing audio and it finished, switch back to silent
      if (this.isRunning && this.isPlayingAudio) {
        console.log('[SyncedStreamManager] Audio finished, switching to silent mode');
        this.isPlayingAudio = false;
        this.currentAudioPath = null;

        // Notify callback
        if (this.onAudioComplete) {
          this.onAudioComplete();
        }

        // Don't call stopFFmpeg here (would set isSwitching), just spawn new process
        this.isSwitching = false;
        setTimeout(() => this.spawnFFmpegSilent(), 100);
      } else if (this.isRunning) {
        // Unexpected close, restart
        console.log('[SyncedStreamManager] Restarting FFmpeg...');
        this.isSwitching = false;
        setTimeout(() => this.spawnFFmpegSilent(), 1000);
      }
    });
  }

  stopFFmpeg() {
    this.isSwitching = true;  // Prevent auto-restart in close handler
    if (this.ffmpegProcess) {
      try {
        this.ffmpegProcess.stdin.end();
        this.ffmpegProcess.kill('SIGTERM');
      } catch (e) {}
      this.ffmpegProcess = null;
    }
    // Small delay to let process fully close
    return new Promise(resolve => setTimeout(resolve, 200));
  }

  // Called by server when new audio should play
  async playAudio(audioPath, duration) {
    console.log(`[SyncedStreamManager] Playing audio: ${audioPath}, duration: ${duration.toFixed(2)}s`);
    await this.startFFmpegWithAudio(audioPath, duration);
  }

  // Render frames into queue
  startRenderLoop() {
    const render = async () => {
      if (!this.isRunning) return;

      if (this.frameQueue.length < this.maxQueueSize && this.onFrameRequest) {
        try {
          // Pass audio progress info to frame renderer
          const audioProgress = this.isPlayingAudio
            ? { playing: true, frame: this.audioFrameIndex, total: this.audioFrameCount }
            : { playing: false, frame: 0, total: 0 };

          const frameBuffer = await this.onFrameRequest(this.frameCount, audioProgress);
          if (frameBuffer) {
            this.frameQueue.push(frameBuffer);
            this.frameCount++;

            // Track audio frame progress
            if (this.isPlayingAudio) {
              this.audioFrameIndex++;

              // Check if audio is done
              if (this.audioFrameIndex >= this.audioFrameCount) {
                console.log('[SyncedStreamManager] Audio frames complete, closing FFmpeg');
                // Close stdin to signal end of video, FFmpeg will finish and close
                if (this.ffmpegProcess && this.ffmpegProcess.stdin.writable) {
                  this.ffmpegProcess.stdin.end();
                }
              }
            }
          }
        } catch (err) {
          console.error('[SyncedStreamManager] Render error:', err.message);
        }
      }

      if (this.isRunning) {
        setImmediate(render);
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
        if (this.frameQueue.length > 0 && this.ffmpegProcess && this.ffmpegProcess.stdin.writable) {
          const frame = this.frameQueue.shift();
          try {
            this.ffmpegProcess.stdin.write(frame);
          } catch (e) {
            // Pipe closed, will restart
          }
        }
        this.lastFrameTime = now - (elapsed % this.frameInterval);
      }

      if (this.isRunning) {
        setTimeout(output, Math.max(1, this.frameInterval - (Date.now() - now)));
      }
    };

    output();
  }

  stop() {
    this.isRunning = false;
    this.isPlayingAudio = false;
    this.frameQueue = [];
    this.stopFFmpeg();
    console.log('[SyncedStreamManager] Stream stopped');
  }

  getStreamUrl() {
    return '/streams/live/stream.m3u8';
  }

  isAudioPlaying() {
    return this.isPlayingAudio;
  }

  getAudioProgress() {
    if (!this.isPlayingAudio) return null;
    return {
      frame: this.audioFrameIndex,
      total: this.audioFrameCount,
      progress: this.audioFrameIndex / this.audioFrameCount
    };
  }
}

module.exports = SyncedStreamManager;
