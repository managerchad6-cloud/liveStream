#!/usr/bin/env node
/* Simulated audience injector for LiveStream orchestrator chat intake */
const axios = require('axios');

const API = process.env.ORCHESTRATOR_API || 'http://localhost:3003';
const PER_MIN = Number(process.env.AUDIENCE_PER_MIN || 3);
const INTERVAL_MS = Math.max(5000, Math.round(60000 / Math.max(1, PER_MIN)));

const users = [
  'degen_ape', 'moonboi77', 'chartwizard', 'ctlurker', 'diamondhands',
  'basedholder', 'solsniper', 'pumpwatcher', 'anonalpha', 'fudhunter'
];

const questions = [
  'is this live?',
  'wen launch?',
  'ca?',
  'who is dev?',
  'mcap rn?',
  'where buy?',
  'what chain we on?',
  'how early are we?',
  'is there official x account?',
  'can chad explain the thesis in 1 line?'
];

let i = 0;
let timer = null;

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function sendOne() {
  const username = pick(users) + '_' + String(Math.floor(Math.random() * 999));
  const text = questions[i % questions.length];
  i += 1;
  try {
    await axios.post(`${API}/api/orchestrator/chat/message`, { username, text });
    console.log(`[audience] ${username}: ${text}`);
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    console.error(`[audience] send failed: ${msg}`);
  }
}

async function main() {
  console.log(`[audience] starting at ${PER_MIN}/min -> every ${INTERVAL_MS}ms (${API})`);
  await sendOne();
  timer = setInterval(sendOne, INTERVAL_MS);
}

process.on('SIGINT', () => { if (timer) clearInterval(timer); process.exit(0); });
process.on('SIGTERM', () => { if (timer) clearInterval(timer); process.exit(0); });

main();
