const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');

// ─── Mock voices ───────────────────────────────────────────────────────
jest.mock('../../../voices', () => ({
  chad: {
    name: 'Chad',
    elevenLabsVoiceId: 'fake-chad-voice-id',
    basePrompt: 'You are Chad.',
    voiceSettings: { stability: 0.0, similarity_boost: 0.8 }
  },
  virgin: {
    name: 'Virgin',
    elevenLabsVoiceId: 'fake-virgin-voice-id',
    basePrompt: 'You are Virgin.',
    voiceSettings: { stability: 1.0, similarity_boost: 0.5 }
  }
}));

// ─── Mock axios ────────────────────────────────────────────────────────
jest.mock('axios');
const axios = require('axios');

const PipelineStore = require('../pipeline-store');
const ScriptGenerator = require('../script-generator');
const SegmentRenderer = require('../segment-renderer');
const BridgeGenerator = require('../bridge-generator');
const FillerGenerator = require('../filler-generator');
const PlaybackController = require('../playback-controller');
const BufferMonitor = require('../buffer-monitor');
const ChatIntakeAgent = require('../chat-intake');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'integration-test-'));
}

function fakeOpenAI(scriptLines) {
  return {
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                script: scriptLines || [
                  { speaker: 'chad', text: 'Hey there' },
                  { speaker: 'virgin', text: 'Oh hi' }
                ],
                exitContext: 'Test conversation'
              })
            }
          }]
        })
      }
    }
  };
}

/**
 * Build a minimal Express app with orchestrator routes wired up.
 * This mirrors the route structure from animation-server/server.js
 * but without the heavy compositor/stream/TV dependencies.
 */
