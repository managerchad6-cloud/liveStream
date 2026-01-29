/**
 * GitHub Webhook Server
 * Listens for push events and runs `git pull` in the repo directory.
 * Run alongside a tunnel (ngrok, localtunnel, etc.) to expose it publicly.
 */

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { exec } = require('child_process');
const path = require('path');

const app = express();
const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || '3945', 10);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const REPO_DIR = path.resolve(__dirname);
const WATCH_BRANCH = process.env.WEBHOOK_BRANCH || 'refs/heads/master';

// Raw body for signature verification; we'll parse JSON ourselves
app.use('/webhook', express.raw({ type: 'application/json', limit: '1mb' }));

app.get('/webhook/health', (req, res) => {
  res.json({ ok: true, service: 'webhook' });
});

app.post('/webhook', (req, res) => {
  const raw = req.body;
  if (!raw || !raw.length) {
    return res.status(400).json({ error: 'No body' });
  }

  if (WEBHOOK_SECRET) {
    const sig = req.headers['x-hub-signature-256'];
    if (!sig || !sig.startsWith('sha256=')) {
      return res.status(401).json({ error: 'Missing X-Hub-Signature-256' });
    }
    const expected = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (req.headers['x-github-event'] !== 'push') {
    return res.status(200).json({ ignored: true, reason: 'not push' });
  }

  const ref = payload.ref;
  if (ref !== WATCH_BRANCH) {
    return res.status(200).json({ ignored: true, reason: `ref ${ref} != ${WATCH_BRANCH}` });
  }

  res.status(202).json({ accepted: true });
  runGitPull();
});

function runGitPull() {
  console.log(`[webhook] Running git pull in ${REPO_DIR}`);
  exec('git pull origin master', { cwd: REPO_DIR }, (err, stdout, stderr) => {
    if (err) {
      console.error('[webhook] git pull failed:', err.message);
      if (stderr) console.error('[webhook] stderr:', stderr);
      return;
    }
    console.log('[webhook] git pull ok');
    if (stdout) console.log(stdout.trim());
  });
}

app.listen(WEBHOOK_PORT, () => {
  console.log(`Webhook server listening on http://localhost:${WEBHOOK_PORT}`);
  console.log(`  POST /webhook  - GitHub webhook`);
  console.log(`  GET  /webhook/health - health check`);
  if (!WEBHOOK_SECRET) {
    console.warn('  WEBHOOK_SECRET not set - webhook accepts all requests');
  }
});
