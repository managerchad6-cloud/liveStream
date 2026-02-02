const { resolveEyeLook, getEyeRange, getBrowRange } = require('./expression-timeline');

const DEFAULT_TWEEN_MS = 300;  // Slower, more natural transitions

class ExpressionEvaluator {
  constructor() {
    this.tracks = {};  // { chad: { eyeX: [], eyeY: [], browY: [], browAsymL: [], browAsymR: [], mouth: [] }, virgin: { ... } }
    this.loaded = false;
  }

  loadPlan(plan, limits) {
    this.clear();
    if (!plan || !Array.isArray(plan.actions)) return;

    const character = plan.character;
    const listener = plan.listener;
    const totalMs = plan.totalMs || 1000;

    const chars = [character, listener].filter(Boolean);
    for (const c of chars) {
      this.tracks[c] = { eyeX: [], eyeY: [], browY: [], browAsymL: [], browAsymR: [], mouth: [] };
    }

    for (const action of plan.actions) {
      const target = action.target || character;
      if (!this.tracks[target]) {
        this.tracks[target] = { eyeX: [], eyeY: [], browY: [], browAsymL: [], browAsymR: [], mouth: [] };
      }

      const tracks = this.tracks[target];
      const t = Number(action.t) || 0;

      if (action.type === 'eye') {
        const eyeRange = getEyeRange(limits, target);
        const targetListener = target === character ? listener : character;
        const { x, y } = resolveEyeLook(action.look, target, targetListener, eyeRange, action.amount || 0.5);
        const tweenMs = action.durationMs || DEFAULT_TWEEN_MS;
        if (typeof x === 'number') {
          tracks.eyeX.push({ t, targetVal: x, tweenMs });
        }
        if (typeof y === 'number') {
          tracks.eyeY.push({ t, targetVal: y, tweenMs });
        }

      } else if (action.type === 'brow') {
        const browRange = getBrowRange(limits, target);

        if (action.emote === 'flick') {
          const up = browRange.up * (action.amount || 0.4);
          const count = Math.max(1, action.count || 2);
          let cursor = t;
          for (let i = 0; i < count; i++) {
            tracks.browY.push({ t: cursor, targetVal: up, tweenMs: 120 });
            cursor += 140;
            tracks.browY.push({ t: cursor, targetVal: 0, tweenMs: 120 });
            cursor += 140;
          }

        } else if (action.emote === 'raise') {
          const up = browRange.up * (action.amount || 0.5);
          const dur = action.durationMs || 220;
          tracks.browY.push({ t, targetVal: up, tweenMs: dur });
          tracks.browY.push({ t: t + dur, targetVal: 0, tweenMs: 200 });

        } else if (action.emote === 'frown') {
          const down = browRange.down * (action.amount || 0.6);
          const dur = action.durationMs || 400;
          tracks.browY.push({ t, targetVal: down, tweenMs: 200 });
          tracks.browY.push({ t: t + dur, targetVal: 0, tweenMs: 300 });  // Return to neutral

        } else if (
          action.emote === 'skeptical' ||
          action.emote === 'skeptical_left' ||
          action.emote === 'skeptical_right' ||
          action.emote === 'asym_up_left' ||
          action.emote === 'asym_up_right' ||
          action.emote === 'asym_down_left' ||
          action.emote === 'asym_down_right'
        ) {
          const up = browRange.up * (action.amount || 0.6);
          const down = browRange.down * (action.amount || 0.6);
          const dur = action.durationMs || 500;
          let leftVal = 0;
          let rightVal = 0;

          if (action.emote === 'skeptical' || action.emote === 'skeptical_left' || action.emote === 'skeptical_right') {
            leftVal = action.emote === 'skeptical_right' ? 0 : up;
            rightVal = action.emote === 'skeptical_left' ? 0 : up;
          } else if (action.emote === 'asym_up_left') {
            leftVal = up;
            rightVal = down * 0.4;
          } else if (action.emote === 'asym_up_right') {
            leftVal = down * 0.4;
            rightVal = up;
          } else if (action.emote === 'asym_down_left') {
            leftVal = down;
            rightVal = up * 0.4;
          } else if (action.emote === 'asym_down_right') {
            leftVal = up * 0.4;
            rightVal = down;
          }

          tracks.browAsymL.push({ t, targetVal: leftVal, tweenMs: 80 });
          tracks.browAsymR.push({ t, targetVal: rightVal, tweenMs: 80 });
          tracks.browAsymL.push({ t: t + dur, targetVal: 0, tweenMs: 80 });
          tracks.browAsymR.push({ t: t + dur, targetVal: 0, tweenMs: 80 });
        }

      } else if (action.type === 'mouth') {
        const shape = (action.shape || 'SMILE').toUpperCase();
        if (['SMILE', 'SURPRISE'].includes(shape)) {
          const durationMs = Math.max(200, Number(action.durationMs) || 500);
          tracks.mouth.push({ t, shape, durationMs });
        }
      }
    }

    // Add return-to-neutral transitions at plan end for all characters
    for (const c of Object.keys(this.tracks)) {
      const tracks = this.tracks[c];
      const endT = totalMs;
      tracks.eyeX.push({ t: endT, targetVal: 0, tweenMs: 200 });
      tracks.eyeY.push({ t: endT, targetVal: 0, tweenMs: 200 });
      tracks.browY.push({ t: endT, targetVal: 0, tweenMs: 200 });
      tracks.browAsymL.push({ t: endT, targetVal: 0, tweenMs: 80 });
      tracks.browAsymR.push({ t: endT, targetVal: 0, tweenMs: 80 });

      // Sort all tracks by time
      for (const key of Object.keys(tracks)) {
        if (key !== 'mouth') {
          tracks[key].sort((a, b) => a.t - b.t);
        }
      }
      tracks.mouth.sort((a, b) => a.t - b.t);
    }

    this.loaded = true;
  }

