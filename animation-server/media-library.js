const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { spawn } = require('child_process');
const { FFMPEG_PATH } = require('./platform');

const THUMB_SIZE = 200;

class MediaLibrary {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.originalsDir = path.join(rootDir, 'media-library', 'originals');
    this.thumbnailsDir = path.join(rootDir, 'media-library', 'thumbnails');
    this.indexPath = path.join(rootDir, 'media-library', 'library.json');
    this.items = [];
  }

  async init() {
    fs.mkdirSync(this.originalsDir, { recursive: true });
    fs.mkdirSync(this.thumbnailsDir, { recursive: true });

    try {
      const raw = await fs.promises.readFile(this.indexPath, 'utf8');
      const parsed = JSON.parse(raw);
      this.items = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn('[MediaLibrary] Failed to load index, starting fresh:', err.message);
      }
      this.items = [];
    }

    console.log(`[MediaLibrary] Initialized with ${this.items.length} items`);
  }

  async _persist() {
    const payload = JSON.stringify(this.items, null, 2);
    const tmpPath = `${this.indexPath}.tmp`;
    await fs.promises.writeFile(tmpPath, payload, 'utf8');
    await fs.promises.rename(tmpPath, this.indexPath);
  }

  async addFile(filePath, originalName, mimeType) {
    const id = crypto.randomUUID();
    const ext = path.extname(originalName) || this._extFromMime(mimeType);
    const filename = `${id}${ext}`;
    const destPath = path.join(this.originalsDir, filename);

    await fs.promises.copyFile(filePath, destPath);

    const stat = await fs.promises.stat(destPath);
    const type = mimeType.startsWith('video/') ? 'video' : 'image';

    const thumbnailFilename = `${id}.jpg`;
    const thumbnailPath = path.join(this.thumbnailsDir, thumbnailFilename);

    try {
      if (type === 'video') {
        await this._generateVideoThumbnail(destPath, thumbnailPath);
      } else {
        await sharp(destPath)
          .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover' })
          .jpeg({ quality: 80 })
          .toFile(thumbnailPath);
      }
    } catch (err) {
      console.warn(`[MediaLibrary] Thumbnail generation failed for ${id}:`, err.message);
    }

    const item = {
      id,
      originalName,
      type,
      mimeType,
      ext,
      filename,
      thumbnailFilename,
      fileSize: stat.size,
      addedAt: new Date().toISOString(),
      metadata: {}
    };

    this.items.push(item);
    await this._persist();

    console.log(`[MediaLibrary] Added ${type}: ${id} (${originalName})`);
    return item;
  }

  async addFromUrl(url, filename) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const buffer = Buffer.from(await response.arrayBuffer());

    if (!filename) {
      const urlPath = new URL(url).pathname;
      filename = path.basename(urlPath) || 'download';
    }

    const tmpPath = path.join(this.originalsDir, `_tmp_${crypto.randomUUID()}`);
    await fs.promises.writeFile(tmpPath, buffer);

    try {
      const item = await this.addFile(tmpPath, filename, contentType);
      return item;
    } finally {
      try { await fs.promises.unlink(tmpPath); } catch (e) {}
    }
  }

  get(id) {
    return this.items.find(item => item.id === id) || null;
  }

  list({ type, limit, offset } = {}) {
    let filtered = this.items;
    if (type) {
      filtered = filtered.filter(item => item.type === type);
    }

    const total = filtered.length;
    const off = Math.max(0, parseInt(offset, 10) || 0);
    const lim = Math.max(1, parseInt(limit, 10) || 50);
    const items = filtered.slice(off, off + lim);

    return { items, total, offset: off, limit: lim };
  }

  async remove(id) {
    const index = this.items.findIndex(item => item.id === id);
    if (index === -1) return false;

    const item = this.items[index];

    try { await fs.promises.unlink(path.join(this.originalsDir, item.filename)); } catch (e) {}
    try { await fs.promises.unlink(path.join(this.thumbnailsDir, item.thumbnailFilename)); } catch (e) {}

    this.items.splice(index, 1);
    await this._persist();

    console.log(`[MediaLibrary] Removed: ${id} (${item.originalName})`);
    return true;
  }

  getOriginalPath(id) {
    const item = this.get(id);
    if (!item) return null;
    return path.join(this.originalsDir, item.filename);
  }

  getThumbnailPath(id) {
    const item = this.get(id);
    if (!item) return null;
    return path.join(this.thumbnailsDir, item.thumbnailFilename);
  }

  async _generateVideoThumbnail(videoPath, outputPath) {
    return new Promise((resolve, reject) => {
      const tmpRaw = `${outputPath}.raw.png`;
      const ffmpeg = spawn(FFMPEG_PATH, [
        '-i', videoPath,
        '-vframes', '1',
        '-vf', `scale=${THUMB_SIZE}:${THUMB_SIZE}:force_original_aspect_ratio=decrease`,
        '-y',
        tmpRaw
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      ffmpeg.on('close', async (code) => {
        if (code !== 0) {
          try { fs.unlinkSync(tmpRaw); } catch (e) {}
          return reject(new Error(`FFmpeg exited with code ${code}`));
        }
        try {
          await sharp(tmpRaw)
            .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover' })
            .jpeg({ quality: 80 })
            .toFile(outputPath);
          try { fs.unlinkSync(tmpRaw); } catch (e) {}
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      ffmpeg.on('error', (err) => {
        reject(err);
      });
    });
  }

  _extFromMime(mimeType) {
    const map = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'video/mp4': '.mp4',
      'video/webm': '.webm',
      'video/quicktime': '.mov',
      'video/x-msvideo': '.avi'
    };
    return map[mimeType] || '';
  }
}

module.exports = MediaLibrary;
