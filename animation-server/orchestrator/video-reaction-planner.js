// VideoReactionPlanner
// Full setup pipeline: YouTube URL → transcript → beats → scripts → TTS → SessionPlan
// Emits progress events so the director console can show live status.

const EventEmitter = require('events');
const os = require('os');
const path = require('path');
const axios = require('axios');
const voices = require('../../voices');
const { getVideoInfo, downloadVideo } = require('./yt-dlp');
const { fetchTranscript } = require('./youtube-transcript');

const RESUME_PADDING = 2.5; // seconds of extra hold after last character line before video resumes
const TTS_CONCURRENCY = 3;  // max parallel ElevenLabs calls
const MAX_BEATS = 5;
const MIN_REACTABILITY = 6; // out of 10

function estimateLineDuration(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(0.5, (words / 150) * 60); // seconds at 150 WPM
}

// Mirror of SegmentRenderer.prepareForTTS — keeps substitutions in sync
const TTS_SUBSTITUTIONS = [
  { match: /\$VVC/gi,       replace: 'VVC' },
  { match: /pump\.fun/gi,   replace: 'pump fun' },
  { match: /\$SOL\b/gi,     replace: 'sol' },
  { match: /\$BTC\b/gi,     replace: 'bitcoin' },
  { match: /\$ETH\b/gi,     replace: 'ethereum' },
  { match: /\bLFG\b/g,      replace: "let's fucking go" },
  { match: /\bWAGMI\b/gi,   replace: 'we are all gonna make it' },
  { match: /\bNGMI\b/gi,    replace: 'not gonna make it' },
  { match: /\bGM\b/g,       replace: 'good morning' },
  { match: /\bGN\b/g,       replace: 'good night' },
];
function prepareForTTS(text) {
  let out = text;
  for (const { match, replace } of TTS_SUBSTITUTIONS) {
    out = out.replace(match, replace);
  }
  return out;
}

class VideoReactionPlanner extends EventEmitter {
  constructor({ openai, elevenLabsApiKey, ttsModel = 'eleven_v3' }) {
    super();
    this.openai = openai;
    this.elevenLabsApiKey = elevenLabsApiKey;
    this.ttsModel = ttsModel;
  }

