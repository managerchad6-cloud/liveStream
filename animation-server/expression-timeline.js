const DEFAULT_WPM = 165;

function makeSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeRng(seed) {
  let s = (seed ^ Date.now() ^ Math.floor(Math.random() * 1000000000)) >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1000000) / 1000000;
  };
}

function randRange(rng, min, max) {
  return min + (max - min) * rng();
}

function estimateWordTimings(text, durationSec) {
  const words = (text || '').trim().split(/\s+/).filter(Boolean);
  const wordCount = Math.max(1, words.length);
  const totalMs = Math.max(200, (durationSec || (wordCount / DEFAULT_WPM) * 60) * 1000);
  const perWord = totalMs / wordCount;
  return { words, wordCount, totalMs, perWord };
}

/**
 * Split text into sentences (major breaks) and phrases (minor breaks).
 * Sentences end with . ! ?
 * Phrases are separated by , ; : —
 */
function splitSentences(text) {
  if (!text) return [{ text: '', type: 'sentence' }];

  // Split on sentence-ending punctuation first
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);

  if (sentences.length === 0) {
    return [{ text: text.trim(), type: 'sentence' }];
  }

  return sentences.map(s => ({ text: s, type: 'sentence' }));
}

function hasPauseMarkers(text) {
  return /[,;:—-]/.test(text || '');
}

function hasSurpriseCues(text) {
  return /(\bwhoa\b|\bwow\b|\bwhat\b|\breally\b|\bno way\b|\bomg\b|\bunbelievable\b|\bshocking\b|\bbreaking\b|!)/i.test(text || '');
}

function hasSmileCues(text) {
  return /(\blol\b|\bhaha\b|\blmao\b|\brofl\b|\bfunny\b|\bjoke\b|\bpunchline\b|\blaugh\b|\bnice\b|\bgreat\b|\bawesome\b|\blove\b|\bgood\b|\bwin\b)/i.test(text || '');
}

function pickListenerMouthReaction(sentTone, text, rng) {
  if (sentTone === 'happy' || sentTone === 'confident' || hasSmileCues(text)) {
    return rng() < 0.95 ? 'SMILE' : null;
  }
  if (sentTone === 'angry' || sentTone === 'question' || hasSurpriseCues(text)) {
    return rng() < 0.85 ? 'SURPRISE' : null;
  }
  return rng() < 0.2 ? (rng() < 0.7 ? 'SMILE' : 'SURPRISE') : null;
}

function reactionDurationMs(rng) {
  return Math.round(randRange(rng, 2200, 3200));
}

function listenerBrowForReaction(shape, rng) {
  if (shape === 'SMILE') return { emote: 'raise', amount: randRange(rng, 0.25, 0.4) };
  if (shape === 'SURPRISE') return { emote: rng() < 0.6 ? 'raise' : 'skeptical_left', amount: randRange(rng, 0.3, 0.45) };
  return null;
}

function classifyTone(text) {
  const t = (text || '').toLowerCase();
  if (/(angry|mad|furious|pissed|rage|annoyed|irritated)/.test(t)) return 'angry';
  if (/(nervous|awkward|anxious|worried|scared|unsure|uh|um|erm)/.test(t)) return 'nervous';
  if (/(confident|sure|obviously|clearly|easy|win|winning|crush)/.test(t)) return 'confident';
  if (/(sad|down|tired|exhausted|depressed|meh)/.test(t)) return 'sad';
  if (/(happy|glad|excited|great|awesome|nice|love|amazing)/.test(t)) return 'happy';
  if (/\?$/.test(t)) return 'question';
  return 'neutral';
}

/**
 * Build a natural expression plan aligned to sentences.
 *
 * Philosophy:
 * - Eyes: Active but purposeful. Look at listener, glance away while thinking, back to listener.
 * - Brows: One accent per sentence based on tone.
 * - Listener: Occasional reactions.
 */
