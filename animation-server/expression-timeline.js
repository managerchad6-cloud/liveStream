const DEFAULT_WPM = 165;

function estimateWordTimings(text, durationSec) {
  const words = (text || '').trim().split(/\s+/).filter(Boolean);
  const wordCount = Math.max(1, words.length);
  const totalMs = Math.max(200, (durationSec || (wordCount / DEFAULT_WPM) * 60) * 1000);
  const perWord = totalMs / wordCount;
  return { words, totalMs, perWord };
}

function splitClauses(text) {
  if (!text) return [''];
  return text
    .split(/(?<=[.!?])\s+|[,;:]\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function classifyTone(text) {
  const t = (text || '').toLowerCase();
  if (/(angry|mad|furious|pissed|rage|annoyed|irritated)/.test(t)) return 'angry';
  if (/(nervous|awkward|anxious|worried|scared|unsure|uh|um|erm)/.test(t)) return 'nervous';
  if (/(confident|sure|obviously|clearly|easy|win|winning|crush)/.test(t)) return 'confident';
  if (/(sad|down|tired|exhausted|depressed|meh)/.test(t)) return 'sad';
  if (/(happy|glad|excited|great|awesome|nice)/.test(t)) return 'happy';
  if (/\?$/.test(t)) return 'question';
  return 'neutral';
}

function pickLook(i) {
  const looks = ['listener', 'down_left', 'down_right', 'up_left', 'up_right', 'away', 'listener'];
  return looks[i % looks.length];
}

function buildExpressionPlan({ message, character, listener, durationSec, limits }) {
  const clauses = splitClauses(message);
  const tone = classifyTone(message);
  const { totalMs, perWord } = estimateWordTimings(message, durationSec);

  const plan = {
    character,
    listener,
    tone,
    totalMs,
    perWordMs: perWord,
    actions: []
  };

  let cursorMs = 0;
  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i];
    const words = clause.split(/\s+/).filter(Boolean);
    const clauseMs = Math.max(200, words.length * perWord);
    const baseLook = pickLook(i);

    // Default gaze toward listener
    plan.actions.push({
      t: cursorMs,
      type: 'eye',
      look: baseLook,
      amount: 0.5,
      durationMs: Math.min(600, clauseMs * 0.6)
    });

    if (i % 2 === 1) {
      plan.actions.push({
        t: cursorMs + Math.max(120, clauseMs * 0.3),
        type: 'eye',
        look: pickLook(i + 1),
        amount: 0.4,
        durationMs: 300
      });
    }

    // Tone-driven brow/eye accents
    if (tone === 'nervous') {
      plan.actions.push({
        t: cursorMs + 120,
        type: 'eye',
        look: 'away',
        amount: 0.45,
        durationMs: 380
      });
      plan.actions.push({
        t: cursorMs + 200,
        type: 'brow',
        emote: 'flick',
        count: 2,
        amount: 0.4
      });
    } else if (tone === 'angry') {
      plan.actions.push({
        t: cursorMs + 100,
        type: 'brow',
        emote: 'frown',
        amount: 0.7,
        durationMs: Math.min(800, clauseMs)
      });
    } else if (tone === 'question') {
      plan.actions.push({
        t: cursorMs + Math.max(100, clauseMs - 300),
        type: 'brow',
        emote: 'skeptical',
        amount: 0.6,
        durationMs: 500
      });
    } else if (tone === 'happy') {
      plan.actions.push({
        t: cursorMs + 80,
        type: 'brow',
        emote: 'raise',
        amount: 0.5,
        durationMs: 350
      });
    }

    cursorMs += clauseMs;
  }

  // Clamp timeline end
  plan.actions = plan.actions.filter(a => a.t <= totalMs + 200);
  return plan;
}