  /**
   * Run the full planning pipeline.
   * @param {string} url - YouTube video URL
   * @returns {Promise<SessionPlan>}
   */
  async plan(url) {
    // ── Step 1: Info + transcript (parallel), video download starts in background ──
    this.emit('progress', { step: 'transcript', status: 'loading' });

    const [info, chunks] = await Promise.all([
      getVideoInfo(url).catch(err => { throw new Error(`Video info failed: ${err.message}`); }),
      fetchTranscript(url).catch(err => { throw new Error(`Transcript failed: ${err.message}`); })
    ]);

    this.emit('progress', { step: 'transcript', status: 'done', detail: `${chunks.length} chunks` });
    this.emit('progress', { step: 'download', status: 'loading' });

    const tempVideoPath = path.join(os.tmpdir(), `vr_${info.id}_${Date.now()}.mp4`);
    let downloadDone = false;

    const downloadPromise = downloadVideo(url, tempVideoPath, pct => {
      this.emit('progress', { step: 'download', status: 'loading', detail: `${Math.round(pct)}%` });
    }).then(() => {
      downloadDone = true;
      this.emit('progress', { step: 'download', status: 'done', videoPath: tempVideoPath });
    }).catch(err => {
      this.emit('progress', { step: 'download', status: 'failed', detail: err.message });
      throw new Error(`Video download failed: ${err.message}`);
    });

    // ── Step 2: Beat selection (one LLM call over all chunks) ──
    this.emit('progress', { step: 'beats', status: 'loading' });
    const beats = await this._selectBeats(info, chunks);
    this.emit('progress', { step: 'beats', status: 'done', detail: `${beats.length} beats selected` });

    // ── Step 3: Script generation (sequential beats for rolling context, parallel intro+wrapup) ──
    this.emit('progress', { step: 'scripts', status: 'loading' });

    const [introScript, beatScripts, wrapupScript] = await Promise.all([
      this._generateIntroScript(info),
      this._generateBeatScripts(info, chunks, beats),
      this._generateWrapupScript(info, beats)
    ]);

    this.emit('progress', { step: 'scripts', status: 'done' });

    // ── Step 4: TTS for beats + wrapup (intro goes through normal pipeline) ──
    this.emit('progress', { step: 'tts', status: 'loading' });

    const allLines = [
      ...beatScripts.flatMap(bs => bs.lines),
      ...wrapupScript.lines
    ];
    const processedLines = await this._generateAllTTS(allLines);

    this.emit('progress', { step: 'tts', status: 'done', detail: `${processedLines.length} lines` });

    // ── Assemble session plan ──
    let lineIdx = 0;
    const processedBeats = beatScripts.map((bs, i) => {
      const lines = processedLines.slice(lineIdx, lineIdx + bs.lines.length);
      lineIdx += bs.lines.length;
      const totalDuration = lines.reduce((sum, l) => sum + l.estimatedDuration, 0);
      return {
        pause_at: beats[i].end,
        resume_at: beats[i].end + totalDuration + RESUME_PADDING,
        chunkText: beats[i].text,
        lines
      };
    });

    const wrapupLines = processedLines.slice(lineIdx);
    const processedWrapup = {
      lines: wrapupLines,
      estimatedDuration: wrapupLines.reduce((sum, l) => sum + l.estimatedDuration, 0)
    };

    // ── Wait for download ──
    await downloadPromise;

    return {
      videoId: info.id,
      url,
      title: info.title,
      uploader: info.uploader,
      videoDuration: info.duration,
      tempVideoPath,
      intro: {
        script: introScript,  // Array of {speaker, text} — no audio, goes through normal pipeline
        estimatedDuration: introScript.reduce((sum, l) => sum + estimateLineDuration(l.text), 0)
      },
      beats: processedBeats,
      wrapup: processedWrapup
    };
  }

  // ── Beat selection ────────────────────────────────────────────────────────────