function buildExpressionPlan({ message, character, listener, durationSec, limits }) {
  const rng = makeRng(makeSeed(`${message || ''}|${character}|${listener || ''}|plan`));
  const sentences = splitSentences(message);
  const { totalMs, perWord, wordCount } = estimateWordTimings(message, durationSec);
  const overallTone = classifyTone(message);
  let listenerReactionCount = 0;

  const plan = {
    character,
    listener,
    tone: overallTone,
    totalMs,
    actions: []
  };

  // Calculate time per sentence based on word count
  let cursorMs = 0;
  const sentenceTimings = sentences.map(s => {
    const words = s.text.split(/\s+/).filter(Boolean);
    const ms = Math.max(400, words.length * perWord);
    const start = cursorMs;
    cursorMs += ms;
    return { ...s, words, startMs: start, durationMs: ms, tone: classifyTone(s.text) };
  });

  const glanceDirs = ['down', 'away', 'down_left', 'down_right', 'up_left', 'up_right'];
  const microDirs = ['left', 'right', 'up', 'down', 'up_left', 'up_right', 'down_left', 'down_right'];

  // Build expression actions per sentence
  const asymEmotes = ['asym_up_left', 'asym_up_right', 'asym_down_left', 'asym_down_right'];

  function addBrowAction(t, emote, amount, durationMs) {
    plan.actions.push({
      t: Math.round(t),
      type: 'brow',
      target: character,
      emote,
      amount,
      durationMs: Math.max(1000, Math.round(durationMs))
    });
  }

  // Keep listener mostly oriented toward the speaker
  if (listener) {
    plan.actions.push({
      t: 0,
      type: 'eye',
      target: listener,
      look: 'listener',
      amount: 0.5,
      durationMs: 320
    });
  }

  for (let i = 0; i < sentenceTimings.length; i++) {
    const sent = sentenceTimings[i];
    const sentTone = sent.tone !== 'neutral' ? sent.tone : overallTone;
    const hasPause = hasPauseMarkers(sent.text);

    // === SPEAKER EYES ===
    // Start of sentence: look at listener
    plan.actions.push({
      t: sent.startMs,
      type: 'eye',
      target: character,
      look: 'listener',
      amount: randRange(rng, 0.42, 0.55),
      durationMs: Math.round(randRange(rng, 220, 320))
    });

    // For longer sentences, add 1-2 glances away and back
    if (sent.durationMs > 1200) {
      // First glance away around 35% through
      const glance1Time = sent.startMs + sent.durationMs * randRange(rng, 0.3, 0.42);
      const glance1Dir = glanceDirs[Math.floor(rng() * glanceDirs.length)];
      plan.actions.push({
        t: glance1Time,
        type: 'eye',
        target: character,
        look: glance1Dir,
        amount: randRange(rng, 0.28, 0.38),
        durationMs: Math.round(randRange(rng, 260, 360))
      });

      // Back to listener
      plan.actions.push({
        t: glance1Time + Math.round(randRange(rng, 320, 460)),
        type: 'eye',
        target: character,
        look: 'listener',
        amount: randRange(rng, 0.42, 0.52),
        durationMs: Math.round(randRange(rng, 220, 320))
      });

      // For very long sentences, add a second glance
      if (sent.durationMs > 2500) {
        const glance2Time = sent.startMs + sent.durationMs * randRange(rng, 0.62, 0.78);
        const glance2Dir = glanceDirs[Math.floor(rng() * glanceDirs.length)];
        plan.actions.push({
          t: glance2Time,
          type: 'eye',
          target: character,
          look: glance2Dir,
          amount: randRange(rng, 0.26, 0.36),
          durationMs: Math.round(randRange(rng, 240, 340))
        });

        plan.actions.push({
          t: glance2Time + Math.round(randRange(rng, 300, 420)),
          type: 'eye',
          target: character,
          look: 'listener',
          amount: randRange(rng, 0.4, 0.5),
          durationMs: Math.round(randRange(rng, 220, 320))
        });
      }
    }

    // Thinking/pauses: brief eye-up or eye-down around commas/long pauses
    if (hasPause || sent.durationMs > 1600) {
      const thinkTime = sent.startMs + sent.durationMs * randRange(rng, 0.45, 0.7);
      const thinkDir = rng() < 0.6 ? 'up' : 'down';
      plan.actions.push({
        t: Math.round(thinkTime),
        type: 'eye',
        target: character,
        look: thinkDir,
        amount: randRange(rng, 0.22, 0.32),
        durationMs: Math.round(randRange(rng, 180, 260))
      });

      plan.actions.push({
        t: Math.round(thinkTime + randRange(rng, 260, 420)),
        type: 'eye',
        target: character,
        look: 'listener',
        amount: randRange(rng, 0.4, 0.5),
        durationMs: Math.round(randRange(rng, 200, 280))
      });
    }

    // Micro saccades: small, quick eye moves to avoid staring
    const microCount = Math.max(0, Math.floor(sent.durationMs / 1200));
    for (let m = 0; m < microCount; m++) {
      const t = sent.startMs + randRange(rng, 0.15, 0.85) * sent.durationMs;
      const look = microDirs[Math.floor(rng() * microDirs.length)];
      plan.actions.push({
        t: Math.round(t),
        type: 'eye',
        target: character,
        look,
        amount: randRange(rng, 0.18, 0.28),
        durationMs: Math.round(randRange(rng, 140, 220))
      });
    }

    // === SPEAKER BROWS ===
    // One brow expression per sentence based on tone
    // === SPEAKER BROWS ===
    // Build 2-4 brow actions per sentence for richer expression.
    const browCount = Math.max(2, Math.min(4, Math.round(sent.durationMs / 700)));
    const baseEmotes = [
      'raise',
      'frown',
      rng() < 0.5 ? 'skeptical_left' : 'skeptical_right',
      asymEmotes[Math.floor(rng() * asymEmotes.length)]
    ];

    for (let b = 0; b < browCount; b++) {
      const t = sent.startMs + sent.durationMs * randRange(rng, 0.15, 0.85);
      let emote = baseEmotes[b % baseEmotes.length];
      let amount = randRange(rng, 0.45, 0.75);
      let durationMs = randRange(rng, 420, 820);

      // Tone biases
      if (sentTone === 'angry') {
        emote = rng() < 0.7 ? 'frown' : asymEmotes[Math.floor(rng() * asymEmotes.length)];
        amount = randRange(rng, 0.6, 0.9);
        durationMs = randRange(rng, 500, 900);
      } else if (sentTone === 'nervous') {
        emote = rng() < 0.7 ? 'raise' : (rng() < 0.5 ? 'skeptical_left' : 'skeptical_right');
        amount = randRange(rng, 0.5, 0.8);
        durationMs = randRange(rng, 500, 900);
      } else if (sentTone === 'question') {
        emote = rng() < 0.6 ? (rng() < 0.5 ? 'skeptical_left' : 'skeptical_right') : asymEmotes[Math.floor(rng() * asymEmotes.length)];
        amount = randRange(rng, 0.55, 0.85);
        durationMs = randRange(rng, 480, 860);
      } else if (sentTone === 'happy' || sentTone === 'confident') {
        emote = rng() < 0.7 ? 'raise' : asymEmotes[Math.floor(rng() * asymEmotes.length)];
        amount = randRange(rng, 0.5, 0.75);
        durationMs = randRange(rng, 450, 820);
      }

      addBrowAction(t, emote, amount, durationMs);
    }

    // Extra asymmetry pop for variety
    if (rng() < 0.6) {
      const asymEmote = asymEmotes[Math.floor(rng() * asymEmotes.length)];
      addBrowAction(
        sent.startMs + sent.durationMs * randRange(rng, 0.3, 0.8),
        asymEmote,
        randRange(rng, 0.4, 0.65),
        randRange(rng, 420, 760)
      );
    }

    // === LISTENER REACTIONS ===
    if (listener) {
      // Listener glances at speaker frequently
      if (i % 2 === 1 || rng() < 0.6) {
        const gazeTime = sent.startMs + Math.round(randRange(rng, 220, 380));
        plan.actions.push({
          t: gazeTime,
          type: 'eye',
          target: listener,
          look: 'listener',
          amount: randRange(rng, 0.32, 0.42),
          durationMs: Math.round(randRange(rng, 280, 380))
        });

        // Mouth reaction while looking at speaker
        const reaction = pickListenerMouthReaction(sentTone, sent.text, rng);
        if (reaction) {
          const dur = reactionDurationMs(rng);
          plan.actions.push({
            t: gazeTime + Math.round(randRange(rng, 80, 220)),
            type: 'mouth',
            target: listener,
            shape: reaction,
            durationMs: dur
          });
          listenerReactionCount++;

          const brow = listenerBrowForReaction(reaction, rng);
          if (brow) {
            plan.actions.push({
              t: gazeTime + Math.round(randRange(rng, 140, 300)),
              type: 'brow',
              target: listener,
              emote: brow.emote,
              amount: brow.amount,
              durationMs: Math.round(Math.min(1600, dur))
            });
          }
        }

        // Listener looks away briefly
        if (sent.durationMs > 1500) {
          const awayTime = sent.startMs + Math.round(sent.durationMs * randRange(rng, 0.55, 0.7));
          plan.actions.push({
            t: awayTime,
            type: 'eye',
            target: listener,
            look: 'down',
            amount: randRange(rng, 0.2, 0.3),
            durationMs: Math.round(randRange(rng, 220, 320))
          });
          plan.actions.push({
            t: awayTime + Math.round(randRange(rng, 260, 420)),
            type: 'eye',
            target: listener,
            look: 'listener',
            amount: randRange(rng, 0.35, 0.45),
            durationMs: Math.round(randRange(rng, 240, 360))
          });
        }
      }

      // Fallback listener mouth reaction if no gaze-triggered reaction
      if (rng() < 0.5) {
        const reaction = pickListenerMouthReaction(sentTone, sent.text, rng);
        if (reaction) {
          const listenerReactTime = sent.startMs + sent.durationMs * randRange(rng, 0.35, 0.65);
          const dur = reactionDurationMs(rng);
          plan.actions.push({
            t: Math.round(listenerReactTime),
            type: 'mouth',
            target: listener,
            shape: reaction,
            durationMs: dur
          });
          listenerReactionCount++;

          const brow = listenerBrowForReaction(reaction, rng);
          if (brow) {
            plan.actions.push({
              t: Math.round(listenerReactTime + randRange(rng, 120, 260)),
              type: 'brow',
              target: listener,
              emote: brow.emote,
              amount: brow.amount,
              durationMs: Math.round(Math.min(1600, dur))
            });
          }
        }
      }
    }
  }

  // Ensure at least one listener reaction per turn
  if (listener && listenerReactionCount === 0) {
    const fallbackReaction = pickListenerMouthReaction(overallTone, message, rng) || (hasSurpriseCues(message) ? 'SURPRISE' : 'SMILE');
    const t = Math.round(totalMs * randRange(rng, 0.4, 0.7));
    const dur = reactionDurationMs(rng);
    plan.actions.push({
      t,
      type: 'mouth',
      target: listener,
      shape: fallbackReaction,
      durationMs: dur
    });
    const brow = listenerBrowForReaction(fallbackReaction, rng);
    if (brow) {
      plan.actions.push({
        t: t + Math.round(randRange(rng, 120, 260)),
        type: 'brow',
        target: listener,
        emote: brow.emote,
        amount: brow.amount,
        durationMs: Math.round(Math.min(1600, dur))
      });
    }
  }

  // Return to neutral at end
  plan.actions.push({
    t: totalMs - 200,
    type: 'eye',
    target: character,
    look: 'listener',
    amount: randRange(rng, 0.28, 0.38),
    durationMs: Math.round(randRange(rng, 180, 240))
  });

  return plan;
}