function buildTestApp({ pipelineStore, scriptGenerator, segmentRenderer, playbackController, chatIntake, bridgeGenerator, fillerGenerator }) {
  const app = express();
  app.use(express.json());

  // Pipeline CRUD
  app.get('/api/pipeline', (req, res) => {
    res.json(pipelineStore.getAllSegments());
  });

  app.get('/api/pipeline/:id', (req, res) => {
    const seg = pipelineStore.getSegment(req.params.id);
    if (!seg) return res.status(404).json({ error: 'Not found' });
    res.json(seg);
  });

  app.delete('/api/pipeline/:id', async (req, res) => {
    try {
      await pipelineStore.removeSegment(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // Orchestrator script
  app.post('/api/orchestrator/expand', async (req, res) => {
    const { seed } = req.body || {};
    if (!seed) return res.status(400).json({ error: 'Missing seed' });
    try {
      const segment = await scriptGenerator.expandDirectorNote(seed);
      res.json(segment);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Render
  app.post('/api/orchestrator/render/:id', async (req, res) => {
    const segmentId = req.params.id;
    const segment = pipelineStore.getSegment(segmentId);
    if (!segment) return res.status(404).json({ error: 'Not found' });
    if (segment.status !== 'forming') {
      return res.status(400).json({ error: `Must be forming (current: ${segment.status})` });
    }

    res.json({ id: segmentId, status: 'rendering' });

    segmentRenderer.queueRender(segmentId).catch(err => {
      console.error(`[Test] Render failed: ${err.message}`);
    });
  });

  // Playback
  app.post('/api/orchestrator/play', (req, res) => {
    res.json(playbackController.start());
  });

  app.post('/api/orchestrator/pause', (req, res) => {
    res.json(playbackController.pause());
  });

  app.post('/api/orchestrator/stop', (req, res) => {
    res.json(playbackController.stop());
  });

  app.get('/api/orchestrator/status', (req, res) => {
    res.json(playbackController.getStatus());
  });

  // Chat inbox
  app.post('/api/orchestrator/chat/message', (req, res) => {
    const { username, text, response } = req.body || {};
    if (!text) return res.status(400).json({ error: 'Missing text' });
    chatIntake.addMessage(username || 'anonymous', text, response || null);
    res.json({ success: true });
  });

  app.get('/api/orchestrator/chat/inbox', (req, res) => {
    res.json(chatIntake.getInbox());
  });

  app.delete('/api/orchestrator/chat/inbox/:id', (req, res) => {
    chatIntake.removeCard(req.params.id);
    res.json({ success: true });
  });

  return app;
}

// Simple HTTP request helper (no external deps needed)
function request(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const options = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers: { 'Content-Type': 'application/json' }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('Integration Smoke Tests', () => {
  let tmpDir, pipelineStore, scriptGenerator, segmentRenderer;
  let playbackController, chatIntake, bridgeGenerator, fillerGenerator;
  let openai, emitter, app, server;

  beforeAll(async () => {
    tmpDir = makeTempDir();
    pipelineStore = new PipelineStore(tmpDir);
    await pipelineStore.init();

    openai = fakeOpenAI();
    emitter = { broadcast: jest.fn() };

    scriptGenerator = new ScriptGenerator({ openai, pipelineStore });
    bridgeGenerator = new BridgeGenerator({ openai, pipelineStore });
    fillerGenerator = new FillerGenerator({ openai, pipelineStore });

    process.env.ELEVENLABS_API_KEY = 'test-key';
    segmentRenderer = new SegmentRenderer({
      pipelineStore,
      animationServerUrl: 'http://127.0.0.1:9999',
      eventEmitter: emitter,
      maxConcurrent: 3
    });

    playbackController = new PlaybackController({ pipelineStore, eventEmitter: emitter });
    chatIntake = new ChatIntakeAgent({ scriptGenerator, pipelineStore, eventEmitter: emitter });

    // Mock TTS and /render
    axios.post.mockImplementation(async (url) => {
      if (url.includes('elevenlabs.io')) {
        return { data: Buffer.from('fake-audio') };
      }
      return { data: { duration: 3.0 } };
    });

    app = buildTestApp({
      pipelineStore, scriptGenerator, segmentRenderer,
      playbackController, chatIntake, bridgeGenerator, fillerGenerator
    });

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
  });

  afterAll(async () => {
    delete process.env.ELEVENLABS_API_KEY;
    playbackController.stop();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('1: POST /api/orchestrator/expand → segment appears in GET /api/pipeline', async () => {
    const expandRes = await request(server, 'POST', '/api/orchestrator/expand', { seed: 'Talk about space' });
    expect(expandRes.status).toBe(200);
    expect(expandRes.body.id).toBeDefined();
    expect(expandRes.body.status).toBe('forming');

    const pipelineRes = await request(server, 'GET', '/api/pipeline');
    expect(pipelineRes.status).toBe(200);
    const found = pipelineRes.body.find(s => s.id === expandRes.body.id);
    expect(found).toBeDefined();
  });

  test('2: POST /api/orchestrator/render/:id → segment transitions to ready', async () => {
    const expandRes = await request(server, 'POST', '/api/orchestrator/expand', { seed: 'Talk about dogs' });
    const segId = expandRes.body.id;

    const renderRes = await request(server, 'POST', `/api/orchestrator/render/${segId}`);
    expect(renderRes.status).toBe(200);
    expect(renderRes.body.status).toBe('rendering');

    // Wait for background render to complete
    await new Promise(r => setTimeout(r, 500));

    const getRes = await request(server, 'GET', `/api/pipeline/${segId}`);
    expect(getRes.body.status).toBe('ready');
  });

  test('3: GET /api/orchestrator/status returns playback state', async () => {
    const statusRes = await request(server, 'GET', '/api/orchestrator/status');
    expect(statusRes.status).toBe(200);
    expect(statusRes.body).toHaveProperty('isPlaying');
    expect(statusRes.body).toHaveProperty('isPaused');
    expect(statusRes.body).toHaveProperty('currentSegmentId');
  });

  test('4: POST play/pause/stop work', async () => {
    const playRes = await request(server, 'POST', '/api/orchestrator/play');
    expect(playRes.body.isPlaying).toBe(true);

    const pauseRes = await request(server, 'POST', '/api/orchestrator/pause');
    expect(pauseRes.body.isPaused).toBe(true);

    const stopRes = await request(server, 'POST', '/api/orchestrator/stop');
    expect(stopRes.body.isPlaying).toBe(false);
    expect(stopRes.body.isPaused).toBe(false);
  });

  test('6: POST /api/orchestrator/chat/message → card appears in inbox', async () => {
    const msgRes = await request(server, 'POST', '/api/orchestrator/chat/message', {
      username: 'viewer1',
      text: 'Say hi!'
    });
    expect(msgRes.status).toBe(200);

    const inboxRes = await request(server, 'GET', '/api/orchestrator/chat/inbox');
    expect(inboxRes.status).toBe(200);
    const found = inboxRes.body.find(c => c.text === 'Say hi!');
    expect(found).toBeDefined();
    expect(found.username).toBe('viewer1');
  });

  test('7: DELETE /api/orchestrator/chat/inbox/:id removes card', async () => {
    await request(server, 'POST', '/api/orchestrator/chat/message', {
      username: 'viewer2',
      text: 'Remove me'
    });

    const inbox1 = await request(server, 'GET', '/api/orchestrator/chat/inbox');
    const card = inbox1.body.find(c => c.text === 'Remove me');
    expect(card).toBeDefined();

    await request(server, 'DELETE', `/api/orchestrator/chat/inbox/${card.id}`);

    const inbox2 = await request(server, 'GET', '/api/orchestrator/chat/inbox');
    const removed = inbox2.body.find(c => c.id === card.id);
    expect(removed).toBeUndefined();
  });

  test('8: full lifecycle: expand → render → setOnAir → segmentDone → aired', async () => {
    const expandRes = await request(server, 'POST', '/api/orchestrator/expand', { seed: 'Full lifecycle test' });
    const segId = expandRes.body.id;
    expect(expandRes.body.status).toBe('forming');

    // Render
    await request(server, 'POST', `/api/orchestrator/render/${segId}`);
    await new Promise(r => setTimeout(r, 500));

    let seg = pipelineStore.getSegment(segId);
    expect(seg.status).toBe('ready');

    // Set on-air (called by animation server)
    playbackController.setOnAir(segId);
    expect(playbackController.getStatus().currentSegmentId).toBe(segId);

    // Segment done
    await playbackController.segmentDone(segId);
    seg = pipelineStore.getSegment(segId);
    expect(seg.status).toBe('aired');
    expect(playbackController.getStatus().currentSegmentId).toBeNull();
  });
});
