/**
 * SfxMatcher — LLM-driven sound effect selector for pipeline segments.
 *
 * Called after TTS (Phase 1.5) with the full segment script. The LLM rates
 * compatibility between the segment content and each available SFX (0.0–1.0).
 * Only scores >= 0.7 result in an attachment; everything else is discarded.
 *
 * Result stored in segment.metadata.sfxAttach:
 *   { sfxId: "bruh.mp3", placement: "pre"|"post", score: 0.82, reason: "..." }
 *
 * Stats tracked in sfx-stats.json to surface which sounds are over/under-used.
 */

const path = require('path');
const fs   = require('fs');

const STATS_PATH      = path.join(__dirname, '..', 'sfx-stats.json');
const MATCH_TIMEOUT   = 5000;  // ms — never hold up rendering longer than this
const SCORE_THRESHOLD = 0.70;  // minimum score to attach an SFX
const COOLDOWN_SIZE   = 8;     // how many recent plays to suppress from candidate list

class SfxMatcher {
  constructor({ sfxService, openai, pipelineStore }) {
    this.sfxService      = sfxService;
    this.openai          = openai;
    this.pipelineStore   = pipelineStore;
    this._stats          = this._loadStats();
    this._recentlyPlayed = []; // cooldown ring — last COOLDOWN_SIZE played sfxIds
  }

  // ── Public ──────────────────────────────────────────────────────────────────

  /**
   * Analyze a segment and return an SFX attachment, or null.
   * Never throws — a failed match is silently ignored.
   */
  async match(segment) {
    if (!this.openai || !this.sfxService) return null;

    const sounds = this.sfxService.list();
    if (!sounds.length) return null;

    // Skip types that are unlikely to benefit (bridges, fillers are too short/contextless)
    const skipTypes = new Set(['bridge', 'filler', 'transition']);
    if (skipTypes.has(segment.type)) return null;

    try {
      const result = await Promise.race([
        this._callLLM(segment, sounds),
        new Promise(resolve => setTimeout(() => resolve(null), MATCH_TIMEOUT))
      ]);
      return result;
    } catch (err) {
      console.warn(`[SfxMatcher] Match failed for ${segment.id?.slice(0, 8)}: ${err.message}`);
      return null;
    }
  }

  /** Record that an SFX was auto-played (score was above threshold). */
  trackPlayed(sfxId) {
    if (!this._stats[sfxId]) this._stats[sfxId] = { autoPlayed: 0, considered: 0 };
    this._stats[sfxId].autoPlayed  = (this._stats[sfxId].autoPlayed  || 0) + 1;
    this._stats[sfxId].lastAutoPlayed = new Date().toISOString();
    this._saveStats();

    // Push to cooldown ring
    this._recentlyPlayed.push(sfxId);
    if (this._recentlyPlayed.length > COOLDOWN_SIZE) this._recentlyPlayed.shift();
  }

  /** Record that an SFX was the LLM's top pick but fell below the threshold. */
  trackConsidered(sfxId) {
    if (!this._stats[sfxId]) this._stats[sfxId] = { autoPlayed: 0, considered: 0 };
    this._stats[sfxId].considered = (this._stats[sfxId].considered || 0) + 1;
    this._saveStats();
  }

  /** Return stats merged with the current SFX list for the API. */
  getStats() {
    const sounds = this.sfxService ? this.sfxService.list() : [];
    return sounds.map(s => ({
      id:           s.id,
      label:        s.label,
      autoPlayed:   this._stats[s.id]?.autoPlayed   || 0,
      considered:   this._stats[s.id]?.considered   || 0,
      lastAutoPlayed: this._stats[s.id]?.lastAutoPlayed || null,
    })).sort((a, b) => b.autoPlayed - a.autoPlayed);
  }

