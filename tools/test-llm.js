#!/usr/bin/env node
/**
 * test-llm.js — Standalone LLM generation tester
 *
 * Tests all conversation generation modes with OpenAI only.
 * No ElevenLabs, no animation server, no pipeline overhead.
 *
 * Usage:
 *   node tools/test-llm.js director "Chad roasts Virgin about bonding curves"
 *   node tools/test-llm.js auto "They debate whether fasting is based" --turns 4
 *   node tools/test-llm.js chat "Hey Chad, do you even lift?" --voice chad
 *   node tools/test-llm.js expand
 *   node tools/test-llm.js expand --wrapup
 *
 * Modes:
 *   director  — ScriptGenerator._generateScript (1 turn, director note seed)
 *   auto      — server.js generateAutoScript (multi-turn, intent blueprint pipeline)
 *   chat      — server.js /api/chat LLM call (single character response to viewer message)
 *   expand    — ScriptGenerator.expandConversation (continues a mock conversation by 1 line)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const OpenAI = require('openai');
const voices = require('../voices');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

if (!process.env.OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY not set in .env');
  process.exit(1);
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

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

function parseJsonArray(content) {
  const clean = String(content).replace(/```json|```/gi, '').trim();
  try { return JSON.parse(clean); } catch (e) {}
  const start = clean.indexOf('[');
  const end = clean.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch (e) {}
  }
  return null;
}

function estimateDurationSeconds(lines) {
  let totalWords = 0;
  for (const line of lines || []) {
    const text = String(line.text || '').trim();
    totalWords += text.split(/\s+/).filter(Boolean).length;
  }
  return Math.max(1, Math.round((totalWords / 150) * 60));
}

function printScript(script) {
  for (const line of script) {
    const speaker = (line.speaker || '').toUpperCase().padEnd(7);
    console.log(`  ${speaker}  ${line.text}`);
  }
}

function header(title) {
  const bar = '─'.repeat(60);
  console.log(`\n${bar}`);
  console.log(`  ${title}`);
  console.log(bar);
}

// ─── Mode: director ──────────────────────────────────────────────────────────
// Mirrors ScriptGenerator._generateScript

async function modeDirector(seed, model) {
  header(`MODE: director  |  model: ${model}`);
  console.log(`  seed: "${seed}"\n`);

  const systemPrompt = `You are a show director for a livestream featuring Chad and Virgin (from the Virgin vs Chad meme).
Generate a dialogue script based on the producer's note.

CHARACTER PROFILES:
CHAD: ${voices.chad.basePrompt}
VIRGIN: ${voices.virgin.basePrompt}

OUTPUT FORMAT:
Return ONLY valid JSON:
{
  "script": [
    { "speaker": "chad", "text": "..." },
    { "speaker": "virgin", "text": "..." }
  ],
  "exitContext": "Brief summary of what was discussed"
}

Rules:
- Generate exactly 1 dialogue turn (line) total
- Natural conversational flow (not rigid alternation)
- Chad can interrupt, Virgin can trail off
- One character can have multiple consecutive lines
- 1-3 sentences per line
- No emojis, no markdown in dialogue text
- Audio tags: [laughs], [chuckles], [sighs], [nervous laugh], [clears throat], etc.
- CRITICAL: Chad must NEVER give advice, encouragement, or act like a life coach. He ROASTS, brags, or dismisses — never helps.
- CRITICAL: Virgin must NEVER agree with Chad or accept his frame. He gets defensive, counters with niche facts, or changes the subject.
- The exitContext must be a brief TOPIC SUMMARY, NOT a transcript`;

  const t0 = Date.now();
  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Director note: ${seed}` }
    ],
    temperature: 0.7
  });
  const elapsed = Date.now() - t0;

  const raw = completion.choices?.[0]?.message?.content || '';
  const parsed = parseJson(raw);

  if (!parsed || !Array.isArray(parsed.script)) {
    console.log('  [PARSE FAILED] Raw response:');
    console.log(raw);
    return;
  }

  printScript(parsed.script);
  console.log(`\n  exitContext: "${parsed.exitContext || '(none)'}"`);
  const est = estimateDurationSeconds(parsed.script);
  console.log(`  estimatedDuration: ~${est}s`);
  console.log(`  tokens: ${completion.usage?.total_tokens ?? '?'}  |  latency: ${elapsed}ms`);
}

// ─── Mode: auto ──────────────────────────────────────────────────────────────
// Mirrors server.js deriveAutoIntent + generateAutoScript + validateAutoScript

async function modeAuto(seed, turns, model) {
  header(`MODE: auto  |  model: ${model}  |  turns: ${turns}`);
  console.log(`  seed: "${seed}"\n`);

  // Step 1: derive intent
  console.log('  [1/3] Deriving intent blueprint...');
  const intentPrompt = `Extract an intent blueprint for a scripted dialogue.
Return JSON only with:
{
  "scenario": "<1 sentence>",
  "dynamics": "<1-2 sentences describing who leads/targets/frames the exchange>",
  "tone": "<short description>",
  "constraints": ["<short, non-negotiable rules>"]
}
Make constraints strong enough to prevent drift. Do not mention "Chad" or "Virgin" in constraints unless the seed requires it.`;

  const t0 = Date.now();
  const intentCompletion = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: intentPrompt },
      { role: 'user', content: seed }
    ],
    max_tokens: 200,
    temperature: 0
  });
  const intent = parseJson(intentCompletion.choices[0].message.content.trim()) || {
    scenario: seed.slice(0, 160),
    dynamics: 'Follow the seed exactly.',
    tone: 'As implied by the seed.',
    constraints: ['Do not deviate from the seed intent.']
  };
  console.log('  intent:', JSON.stringify(intent, null, 4).replace(/^/gm, '  '));

  // Step 2: generate script
  console.log('\n  [2/3] Generating script...');
  const scriptSystemPrompt = `You are writing a scripted dialogue between Chad and Virgin from the Virgin vs Chad meme.
The seed's intent is the blueprint. Do not deviate from it at any point.
Respect archetypes, but never override the intent.
Alternate speakers each turn, starting with Chad.
Write exactly ${turns} turns.
Each line should be 1-3 sentences, no emojis, no markdown.
Output JSON only as an array of objects like:
[
  {"speaker":"chad","text":"..."},
  {"speaker":"virgin","text":"..."}
]
INTENT BLUEPRINT (must be followed exactly):
${JSON.stringify(intent)}

CHARACTER PROFILES:
CHAD:
${voices.chad.basePrompt.trim()}

VIRGIN:
${voices.virgin.basePrompt.trim()}`;

  const scriptCompletion = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: scriptSystemPrompt },
      { role: 'user', content: seed }
    ],
    max_tokens: 200 * turns,
    temperature: 0.7
  });
  const scriptRaw = scriptCompletion.choices[0].message.content.trim();
  let script = parseJsonArray(scriptRaw);
  if (!Array.isArray(script)) {
    console.log('  [PARSE FAILED] Raw response:', scriptRaw);
    return;
  }

  // Step 3: validate
  console.log('\n  [3/3] Validating...');
  const validatePrompt = `You are a strict validator. Check if the dialogue follows the intent blueprint.
If it fully complies, reply with: {"ok":true}
If not, reply with: {"ok":false,"issues":["..."],"fix":"<short instruction to rewrite>"}
Be concise and strict.`;

  const validateCompletion = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: validatePrompt },
      { role: 'user', content: JSON.stringify({ intent, script }) }
    ],
    max_tokens: 120,
    temperature: 0
  });
  const verdict = parseJson(validateCompletion.choices[0].message.content.trim());
  const elapsed = Date.now() - t0;

  if (verdict && verdict.ok === false) {
    console.log(`  Validation failed: ${(verdict.issues || []).join('; ')}`);
    console.log(`  Fix instruction: ${verdict.fix}`);
    console.log('  Rewriting...\n');

    const rewriteCompletion = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'Rewrite this dialogue to strictly follow the intent blueprint.\nKeep the number of turns and speakers, but fix any drift.\nOutput JSON only as an array of objects with speaker/text.' },
        { role: 'user', content: JSON.stringify({ intent, fix: verdict.fix, script }) }
      ],
      max_tokens: 1200,
      temperature: 0.5
    });
    const rewritten = parseJsonArray(rewriteCompletion.choices[0].message.content.trim());
    if (Array.isArray(rewritten)) script = rewritten;
  } else {
    console.log('  Validation: OK');
  }

  console.log('');
  printScript(script);
  const est = estimateDurationSeconds(script);
  console.log(`\n  estimatedDuration: ~${est}s`);
  console.log(`  latency: ${elapsed}ms`);
}

// ─── Mode: chat ───────────────────────────────────────────────────────────────
// Mirrors server.js /api/chat LLM call + buildCharacterSystemPrompt

async function modeChat(message, voiceId, model) {
  header(`MODE: chat  |  voice: ${voiceId}  |  model: ${model}`);
  console.log(`  message: "${message}"\n`);

  const voiceConfig = voices[voiceId];
  if (!voiceConfig) {
    console.error(`  ERROR: unknown voice "${voiceId}". Use "chad" or "virgin".`);
    return;
  }

  const freshnessGuard = `\n\nSTYLE GUARDRAILS:\nNEVER use the "I accidentally did X and it turned into Y success" formula. No accidental success stories.\nChad: NEVER give advice or encouragement. No "just wing it", "fake it till you make it", "you gotta", "try X sometime", "you do you", "no worries". You ROAST, brag, or dismiss — never help.\nVirgin: NEVER just be generically sad or agree with Chad. No "I guess", "easier said than done", "if only". Always have a SPECIFIC detail. Get defensive about your hobbies or change the subject.\nKeep each response fresh, punchy, and aligned to the user's intent.`;

  // Use v3 audio tags for richer output in test
  const systemPrompt = voiceConfig.basePrompt + voiceConfig.audioTags + freshnessGuard;

  const t0 = Date.now();
  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message }
    ],
    max_tokens: 150,
    temperature: 0.7
  });
  const elapsed = Date.now() - t0;

  const reply = completion.choices[0].message.content;
  console.log(`  ${voiceId.toUpperCase()}: ${reply}`);
  console.log(`\n  tokens: ${completion.usage?.total_tokens ?? '?'}  |  latency: ${elapsed}ms`);
}

// ─── Mode: expand ─────────────────────────────────────────────────────────────
// Mirrors ScriptGenerator.expandConversation

const MOCK_HISTORY = [
  { speaker: 'chad', text: "Honestly I put twenty bucks in $VVC just to see what happens. Already up three x." },
  { speaker: 'virgin', text: "That's statistically meaningless. You need to look at the bonding curve velocity relative to wallet concentration, otherwise you're just noise-trading." },
  { speaker: 'chad', text: "[chuckles] Noise-trading with a three x return." },
  { speaker: 'virgin', text: "Unrealized. You haven't sold. There's a difference between paper gains and — you know what, forget it." },
];

async function modeExpand(isFirstExpand, wrapUp, model) {
  header(`MODE: expand  |  isFirstExpand: ${isFirstExpand}  |  wrapUp: ${wrapUp}  |  model: ${model}`);
  console.log('  Using mock conversation history:');
  printScript(MOCK_HISTORY);
  console.log('');

  let jsonFormat = '{ "script": [ { "speaker": "chad|virgin", "text": "..." } ], "exitContext": "brief topic summary"';
  if (isFirstExpand) jsonFormat += ', "maxExpands": <number>';
  jsonFormat += ' }';

  let maxExpandsClause = '';
  if (isFirstExpand) {
    maxExpandsClause = '\n\n"maxExpands" — how many total follow-up lines this topic deserves (0-5). Most conversations should be SHORT. Greetings like "hi", "what\'s up", "hey guys" = 0. Simple questions or generic comments = 0-1. A topic with mild debate potential = 2. A genuinely heated argument or deep lore discussion = 3-5. Default to 0 or 1 unless the topic is truly compelling. Silence is fine — don\'t force conversation.';
  }

  let wrapUpClause = '';
  if (wrapUp) {
    wrapUpClause = '\n\nIMPORTANT: This is the FINAL line on this topic. Wrap up naturally — make a closing remark, a dismissive sign-off, or a natural conversation-ender. Do NOT open new threads or ask questions.';
  }

  const messages = [
    { role: 'system', content: `Livestream conversation between Chad and Virgin. Continue naturally.\n\nCHAD: ${voices.chad.basePrompt}\nVIRGIN: ${voices.virgin.basePrompt}\n\nCRITICAL RULES:\n- Chad must NEVER give advice, encouragement, or life coaching. No "just be yourself", "fake it till you make it", "just wing it", "you gotta", "try X sometime". Instead Chad ROASTS Virgin, brags about himself, or dismisses what Virgin said entirely.\n- Chad must NEVER say "no worries", "you'll get there", "everyone starts somewhere", "you do you", "if that's your thing", or offer comfort/reassurance of any kind.\n- Virgin must NEVER just agree with Chad or accept his frame. No "I guess", "I guess you're right", "easier said than done", "if only". Instead Virgin gets DEFENSIVE about his niche interests, fires back with an obscure fact, or changes the subject to something he knows about.\n- Do NOT repeat the dynamic of Chad giving advice and Virgin accepting it. Instead: argue, roast, one-up, tangent, or disagree.\n- Each continuation must introduce a NEW detail, opinion, or mini-topic — never just rephrase what was already said.\n\nRespond with ONLY JSON: ${jsonFormat}\nExactly 1 line. No emojis, no markdown. Audio tags allowed: [laughs], [chuckles], [sighs], [nervous laugh], etc.${maxExpandsClause}${wrapUpClause}` }
  ];

  for (const line of MOCK_HISTORY) {
    messages.push({ role: 'assistant', content: `${line.speaker}: ${line.text}` });
  }
  messages.push({ role: 'user', content: wrapUp ? 'Wrap it up.' : 'Continue.' });

  const t0 = Date.now();
  let completion = await openai.chat.completions.create({
    model,
    messages,
    temperature: 0.8,
    max_tokens: 250
  });
  let raw = completion.choices?.[0]?.message?.content || '';
  let parsed = parseJson(raw);

  if (!parsed || !Array.isArray(parsed.script)) {
    console.log('  [First attempt failed, retrying with simpler prompt...]');
    const historyText = MOCK_HISTORY.map(l => `${l.speaker}: ${l.text}`).join('\n');
    const retry = [
      { role: 'system', content: `Continue this conversation with exactly 1 line. Return ONLY valid JSON:\n{\n  "script": [\n    { "speaker": "chad|virgin", "text": "..." }\n  ]\n}\nNo markdown, no code blocks — ONLY the JSON object.${wrapUp ? ' This is the FINAL line — wrap up the topic naturally.' : ''}` },
      { role: 'user', content: `Recent conversation:\n${historyText}\n\nContinue naturally:` }
    ];
    completion = await openai.chat.completions.create({
      model,
      messages: retry,
      temperature: 0.7,
      max_tokens: 250
    });
    raw = completion.choices?.[0]?.message?.content || '';
    parsed = parseJson(raw);
  }

  const elapsed = Date.now() - t0;

  if (!parsed || !Array.isArray(parsed.script)) {
    console.log('  [PARSE FAILED] Raw response:');
    console.log(raw);
    return;
  }

  console.log('  Next line:');
  printScript(parsed.script);
  if (parsed.exitContext) console.log(`\n  exitContext: "${parsed.exitContext}"`);
  if (isFirstExpand && typeof parsed.maxExpands === 'number') {
    console.log(`  maxExpands: ${parsed.maxExpands}`);
  }
  console.log(`  tokens: ${completion.usage?.total_tokens ?? '?'}  |  latency: ${elapsed}ms`);
}

// ─── CLI entrypoint ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const mode = args[0];
  const flags = {};
  const positional = [];

  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
      flags[key] = val;
    } else {
      positional.push(args[i]);
    }
  }

  return { mode, positional, flags };
}

function printHelp() {
  console.log(`
test-llm.js — Test LLM generation without ElevenLabs

Usage:
  node tools/test-llm.js <mode> [seed] [options]

Modes:
  director "<seed>"           Single-turn director note → 1 dialogue line
  auto "<seed>" [--turns N]   Multi-turn auto conversation (intent → script → validate)
  chat "<message>" [--voice chad|virgin]  Single character replies to a viewer message
  expand [--first] [--wrapup] Continue a mock conversation by 1 line

Options:
  --model <model>   OpenAI model (default: gpt-4o-mini)
  --turns <n>       Number of turns for auto mode (default: 4)
  --voice <id>      chad or virgin for chat mode (default: chad)
  --first           Mark as first expand (requests maxExpands from LLM)
  --wrapup          Tell LLM to wrap up the conversation

Examples:
  node tools/test-llm.js director "Virgin tries to explain market cap"
  node tools/test-llm.js auto "They debate whether fasting is based" --turns 3
  node tools/test-llm.js chat "Hey chad, are you actually rich?" --voice chad
  node tools/test-llm.js expand --first
  node tools/test-llm.js expand --wrapup
`);
}

async function main() {
  const { mode, positional, flags } = parseArgs(process.argv);
  const model = flags.model || process.env.SCRIPT_MODEL || 'gpt-4o-mini';

  if (!mode || mode === '--help' || mode === '-h') {
    printHelp();
    return;
  }

  try {
    if (mode === 'director') {
      const seed = positional[0];
      if (!seed) { console.error('director mode requires a seed argument'); process.exit(1); }
      await modeDirector(seed, model);

    } else if (mode === 'auto') {
      const seed = positional[0];
      if (!seed) { console.error('auto mode requires a seed argument'); process.exit(1); }
      const turns = Math.max(1, Math.min(30, parseInt(flags.turns || '4', 10)));
      await modeAuto(seed, turns, model);

    } else if (mode === 'chat') {
      const message = positional[0];
      if (!message) { console.error('chat mode requires a message argument'); process.exit(1); }
      const voice = flags.voice || 'chad';
      await modeChat(message, voice, model);

    } else if (mode === 'expand') {
      const isFirstExpand = !!flags.first;
      const wrapUp = !!(flags.wrapup || flags['wrap-up']);
      await modeExpand(isFirstExpand, wrapUp, model);

    } else {
      console.error(`Unknown mode: "${mode}"`);
      printHelp();
      process.exit(1);
    }
  } catch (err) {
    console.error('\nERROR:', err.message);
    if (err.status) console.error('HTTP status:', err.status);
    process.exit(1);
  }

  console.log('');
}

main();
