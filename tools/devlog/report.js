#!/usr/bin/env node
/**
 * tools/devlog/report.js
 *
 * VVC devlog: posts code-progress reports to a Telegram chat.
 *
 * PRIVACY MODEL — only code leaves this machine:
 *   - The only things read from Claude Code transcripts are successful file edits (Edit/Write
 *     results) whose path is inside DEVLOG_SCOPE (default: the folder containing LiveStream,
 *     i.e. Dev\vvc). Prompts, assistant replies, session titles and shell commands are never
 *     read, summarized or sent.
 *   - Sessions that edit nothing inside the scope produce no messages at all.
 *   - "Why" is inferred by Gemini from the diffs alone (comments, names, behaviour), plus
 *     commit messages for commits.
 *   - Secrets (all KEY/TOKEN/SECRET values from .env plus common key formats) are redacted
 *     before anything is sent to Gemini or Telegram.
 *
 * Usage:
 *   node tools/devlog/report.js hook      # Claude Code hook: PostToolUse (edits) / Stop / SessionEnd
 *   node tools/devlog/report.js commit    # report latest commit of the repo in cwd (post-commit hook)
 *   node tools/devlog/report.js now       # report any unreported VVC edits from the last 24h
 *   node tools/devlog/report.js chat-id   # list chats that messaged the bot (setup helper)
 *   node tools/devlog/report.js test      # send a test message
 *   node tools/devlog/report.js send [f]  # send a Telegram-HTML message from file or stdin (used by /vvc-devlog skill)
 *
 * Env (LiveStream/.env): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, GEMINI_API_KEY
 *   DEVLOG_SCOPE=<dir>          # only edits inside this folder are reported (default: ..\ of LiveStream)
 *   DEVLOG_IDLE_MINUTES=15      # post the full summary after this long with no VVC edits
 *   DEVLOG_DRY=1                # print instead of sending (testing)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const SCOPE = path.resolve(process.env.DEVLOG_SCOPE || path.join(ROOT, '..'));
const STATE_DIR = path.join(ROOT, '.devlog');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOG_FILE = path.join(STATE_DIR, 'devlog.log');
const LOCK_DIR = path.join(STATE_DIR, 'lock');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

const IDLE_MS = (parseFloat(process.env.DEVLOG_IDLE_MINUTES) || 15) * 60 * 1000;
const LIVE_DEBOUNCE_MS = 8000;
const TG_LIMIT = 4000;
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

// ---------- utils ----------

function log(...args) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${args.join(' ')}\n`);
  } catch {}
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { sessions: {} }; }
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Hook workers run as separate detached processes; serialize state + Telegram writes.
async function withLock(fn) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  for (let i = 0; i < 100; i++) {
    try { fs.mkdirSync(LOCK_DIR); break; } catch {
      try { if (Date.now() - fs.statSync(LOCK_DIR).mtimeMs > 30000) fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try { return await fn(); } finally { try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch {} }
}

function getSession(id) {
  return loadState().sessions[id] || { reportedLines: 0 };
}

function updateSession(id, patch) {
  const state = loadState();
  state.sessions[id] = { ...(state.sessions[id] || { reportedLines: 0 }), ...patch };
  saveState(state);
  return state.sessions[id];
}

function git(cmd, cwd = ROOT) {
  try { return execSync(`git ${cmd}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function inScope(file) {
  if (!file) return false;
  const rel = path.relative(SCOPE.toLowerCase(), path.resolve(file).toLowerCase());
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function scopeRel(file) {
  return path.relative(SCOPE, path.resolve(file)).replace(/\\/g, '/');
}

function clock(ts) {
  return new Date(ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(a, b) {
  if (!a || !b) return '';
  const mins = Math.round((new Date(b) - new Date(a)) / 60000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// Strip secrets before anything leaves this machine.
const ENV_SECRETS = Object.entries(process.env)
  .filter(([k, v]) => /KEY|TOKEN|SECRET|PASS|COOKIE/i.test(k) && v && v.length >= 8)
  .map(([, v]) => v);

function redact(text) {
  let out = String(text);
  for (const secret of ENV_SECRETS) out = out.split(secret).join('[REDACTED]');
  return out
    .replace(/\b(sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{30,}/g, '[REDACTED]')
    .replace(/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED]') // telegram bot tokens
    .replace(/\b([A-Z][A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASS))\s*[=:]\s*['"]?[^\s'"]+/g, '$1=[REDACTED]')
    // long random-looking tokens (must contain a digit and an uppercase letter, so paths/words survive)
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{32,}\b/g, '[REDACTED]');
}

// ---------- telegram ----------

async function telegram(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set in .env');
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const payload = JSON.stringify(body || {});
  let json;
  try {
    // Hard timeout: a stalled connection must never hang the caller (e.g. a Claude session).
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(15000),
    });
    json = await res.json();
  } catch (e) {
    // Node fetch ignores HTTP(S)_PROXY and can stall in restricted shells; curl handles both.
    log(`fetch ${method} failed (${e.cause?.code || e.name}), retrying with curl`);
    const out = require('child_process').execFileSync(
      'curl', ['-s', '--max-time', '15', '-H', 'Content-Type: application/json', '--data-binary', '@-', url],
      { input: payload, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
    );
    json = JSON.parse(out);
  }
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
  return json.result;
}

async function sendTelegram(html, extra = {}) {
  if (process.env.DEVLOG_DRY === '1') {
    console.log(truncate(redact(html), TG_LIMIT));
    return { message_id: 0 };
  }
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID not set in .env');
  return telegram('sendMessage', {
    chat_id: chatId,
    text: truncate(redact(html), TG_LIMIT),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

async function editTelegram(messageId, html) {
  if (process.env.DEVLOG_DRY === '1') {
    console.log(`[edit ${messageId}]\n${truncate(redact(html), TG_LIMIT)}`);
    return;
  }
  try {
    await telegram('editMessageText', {
      chat_id: process.env.TELEGRAM_CHAT_ID,
      message_id: messageId,
      text: truncate(redact(html), TG_LIMIT),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (e) {
    if (!/not modified/i.test(e.message)) throw e;
  }
}

// ---------- transcript: successful in-scope edits only ----------

// Builds a compact diff from Claude Code's recorded tool result. Nothing else in the transcript is read.
function diffFromResult(r) {
  if (Array.isArray(r.structuredPatch) && r.structuredPatch.length) {
    return r.structuredPatch
      .map((h) => `@@ line ${h.newStart} @@\n` + (h.lines || []).filter((l) => /^[+-]/.test(l)).join('\n'))
      .join('\n');
  }
  if (r.type === 'create' && typeof r.content === 'string') {
    const lines = r.content.split('\n');
    return `(new file, ${lines.length} lines)\n` + lines.slice(0, 60).map((l) => '+' + l).join('\n');
  }
  if (typeof r.content === 'string') return `(file rewritten)\n` + r.content.split('\n').slice(0, 40).map((l) => '+' + l).join('\n');
  return '(edited)';
}

function readEdits(file, fromLine) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const edits = [];
  for (let i = fromLine; i < lines.length; i++) {
    if (!lines[i].includes('"toolUseResult"')) continue;
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    const r = o.toolUseResult;
    const fp = r && typeof r === 'object' && (r.filePath || r.notebook_path);
    if (!fp || !inScope(fp)) continue;
    edits.push({ file: scopeRel(fp), ts: o.timestamp, diff: truncate(diffFromResult(r), 3000) });
  }
  return {
    totalLines: lines.length,
    edits,
    files: [...new Set(edits.map((e) => e.file))],
    firstTs: edits[0]?.ts,
    lastTs: edits[edits.length - 1]?.ts,
  };
}

// Group edited files by their top-level VVC project folder (LiveStream, soul, MemeFactory...).
function projectsOf(files) {
  return [...new Set(files.map((f) => f.split('/')[0]))];
}

function repoStats(files) {
  const out = [];
  for (const proj of projectsOf(files)) {
    const dir = path.join(SCOPE, proj);
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    const dirty = git('status --porcelain', dir).split('\n').filter(Boolean).length;
    out.push({ proj, branch: git('rev-parse --abbrev-ref HEAD', dir), dirty });
  }
  return out;
}

// ---------- gemini ----------

function gemini() {
  const GeminiClient = require(path.join(ROOT, 'gemini-client'));
  return new GeminiClient({ apiKey: process.env.GEMINI_API_KEY });
}

const PROJECT_CONTEXT =
  'Project: VVC (Virgin vs Chad) — an animated Chad vs Virgin livestream and related tools ' +
  '(Node.js chat API, animation server, HLS streaming, TTS, meme generation).';

function diffMaterial(edits, budget) {
  const byFile = new Map();
  for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) || []), e.diff]);
  let out = '';
  for (const [file, diffs] of byFile) {
    const chunk = `=== ${file} (${diffs.length} edit${diffs.length > 1 ? 's' : ''})\n${diffs.join('\n')}\n\n`;
    if (out.length + chunk.length > budget) { out += `=== ${file} (${diffs.length} edits, diff omitted for length)\n`; continue; }
    out += chunk;
  }
  return redact(out);
}

async function summarize(edits) {
  const res = await gemini().chat.completions.create({
    model: process.env.DEVLOG_MODEL || 'gemini-2.5-flash',
    temperature: 0.2,
    max_tokens: 800,
    messages: [
      {
        role: 'system',
        content:
          `You write factual code-change reports for a project lead. ${PROJECT_CONTEXT} ` +
          'You are given ONLY code diffs. Describe what changed and why, inferring the purpose strictly from the code ' +
          '(comments, names, behaviour). Do not invent context, results or testing that the diff does not show; if the purpose ' +
          'is unclear, say "purpose not evident from the code". No praise. Never reproduce secrets, keys or credentials. ' +
          'Output plain text, max ~150 words, exactly these two sections with "- " bullets:\n' +
          'What changed & why:\nLoose ends:\n' +
          '(Loose ends = TODOs, debug logging, commented-out code, half-finished work visible in the diff; "- none visible" if none.)',
      },
      { role: 'user', content: diffMaterial(edits, 20000) },
    ],
  });
  return (res.choices?.[0]?.message?.content || '').trim();
}

async function describeNow(edits) {
  try {
    const res = await gemini().chat.completions.create({
      model: process.env.DEVLOG_MODEL || 'gemini-2.5-flash',
      temperature: 0,
      max_tokens: 60,
      messages: [
        {
          role: 'system',
          content:
            `${PROJECT_CONTEXT} From these code diffs (oldest first), write what the developer is working on right now, based on the LAST diff ` +
            'as one short neutral line (max 12 words, no quotes, no secrets). Example: "Adding retry backoff to TTS calls in segment renderer".',
        },
        { role: 'user', content: diffMaterial(edits.slice(-2), 6000) },
      ],
    });
    return truncate((res.choices?.[0]?.message?.content || '').trim().split('\n')[0], 160);
  } catch (e) {
    log(`describeNow failed: ${e.message}`);
    return '';
  }
}

// ---------- live status message ----------

function renderLive(s, activity, status) {
  const icon = { working: '🟢', paused: '🟡', idle: '⚪' }[status];
  const label = { working: 'Editing code', paused: 'Paused', idle: 'Idle — summary below' }[status];
  const parts = [
    `${icon} <b>LIVE · VVC dev</b> — ${escapeHtml(projectsOf(activity.files).join(', '))}`,
    `<b>Now:</b> ${escapeHtml(s.now || 'Editing ' + (activity.files[activity.files.length - 1] || 'code'))}`,
    `<b>Status:</b> ${label}`,
    `<i>Started ${clock(s.blockStart)} · ${formatDuration(s.blockStart, Date.now()) || '0m'} · ${activity.edits.length} edits · ${activity.files.length} files · updated ${clock()}</i>`,
  ];
  if (s.history && s.history.length > 1) {
    parts.push('', '<b>Earlier:</b>', ...s.history.slice(0, -1).slice(-5).map((t) => `• ${escapeHtml(t)}`));
  }
  parts.push('', `<b>Files:</b> <code>${escapeHtml(truncate(activity.files.join(', '), 600))}</code>`);
  return parts.join('\n');
}

async function liveUpdate(sessionId, phase, token) {
  if (phase === 'working') {
    await new Promise((r) => setTimeout(r, LIVE_DEBOUNCE_MS));
    if (String(getSession(sessionId).liveToken) !== token) return; // a newer edit will update instead
  }
  let s = getSession(sessionId);
  if (!s.transcriptPath || !fs.existsSync(s.transcriptPath)) return;
  const activity = readEdits(s.transcriptPath, s.reportedLines);
  if (!activity.edits.length) return; // nothing VVC-related in this block: say nothing

  const now = phase === 'working' ? await describeNow(activity.edits) : '';

  await withLock(async () => {
    s = getSession(sessionId);
    const patch = {};
    if (now && now !== s.now) {
      patch.now = now;
      patch.history = [...(s.history || []), now].slice(-10);
    }
    if (!s.liveMessageId) patch.blockStart = Date.parse(activity.firstTs) || Date.now();
    const html = renderLive({ ...s, ...patch }, activity, phase);
    if (s.liveMessageId) {
      await editTelegram(s.liveMessageId, html);
    } else {
      patch.liveMessageId = (await sendTelegram(html)).message_id;
    }
    updateSession(sessionId, patch);
  });
}

// ---------- block summary ----------

async function reportSession(sessionId, transcriptPath) {
  const s = getSession(sessionId);
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return;
  const activity = readEdits(transcriptPath, s.reportedLines);

  if (!activity.edits.length) {
    await withLock(() => updateSession(sessionId, { reportedLines: activity.totalLines, transcriptPath, reportedAt: Date.now() }));
    return;
  }

  let summary;
  try {
    summary = await summarize(activity.edits);
  } catch (e) {
    log(`summarize failed: ${e.message}`);
    summary = '(AI summary unavailable)';
  }

  const repos = repoStats(activity.files)
    .map((r) => `${escapeHtml(r.proj)} (${escapeHtml(r.branch)}, ${r.dirty} uncommitted)`)
    .join(' · ');
  const parts = [
    `🛠 <b>VVC code update</b> — ${escapeHtml(projectsOf(activity.files).join(', '))}`,
    `<i>${clock(activity.firstTs)}–${clock(activity.lastTs)} · ${activity.edits.length} edits · ${activity.files.length} files${repos ? ' · ' + repos : ''}</i>`,
    '',
    escapeHtml(summary),
    '',
    `<b>Files:</b> <code>${escapeHtml(truncate(activity.files.join(', '), 600))}</code>`,
  ];

  await withLock(async () => {
    const cur = getSession(sessionId);
    if (cur.liveMessageId) {
      await editTelegram(cur.liveMessageId, renderLive(cur, activity, 'idle')).catch((e) => log(`live close failed: ${e.message}`));
    }
    await sendTelegram(parts.join('\n'), cur.liveMessageId ? { reply_to_message_id: cur.liveMessageId } : {});
    // Next edit starts a fresh live message.
    updateSession(sessionId, {
      reportedLines: activity.totalLines, transcriptPath, reportedAt: Date.now(),
      liveMessageId: undefined, blockStart: undefined, now: undefined, history: [], idleToken: undefined, liveToken: undefined,
    });
  });
  log(`reported ${sessionId.slice(0, 8)} (${activity.edits.length} edits)`);
}

async function idleWorker(sessionId, token) {
  await new Promise((r) => setTimeout(r, IDLE_MS));
  const s = getSession(sessionId);
  if (String(s.idleToken) !== token) return; // newer activity took over
  await reportSession(sessionId, s.transcriptPath);
}

// ---------- hook entry ----------

function spawnSelf(...args) {
  spawn(process.execPath, [__filename, ...args], { detached: true, stdio: 'ignore', windowsHide: true, cwd: ROOT }).unref();
}

async function hook() {
  const input = await new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
  const evt = JSON.parse(input || '{}');
  const id = evt.session_id;
  if (!id || !evt.transcript_path) return;
  const known = !!loadState().sessions[id];
  const token = String(Date.now());

  // Everything slow runs detached so Claude Code is never held up.
  if (evt.hook_event_name === 'PostToolUse') {
    const ti = evt.tool_input || {};
    if (!EDIT_TOOLS.includes(evt.tool_name) || !inScope(ti.file_path || ti.notebook_path)) return; // not VVC: ignore entirely
    await withLock(() => updateSession(id, { transcriptPath: evt.transcript_path, liveToken: token, idleToken: token }));
    spawnSelf('live', id, 'working', token);
    spawnSelf('idle-worker', id, token);
  } else if (!known) {
    return; // session never touched VVC code
  } else if (evt.hook_event_name === 'Stop') {
    if (getSession(id).liveMessageId) spawnSelf('live', id, 'paused', token);
  } else if (evt.hook_event_name === 'SessionEnd') {
    spawnSelf('session-now', id);
  }
}

// ---------- manual catch-up ----------

async function reportAllNow() {
  const state = loadState();
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const dir of fs.readdirSync(PROJECTS_DIR)) {
    const full = path.join(PROJECTS_DIR, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(full, f);
      const mtime = fs.statSync(file).mtimeMs;
      const prev = state.sessions[path.basename(f, '.jsonl')];
      if (mtime < cutoff || (prev && prev.reportedAt && mtime <= prev.reportedAt)) continue;
      await reportSession(path.basename(f, '.jsonl'), file);
    }
  }
}

// ---------- commits ----------

async function reportCommit() {
  const cwd = process.cwd();
  const top = git('rev-parse --show-toplevel', cwd);
  if (!top || !inScope(top)) return;
  const subject = git('log -1 --format=%s', cwd);
  const body = git('log -1 --format=%b', cwd).replace(/Co-Authored-By:.*$/gim, '').trim();
  const hash = git('log -1 --format=%h', cwd);
  const branch = git('rev-parse --abbrev-ref HEAD', cwd);
  const stat = git('show --stat --format= HEAD', cwd).split('\n');
  const totals = stat.pop() || '';
  const files = stat.map((l) => l.trim()).filter(Boolean).slice(0, 15);

  const parts = [
    `📦 <b>Commit</b> · ${escapeHtml(path.basename(top))} <code>${escapeHtml(hash)}</code> on <i>${escapeHtml(branch)}</i>`,
    `<b>${escapeHtml(subject)}</b>`,
  ];
  if (body) parts.push(escapeHtml(truncate(body, 800)));
  parts.push('', `<code>${escapeHtml(files.join('\n'))}</code>`, `<i>${escapeHtml(totals.trim())}</i>`);
  await sendTelegram(parts.join('\n'));
  log(`commit ${path.basename(top)} ${hash} reported`);
}

// ---------- setup helpers ----------

async function printChatIds() {
  const updates = await telegram('getUpdates', {});
  const chats = new Map();
  for (const u of updates) {
    const chat = (u.message || u.channel_post || u.my_chat_member || {}).chat;
    if (chat) chats.set(chat.id, chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username);
  }
  if (!chats.size) {
    console.log('No messages yet. Add the bot to a group and send a message (or press Start in a DM), then rerun.');
    return;
  }
  for (const [id, name] of chats) console.log(`${id}\t${name}`);
  console.log('\nPut the right one in .env as TELEGRAM_CHAT_ID=<id>');
}

// ---------- main ----------

(async () => {
  const [mode, ...args] = process.argv.slice(2);
  try {
    switch (mode) {
      case 'hook': await hook(); break;
      case 'live': await liveUpdate(args[0], args[1], args[2]); break;
      case 'idle-worker': await idleWorker(args[0], args[1]); break;
      case 'session-now': { const s = getSession(args[0]); await reportSession(args[0], s.transcriptPath); break; }
      case 'commit': await reportCommit(); break;
      case 'now': await reportAllNow(); break;
      case 'chat-id': await printChatIds(); break;
      case 'send': {
        // Used by the /vvc-devlog skill: message (Telegram HTML) from a file arg or stdin
        const text = args[0] ? fs.readFileSync(args[0], 'utf8') : fs.readFileSync(0, 'utf8');
        if (!text.trim()) throw new Error('empty message');
        try {
          await sendTelegram(text.trim());
        } catch (e) {
          if (!/parse entities/i.test(e.message)) throw e;
          // Malformed HTML: send as plain text rather than lose the update
          await sendTelegram(escapeHtml(text.trim().replace(/<[^>]+>/g, '')));
        }
        console.log('Sent.');
        break;
      }
      case 'test': await sendTelegram('✅ <b>VVC devlog connected.</b> Code updates and commits will show up here.'); console.log('Sent.'); break;
      default:
        console.log('Usage: node tools/devlog/report.js <hook|commit|now|chat-id|test>');
    }
  } catch (e) {
    log(`${mode} error: ${e.message}`);
    if (['now', 'chat-id', 'test', 'send'].includes(mode) || !mode) {
      console.error(e.message);
      process.exitCode = 1;
    }
  }
})();