  resetStats() {
    this._stats = {};
    this._saveStats();
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  async _callLLM(segment, sounds) {
    // Build recent context from last 3 aired segments
    const allSegs = this.pipelineStore ? this.pipelineStore.getAllSegments() : [];
    const recentContext = allSegs
      .filter(s => s.status === 'aired' && Array.isArray(s.script))
      .slice(-3)
      .map(s => s.script.map(l => `[${l.speaker}]: ${l.text}`).join(' '))
      .filter(Boolean)
      .join(' → ');

    const scriptText = segment.script
      .map(l => `[${l.speaker.toUpperCase()}]: ${l.text}`)
      .join('\n');

    // Suppress recently played sounds — forces variety
    const cooldownSet = new Set(this._recentlyPlayed);
    const candidates = sounds.filter(s => !cooldownSet.has(s.id));
    const activeSounds = candidates.length > 0 ? candidates : sounds;

    const sfxList = activeSounds
      .map(s => `"${s.id}" — ${s.label}: ${s.meaning || ''}`)
      .join('\n');

    // Build usage hint so the LLM can see which sounds are starving
    const totalPlays = sounds.reduce((sum, s) => sum + (this._stats[s.id]?.autoPlayed || 0), 0);
    const overused = sounds
      .filter(s => (this._stats[s.id]?.autoPlayed || 0) > 0)
      .sort((a, b) => (this._stats[b.id]?.autoPlayed || 0) - (this._stats[a.id]?.autoPlayed || 0))
      .slice(0, 6)
      .map(s => `  ${s.id} (${this._stats[s.id].autoPlayed} plays)`)
      .join('\n');
    const usageHint = totalPlays > 5 && overused
      ? `\nDIVERSITY NOTE — these sounds have been overused; prefer underused alternatives when fit is comparable:\n${overused}\nSounds absent from this list have 0 plays and should be favored when the match quality is similar.\n`
      : '';

    const prompt = `You are a livestream comedy director selecting a sound effect for a scripted segment.

SEGMENT TYPE: ${segment.type}
SCRIPT:
${scriptText}
${recentContext ? `\nRECENT PRIOR CONTENT (for context):\n${recentContext}` : ''}
${usageHint}
AVAILABLE SOUND EFFECTS:
${sfxList}

TASK:
Decide if any sound effect would create a genuinely funny, fitting, or impactful comedic moment when played with this segment.

PLACEMENT GUIDE:
- "post" = plays right after the segment's last word ends (most common — reaction/punctuation)
- "pre" = plays at the very first word (rare — only if it sets up the content perfectly)

SCORING:
- 0.9–1.0: Perfect match, unmistakably funny or fitting
- 0.7–0.89: Good match, clearly appropriate
- Below 0.7: Weak — do NOT use

IMPORTANT: Most segments do NOT need a sound effect. Only attach one when the match is strong and the moment deserves it. Silence is often better than a forced sound.

Respond with ONLY valid JSON matching this schema exactly (no markdown, no extra fields):
{ "match": true, "sfxId": "filename.mp3", "placement": "post", "score": 0.85, "reason": "one sentence" }
OR if no good match:
{ "match": false }`;

    const response = await this.openai.chat.completions.create({
      model:    process.env.EXPRESSION_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature:  0.6,
      max_tokens:   120,
      response_format: { type: 'json_object' }
    });

    const raw = response.choices[0]?.message?.content?.trim();
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!parsed.match) return null;

    const score = Number(parsed.score) || 0;

    // Track consideration even if below threshold
    if (parsed.sfxId) {
      if (score < SCORE_THRESHOLD) {
        this.trackConsidered(parsed.sfxId);
        console.log(`[SfxMatcher] Below threshold (${score.toFixed(2)}): ${parsed.sfxId} — ${parsed.reason}`);
        return null;
      }
    }

    if (!parsed.sfxId || score < SCORE_THRESHOLD) return null;

    // Validate sfxId exists in the list
    const valid = sounds.find(s => s.id === parsed.sfxId);
    if (!valid) {
      console.warn(`[SfxMatcher] LLM returned unknown sfxId: ${parsed.sfxId}`);
      return null;
    }

    const placement = parsed.placement === 'pre' ? 'pre' : 'post';

    console.log(`[SfxMatcher] Matched: ${parsed.sfxId} (${placement}, score=${score.toFixed(2)}) — ${parsed.reason}`);
    return { sfxId: parsed.sfxId, placement, score, reason: parsed.reason || '' };
  }

  _loadStats() {
    try {
      if (fs.existsSync(STATS_PATH)) {
        return JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
      }
    } catch (e) {}
    return {};
  }

  _saveStats() {
    try {
      fs.writeFileSync(STATS_PATH, JSON.stringify(this._stats, null, 2), 'utf8');
    } catch (e) {
      console.warn('[SfxMatcher] Failed to save stats:', e.message);
    }
  }
}

module.exports = SfxMatcher;
