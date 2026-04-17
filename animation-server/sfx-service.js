// SFX Service — plays sound effects into the live stream audio mix.
// Decodes MP3s from the SFX/ folder to s16le stereo 44100Hz PCM on demand
// and mixes them in via getChunk(), called from the ContinuousStreamManager frame loop.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { FFMPEG_PATH } = require('./platform');

const SFX_DIR = path.join(__dirname, '..', 'SFX');
const DATA_PATH = path.join(__dirname, 'sfx-labels.json');

// Supported audio extensions
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac']);

// Default contextual meaning for each known sound
const DEFAULT_MEANINGS = {
  'a-few-moments-later-sponge-bob-sfx-fun.mp3': 'Time skip. Use when something takes way longer than expected or to gloss over a boring stretch.',
  'anime-wow-sound-effect.mp3':                 'Impressed reaction. Use when something unexpectedly good, wild, or impressive happens.',
  'brother-ewwwwwww.mp3':                       'Cringe/disgust. Use on a revolting reveal, shameful play, or deeply uncomfortable moment.',
  'bruh.mp3':                                   'Disbelief. Use when someone does something obviously dumb or says a take so bad it speaks for itself.',
  'censor-beep-1.mp3':                          'TV bleep. Use to censor something that definitely should not be said out loud.',
  'core-sound-effect.mp3':                      'Aesthetic sting. Use to label or underscore a vibe — "this is very [x]-core" energy.',
  'dexter-meme.mp3':                            'Unexpected competence. Use when someone pulls off something weirdly sophisticated or speaks an unexpected language.',
  'dry-fart.mp3':                               'Anticlimactic letdown. Use when something hyped up delivers absolutely nothing.',
  'emotional-damage-meme.mp3':                  'Brutal roast landed. Use when someone takes a devastating L — especially financial, social, or ego-based.',
  'error_CDOxCYm.mp3':                          'System failure. Use when something crashes, breaks, or goes technically wrong in a bad way.',
  'faaah.mp3':                                  'Gut-punch despair. Use when someone opens to catastrophic news — wiped position, rug pull, fatal mistake. The sound of helpless "FUUUUCK".',
  'gah-dayum.mp3':                              'Stunned admiration or shock. Use when something is outrageously impressive or too much to process.',
  'galaxy-meme.mp3':                            'Big brain moment. Use when someone says something unexpectedly philosophical, overcomplicated, or galaxy-brained.',
  'heavenly-music-gaming-sound-effect-hd-mp3cut.mp3': 'Divine/epic moment. Use when something genuinely impressive happens or a surprisingly good play lands.',
  'hub-intro-sound.mp3':                        'The forbidden theme. Use for money talk, suspicious business proposals, or pure unhinged chaos.',
  'i-s-r-a-e-l.mp3':                           'Chant meme. Specific cultural reference — use when something becomes a rallying point or crowd moment.',
  'inceptionbutton.mp3':                        'Dramatic sting. Use on a fake-deep statement, a major reveal, or when something suddenly gets very serious.',
  'indian-song.mp3':                            'Chaos energy. Use when things devolve into madness, the topic goes off the rails, or someone starts vibing too hard.',
  'kids-saying-yay-sound-effect_3.mp3':         'Mock celebration. Use to over-celebrate something minor or to satirize hollow hype.',
  'mlg-airhorn.mp3':                            'Mock epic moment. Use to ironically celebrate anything — no matter how small or absurd.',
  'money-soundfx.mp3':                          'Cash register. Use the moment profit is mentioned, a win is confirmed, or money changes hands.',
  'musica-elevador-short.mp3':                  'Awkward silence filler. Use during dead air, waiting, or socially uncomfortable pauses.',
  'notification_o14egLP.mp3':                   'Alert/ping. Use to signal something important just arrived, a message dropped, or attention is needed.',
  'oh-my-god-meme.mp3':                         'Pure shock. Use on a truly unexpected, outrageous, or unbelievable moment.',
  'perfect-fart.mp3':                           'Comic relief. Use to deflate a serious moment, punctuate garbage content, or reset the vibe.',
  'punch-gaming-sound-effect-hd_RzlG1GE.mp3':  'Someone just got dunked on. Use when a verbal knockout, a hard counter, or a decisive blow lands.',
  'rizz-sound-effect.mp3':                      'Smooth operator. Use when someone says something genuinely charming, slick, or stylish.',
  'rizzbot-laugh.mp3':                          'Appreciative laugh. Use when a joke lands clean or something is genuinely funny rather than just chaotic.',
  'run-vine-sound-effect.mp3':                  'Escape/flee. Use when someone (or the whole conversation) needs to get out immediately.',
  'sad-meow-song.mp3':                          'Pitiful soft L. Use when someone loses something in the most pathetic, low-energy way — no anger, just sadness.',
  'shocked-sound-effect.mp3':                   'Dramatic sting. Use on a sudden twist, a shocking reveal, or an unexpected turn of events.',
  'shut-your-mouth-syfm.mp3':                   'Silence a bad take. Use when someone says something so wrong it needs to be ended immediately.',
  'spiderman-meme-song.mp3':                    'Two things are the same. Use when something is hypocritical, identical to its opposite, or self-referential.',
  'spongebob-fail.mp3':                         'General failure. Use when something goes wrong in a classic, predictable, and somewhat expected way.',
  'the-weeknd-rizzz.mp3':                       'Smooth/sexy moment. Use when the vibe unexpectedly turns suave or someone pulls off something effortlessly cool.',
  'tuco-get-out.mp3':                           'Get out. Use to dismiss someone, end a bad argument, or eject a terrible take from the conversation.',
  'undertakers-bell_2UwFCIe.mp3':               'Rest in peace. Use when something is definitively dead — a position, a project, a relationship, a take.',
  'vine-boom.mp3':                              'Punctuation hit. Use on any sudden visual or verbal reveal for perfect comedic timing.',
  'wrong-answer-sound-effect.mp3':              'Bad take confirmed. Use when someone confidently says something completely, provably wrong.',
  'yeah-boiii-i-i-i.mp3':                       'Hype reaction. Use when something genuinely good, exciting, or long-awaited finally happens.',
  'zvuk-fotoapparata.mp3':                      'Screenshot this. Use to mark an iconic moment, a quote worth saving, or something that deserves to be documented.',
};

