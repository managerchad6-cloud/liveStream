const DEFAULT_WPM = 165;
const DEFAULT_TWEEN_MS = 180;
const TWEEN_STEPS = 6;

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
  const minActions = Math.max(6, Math.floor(words.length / 3));
  const actions = Array.isArray(plan.actions) ? plan.actions.slice() : [];

  if (actions.length >= minActions) {
    plan.totalMs = plan.totalMs || totalMs;
    return plan;
  }

  let t = 0;
  let wordIndex = 0;
  const addEye = (target, look, amount) => {
    actions.push({ t, type: 'eye', target, look, amount, durationMs: 260 });
  };
  const addBrow = (target, emote, amount) => {
    actions.push({ t: Math.max(0, t - 80), type: 'brow', target, emote, amount, durationMs: 260 });
  };

  const looks = ['listener', 'down_left', 'down_right', 'up_left', 'up_right', 'away', 'left', 'right'];
  let lookIdx = 0;

  while (t < totalMs && actions.length < minActions * 2) {
    const look = looks[lookIdx % looks.length];
    addEye(character, look, 0.45);
    if (actions.length % 3 === 0) {
      addBrow(character, 'raise', 0.4);
    } else if (actions.length % 5 === 0) {
      addBrow(character, 'flick', 0.35);
    }

    // Listener reacts subtly
    if (listener) {
      addEye(listener, 'listener', 0.35);
      if (actions.length % 4 === 0) {
        actions.push({ t: t + 120, type: 'mouth', target: listener, shape: 'SMILE', durationMs: 500 });
      }
    }

    wordIndex += 4;
    t += perWord * 4;
    lookIdx += 1;
  }

  plan.totalMs = plan.totalMs || totalMs;
  plan.actions = actions.sort((a, b) => a.t - b.t);
  return plan;
}

function makeTweener(applyFn, timers) {
  return function tween(from, to, durationMs = DEFAULT_TWEEN_MS) {
    const steps = Math.max(1, TWEEN_STEPS);
    const stepMs = Math.max(16, Math.floor(durationMs / steps));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const val = from + (to - from) * t;
      const id = setTimeout(() => applyFn(val), i * stepMs);
      timers.push(id);
    }
  };
}

function scheduleExpressionPlan(plan, api) {
  const timers = [];
  const log = api.log || (() => {});
  const totalMs = plan.totalMs || Math.max(200, (plan.durationSec || 1) * 1000);

  const getEyeRangeFor = (c) => getEyeRange(api.limits, c);
  const getBrowRangeFor = (c) => getBrowRange(api.limits, c);

  for (const action of plan.actions || []) {
    const id = setTimeout(() => {
      log(`[Expr] ${plan.character} action: ${JSON.stringify(action)}`);
      const target = action.target || plan.character;
      if (action.type === 'eye') {
        const eyeRange = getEyeRangeFor(target);
        const targetListener = target === plan.character ? plan.listener : plan.character;
        const { x, y } = resolveEyeLook(action.look, target, targetListener, eyeRange, action.amount || 0.5);
        if (typeof x === 'number') {
          const tweenEyeX = makeTweener((val) => api.setEyes(target, val, api.getEyeY(target)), timers);
          tweenEyeX(api.getEyeX(target), x, action.durationMs || DEFAULT_TWEEN_MS);
        }
        if (typeof y === 'number') {
          const tweenEyeY = makeTweener((val) => api.setEyes(target, api.getEyeX(target), val), timers);
          tweenEyeY(api.getEyeY(target), y, action.durationMs || DEFAULT_TWEEN_MS);
        }
      } else if (action.type === 'brow') {
        const browRange = getBrowRangeFor(target);
        const tweenBrow = makeTweener((val) => api.setBrows(target, val), timers);
        if (action.emote === 'flick') {
          const up = browRange.up * (action.amount || 0.4);
          const down = 0;
          const count = Math.max(1, action.count || 2);
          let t = 0;
          for (let i = 0; i < count; i++) {
            const upId = setTimeout(() => tweenBrow(api.getBrowBase(target), up, 120), t);
            timers.push(upId);
            t += 140;
            const downId = setTimeout(() => tweenBrow(api.getBrowBase(target), down, 120), t);
            timers.push(downId);
            t += 140;
          }
        } else if (action.emote === 'raise') {
          const up = browRange.up * (action.amount || 0.5);
          tweenBrow(api.getBrowBase(target), up, action.durationMs || 220);
          const id2 = setTimeout(() => tweenBrow(api.getBrowBase(target), 0, 200), action.durationMs || 220);
          timers.push(id2);
        } else if (action.emote === 'frown') {
          const down = browRange.down * (action.amount || 0.6);
          tweenBrow(api.getBrowBase(target), down, action.durationMs || 240);
        } else if (action.emote === 'skeptical') {
          const up = browRange.up * (action.amount || 0.6);
          const id3 = setTimeout(() => api.setBrowAsym(target, up, 0), 0);
          timers.push(id3);
          const id4 = setTimeout(() => api.setBrowAsym(target, 0, 0), action.durationMs || 500);
          timers.push(id4);
        }
      } else if (action.type === 'mouth') {
        const durationMs = Math.max(200, Number(action.durationMs) || 500);
        api.setMouth(target, action.shape, durationMs);
      }
    }, action.t);
    timers.push(id);
  }

  // Reset to neutral at end
  timers.push(setTimeout(() => {
    api.resetFace(plan.character);
    log(`[Expr] ${plan.character} reset to neutral`);
    if (plan.listener && plan.listener !== plan.character) {
      api.resetFace(plan.listener);
      log(`[Expr] ${plan.listener} reset to neutral`);
    }
  }, totalMs + 200));

  return timers;
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
  scheduleExpressionPlan,
  augmentExpressionPlan
};
