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

    // Default gaze toward listener
    plan.actions.push({
      t: cursorMs,
      type: 'eye',
      look: 'listener',
      amount: 0.5,
      durationMs: Math.min(600, clauseMs * 0.6)
    });

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

  const eyeRange = getEyeRange(api.limits, plan.character);
  const browRange = getBrowRange(api.limits, plan.character);

  const tweenEyeX = makeTweener((val) => api.setEyes(plan.character, val, api.getEyeY(plan.character)), timers);
  const tweenEyeY = makeTweener((val) => api.setEyes(plan.character, api.getEyeX(plan.character), val), timers);
  const tweenBrow = makeTweener((val) => api.setBrows(plan.character, val), timers);

  for (const action of plan.actions || []) {
    const id = setTimeout(() => {
      log(`[Expr] ${plan.character} action: ${JSON.stringify(action)}`);
      if (action.type === 'eye') {
        const { x, y } = resolveEyeLook(action.look, plan.character, plan.listener, eyeRange, action.amount || 0.5);
        if (typeof x === 'number') tweenEyeX(api.getEyeX(plan.character), x, action.durationMs || DEFAULT_TWEEN_MS);
        if (typeof y === 'number') tweenEyeY(api.getEyeY(plan.character), y, action.durationMs || DEFAULT_TWEEN_MS);
      } else if (action.type === 'brow') {
        if (action.emote === 'flick') {
          const up = browRange.up * (action.amount || 0.4);
          const down = 0;
          const count = Math.max(1, action.count || 2);
          let t = 0;
          for (let i = 0; i < count; i++) {
            const upId = setTimeout(() => tweenBrow(api.getBrowBase(plan.character), up, 120), t);
            timers.push(upId);
            t += 140;
            const downId = setTimeout(() => tweenBrow(api.getBrowBase(plan.character), down, 120), t);
            timers.push(downId);
            t += 140;
          }
        } else if (action.emote === 'raise') {
          const up = browRange.up * (action.amount || 0.5);
          tweenBrow(api.getBrowBase(plan.character), up, action.durationMs || 220);
          const id2 = setTimeout(() => tweenBrow(api.getBrowBase(plan.character), 0, 200), action.durationMs || 220);
          timers.push(id2);
        } else if (action.emote === 'frown') {
          const down = browRange.down * (action.amount || 0.6);
          tweenBrow(api.getBrowBase(plan.character), down, action.durationMs || 240);
        } else if (action.emote === 'skeptical') {
          const up = browRange.up * (action.amount || 0.6);
          const id3 = setTimeout(() => api.setBrowAsym(plan.character, up, 0), 0);
          timers.push(id3);
          const id4 = setTimeout(() => api.setBrowAsym(plan.character, 0, 0), action.durationMs || 500);
          timers.push(id4);
        }
      }
    }, action.t);
    timers.push(id);
  }

  // Reset to neutral at end
  timers.push(setTimeout(() => {
    api.resetFace(plan.character);
    log(`[Expr] ${plan.character} reset to neutral`);
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
  return { x: 0, y: 0 };
}

module.exports = {
  buildExpressionPlan,
  scheduleExpressionPlan
};
