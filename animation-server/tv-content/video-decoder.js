// Video decoder - extracts frames from video files for TV content playback

const { spawn } = require('child_process');
const { FFMPEG_PATH } = require('../platform');

/**
 * VideoDecoder - extracts frames from video at specified fps and resolution
 * Uses FFmpeg pipe output (no temp files) for efficiency
 */
class VideoDecoder {
  constructor(videoPath, fps = 15, width = 315, height = 166) {
    this.videoPath = videoPath;
    this.fps = fps;
    this.width = width;
    this.height = height;
    this.frames = [];
    this.duration = 0;
    this.loaded = false;
    this.loading = null;
  }

  /**
   * Decode all frames from video into memory
   * @returns {Promise<{frames: Buffer[], duration: number, frameCount: number}>}
   */
  async decode() {
    if (this.loaded) {
      return { frames: this.frames, duration: this.duration, frameCount: this.frames.length };
    }

    if (this.loading) {
      return this.loading;
    }

    this.loading = this._decode();
    const result = await this.loading;
    this.loading = null;
    return result;
  }

  async _decode() {
    return new Promise((resolve, reject) => {
      const frames = [];
      let currentFrame = Buffer.alloc(0);
      const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      const PNG_END = Buffer.from([0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);

      // FFmpeg command to extract frames as PNG stream
      const ffmpeg = spawn(FFMPEG_PATH, [
        '-i', this.videoPath,
        '-vf', `fps=${this.fps},scale=${this.width}:${this.height}:force_original_aspect_ratio=decrease,pad=${this.width}:${this.height}:(ow-iw)/2:(oh-ih)/2`,
        '-f', 'image2pipe',
        '-c:v', 'png',
        'pipe:1'
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      let durationStr = '';

      ffmpeg.stderr.on('data', (data) => {
        const str = data.toString();
        // Parse duration from ffmpeg output
        const match = str.match(/Duration: (\d+):(\d+):(\d+)\.(\d+)/);
        if (match) {
          const hours = parseInt(match[1]);
          const minutes = parseInt(match[2]);
          const seconds = parseInt(match[3]);
          const ms = parseInt(match[4]) * 10;
          this.duration = hours * 3600 + minutes * 60 + seconds + ms / 1000;
        }
      });

      ffmpeg.stdout.on('data', (chunk) => {
        currentFrame = Buffer.concat([currentFrame, chunk]);

        // Look for PNG end marker to split frames
        let endIndex;
        while ((endIndex = currentFrame.indexOf(PNG_END)) !== -1) {
          const frameEnd = endIndex + PNG_END.length;
          const frame = currentFrame.slice(0, frameEnd);
          frames.push(frame);
          currentFrame = currentFrame.slice(frameEnd);
        }
      });

      ffmpeg.on('close', (code) => {
        if (code !== 0 && frames.length === 0) {
          reject(new Error(`FFmpeg exited with code ${code}`));
          return;
        }

        // Handle any remaining data
        if (currentFrame.length > 0) {
          const endIdx = currentFrame.indexOf(PNG_END);
          if (endIdx !== -1) {
            frames.push(currentFrame.slice(0, endIdx + PNG_END.length));
          }
        }

        this.frames = frames;
        this.loaded = true;

        console.log(`[VideoDecoder] Decoded ${frames.length} frames from ${this.videoPath}, duration: ${this.duration.toFixed(2)}s`);
        resolve({ frames: this.frames, duration: this.duration, frameCount: this.frames.length });
      });

      ffmpeg.on('error', (err) => {
        reject(new Error(`Video decode failed: ${err.message}`));
      });
    });
  }

  /**
   * Get a specific frame by index
   * @param {number} index - Frame index (0-based)
   * @returns {Buffer|null} - PNG buffer or null if out of range
   */
  getFrame(index) {
    if (!this.loaded || index < 0 || index >= this.frames.length) {
      return null;
    }
    return this.frames[index];
  }

  /**
   * Get total frame count
   */
  get frameCount() {
    return this.frames.length;
  }

  /**
   * Clean up resources
   */
  close() {
    this.frames = [];
    this.loaded = false;
  }
}

/**
 * Get video metadata without full decode
 */
async function getVideoInfo(videoPath) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn(FFMPEG_PATH.replace('ffmpeg', 'ffprobe'), [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      videoPath
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let output = '';

    ffprobe.stdout.on('data', (data) => {
      output += data.toString();
    });

    ffprobe.on('close', (code) => {
      if (code !== 0) {
        // Fallback: try to get duration from ffmpeg
        resolve({ duration: 0, width: 0, height: 0 });
        return;
      }

      try {
        const info = JSON.parse(output);
        const videoStream = info.streams?.find(s => s.codec_type === 'video');
        resolve({
          duration: parseFloat(info.format?.duration || 0),
          width: videoStream?.width || 0,
          height: videoStream?.height || 0,
          fps: eval(videoStream?.r_frame_rate || '0') || 0
        });
      } catch (e) {
        resolve({ duration: 0, width: 0, height: 0 });
      }
    });

    ffprobe.on('error', () => {
      resolve({ duration: 0, width: 0, height: 0 });
    });
  });
}

module.exports = { VideoDecoder, getVideoInfo };
