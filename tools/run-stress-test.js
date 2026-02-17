#!/usr/bin/env node
/**
 * Paced pipeline stress test — runs autonomously with proper cadence.
 * Sends chat messages, seed prompts, and monitors pipeline order throughout.
 */
const http = require('http');
const CHAT = 'http://127.0.0.1:3002';
const ANIM = 'http://127.0.0.1:3003';

function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    }).on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);

// --- Actions ---

async function chat(message, voice = 'chad') {
  console.log(`\n[${ts()}] >> CHAT (${voice}): "${message}"`);
  const r = await post(`${CHAT}/api/chat`, { message, voice, mode: 'direct', temperature: 0.8 });
  console.log(`[${ts()}]    ${r.queued ? 'queued ok' : JSON.stringify(r)}`);
  return r;
}

async function seed(topic) {
  console.log(`\n[${ts()}] >> SEED: "${topic}"`);
  const r = await post(`${ANIM}/api/orchestrator/expand`, { seed: topic, mediaRefs: [] });
  if (r.error) { console.log(`[${ts()}]    ERROR: ${r.error}`); return null; }
  const id = r.id;
  console.log(`[${ts()}]    segment ${id.slice(0,8)} (${r.script?.length || 0} lines)`);
  await post(`${ANIM}/api/orchestrator/render/${id}`, {});
  console.log(`[${ts()}]    render queued`);
  return id;
}

async function monitor(label) {
  const state = await get(`${ANIM}/api/orchestrator/state`);
  const segs = state.pipeline?.segments || [];
  const cur = state.playback?.currentSegmentId;

  // Count statuses
  const counts = {};
  for (const s of segs) counts[s.status] = (counts[s.status] || 0) + 1;

  const playing = segs.find(s => s.id === cur);
  const playingDesc = playing
    ? `${playing.type} ${playing.id.slice(0,8)} "${(playing.seed || playing.script?.[0]?.text || '').slice(0,35)}"`
    : 'none';

  console.log(`\n[${ts()}] --- ${label} ---`);
  console.log(`  Segments: ${segs.length} | ${JSON.stringify(counts)} | on-air: ${playingDesc}`);

  // Show non-aired segments detail
  const active = segs.filter(s => s.status !== 'aired');
  if (active.length > 0) {
    for (const s of active) {
      const m = s.id === cur ? ' <<< ON-AIR' : '';
      const cont = s.metadata?.continuity || '';
      console.log(`    ${s.id.slice(0,8)} | ${s.type.padEnd(14)} | ${s.status.padEnd(8)} | prog:${(s.renderProgress||0).toFixed(2)} | ${cont || '-'}${m}`);
    }
  }

  // Order violation check
  let sawNonAired = false;
  let violations = 0;
  for (const s of segs) {
    if (s.status !== 'aired') sawNonAired = true;
    if (s.status === 'aired' && sawNonAired) violations++;
  }
  if (violations > 0) console.log(`  !! ORDER VIOLATION: ${violations} aired segments after non-aired`);

  return { segs, counts, violations };
}

// --- Main test sequence ---

async function main() {
  console.log('='.repeat(60));
  console.log('  PACED PIPELINE STRESS TEST');
  console.log('='.repeat(60));

  // Verify servers
  try {
    await get(`${CHAT}/api/health`);
    await get(`${ANIM}/health`);
  } catch { console.error('Servers not reachable'); process.exit(1); }

  // Ensure auto-approve
  await post(`${ANIM}/api/orchestrator/chat/auto-approve`, { enabled: true });
  console.log(`[${ts()}] Servers up, auto-approve on\n`);

  // ============================================================
  // PHASE 1: Single chat to start the pipeline
  // ============================================================
  await chat("yo chad what's your morning routine like", "chad");
  await sleep(20000);
  await monitor("After kickoff chat");

  // Let expand chain breathe for one cycle
  await sleep(15000);
  await monitor("Expand chain running");

  // ============================================================
  // PHASE 2: Second chat while expand is playing
  // ============================================================
  await chat("virgin do you even have a morning routine or just wake up and game", "virgin");
  await sleep(25000);
  await monitor("After second chat");

  // ============================================================
  // PHASE 3: Seed a new topic to steer the conversation
  // ============================================================
  await seed("Chad and Virgin argue about whether gym bros or gamers have it harder in life");
  await sleep(30000);
  await monitor("After seed topic");

  // Let it expand once
  await sleep(20000);
  await monitor("Seed expand running");

  // ============================================================
  // PHASE 4: Chat interrupting the seeded topic
  // ============================================================
  await chat("chad do you think gamers could survive your gym routine", "chad");
  await sleep(25000);
  await monitor("After chat interrupt on seed");

  // ============================================================
  // PHASE 5: Two rapid chats (8s apart) — the scenario that broke before
  // ============================================================
  await chat("virgin what game are you best at", "virgin");
  await sleep(8000);
  await chat("chad have you ever rage quit anything", "chad");
  await sleep(35000);
  await monitor("After rapid double chat");

  // Let pipeline drain a bit
  await sleep(20000);
  await monitor("Pipeline settling");

  // ============================================================
  // PHASE 6: Second seed to test back-to-back topic change
  // ============================================================
  await seed("The guys debate what the perfect first date looks like");
  await sleep(30000);
  await monitor("After second seed");

  // ============================================================
  // PHASE 7: Final chat to wrap up
  // ============================================================
  await chat("virgin would you ever ask someone out or just wait forever", "virgin");
  await sleep(25000);

  // ============================================================
  // FINAL AUDIT
  // ============================================================
  const { segs, violations } = await monitor("FINAL AUDIT");

  console.log('\n' + '='.repeat(60));
  console.log('  RESULTS');
  console.log('='.repeat(60));
  console.log(`Total segments: ${segs.length}`);

  // FIFO check
  const chats = segs.filter(s => s.type === 'chat-response');
  const chatTimestamps = chats.map(s => s.createdAt);
  const chatPositions = chats.map(s => segs.indexOf(s));
  const fifoOk = chatPositions.every((pos, i) => i === 0 || pos > chatPositions[i-1]);
  console.log(`Chat FIFO: ${fifoOk ? 'PASS' : 'FAIL'} (${chats.length} chats at positions [${chatPositions.join(',')}])`);

  // Bridge check
  const bridges = segs.filter(s => s.type === 'transition' || s.type === 'bridge');
  console.log(`Bridges: ${bridges.length}`);

  // Expand count
  const expands = segs.filter(s => s.metadata?.continuity === 'expand');
  console.log(`Expands: ${expands.length}`);

  // Stuck segments
  const stuck = segs.filter(s => s.status === 'forming' && s.renderProgress <= 0);
  console.log(`Stuck at 0%: ${stuck.length}`);

  // Order violations
  console.log(`Order violations: ${violations}`);
  console.log(`\nOverall: ${violations === 0 && fifoOk && stuck.length === 0 ? 'PASS' : 'FAIL'}`);
  console.log('='.repeat(60));
}

main().catch(err => { console.error('Test failed:', err); process.exit(1); });
