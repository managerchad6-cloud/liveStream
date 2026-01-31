// Continuous stream manager - single FFmpeg instance, never restarts
// Audio is always enabled, fed via pipe (silence when idle, real audio when speaking)

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { FFMPEG_PATH } = require('./platform');

class ContinuousStreamManager {
  constructor(streamsDir, fps = 30) {
    this.streamsDir = streamsDir;
    this.fps = fps;
    this.ffmpegProcess = null;
    this.isRunning = false;
    this.frameInterval = 1000 / fps;
    this.onFrameRequest = null;
    this.frameCount = 0;
    this.lastFrameTime = 0;
    this.liveDir = null;

    // Audio configuration
    this.sampleRate = 44100;
    this.channels = 2;
    this.bytesPerSample = 2; // 16-bit
    this.samplesPerFrame = Math.floor(this.sampleRate / fps); // ~1470 samples per video frame
    this.audioBytesPerFrame = this.samplesPerFrame * this.channels * this.bytesPerSample;

    // Audio state
    this.audioSamples = null;      // Current audio buffer (Float32Array, mono)
    this.audioSampleRate = 16000;  // Input audio sample rate
    this.audioFrameIndex = 0;      // Current position in audio
    this.audioTotalFrames = 0;     // Total frames of audio
    this.isPlayingAudio = false;
    this.currentCharacter = null;

    // Silence buffer (pre-generated)
    this.silenceBuffer = Buffer.alloc(this.audioBytesPerFrame, 0);

    // Last frame for repeat on queue underrun (prevents FFmpeg starvation)
    this.lastVideoFrame = null;

    // Callbacks
    this.onAudioComplete = null;
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

    // Start single FFmpeg instance with both video and audio pipes
    this.startFFmpeg();
    this.startFrameLoop();

    console.log('[ContinuousStreamManager] Live stream started');
  }

  cleanSegments() {
    try {
      const files = fs.readdirSync(this.liveDir);
      for (const file of files) {
        fs.unlinkSync(path.join(this.liveDir, file));
      }
    } catch (e) {}
  }