  async _selectBeats(info, chunks) {
    const chunkList = chunks.map((c, i) =>
      `[${i}] ${c.start.toFixed(1)}s–${c.end.toFixed(1)}s: "${c.text}"`
    ).join('\n');

    const prompt = `You are a reaction director for Chad and Virgin (Virgin vs Chad meme characters) who are watching a YouTube video and pausing to react to notable moments.

VIDEO: "${info.title}" by ${info.uploader || 'unknown'}
Description: ${info.description || '(none)'}
Duration: ${info.duration}s

TRANSCRIPT CHUNKS:
${chunkList}

Select ${MAX_BEATS} or fewer moments that are most worth pausing to react to. Choose moments that are surprising, funny, controversial, or highly quotable. Avoid the last 30 seconds. Prefer moments spread throughout the video.

Respond with a JSON object: {"beats": [{"chunkIndex": 0, "reactabilityScore": 8, "reason": "..."}, ...]}`;

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.7
    });

    let parsed;
    try {
      const obj = JSON.parse(response.choices[0].message.content);
      parsed = obj.beats || obj.moments || obj.selections || (Array.isArray(obj) ? obj : Object.values(obj)[0]) || [];
    } catch (e) {
      console.warn('[VideoReactionPlanner] Beat selection parse failed, using evenly spaced chunks');
      const step = Math.max(1, Math.floor(chunks.length / MAX_BEATS));
      parsed = Array.from({ length: MAX_BEATS }, (_, i) => ({ chunkIndex: i * step, reactabilityScore: 7 }));
    }

    const beats = parsed
      .filter(b => (b.reactabilityScore || 0) >= MIN_REACTABILITY && chunks[b.chunkIndex])
      .slice(0, MAX_BEATS)
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map(b => ({
        chunkIndex: b.chunkIndex,
        text: chunks[b.chunkIndex].text,
        start: chunks[b.chunkIndex].start,
        end: chunks[b.chunkIndex].end,
        reason: b.reason || ''
      }));

    // Guarantee at least 1 beat even if scoring is low
    if (beats.length === 0 && chunks.length > 0) {
      const mid = Math.floor(chunks.length / 2);
      beats.push({ chunkIndex: mid, text: chunks[mid].text, start: chunks[mid].start, end: chunks[mid].end, reason: 'fallback' });
    }

    return beats;
  }

  // ── Script generation ─────────────────────────────────────────────────────────

  async _generateIntroScript(info) {
    const prompt = `You are writing a short intro for Chad and Virgin (Virgin vs Chad meme characters) who just noticed a video starting on the TV behind them.

VIDEO: "${info.title}" by ${info.uploader || 'unknown'}

Write 2-3 lines where they notice the video and react to the title/topic. Chad is confident and dismissive, Virgin is nervous and over-analytical. Keep it short — this plays while the video is about to start.

Respond with a JSON object: {"lines": [{"speaker": "chad", "text": "..."}, {"speaker": "virgin", "text": "..."}]}`;

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.8
    });

    try {
      const obj = JSON.parse(response.choices[0].message.content);
      const arr = Array.isArray(obj) ? obj : (obj.lines || obj.script || Object.values(obj)[0] || []);
      if (Array.isArray(arr) && arr.length > 0) return arr;
    } catch (e) {}

    return [
      { speaker: 'chad', text: `Oh nice, "${info.title}". Let's see what this is about.` },
      { speaker: 'virgin', text: `I-I've actually been meaning to watch this one. Should be interesting...` }
    ];
  }

  async _generateBeatScripts(info, chunks, beats) {
    // Build beat scripts sequentially so each one has rolling context from previous beats
    const beatScripts = [];
    let rollingContext = '';
    const reactedSummaries = [];

    for (let i = 0; i < beats.length; i++) {
      const beat = beats[i];

      // Preceding 3 chunks for immediate conversational context
      const preceding = chunks
        .slice(Math.max(0, beat.chunkIndex - 3), beat.chunkIndex)
        .map(c => c.text)
        .join(' ');

      // Extend rolling context with what the video covered since the last beat
      const prevChunkIdx = i === 0 ? 0 : beats[i - 1].chunkIndex + 1;
      const coveredText = chunks
        .slice(prevChunkIdx, beat.chunkIndex)
        .map(c => c.text)
        .join(' ');
      if (coveredText.trim()) {
        rollingContext = (rollingContext
          ? `${rollingContext} | Then: ${coveredText.slice(0, 200)}`
          : coveredText.slice(0, 300));
      }

      const previousReactions = reactedSummaries
        .map((r, j) => `Beat ${j + 1}: reacted to "${r.chunkText.slice(0, 60)}"`)
        .join('; ');

      const prompt = `Chad and Virgin (Virgin vs Chad meme characters) just paused a YouTube video to react to a specific moment.

VIDEO: "${info.title}" by ${info.uploader || 'unknown'}
Video context so far: ${rollingContext.slice(0, 400) || '(start of video)'}
Just before this moment: "${preceding.slice(0, 200)}"
MOMENT BEING REACTED TO: "${beat.text}"
${previousReactions ? `Already reacted to: ${previousReactions}` : ''}

Write a natural 2-4 line reaction dialogue. Chad is confident, unimpressed by things that would impress Virgin, makes bold takes. Virgin overthinks everything, is nervous, occasionally has a good point. Reference the specific quote. Don't repeat previous reactions.

Respond with a JSON object: {"lines": [{"speaker": "chad", "text": "..."}, {"speaker": "virgin", "text": "..."}]}`;

      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.85
      });

      let lines;
      try {
        const obj = JSON.parse(response.choices[0].message.content);
        lines = Array.isArray(obj) ? obj : (obj.lines || obj.script || Object.values(obj)[0] || []);
        if (!Array.isArray(lines)) lines = [];
      } catch (e) {
        lines = [
          { speaker: 'chad', text: 'That\'s something.' },
          { speaker: 'virgin', text: 'Yeah I... yeah.' }
        ];
      }

      beatScripts.push({ lines: lines.filter(l => l.speaker && l.text) });
      reactedSummaries.push({ chunkText: beat.text });
    }

    return beatScripts;
  }

  async _generateWrapupScript(info, beats) {
    const beatSummary = beats
      .map((b, i) => `Beat ${i + 1}: "${b.text.slice(0, 80)}"`)
      .join('\n');

    const prompt = `Chad and Virgin (Virgin vs Chad meme characters) just finished watching "${info.title}" by ${info.uploader || 'unknown'}.

During the video they paused and reacted to:
${beatSummary || '(no specific reaction moments)'}

Write a 2-4 line wrap-up where they give their overall take on the video. Chad has a confident final verdict, Virgin hedges but tries to add something. Keep it brief.

Respond with a JSON object: {"lines": [{"speaker": "chad", "text": "..."}, {"speaker": "virgin", "text": "..."}]}`;

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.8
    });

    let lines;
    try {
      const obj = JSON.parse(response.choices[0].message.content);
      lines = Array.isArray(obj) ? obj : (obj.lines || obj.script || Object.values(obj)[0] || []);
      if (!Array.isArray(lines)) lines = [];
    } catch (e) {
      lines = [
        { speaker: 'chad', text: `That was actually decent. Solid video.` },
        { speaker: 'virgin', text: `Y-yeah, there were some really interesting points in there...` }
      ];
    }

    return { lines: lines.filter(l => l.speaker && l.text) };
  }

  // ── TTS pre-generation ────────────────────────────────────────────────────────

  async _generateAllTTS(lines) {
    const results = [];
    // Process in batches of TTS_CONCURRENCY
    for (let i = 0; i < lines.length; i += TTS_CONCURRENCY) {
      const batch = lines.slice(i, i + TTS_CONCURRENCY);
      const batchResults = await Promise.all(batch.map(line => this._ttsLine(line)));
      results.push(...batchResults);
      this.emit('progress', { step: 'tts', status: 'loading', detail: `${results.length}/${lines.length}` });
    }
    return results;
  }

  async _ttsLine(line) {
    const voiceConfig = voices[line.speaker];
    if (!voiceConfig) {
      console.warn(`[VideoReactionPlanner] Unknown speaker: ${line.speaker}, skipping TTS`);
      return { ...line, audioBuffer: null, estimatedDuration: estimateLineDuration(line.text) };
    }

    let audioBuffer = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await axios.post(
          `https://api.elevenlabs.io/v1/text-to-speech/${voiceConfig.elevenLabsVoiceId}`,
          {
            text: prepareForTTS(line.text),
            model_id: this.ttsModel,
            voice_settings: voiceConfig.voiceSettings,
            ...(voiceConfig.speed != null && { speed: voiceConfig.speed })
          },
          {
            headers: {
              'Accept': 'audio/mpeg',
              'Content-Type': 'application/json',
              'xi-api-key': this.elevenLabsApiKey
            },
            responseType: 'arraybuffer',
            timeout: 30000
          }
        );
        audioBuffer = Buffer.from(response.data);
        break;
      } catch (err) {
        console.warn(`[VideoReactionPlanner] TTS attempt ${attempt} failed for "${line.text.slice(0, 40)}": ${err.message}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }

    return {
      ...line,
      audioBuffer,
      estimatedDuration: estimateLineDuration(line.text)
    };
  }
}

module.exports = VideoReactionPlanner;
