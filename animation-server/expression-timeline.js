const DEFAULT_WPM = 165;

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
  const sentences = splitSentences(message);
  const { totalMs, perWord, wordCount } = estimateWordTimings(message, durationSec);
  const overallTone = classifyTone(message);

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

  const glanceDirs = ['down', 'away', 'down_left', 'down_right'];

  // Build expression actions per sentence
  for (let i = 0; i < sentenceTimings.length; i++) {
    const sent = sentenceTimings[i];
    const sentTone = sent.tone !== 'neutral' ? sent.tone : overallTone;

    // === SPEAKER EYES ===
    // Start of sentence: look at listener
    plan.actions.push({
      t: sent.startMs,
      type: 'eye',
      target: character,
      look: 'listener',
      amount: 0.5,
      durationMs: 250
    });

    // For longer sentences, add 1-2 glances away and back
    if (sent.durationMs > 1200) {
      // First glance away around 35% through
      const glance1Time = sent.startMs + sent.durationMs * 0.35;
      const glance1Dir = glanceDirs[i % glanceDirs.length];
      plan.actions.push({
        t: glance1Time,
        type: 'eye',
        target: character,
        look: glance1Dir,
        amount: 0.35,
        durationMs: 300
      });

      // Back to listener
      plan.actions.push({
        t: glance1Time + 400,
        type: 'eye',
        target: character,
        look: 'listener',
        amount: 0.5,
        durationMs: 250
      });

      // For very long sentences, add a second glance
      if (sent.durationMs > 2500) {
        const glance2Time = sent.startMs + sent.durationMs * 0.7;
        const glance2Dir = glanceDirs[(i + 1) % glanceDirs.length];
        plan.actions.push({
          t: glance2Time,
          type: 'eye',
          target: character,
          look: glance2Dir,
          amount: 0.3,
          durationMs: 280
        });

        plan.actions.push({
          t: glance2Time + 380,
          type: 'eye',
          target: character,
          look: 'listener',
          amount: 0.45,
          durationMs: 250
        });
      }
    }

    // === SPEAKER BROWS ===
    // One brow expression per sentence based on tone
    if (sentTone === 'nervous') {
      plan.actions.push({
        t: sent.startMs + 200,
        type: 'brow',
        target: character,
        emote: 'raise',
        amount: 0.4,
        durationMs: Math.min(800, sent.durationMs * 0.6)
      });
    } else if (sentTone === 'angry') {
      plan.actions.push({
        t: sent.startMs + 100,
        type: 'brow',
        target: character,
        emote: 'frown',
        amount: 0.6,
        durationMs: Math.min(1200, sent.durationMs * 0.8)
      });
    } else if (sentTone === 'question') {
      plan.actions.push({
        t: sent.startMs + sent.durationMs * 0.6,
        type: 'brow',
        target: character,
        emote: 'skeptical',
        amount: 0.5,
        durationMs: Math.min(800, sent.durationMs * 0.4)
      });
    } else if (sentTone === 'happy' || sentTone === 'confident') {
      plan.actions.push({
        t: sent.startMs + 150,
        type: 'brow',
        target: character,
        emote: 'raise',
        amount: 0.35,
        durationMs: Math.min(600, sent.durationMs * 0.5)
      });
    }

    // === LISTENER REACTIONS ===
    if (listener) {
      // Listener glances at speaker every other sentence
      if (i % 2 === 1) {
        plan.actions.push({
          t: sent.startMs + 300,
          type: 'eye',
          target: listener,
          look: 'listener',
          amount: 0.4,
          durationMs: 350
        });

        // Listener looks away briefly
        if (sent.durationMs > 1500) {
          plan.actions.push({
            t: sent.startMs + sent.durationMs * 0.6,
            type: 'eye',
            target: listener,
            look: 'down',
            amount: 0.25,
            durationMs: 300
          });
        }
      }

      // Listener smiles occasionally during positive content
      if (sentenceTimings.length >= 2 && i === Math.floor(sentenceTimings.length / 2)) {
        if (sentTone === 'happy' || sentTone === 'confident') {
          plan.actions.push({
            t: sent.startMs + sent.durationMs * 0.5,
            type: 'mouth',
            target: listener,
            shape: 'SMILE',
            durationMs: 700
          });
        }
      }
    }
  }

  // Return to neutral at end
  plan.actions.push({
    t: totalMs - 200,
    type: 'eye',
    target: character,
    look: 'listener',
    amount: 0.3,
    durationMs: 200
  });

  return plan;
}

/**
 * Augment plan if it has few actions.
 * Balanced approach - enough movement to feel alive, not so much it lags.
 */
function augmentExpressionPlan(plan, { message, character, listener, durationSec }) {
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
  const glanceDirs = ['listener', 'down', 'listener', 'away', 'listener', 'down_left'];

  for (let i = 0; i < neededActions; i++) {
    const t = Math.round((i + 1) * interval);
    const look = glanceDirs[i % glanceDirs.length];
    const amount = look === 'listener' ? 0.45 : 0.3;

    actions.push({
      t,
      type: 'eye',
      target: character,
      look,
      amount,
      durationMs: 280
    });
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
