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

    // Background music service (optional)
    this.backgroundMusicService = null;

    // TV content service (optional) — provides per-frame audio from playing video
    this.tvContentService = null;

    // SFX service (optional) — one-shot sound effects mixed on top of everything
    this.sfxService = null;

    // Duck factor: lowers music to 20% while a character speaks, fades back after silence.
    // Attack: 3 frames (~100ms) to reach 0.2. Release: 500ms to return to 1.0.
    this._duckFactor = 1.0;
    this._duckAttackPerFrame  = 1.0 / Math.round(0.1 * fps); // ≈0.333 — silence in 3 frames
    this._duckReleasePerFrame = 1.0 / Math.round(0.5 * fps); // ≈0.067 — restore in 15 frames
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

    // Optional RTMP push — set either or both in .env to enable.
    // PUMP_FUN_RTMP_URL=rtmp://<server>/live/<stream-key>
    // X_RTMP_URL=rtmps://fr.pscp.tv:443/x/<stream-key>
    // Tee muxer encodes once and fans out to all enabled destinations.
    const pumpRtmpUrl = process.env.PUMP_FUN_RTMP_URL || null;
    const xRtmpUrl    = process.env.X_RTMP_URL || null;
    const rtmpTargets = [pumpRtmpUrl, xRtmpUrl].filter(Boolean);

    // 2-second GOP — required by pump.fun (keyframe every 2s at 30fps = 60 frames)
    const gopSize = this.fps * 2;

    // Build output args: HLS only, or HLS + RTMP(s) via tee muxer
    let outputArgs;
    if (rtmpTargets.length > 0) {
      // Tee muxer: single encode, multiple outputs. Forward slashes required in tee path strings.
      const segPathFwd = segmentPath.replace(/\\/g, '/');
      const outPathFwd = outputPath.replace(/\\/g, '/');
      const hlsOpts = [
        'f=hls',
        'hls_time=1',
        'hls_list_size=6',
        'hls_flags=delete_segments+append_list+independent_segments',
        'hls_segment_type=mpegts',
        `hls_segment_filename=${segPathFwd}`
      ].join(':');
      const rtmpParts = rtmpTargets.map(url => `[f=flv]${url}`);
      const teeParts  = [`[${hlsOpts}]${outPathFwd}`, ...rtmpParts];
      outputArgs = [
        '-f', 'tee',
        '-map', '0:v', '-map', '1:a',
        teeParts.join('|')
      ];
      rtmpTargets.forEach(url => console.log(`[ContinuousStreamManager] RTMP push enabled → ${url}`));
    } else {
      outputArgs = [
        '-f', 'hls',
        '-hls_time', '1',
        '-hls_list_size', '6',
        '-hls_flags', 'delete_segments+append_list+independent_segments',
        '-hls_segment_type', 'mpegts',
        '-hls_segment_filename', segmentPath,
        outputPath
      ];
    }

    // FFmpeg with TWO pipe inputs: video (stdin) and audio (fd 3)
    const args = [
      '-y',
      // Video input from stdin (pipe:0)
      '-thread_queue_size', '512',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-s', '1280x720',
      '-r', String(this.fps),
      '-i', 'pipe:0',
      // Audio input from pipe:3 (raw PCM)
      '-thread_queue_size', '512',
      '-f', 's16le',
      '-ar', String(this.sampleRate),
      '-ac', String(this.channels),
      '-i', 'pipe:3',
      // Video encoding — Main/4.0 profile required for X (Twitter) RTMP ingest validation.
      // High profile and zerolatency tune cause SPS/VUI rejection in the Periscope validator.
      // Bitrate capped at 3500k (X's documented 720p30 max is 4000k; 3500k gives headroom).
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-profile:v', 'main',
      '-level:v', '4.0',
      '-pix_fmt', 'yuv420p',
      '-b:v', '3500k',
      '-maxrate', '3500k',
      '-bufsize', '7000k',
      '-r', String(this.fps),
      '-g', String(gopSize),         // 2-second keyframe interval
      '-keyint_min', String(gopSize),
      '-sc_threshold', '0',
      '-bf', '0',
      // Audio encoding
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', String(this.sampleRate),
      // CFR video ensures stable HLS segments
      '-vsync', 'cfr',
      // Output(s)
      ...outputArgs
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

  setBackgroundMusic(service) {
    this.backgroundMusicService = service;
  }

  setTVContentService(service) {
    this.tvContentService = service;
  }

  setSFXService(service) {
    this.sfxService = service;
  }

  // Mix character audio with background music (s16le stereo).
  // Allocates a fresh buffer per call — required because audioStdin.write() is async
  // (libuv holds the buffer reference until the uv_write completes), so reusing a
  // pre-allocated buffer causes the previous frame's write to see the next frame's data,
  // producing accumulating echo/reverb.
  _mixAudio(charBuf, musicBuf, musicVolume) {
    const out = Buffer.allocUnsafe(charBuf.length);
    const n = charBuf.length >>> 2; // bytes/4 = stereo sample pairs (L+R = 4 bytes each)
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      // Fold music to mono (average L+R) before mixing.
      // Music is stereo with deliberate L/R phase offsets for width — adding it
      // sample-by-sample would create a comb filter against the mono character audio.
      const musicMono = Math.round(((musicBuf.readInt16LE(o) + musicBuf.readInt16LE(o + 2)) >> 1) * musicVolume);
      const mixedL = charBuf.readInt16LE(o) + musicMono;
      const mixedR = charBuf.readInt16LE(o + 2) + musicMono;
      out.writeInt16LE(mixedL > 32767 ? 32767 : mixedL < -32768 ? -32768 : mixedL, o);
      out.writeInt16LE(mixedR > 32767 ? 32767 : mixedR < -32768 ? -32768 : mixedR, o + 2);
    }
    return out;
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
    const RENDER_DEADLINE_MS = 30; // Hard deadline: drop to last frame if render exceeds this
    this._renderInFlight = false;  // Guard: only one compositor call at a time

    const tick = async () => {
      if (!this.isRunning) return;

      const now = Date.now();

      if (now - this.lastFrameTime >= this.frameInterval && this.ffmpegProcess) {
        let videoData = null;
        // Capture audio progress BEFORE advancing, so lip sync phoneme matches this frame's audio
        const audioProgress = this.getAudioProgress();
        // Always advance audio regardless of video render success (prevent A/V desync)
        let audioData = this.getAudioChunkForFrame();

        // Render a new frame with deadline enforcement
        if (this.onFrameRequest) {
          try {
            if (this._renderInFlight) {
              // Previous compositor call still running — reuse last frame instead of stacking
              // another Sharp operation on top. The in-flight render will update lastVideoFrame
              // once it completes, so the next tick that clears the guard will get fresh output.
              videoData = this.lastVideoFrame;
              if (videoData) this.frameCount++;
            } else {
              this._renderInFlight = true;
              const renderPromise = this.onFrameRequest(this.frameCount, audioProgress)
                .finally(() => { this._renderInFlight = false; });

              // Race render against deadline — if render is slow, reuse last frame
              const timeoutPromise = new Promise(resolve =>
                setTimeout(() => resolve(null), RENDER_DEADLINE_MS)
              );
              const frameBuffer = await Promise.race([renderPromise, timeoutPromise]);

              if (frameBuffer) {
                videoData = frameBuffer;
                this.lastVideoFrame = frameBuffer;
                this.frameCount++;
              } else if (this.lastVideoFrame) {
                // Deadline exceeded — reuse last frame, in-flight render still populates cache
                videoData = this.lastVideoFrame;
                this.frameCount++;
              }
            }
          } catch (err) {
            this._renderInFlight = false;
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
            try {
              const bms = this.backgroundMusicService;
              if (bms && bms.isActive()) {
                // Hard-gate duck: silence music quickly on speech onset, restore smoothly after
                if (this.isPlayingAudio) {
                  this._duckFactor = Math.max(0.2, this._duckFactor - this._duckAttackPerFrame);
                } else {
                  this._duckFactor = Math.min(1.0, this._duckFactor + this._duckReleasePerFrame);
                }
                audioData = this._mixAudio(audioData, bms.getChunk(audioData.length), bms.volume * this._duckFactor);
              } else {
                // No active music — still advance duck toward 1.0 so it's ready when music resumes
                this._duckFactor = Math.min(1.0, this._duckFactor + this._duckReleasePerFrame);
              }
              // Mix in TV audio when a video is playing (TV pauses during character speech,
              // so character audio and TV audio never overlap)
              const tvs = this.tvContentService;
              if (tvs) {
                const tvChunk = tvs.getAudioChunk(audioData.length);
                if (tvChunk) {
                  audioData = this._mixAudio(audioData, tvChunk, 1.0);
                }
              }
              // Mix SFX on top (one-shot sounds triggered from soundboard)
              const sfx = this.sfxService;
              if (sfx) {
                const sfxChunk = sfx.getChunk(audioData.length);
                if (sfxChunk) {
                  audioData = this._mixAudio(audioData, sfxChunk, sfx.volume);
                }
              }
              this.audioStdin.write(audioData);
            } catch (e) {}
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
