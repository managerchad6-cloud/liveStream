// Continuous stream manager - single FFmpeg instance, never restarts
// Audio is always enabled, fed via pipe (silence when idle, real audio when speaking)

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { FFMPEG_PATH } = require('./platform');

class ContinuousStreamManager {
  constructor(streamsDir, fps = 30, frameWidth = 1280, frameHeight = 720) {
    this.streamsDir = streamsDir;
    this.fps = fps;
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    this.ffmpegProcess = null;
    this.isRunning = false;
    this.frameInterval = 1000 / fps;
    this.onFrameRequest = null;
    this.frameCount = 0;
    this.lastFrameTime = 0;
    this.frameQueue = [];
    this.maxQueueSize = 4;
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
    this.startRenderLoop();
    this.startOutputLoop();

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
      // Video input from stdin (pipe:0) — raw RGB pixels, no decode needed
      '-thread_queue_size', '512',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgb24',
      '-s', `${this.frameWidth}x${this.frameHeight}`,
      '-r', String(this.fps),
      '-i', 'pipe:0',
      // Audio input from pipe:3 (raw PCM)
      '-thread_queue_size', '512',
      '-f', 's16le',
      '-ar', String(this.sampleRate),
      '-ac', String(this.channels),
      '-i', 'pipe:3',
      // Video encoding - 720p, low CPU usage for 2-core VPS
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p',
      '-crf', '28',
      '-threads', '1',
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
  loadAudio(samples, sampleRate, character, duration) {
    this.frameQueue = []; // Clear stale frames
    this.audioSamples = samples;
    this.audioSampleRate = sampleRate;
    this.currentCharacter = character;
    this.audioFrameIndex = 0;
    this.audioTotalFrames = Math.ceil(duration * this.fps);
    this.isPlayingAudio = true;

    console.log(`[ContinuousStreamManager] Audio started: ${duration.toFixed(2)}s, ${this.audioTotalFrames} frames`);
  }

  // Get audio chunk for current frame (resampled to output rate)
  getAudioChunkForFrame() {
    if (!this.isPlayingAudio || !this.audioSamples) {
      return this.silenceBuffer;
    }

    // Check if audio is done
    if (this.audioFrameIndex >= this.audioTotalFrames) {
      this.isPlayingAudio = false;
      this.currentCharacter = null;
      if (this.onAudioComplete) {
        this.onAudioComplete();
      }
      return this.silenceBuffer;
    }

    // Calculate source samples for this frame
    const inputSamplesPerFrame = Math.floor(this.audioSampleRate / this.fps);
    const srcStart = this.audioFrameIndex * inputSamplesPerFrame;
    const srcEnd = Math.min(srcStart + inputSamplesPerFrame, this.audioSamples.length);

    // Resample from input rate to output rate (simple linear interpolation)
    const outputBuffer = Buffer.alloc(this.audioBytesPerFrame);
    const ratio = this.audioSampleRate / this.sampleRate;

    for (let i = 0; i < this.samplesPerFrame; i++) {
      const srcIdx = srcStart + Math.floor(i * ratio);
      let sample = 0;

      if (srcIdx < this.audioSamples.length) {
        // Convert from float [-1, 1] to int16
        sample = Math.max(-1, Math.min(1, this.audioSamples[srcIdx]));
        sample = Math.floor(sample * 32767);
      }

      // Write stereo (duplicate mono to both channels)
      const offset = i * 4; // 2 bytes per sample * 2 channels
      outputBuffer.writeInt16LE(sample, offset);     // Left
      outputBuffer.writeInt16LE(sample, offset + 2); // Right
    }

    this.audioFrameIndex++;
    return outputBuffer;
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

  startRenderLoop() {
    const render = async () => {
      if (!this.isRunning) return;

      if (this.frameQueue.length < this.maxQueueSize && this.onFrameRequest) {
        try {
          // Get audio progress for frame renderer
          const audioProgress = this.getAudioProgress();

          const frameBuffer = await this.onFrameRequest(this.frameCount, audioProgress);
          if (frameBuffer) {
            // Get audio for this frame
            const audioBuffer = this.getAudioChunkForFrame();

            this.frameQueue.push({ video: frameBuffer, audio: audioBuffer });
            this.frameCount++;
          }
        } catch (err) {
          console.error('[ContinuousStreamManager] Render error:', err.message);
        }

        // Frame produced — immediately try next one
        if (this.isRunning) setImmediate(render);
      } else {
        // Queue full — back off to avoid CPU spin loop
        if (this.isRunning) setTimeout(render, Math.max(1, this.frameInterval / 2));
      }
    };

    render();
  }

  startOutputLoop() {
    const output = () => {
      if (!this.isRunning) return;

      const now = Date.now();
      const elapsed = now - this.lastFrameTime;

      if (elapsed >= this.frameInterval && this.ffmpegProcess) {
        let videoData = null;
        let audioData = this.silenceBuffer;

        if (this.frameQueue.length > 0) {
          const frame = this.frameQueue.shift();
          videoData = frame.video;
          audioData = frame.audio;
          this.lastVideoFrame = videoData; // Save for underrun repeat
        } else if (this.lastVideoFrame) {
          // Queue underrun: repeat last frame + silence to prevent FFmpeg starvation
          videoData = this.lastVideoFrame;
        }

        if (videoData) {
          if (this.videoStdin && this.videoStdin.writable) {
            try {
              this.videoStdin.write(videoData);
            } catch (e) {}
          }
          if (this.audioStdin && this.audioStdin.writable) {
            try {
              this.audioStdin.write(audioData);
            } catch (e) {}
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
