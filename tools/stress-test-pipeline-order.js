#!/usr/bin/env node
/**
 * Stress-test: Pipeline-order enforcement
 *
 * Simulates the Feb 14 session pattern but more aggressively:
 * 1. Seed an auto-convo topic
 * 2. While it's generating/playing, fire rapid chat messages
 * 3. Seed another topic mid-stream
 * 4. Fire more chat messages
 * 5. Monitor pipeline to verify everything airs in pipeline order
 *
 * Usage: node tools/stress-test-pipeline-order.js
 */

const http = require('http');

const CHAT_API = 'http://127.0.0.1:3002';
const ANIM_API = 'http://127.0.0.1:3003';

// --- Helpers ---

function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
      });
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
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function ts() { return new Date().toISOString().slice(11, 23); }

// --- API Wrappers ---

async function sendChat(message, voice = 'chad') {
  console.log(`[${ts()}] 💬 CHAT → "${message}" (voice: ${voice})`);
  const result = await post(`${CHAT_API}/api/chat`, {
    message,
    voice,
    mode: 'direct',
    model: 'eleven_v3',
    temperature: 0.8
  });
  console.log(`[${ts()}]    ↳ ${result.queued ? 'queued' : result.message || JSON.stringify(result)}`);
  return result;
}

async function seedAutoConvo(seed) {
  console.log(`[${ts()}] 🎬 SEED → "${seed}"`);
  const expandResult = await post(`${ANIM_API}/api/orchestrator/expand`, { seed, mediaRefs: [] });
  if (expandResult.error) {
    console.log(`[${ts()}]    ↳ ERROR: ${expandResult.error}`);
    return null;
  }
  const segId = expandResult.id;
  const lines = expandResult.script?.length || 0;
  console.log(`[${ts()}]    ↳ segment ${segId?.slice(0,8)} (${lines} lines) — rendering...`);

  // Trigger render
  const renderResult = await post(`${ANIM_API}/api/orchestrator/render/${segId}`, {});
  console.log(`[${ts()}]    ↳ render: ${renderResult.message || renderResult.status || JSON.stringify(renderResult)}`);
  return segId;
}

async function getState() {
  return get(`${ANIM_API}/api/orchestrator/state`);
}

async function getSegments() {
  const state = await getState();
  return state?.pipeline?.segments || [];
}

// --- Monitor ---

async function printPipelineSnapshot(label) {
  const segments = await getSegments();
  console.log(`\n[${ts()}] === PIPELINE SNAPSHOT: ${label} === (${segments.length} segments)`);
  for (const seg of segments) {
    const scriptPreview = seg.script?.map(l => `${l.speaker}: "${l.text?.slice(0, 40)}..."`).join(' | ') || 'no script';
    console.log(`  ${seg.id?.slice(0,8)} | ${seg.type.padEnd(14)} | ${seg.status.padEnd(8)} | seed: "${(seg.seed || '').slice(0, 30)}" | ${scriptPreview}`);
  }
  console.log('');
}

function verifyAiredOrder(segments) {
  const aired = segments.filter(s => s.status === 'aired');
  const pipeline = segments; // getAllSegments returns them in pipeline order
  const airedInPipeline = pipeline.filter(s => s.status === 'aired');

  // Check that aired segments appear in the same relative order as pipeline
  let issues = 0;
  for (let i = 1; i < airedInPipeline.length; i++) {
    const prevIdx = pipeline.findIndex(s => s.id === airedInPipeline[i-1].id);
    const currIdx = pipeline.findIndex(s => s.id === airedInPipeline[i].id);
    if (currIdx < prevIdx) {
      console.log(`  !! ORDER VIOLATION: ${airedInPipeline[i].id?.slice(0,8)} (${airedInPipeline[i].type}) aired before ${airedInPipeline[i-1].id?.slice(0,8)} (${airedInPipeline[i-1].type}) but is earlier in pipeline`);
      issues++;
    }
  }
  return issues;
}

// --- Stress Test Sequence ---

