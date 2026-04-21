// YouTube transcript fetcher
// Primary: youtube-transcript npm package
// Fallback: yt-dlp --write-auto-subs (handles more videos including age-gated/region-locked)

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';

function ytdlpArgs(args) {
  const cookies = process.env.YTDLP_COOKIES || null;
  const base = ['--js-runtimes', 'node', ...args];
  return cookies ? ['--cookies', cookies, ...base] : base;
}

let YoutubeTranscript;
try {
  ({ YoutubeTranscript } = require('youtube-transcript'));
} catch (e) {
  YoutubeTranscript = null;
}

/**
 * Extract YouTube video ID from a URL or return as-is if it looks like an ID.
 */
function extractVideoId(url) {
  if (!url) return null;
  const clean = url.trim();
  if (/^[\w-]{11}$/.test(clean)) return clean;
  const match = clean.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/)([\w-]{11})/);
  return match ? match[1] : null;
}

/**
 * Group raw transcript entries into sentence-level chunks.
 * @param {Array<{text, start, end}>} entries - Normalised entries
 * @param {number} maxWords
 * @returns {Array<{text, start, end}>}
 */
function groupIntoChunks(entries, maxWords = 20) {
  const chunks = [];
  let currentWords = [];
  let chunkStart = null;
  let chunkEnd = null;

  for (const entry of entries) {
    const text = (entry.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;

    if (chunkStart === null) chunkStart = entry.start;
    chunkEnd = entry.end;
    currentWords.push(text);

    const joined = currentWords.join(' ');
    const wordCount = joined.split(/\s+/).length;
    const endsWithPunctuation = /[.?!](\s|$)/.test(text);

    if (endsWithPunctuation || wordCount >= maxWords) {
      chunks.push({ text: joined.replace(/\s+/g, ' ').trim(), start: chunkStart, end: chunkEnd });
      currentWords = [];
      chunkStart = null;
      chunkEnd = null;
    }
  }

  if (currentWords.length > 0 && chunkStart !== null) {
    chunks.push({ text: currentWords.join(' ').trim(), start: chunkStart, end: chunkEnd });
  }

  return chunks;
}

// ── npm package fetch ────────────────────────────────────────────────────────

async function fetchViaPackage(videoId) {
  if (!YoutubeTranscript) throw new Error('youtube-transcript not installed');
  const entries = await YoutubeTranscript.fetchTranscript(videoId);
  if (!entries || entries.length === 0) throw new Error('Empty transcript');
  return entries.map(e => ({
    text: e.text,
    start: e.offset != null ? e.offset / 1000 : (e.start || 0),
    end:   e.offset != null ? (e.offset + e.duration) / 1000 : ((e.start || 0) + (e.dur || 0))
  }));
}

// ── yt-dlp fallback ──────────────────────────────────────────────────────────

async function fetchViaYtdlp(url) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-sub-'));

  try {
    await new Promise((resolve, reject) => {
      // Try auto-subs first, also request manual subs as fallback
      const proc = spawn(YTDLP_PATH, ytdlpArgs([
        '--write-auto-subs',
        '--write-subs',
        '--skip-download',
        '--sub-format', 'json3',
        '--sub-langs', 'en.*,en',
        '--no-playlist',
        '-o', path.join(tmpDir, 'sub'),
        url
      ]), { stdio: ['ignore', 'pipe', 'pipe'] });

      proc.on('error', err => reject(new Error(`yt-dlp error: ${err.message}`)));
      proc.on('close', code => {
        // yt-dlp exits 0 even if no subs found; we check file existence below
        resolve();
      });
    });

    // Find the downloaded subtitle file (any .json3 file in tmpDir)
    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json3'));
    if (files.length === 0) {
      throw new Error('No subtitle file found — video may not have captions in any supported language');
    }

    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8'));
    return parseJson3(raw);
  } finally {
    // Clean up temp dir
    try {
      for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
      fs.rmdirSync(tmpDir);
    } catch (_) {}
  }
}