  startFFmpeg() {
    const outputPath = path.join(this.liveDir, 'stream.m3u8');
    const segmentPath = path.join(this.liveDir, 'segment_%03d.ts');

    // FFmpeg with TWO pipe inputs: video (stdin) and audio (fd 3)
    const args = [
      '-y',
      // Video input from stdin (pipe:0)
      '-thread_queue_size', '512',
      '-f', 'image2pipe',
      '-framerate', String(this.fps),
      '-i', 'pipe:0',
      // Audio input from pipe:3 (raw PCM)
      '-thread_queue_size', '512',
      '-f', 's16le',
      '-ar', String(this.sampleRate),
      '-ac', String(this.channels),
      '-i', 'pipe:3',
      // Video encoding
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p',
      '-crf', '23',
      '-r', String(this.fps),
      '-g', String(this.fps),
      '-keyint_min', String(this.fps),
      '-sc_threshold', '0',
      '-bf', '0',
      // Audio encoding
      '-c:a', 'aac',
      '-b:a', '128k',
      // Force A/V sync
      '-async', '1',
      '-vsync', 'cfr',
      // Output - short segments for low latency
      '-f', 'hls',
      '-hls_time', '1',             // 1 second segments (was 2)
      '-hls_list_size', '6',        // Keep 6 segments
      '-hls_flags', 'delete_segments+append_list+independent_segments',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', segmentPath,
      outputPath
    ];

    // Spawn with extra pipe for audio (fd 3)
    this.ffmpegProcess = spawn(FFMPEG_PATH, args, {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe']  // stdin, stdout, stderr, audio pipe
    });

    this.videoStdin = this.ffmpegProcess.stdin;
    this.audioStdin = this.ffmpegProcess.stdio[3];

    this.ffmpegProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('error') || msg.includes('Invalid')) {
        console.error('[FFmpeg]', msg.trim());
      }
    });

    this.ffmpegProcess.on('error', (err) => {
      console.error('[ContinuousStreamManager] FFmpeg error:', err.message);
      this.isRunning = false;
    });

    this.ffmpegProcess.on('close', (code) => {
      console.log('[ContinuousStreamManager] FFmpeg closed with code:', code);
      if (this.isRunning) {
        console.log('[ContinuousStreamManager] Restarting FFmpeg...');
        setTimeout(() => this.startFFmpeg(), 1000);
      }
    });

    console.log('[ContinuousStreamManager] FFmpeg started with audio pipe');
  }

  // Load audio for playback (called by server)
  // Pre-computes the entire resampled PCM buffer so per-frame cost is just a slice
  loadAudio(samples, sampleRate, character, duration) {
    this.audioSamples = samples;
    this.audioSampleRate = sampleRate;
    this.currentCharacter = character;
    this.audioFrameIndex = 0;
    this.audioTotalFrames = Math.ceil(duration * this.fps);
    this.isPlayingAudio = true;

    // Pre-compute entire resampled audio as Int16 stereo PCM
    // This eliminates per-frame Buffer allocation and sample-by-sample resampling
    const totalOutputSamples = this.audioTotalFrames * this.samplesPerFrame;
    const totalBytes = totalOutputSamples * this.channels * this.bytesPerSample;
    this.precomputedAudio = Buffer.alloc(totalBytes);
    const ratio = sampleRate / this.sampleRate;

    for (let i = 0; i < totalOutputSamples; i++) {
      const srcIdx = Math.floor(i * ratio);
      let sample = 0;
      if (srcIdx < samples.length) {
        sample = Math.max(-1, Math.min(1, samples[srcIdx]));
        sample = Math.floor(sample * 32767);
      }
      const offset = i * 4;
      this.precomputedAudio.writeInt16LE(sample, offset);     // Left
      this.precomputedAudio.writeInt16LE(sample, offset + 2); // Right
    }

    console.log(`[ContinuousStreamManager] Audio started: ${duration.toFixed(2)}s, ${this.audioTotalFrames} frames (pre-resampled)`);
  }

  // Get audio chunk for current frame — just slices the pre-computed buffer
  getAudioChunkForFrame() {
    if (!this.isPlayingAudio || !this.precomputedAudio) {
      return this.silenceBuffer;
    }

    // Check if audio is done
    if (this.audioFrameIndex >= this.audioTotalFrames) {
      this.isPlayingAudio = false;
      this.currentCharacter = null;
      this.precomputedAudio = null;
      if (this.onAudioComplete) {
        this.onAudioComplete();
      }
      return this.silenceBuffer;
    }

    // Slice pre-computed buffer — zero allocation, zero computation
    const start = this.audioFrameIndex * this.audioBytesPerFrame;
    const chunk = this.precomputedAudio.subarray(start, start + this.audioBytesPerFrame);

    this.audioFrameIndex++;
    return chunk;
  }

  // Get current audio progress for frame renderer
  getAudioProgress() {
    if (!this.isPlayingAudio) {
      return { playing: false, frame: 0, total: 0, character: null };
    }
    return {
      playing: true,
      frame: this.audioFrameIndex,
      total: this.audioTotalFrames,
      character: this.currentCharacter
    };
  }

  // Unified render + output loop — single timer, no queue, no spin loop
  startFrameLoop() {
    const tick = async () => {
      if (!this.isRunning) return;

      const now = Date.now();

      if (now - this.lastFrameTime >= this.frameInterval && this.ffmpegProcess) {
        let videoData = null;
        let audioData = this.silenceBuffer;

        // Render a new frame
        if (this.onFrameRequest) {
          try {
            const audioProgress = this.getAudioProgress();
            const frameBuffer = await this.onFrameRequest(this.frameCount, audioProgress);
            if (frameBuffer) {
              audioData = this.getAudioChunkForFrame();
              videoData = frameBuffer;
              this.lastVideoFrame = frameBuffer;
              this.frameCount++;
            }
          } catch (err) {
            console.error('[ContinuousStreamManager] Render error:', err.message);
          }
        }

        // If render failed or returned null, repeat last frame
        if (!videoData && this.lastVideoFrame) {
          videoData = this.lastVideoFrame;
        }

        // Write to FFmpeg
        if (videoData) {
          if (this.videoStdin && this.videoStdin.writable) {
            try { this.videoStdin.write(videoData); } catch (e) {}
          }
          if (this.audioStdin && this.audioStdin.writable) {
            try { this.audioStdin.write(audioData); } catch (e) {}
          }
        }

        this.lastFrameTime = now - ((now - this.lastFrameTime) % this.frameInterval);
      }

      if (this.isRunning) {
        const nextTick = Math.max(1, this.frameInterval - (Date.now() - this.lastFrameTime));
        setTimeout(tick, nextTick);
      }
    };

    tick();
  }

  stop() {
    this.isRunning = false;
    this.isPlayingAudio = false;
    if (this.ffmpegProcess) {
      try {
        if (this.videoStdin) this.videoStdin.end();
        if (this.audioStdin) this.audioStdin.end();
        this.ffmpegProcess.kill('SIGTERM');
      } catch (e) {}
      this.ffmpegProcess = null;
    }
    console.log('[ContinuousStreamManager] Stream stopped');
  }

  getStreamUrl() {
    return '/streams/live/stream.m3u8';
  }

  isAudioPlaying() {
    return this.isPlayingAudio;
  }
}

module.exports = ContinuousStreamManager;
