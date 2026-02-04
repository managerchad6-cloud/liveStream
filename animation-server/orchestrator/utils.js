function parseJson(content) {
  if (!content) return null;
  const clean = String(content).replace(/```json|```/gi, '').trim();
  try { return JSON.parse(clean); } catch (e) {}
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch (e) {}
  }
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function estimateLineDurationMs(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  const minutes = words / 150;
  return Math.max(500, Math.round(minutes * 60 * 1000));
}

function estimateDurationSeconds(lines) {
  let totalWords = 0;
  for (const line of lines || []) {
    const text = String(line.text || '').trim();
    if (!text) continue;
    totalWords += text.split(/\s+/).filter(Boolean).length;
  }
  return Math.max(1, Math.round((totalWords / 150) * 60));
}

function collectCues(lines) {
  const tvCues = [];
  const lightingCues = [];

  (lines || []).forEach((line, index) => {
    const cues = Array.isArray(line.cues) ? line.cues : [];
    for (const cue of cues) {
      if (!cue || !cue.type) continue;
      const entry = { ...cue, lineIndex: index };
      if (cue.type.startsWith('tv:')) tvCues.push(entry);
      if (cue.type.startsWith('lighting:')) lightingCues.push(entry);
    }
  });

  return { tvCues, lightingCues };
}

const LIGHTING_MOODS = {
  dramatic: { hue: -60, emissionOpacity: 0.8 },
  upbeat: { hue: 30, emissionOpacity: 1.0 },
  chill: { hue: 180, emissionOpacity: 0.6 },
  spooky: { hue: -120, emissionOpacity: 0.4, flicker: true },
  neutral: { hue: 0, emissionOpacity: 0.7 }
};

module.exports = {
  parseJson,
  sleep,
  estimateLineDurationMs,
  estimateDurationSeconds,
  collectCues,
  LIGHTING_MOODS
};