/**
 * Augment plan if it has few actions.
 * Balanced approach - enough movement to feel alive, not so much it lags.
 */
function augmentExpressionPlan(plan, { message, character, listener, durationSec }) {
  const rng = makeRng(makeSeed(`${message || ''}|${character}|${listener || ''}|augment`));
  const { totalMs, wordCount } = estimateWordTimings(message, durationSec);
  const actions = Array.isArray(plan.actions) ? plan.actions.slice() : [];

  // Target roughly 1 eye action per 1.5 seconds, capped at reasonable limits
  const targetActions = Math.min(15, Math.max(4, Math.floor(totalMs / 1500)));

  if (actions.length >= targetActions) {
    plan.totalMs = plan.totalMs || totalMs;
    return plan;
  }

  // Add eye movements spread across the duration
  const neededActions = targetActions - actions.length;
  const interval = totalMs / (neededActions + 1);
  const glanceDirs = ['listener', 'down', 'listener', 'away', 'listener', 'down_left', 'up_left', 'up_right'];

  for (let i = 0; i < neededActions; i++) {
    const t = Math.round((i + 1) * interval);
    const look = glanceDirs[Math.floor(rng() * glanceDirs.length)];
    const amount = look === 'listener' ? randRange(rng, 0.4, 0.5) : randRange(rng, 0.25, 0.35);

    actions.push({
      t,
      type: 'eye',
      target: character,
      look,
      amount,
      durationMs: Math.round(randRange(rng, 240, 320))
    });
  }

  // Add subtle brow actions if none exist
  const browCount = actions.filter(a => a.type === 'brow' && (a.target || character) === character).length;
  if (browCount < 10) {
    const browAdds = 10 - browCount;
    for (let i = 0; i < browAdds; i++) {
      const asymEmotes = ['skeptical_left', 'skeptical_right', 'asym_up_left', 'asym_up_right', 'asym_down_left', 'asym_down_right'];
      const emote = rng() < 0.6 ? 'raise' : asymEmotes[Math.floor(rng() * asymEmotes.length)];
      actions.push({
        t: Math.round(totalMs * randRange(rng, 0.25, 0.8)),
        type: 'brow',
        target: character,
        emote,
        amount: randRange(rng, 0.35, 0.55),
        durationMs: Math.round(randRange(rng, 360, 620))
      });
    }
  }

  // Add a couple listener reactions for longer speeches
  if (listener && totalMs > 3000 && neededActions > 3) {
    actions.push({
      t: Math.round(totalMs * 0.3),
      type: 'eye',
      target: listener,
      look: 'listener',
      amount: 0.35,
      durationMs: 300
    });
    actions.push({
      t: Math.round(totalMs * 0.7),
      type: 'eye',
      target: listener,
      look: 'down',
      amount: 0.25,
      durationMs: 280
    });
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
  // Only scale if actions are bunched in less than 75% of duration
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
  const up = lim.minY || -6;
  const down = lim.maxY || 6;
  // Clamp downward movement to 2px max (and none for virgin)
  const clampedDown = Math.min(down, 2);
  return { up, down: character === 'virgin' ? 0 : clampedDown };
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
