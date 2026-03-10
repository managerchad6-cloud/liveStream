#!/usr/bin/env node
/**
 * director-run.js — Event-Driven Director Agent
 *
 * Subscribes to pipeline:update WebSocket events from the animation server.
 * On wrapUp signal, uses OpenAI to judge timing and injects the next scripted
 * block. Only ever submits custom-script segments — never chat messages.
 *
 * Usage:
 *   node tools/director-run.js
 *   node tools/director-run.js --reset   (clear saved state, start from block 1)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs     = require('fs');
const path   = require('path');
const OpenAI = require('openai');

const ANIM         = 'http://127.0.0.1:3003';
const WS_URL       = 'ws://127.0.0.1:3003/ws/orchestrator';
const SCRIPT_PATH  = path.join(__dirname, '..', 'livestream-script.md');
const STATE_PATH   = path.join(__dirname, '..', 'data', 'director-state.json');
const DIALOGUE_LOG = path.join(__dirname, '..', 'logs', 'dialogue.jsonl');
const RECONNECT_MS = 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Script parser ──────────────────────────────────────────────────────────

function parseScript(md) {
  const sections = [];
  md = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (const raw of md.split(/\n(?=# Section)/)) {
    const lines     = raw.split('\n');
    const titleLine = lines[0].replace(/^# /, '').trim();
    if (!titleLine.startsWith('Section')) continue;

    const section = { title: titleLine, blocks: [] };

    const rawBlocks = raw.split(/\n(?=## Block)/);
    for (const rb of rawBlocks.slice(1)) {
      const bLines = rb.split('\n');
      const block  = { seed: '', exitContext: '', script: [] };
      for (const line of bLines) {
        if (line.startsWith('seed:'))
          block.seed = line.slice('seed:'.length).trim();
        else if (line.startsWith('exitContext:'))
          block.exitContext = line.slice('exitContext:'.length).trim();
        else {
          const m = line.match(/^(chad|virgin|narrator):\s*"(.+)"$/);
          if (m) block.script.push({ speaker: m[1], text: m[2] });
        }
      }
      if (block.script.length > 0) section.blocks.push(block);
    }

    if (section.blocks.length > 0) sections.push(section);
  }
  return sections;
}

// ─── State ──────────────────────────────────────────────────────────────────

const DEFAULT_STATE = {
  sectionIndex:      0,
  blockIndex:        0,
  lastWrapUpHandled: null,
  blockInjected:     false
};

function loadState() {
  try { return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) }; }
  catch { return { ...DEFAULT_STATE }; }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function apiGet(url) {
  const res = await fetch(url);
  return res.json();
}

async function apiPost(url, body) {
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body)
  });
  return res.json();
}

// ─── Dialogue log ────────────────────────────────────────────────────────────

function readRecentDialogue(n = 15) {
  try {
    const raw = fs.readFileSync(DIALOGUE_LOG, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').slice(-n).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// ─── Pipeline helpers ─────────────────────────────────────────────────────────

function findWrapUp(segments) {
  return segments.find(s =>
    s.status === 'forming' &&
    s.metadata?.continuity === 'expand' &&
    s.metadata?.wrapUp === true
  ) || null;
}

function hasNonExpandForming(segments) {
  return segments.some(s =>
    s.status === 'forming' &&
    s.metadata?.continuity !== 'expand'
  );
}

function pipelineHasActivity(segments) {
  return segments.some(s => s.status === 'forming' || s.status === 'ready');
}

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] ${msg}`);
}

function label(sections, state) {
  const b = sections[state.sectionIndex]?.blocks[state.blockIndex];
  return `S${state.sectionIndex + 1}B${state.blockIndex + 1} "${b?.seed || '?'}"`;
}

// ─── Action ──────────────────────────────────────────────────────────────────

async function injectBlock(block) {
  const res = await apiPost(`${ANIM}/api/orchestrator/custom-script`, {
    seed:        block.seed,
    exitContext: block.exitContext,
    script:      block.script
  });
  if (res.error) throw new Error(`custom-script: ${res.error}`);
  const renderRes = await apiPost(`${ANIM}/api/orchestrator/render/${res.id}`, {});
  if (renderRes.error) throw new Error(`render: ${renderRes.error}`);
  return res.id;
}

// ─── OpenAI timing judgment ──────────────────────────────────────────────────
// Guards have already passed. OpenAI decides: inject now or hold one cycle.

async function askDirector({ sections, state, dialogue }) {
  const section   = sections[state.sectionIndex];
  const block     = section?.blocks[state.blockIndex];
  const isLast    = state.blockIndex >= section.blocks.length - 1 && state.sectionIndex >= sections.length - 1;
  const nextSeed  = isLast ? '(end of script)' : (
    state.blockIndex < section.blocks.length - 1
      ? section.blocks[state.blockIndex + 1].seed
      : sections[state.sectionIndex + 1].blocks[0].seed
  );

  const recentLines = dialogue.slice(-12).map(l => `${l.speaker}: ${l.text}`).join('\n') || '(none)';

  const system = `You are the Director Agent for the $VVC token launch livestream. Chad and Virgin are live AI hosts.
The expand chain has wrapped up. Chat inbox is empty. No segments are rendering. You must decide: inject the next scripted block now, or hold one more cycle.

Return ONLY valid JSON: { "action": "inject_block" | "hold" | "done", "reason": "one sentence" }

- "inject_block": topic has wound down or the conversation is looping — advance the script
- "hold": the exchange just hit something genuinely interesting and should breathe for one more expand cycle
- "done": next_block is "(end of script)"`;

  const user = `Current block: "${block?.seed}"
Next block: "${nextSeed}"

Recent dialogue:
${recentLines}`;

  const res = await openai.chat.completions.create({
    model:           process.env.MODEL || 'gpt-4o-mini',
    messages:        [{ role: 'system', content: system }, { role: 'user', content: user }],
    response_format: { type: 'json_object' },
    temperature:     0.2,
    max_tokens:      100
  });

  return JSON.parse(res.choices[0].message.content);
}

// ─── Core evaluate ───────────────────────────────────────────────────────────

let evaluating = false;

async function evaluate(sections, state, segments, inbox) {
  if (evaluating) return;
  evaluating = true;

  try {
    const section = sections[state.sectionIndex];
    const block   = section?.blocks[state.blockIndex];

    if (!section || !block) {
      log('*** SCRIPT COMPLETE — all sections delivered ***');
      saveState(state);
      process.exit(0);
    }

    // ── Cold start ──
    if (!state.blockInjected) {
      if (pipelineHasActivity(segments)) {
        log(`Pipeline active — assuming ${label(sections, state)} already running, watching for wrapUp`);
        state.blockInjected = true;
        saveState(state);
      } else {
        log(`Cold start — injecting ${label(sections, state)}`);
        await injectBlock(block);
        state.blockInjected = true;
        saveState(state);
      }
      return;
    }

    // ── Wait for wrapUp ──
    const wrapUpSeg = findWrapUp(segments);
    if (!wrapUpSeg) return;
    if (state.lastWrapUpHandled === wrapUpSeg.id) return;

    log(`wrapUp detected (${wrapUpSeg.id.slice(0, 8)})`);

    // Hard guards — never reach OpenAI
    if (inbox.length > 0) {
      log(`  → ${inbox.length} chat message(s) pending — holding`);
      return;
    }
    if (hasNonExpandForming(segments)) {
      log(`  → non-expand segment already forming — holding`);
      return;
    }

    // Ask OpenAI for timing judgment
    const dialogue = readRecentDialogue(15);
    let decision;
    try {
      decision = await askDirector({ sections, state, dialogue });
    } catch (err) {
      log(`OpenAI error: ${err.message} — defaulting to inject_block`);
      decision = { action: 'inject_block', reason: 'OpenAI unavailable' };
    }

    log(`  Director: ${decision.action} — ${decision.reason}`);

    if (decision.action === 'hold') {
      // Don't mark as handled — re-evaluate on next wrapUp event
      return;
    }

    // Mark handled before any async action
    state.lastWrapUpHandled = wrapUpSeg.id;

    if (decision.action === 'done') {
      log('  → End of script.');
      saveState(state);
      process.exit(0);
    }

    // Advance cursor
    const isLastBlock   = state.blockIndex >= section.blocks.length - 1;
    const isLastSection = state.sectionIndex >= sections.length - 1;

    if (!isLastBlock) {
      state.blockIndex   += 1;
      state.blockInjected = false;
    } else if (!isLastSection) {
      state.sectionIndex += 1;
      state.blockIndex    = 0;
      state.blockInjected = false;
      log(`  *** Section complete — entering ${sections[state.sectionIndex].title} ***`);
    } else {
      log('  → Last block of last section — script delivered.');
      state.sectionIndex = sections.length;
      saveState(state);
      process.exit(0);
    }

    saveState(state);

    const nextBlock = sections[state.sectionIndex].blocks[state.blockIndex];
    log(`  → Injecting ${label(sections, state)}`);
    await injectBlock(nextBlock);
    state.blockInjected = true;
    saveState(state);

  } catch (err) {
    log(`Evaluate error: ${err.message}`);
  } finally {
    evaluating = false;
  }
}

// ─── WebSocket ───────────────────────────────────────────────────────────────

function connect(sections, state) {
  log(`Connecting to ${WS_URL}...`);
  const ws = new WebSocket(WS_URL);

  // Track inbox locally — pipeline:update does not carry inbox data
  let currentInbox = [];

  ws.addEventListener('open', () => {
    log('WebSocket connected.');
    apiGet(`${ANIM}/api/orchestrator/state`).then(data => {
      currentInbox = data.chatIntake?.inbox ?? [];
      evaluate(sections, state, data.pipeline.segments, currentInbox);
    }).catch(err => log(`Initial fetch failed: ${err.message}`));
  });

  ws.addEventListener('message', ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.event === 'chat:inbox-update') {
      currentInbox = msg.data?.inbox ?? [];
      return;
    }

    if (msg.event !== 'pipeline:update') return;

    evaluate(sections, state, msg.data?.segments ?? [], currentInbox);
  });

  ws.addEventListener('close', () => {
    log(`WebSocket closed. Reconnecting in ${RECONNECT_MS / 1000}s...`);
    setTimeout(() => connect(sections, state), RECONNECT_MS);
  });

  ws.addEventListener('error', err => {
    log(`WebSocket error: ${err.message || err}`);
  });
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes('--reset')) {
    try { fs.unlinkSync(STATE_PATH); } catch {}
    log('State reset.');
  }

  const md       = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const sections = parseScript(md);

  if (sections.length === 0) {
    console.error('[Director] No sections parsed. Check livestream-script.md format.');
    process.exit(1);
  }

  const totalBlocks = sections.reduce((n, s) => n + s.blocks.length, 0);
  log(`Script loaded: ${sections.length} sections, ${totalBlocks} blocks`);
  sections.forEach((s, i) => log(`  Section ${i + 1}: ${s.title} (${s.blocks.length} blocks)`));

  const state = loadState();
  log(`Cursor: S${state.sectionIndex + 1} B${state.blockIndex + 1}, injected=${state.blockInjected}`);
  log('Listening for pipeline events. Ctrl+C to stop.\n');

  connect(sections, state);
}

main().catch(err => {
  console.error('[Director] Fatal:', err.message);
  process.exit(1);
});