function augmentExpressionPlan(plan, { message, character, listener, durationSec }) {
  const { totalMs, perWord, words } = estimateWordTimings(message, durationSec);
  const minActions = Math.max(10, Math.floor(words.length / 2));
  const actions = Array.isArray(plan.actions) ? plan.actions.slice() : [];

  if (actions.length >= minActions) {
    plan.totalMs = plan.totalMs || totalMs;
    return plan;
  }

  const looks = ['listener', 'down_left', 'down_right', 'up_left', 'up_right', 'away', 'left', 'right', 'down', 'up'];
  const browEmotes = ['raise', 'flick', 'skeptical', 'frown'];

  const actionCount = Math.max(minActions * 2, Math.floor(totalMs / 900));
  const interval = totalMs / (actionCount + 1);

  for (let i = 0; i < actionCount; i++) {
    const jitter = (Math.random() - 0.5) * interval * 0.4;
    const t = Math.max(0, Math.min(totalMs, Math.round((i + 1) * interval + jitter)));
    const look = looks[i % looks.length];
    const eyeAmount = 0.35 + (i % 3) * 0.1;
    actions.push({ t, type: 'eye', target: character, look, amount: eyeAmount, durationMs: 220 });

    if (i % 2 === 0) {
      const emote = browEmotes[i % browEmotes.length];
      const amount = emote === 'frown' ? 0.5 : 0.4;
      actions.push({ t: Math.max(0, t - 60), type: 'brow', target: character, emote, amount, durationMs: 240, count: emote === 'flick' ? 2 : undefined });
    }

    if (listener) {
      const listenerLook = i % 3 === 0 ? 'listener' : (i % 3 === 1 ? 'away' : 'down');
      actions.push({ t: t + 80, type: 'eye', target: listener, look: listenerLook, amount: 0.3, durationMs: 200 });
      if (i % 5 === 0) {
        actions.push({ t: t + 140, type: 'mouth', target: listener, shape: 'SMILE', durationMs: 500 });
      }
    }
  }

  plan.totalMs = plan.totalMs || totalMs;
  plan.actions = actions.sort((a, b) => a.t - b.t);
  return plan;
}

function normalizePlanTiming(plan, durationSec) {
  if (!plan || !Array.isArray(plan.actions)) return plan;
  const totalMs = Math.max(400, (durationSec || 1) * 1000);
  const maxT = plan.actions.reduce((m, a) => Math.max(m, Number(a.t) || 0), 0);
  if (maxT <= 0) {
    plan.totalMs = totalMs;
    return plan;
  }
  const spread = maxT / totalMs;
  if (spread < 0.75) {
    const scale = totalMs / maxT;
    plan.actions = plan.actions.map(a => ({ ...a, t: Math.round((Number(a.t) || 0) * scale) }));
  }
  plan.totalMs = totalMs;
  return plan;
}


function getEyeRange(limits, character) {
  const lim = limits?.[character]?.eyes;
  if (!lim) return { x: 6, y: 4 };
  return { x: Math.max(Math.abs(lim.minX), Math.abs(lim.maxX)) * 0.7, y: Math.max(Math.abs(lim.minY), Math.abs(lim.maxY)) * 0.7 };
}

function getBrowRange(limits, character) {
  const lim = limits?.[character]?.eyebrows;
  if (!lim) return { up: -6, down: 6 };
  return { up: lim.minY || -6, down: lim.maxY || 6 };
}

function resolveEyeLook(look, character, listener, range, amount) {
  const amtX = range.x * amount;
  const amtY = range.y * amount;
  if (look === 'listener') {
    if (character === 'virgin' && listener === 'chad') return { x: -amtX, y: 0 };
    if (character === 'chad' && listener === 'virgin') return { x: amtX, y: 0 };
  }
  if (look === 'away') {
    if (character === 'virgin' && listener === 'chad') return { x: amtX, y: amtY * 0.4 };
    if (character === 'chad' && listener === 'virgin') return { x: -amtX, y: amtY * 0.4 };
  }
  if (look === 'down') return { x: 0, y: amtY };
  if (look === 'up') return { x: 0, y: -amtY };
  if (look === 'left') return { x: -amtX, y: 0 };
  if (look === 'right') return { x: amtX, y: 0 };
  if (look === 'up_left') return { x: -amtX, y: -amtY };
  if (look === 'up_right') return { x: amtX, y: -amtY };
  if (look === 'down_left') return { x: -amtX, y: amtY };
  if (look === 'down_right') return { x: amtX, y: amtY };
  return { x: 0, y: 0 };
}

module.exports = {
  buildExpressionPlan,
  augmentExpressionPlan,
  normalizePlanTiming,
  resolveEyeLook,
  getEyeRange,
  getBrowRange
};