  evaluateAtMs(timeMs) {
    const result = {};
    for (const c of Object.keys(this.tracks)) {
      const tracks = this.tracks[c];
      // Round to integers — fractional pixel offsets bust the compositor's
      // frame cache (cache key includes offset values) and force expensive
      // Sharp extract+extend+rotate pipelines on every single frame.
      result[c] = {
        eyeX: Math.round(evalTrack(tracks.eyeX, timeMs)),
        eyeY: Math.round(evalTrack(tracks.eyeY, timeMs)),
        browY: Math.round(evalTrack(tracks.browY, timeMs)),
        browAsymL: Math.round(evalTrack(tracks.browAsymL, timeMs)),
        browAsymR: Math.round(evalTrack(tracks.browAsymR, timeMs)),
        mouth: evalMouthTrack(tracks.mouth, timeMs)
      };
    }
    return result;
  }

  clear() {
    this.tracks = {};
    this.loaded = false;
  }
}

function lerp(a, b, t) {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

function evalTrack(transitions, timeMs, defaultVal = 0) {
  if (!transitions || transitions.length === 0) return defaultVal;

  let prevVal = defaultVal;
  for (let i = 0; i < transitions.length; i++) {
    const tr = transitions[i];
    if (timeMs < tr.t) {
      return prevVal;
    }
    const tweenEnd = tr.t + tr.tweenMs;
    if (timeMs <= tweenEnd) {
      const progress = tr.tweenMs > 0 ? (timeMs - tr.t) / tr.tweenMs : 1;
      return lerp(prevVal, tr.targetVal, progress);
    }
    prevVal = tr.targetVal;
  }
  return prevVal;
}

function evalMouthTrack(transitions, timeMs) {
  if (!transitions || transitions.length === 0) return null;

  // Find the last mouth action that is currently active
  for (let i = transitions.length - 1; i >= 0; i--) {
    const tr = transitions[i];
    if (timeMs >= tr.t && timeMs <= tr.t + tr.durationMs) {
      return tr.shape;
    }
  }
  return null;
}

module.exports = ExpressionEvaluator;