// Guess a human-friendly title from a filename
function titleFromFilename(filename) {
  const base = path.basename(filename, path.extname(filename));
  return base
    .replace(/[-_]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

class SfxService {
  constructor() {
    this.volume = 0.85;
    this._labels   = {};        // id → custom label
    this._meanings = {};        // id → contextual meaning
    this._pcmCache = new Map(); // id → Buffer (s16le stereo 44100)
    this._active   = [];        // { buf, pos } — currently playing

    this._load();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  list() {
    if (!fs.existsSync(SFX_DIR)) return [];
    const files = fs.readdirSync(SFX_DIR)
      .filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()))
      .sort();

    return files.map(f => ({
      id:      f,
      filename: f,
      label:   this._labels[f]   || titleFromFilename(f),
      meaning: this._meanings[f] || DEFAULT_MEANINGS[f] || '',
    }));
  }

  setLabel(id, label) {
    this._labels[id] = String(label).trim();
    this._save();
  }

  setMeaning(id, meaning) {
    this._meanings[id] = String(meaning).trim();
    this._save();
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, Number(v) || 0));
  }

  async play(id) {
    const sfxPath = path.join(SFX_DIR, id);
    if (!fs.existsSync(sfxPath)) throw new Error(`SFX not found: ${id}`);

    if (!this._pcmCache.has(id)) {
      const buf = await this._decode(sfxPath);
      this._pcmCache.set(id, buf);
    }

    const buf = this._pcmCache.get(id);
    this._active.push({ buf, pos: 0 });
    console.log(`[SFX] Playing: ${id} (${(buf.length / (44100 * 4)).toFixed(2)}s, ${this._active.length} active)`);
  }

  // Hot path — called 30×/sec. Returns null when nothing is playing.
  getChunk(numBytes) {
    this._active = this._active.filter(s => s.pos < s.buf.length);
    if (this._active.length === 0) return null;

    numBytes = numBytes & ~3;
    if (!numBytes) return null;

    const out = Buffer.alloc(numBytes, 0);
    for (const sound of this._active) {
      const toCopy = Math.min(sound.buf.length - sound.pos, numBytes);
      for (let i = 0; i < toCopy; i += 4) {
        const sL = sound.buf.readInt16LE(sound.pos + i);
        const sR = sound.buf.readInt16LE(sound.pos + i + 2);
        const oL = out.readInt16LE(i);
        const oR = out.readInt16LE(i + 2);
        out.writeInt16LE(Math.max(-32768, Math.min(32767, oL + sL)), i);
        out.writeInt16LE(Math.max(-32768, Math.min(32767, oR + sR)), i + 2);
      }
      sound.pos += toCopy;
    }
    return out;
  }

  /** Duration of a cached sound in milliseconds. Returns 0 if not yet decoded. */
  getDurationMs(id) {
    const buf = this._pcmCache.get(id);
    if (!buf) return 0;
    // s16le stereo 44100Hz: each stereo frame = 4 bytes
    return Math.ceil(buf.length / 4 / 44100 * 1000);
  }

  /** Pre-decode all sounds so getDurationMs is always accurate. Fire-and-forget at startup. */
  async preloadAll() {
    const sounds = this.list();
    let loaded = 0;
    await Promise.all(sounds.map(async s => {
      if (this._pcmCache.has(s.id)) return;
      const sfxPath = path.join(SFX_DIR, s.id);
      try {
        const buf = await this._decode(sfxPath);
        this._pcmCache.set(s.id, buf);
        loaded++;
      } catch (e) {
        console.warn(`[SFX] Preload failed for ${s.id}: ${e.message}`);
      }
    }));
    console.log(`[SFX] Preloaded ${loaded} sounds (${this._pcmCache.size} total cached)`);
  }

  getStatus() {
    return { volume: this.volume, activeSounds: this._active.length, sounds: this.list().length };
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _decode(filePath) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const ff = spawn(FFMPEG_PATH, ['-i', filePath, '-ar', '44100', '-ac', '2', '-f', 's16le', 'pipe:1'],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      ff.stdout.on('data', c => chunks.push(c));
      ff.stderr.on('data', () => {});
      ff.on('close', code => {
        if (code !== 0) return reject(new Error(`FFmpeg decode failed (code ${code}) for ${filePath}`));
        resolve(Buffer.concat(chunks));
      });
      ff.on('error', err => reject(new Error(`FFmpeg spawn error: ${err.message}`)));
    });
  }

  _load() {
    try {
      if (fs.existsSync(DATA_PATH)) {
        const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
        // Support old flat format (just labels) and new nested format
        if (raw.labels || raw.meanings) {
          this._labels   = raw.labels   || {};
          this._meanings = raw.meanings || {};
        } else {
          // Legacy: entire object was labels
          this._labels = raw;
        }
      }
    } catch (e) {
      this._labels = {}; this._meanings = {};
    }
  }

  _save() {
    try {
      fs.writeFileSync(DATA_PATH, JSON.stringify({ labels: this._labels, meanings: this._meanings }, null, 2), 'utf8');
    } catch (e) {
      console.warn('[SFX] Failed to save data:', e.message);
    }
  }
}

module.exports = SfxService;