/**
 * Parse yt-dlp json3 subtitle format into normalised entries.
 * json3 structure: { events: [ { tStartMs, dDurationMs, segs: [{utf8}] } ] }
 */
function parseJson3(data) {
  const events = data.events || [];
  const entries = [];

  for (const ev of events) {
    if (!ev.segs) continue;
    const text = ev.segs.map(s => s.utf8 || '').join('').replace(/\n/g, ' ').trim();
    if (!text) continue;
    const start = (ev.tStartMs || 0) / 1000;
    const duration = (ev.dDurationMs || 2000) / 1000;
    entries.push({ text, start, end: start + duration });
  }

  return entries;
}

// ── Whisper fallback ─────────────────────────────────────────────────────────

async function fetchViaWhisper(url) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set — cannot use Whisper fallback');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-audio-'));
  const audioPath = path.join(tmpDir, 'audio.mp3');

  try {
    // Download first 10 minutes of audio only
    await new Promise((resolve, reject) => {
      const proc = spawn(YTDLP_PATH, ytdlpArgs([
        '-x', '--audio-format', 'mp3', '--audio-quality', '5',
        '--download-sections', '*0:00-600',
        '--no-playlist',
        '-o', audioPath,
        url
      ]), { stdio: ['ignore', 'pipe', 'pipe'] });
      const errs = [];
      proc.stderr.on('data', d => errs.push(d));
      proc.on('error', err => reject(new Error(`yt-dlp audio error: ${err.message}`)));
      proc.on('close', code => {
        if (code !== 0 && !fs.existsSync(audioPath)) {
          reject(new Error(`yt-dlp audio exit ${code}: ${Buffer.concat(errs).toString().slice(-200)}`));
        } else {
          resolve();
        }
      });
    });

    if (!fs.existsSync(audioPath)) throw new Error('Audio file not created by yt-dlp');

    // Transcribe via OpenAI Whisper
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey });
    console.log('[Transcript] Sending audio to Whisper...');
    const resp = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file: fs.createReadStream(audioPath),
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });

    const segments = resp.segments || [];
    if (segments.length === 0) throw new Error('Whisper returned no segments');

    return segments.map(s => ({
      text: (s.text || '').trim(),
      start: s.start || 0,
      end: s.end || (s.start + 2),
    })).filter(s => s.text);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch and chunk the transcript for a YouTube video URL.
 * Tries the npm package first, falls back to yt-dlp on failure.
 * @param {string} url
 * @returns {Promise<Array<{text, start, end}>>}
 */
async function fetchTranscript(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error(`Could not extract video ID from URL: ${url}`);

  let entries = null;
  let lastError = null;

  // Try npm package
  try {
    entries = await fetchViaPackage(videoId);
    console.log(`[Transcript] Fetched via npm package: ${entries.length} entries`);
  } catch (err) {
    lastError = err;
    console.warn(`[Transcript] npm package failed (${err.message}), trying yt-dlp...`);
  }

  // Fall back to yt-dlp subtitles
  if (!entries) {
    try {
      entries = await fetchViaYtdlp(url);
      console.log(`[Transcript] Fetched via yt-dlp: ${entries.length} entries`);
    } catch (err) {
      lastError = err;
    }
  }

  // Fall back to Whisper (downloads audio + transcribes — works for any video)
  if (!entries) {
    try {
      console.log(`[Transcript] No captions found, falling back to Whisper transcription...`);
      entries = await fetchViaWhisper(url);
      console.log(`[Transcript] Fetched via Whisper: ${entries.length} segments`);
    } catch (err) {
      lastError = err;
      console.warn(`[Transcript] Whisper failed: ${err.message}`);
    }
  }

  if (!entries || entries.length === 0) {
    throw new Error(
      `No transcript available for video ${videoId}. ` +
      `This video may not have captions enabled. Last error: ${lastError?.message || 'unknown'}`
    );
  }

  const chunks = groupIntoChunks(entries, 20);
  if (chunks.length === 0) throw new Error('Transcript parsed to zero chunks');

  return chunks;
}

module.exports = { fetchTranscript, extractVideoId };