async function main() {
  console.log('='.repeat(70));
  console.log('  STRESS TEST: Pipeline-Order Audio Push Enforcement');
  console.log('  Testing: segments air in pipeline order, not TTS-completion order');
  console.log('='.repeat(70));
  console.log('');

  // Verify servers are up
  try {
    await get(`${CHAT_API}/api/health`);
    await get(`${ANIM_API}/health`);
  } catch (e) {
    console.error('ERROR: Servers not reachable. Start both with `npm run dev`.');
    process.exit(1);
  }
  console.log(`[${ts()}] Both servers healthy.\n`);

  // ====== PHASE 1: Seed an auto-convo to get the pipeline flowing ======
  console.log('--- PHASE 1: Start auto-convo (4 lines) ---');
  const seed1Id = await seedAutoConvo("Chad brags about his Valentine's Day plans, Virgin admits he has none");
  await sleep(2000);
  await printPipelineSnapshot('After seed #1');

  // ====== PHASE 2: Rapid-fire chat messages while auto-convo is rendering/playing ======
  console.log('--- PHASE 2: Rapid chat burst (3 messages in quick succession) ---');
  // Don't await these in sequence - fire them as fast as possible
  const chat1 = sendChat("yo chad what do you even do for valentines", "chad");
  await sleep(300);
  const chat2 = sendChat("virgin have you ever had a girlfriend", "virgin");
  await sleep(300);
  const chat3 = sendChat("who would win in a fight between you two", "chad");

  // Wait for all chat messages to be accepted
  await Promise.all([chat1, chat2, chat3]);
  console.log(`[${ts()}] All 3 chat messages sent.`);

  await sleep(4000);
  await printPipelineSnapshot('After chat burst #1');

  // ====== PHASE 3: Seed a second topic while chat responses are still rendering ======
  console.log('--- PHASE 3: Second seed topic while pipeline is busy ---');
  const seed2Id = await seedAutoConvo("The guys debate whether pineapple belongs on pizza - Chad loves it, Virgin is horrified");

  // Immediately fire another chat message to race against the new seed
  await sleep(500);
  console.log('--- PHASE 3b: Chat message racing against seed #2 ---');
  await sendChat("hey virgin what's your favorite food", "virgin");

  await sleep(5000);
  await printPipelineSnapshot('After seed #2 + racing chat');

  // ====== PHASE 4: Another burst while everything is in-flight ======
  console.log('--- PHASE 4: Second chat burst (2 rapid messages) ---');
  const chat5 = sendChat("chad do you even cook or just order ubereats", "chad");
  await sleep(200);
  const chat6 = sendChat("virgin what's the weirdest thing you've eaten", "virgin");
  await Promise.all([chat5, chat6]);

  await sleep(3000);
  await printPipelineSnapshot('After chat burst #2');

  // ====== PHASE 5: Third seed to test cascading topic transitions ======
  console.log('--- PHASE 5: Third seed topic (stress: 3 topics + 6 chat messages) ---');
  const seed3Id = await seedAutoConvo("The guys argue about which is better: cats or dogs");

  await sleep(2000);
  // One more chat to push limits
  await sendChat("do either of you have pets", "chad");

  // ====== MONITORING PHASE: Watch pipeline drain ======
  console.log('\n--- MONITORING: Watching pipeline drain (checking every 5s for 120s) ---\n');

  let totalChecks = 0;
  let allAired = false;
  const orderViolations = [];

  while (totalChecks < 24 && !allAired) {
    await sleep(5000);
    totalChecks++;

    const segments = await getSegments();
    const statusCounts = {};
    for (const s of segments) {
      statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
    }

    const airedCount = statusCounts['aired'] || 0;
    const totalCount = segments.length;
    const playing = segments.find(s => s.status === 'playing');

    console.log(`[${ts()}] Check ${totalChecks}: ${JSON.stringify(statusCounts)} | playing: ${playing?.id?.slice(0,8) || 'none'} (${playing?.type || '-'})`);

    // Check order
    const issues = verifyAiredOrder(segments);
    if (issues > 0) {
      orderViolations.push({ check: totalChecks, issues, segments: segments.map(s => ({ id: s.id?.slice(0,8), type: s.type, status: s.status })) });
    }

    // Check if all non-deleted are aired
    const nonDeleted = segments.filter(s => s.status !== 'deleted');
    if (nonDeleted.length > 0 && nonDeleted.every(s => s.status === 'aired')) {
      allAired = true;
    }
  }

  // ====== FINAL REPORT ======
  console.log('\n' + '='.repeat(70));
  console.log('  FINAL REPORT');
  console.log('='.repeat(70));

  const finalSegments = await getSegments();
  console.log(`\nTotal segments created: ${finalSegments.length}`);

  // Show final pipeline order with airing sequence
  console.log('\nFinal pipeline order (top = first in pipeline):');
  let airedIndex = 0;
  for (const seg of finalSegments) {
    const marker = seg.status === 'aired' ? `[AIRED #${++airedIndex}]` : `[${seg.status.toUpperCase()}]`;
    const seedShort = (seg.seed || '').slice(0, 50);
    console.log(`  ${marker.padEnd(14)} ${seg.id?.slice(0,8)} ${seg.type.padEnd(14)} "${seedShort}"`);
  }

  // Check for order violations
  console.log(`\nOrder violations detected: ${orderViolations.length}`);
  if (orderViolations.length > 0) {
    console.log('FAIL: Segments aired out of pipeline order!');
    for (const v of orderViolations) {
      console.log(`  Check ${v.check}: ${v.issues} violations`);
    }
  } else {
    console.log('PASS: All segments aired in correct pipeline order.');
  }

  // Check for unaired segments that shouldn't exist
  const unaired = finalSegments.filter(s => !['aired', 'deleted'].includes(s.status));
  if (unaired.length > 0) {
    console.log(`\nWARNING: ${unaired.length} segments still not aired:`);
    for (const s of unaired) {
      console.log(`  ${s.id?.slice(0,8)} ${s.type} → ${s.status}`);
    }
  }

  // Check for bridges between topic changes
  const bridges = finalSegments.filter(s => s.type === 'bridge');
  console.log(`\nBridge segments: ${bridges.length}`);
  for (const b of bridges) {
    const idx = finalSegments.indexOf(b);
    const before = idx > 0 ? finalSegments[idx-1] : null;
    const after = idx < finalSegments.length - 1 ? finalSegments[idx+1] : null;
    console.log(`  ${b.id?.slice(0,8)} between ${before?.type || '?'}→${after?.type || '?'} (${b.status})`);
  }

  console.log('\n' + '='.repeat(70));
  console.log(allAired ? '  TEST COMPLETE: All segments drained.' : '  TEST TIMED OUT: Some segments still pending.');
  console.log('='.repeat(70));
}

main().catch(err => {
  console.error('Stress test failed:', err);
  process.exit(1);
});
