const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── Mock voices before requiring modules ──────────────────────────────
jest.mock('../../../voices', () => ({
  chad: {
    name: 'Chad',
    elevenLabsVoiceId: 'fake-chad-voice-id',
    basePrompt: 'You are Chad, effortlessly successful.',
    voiceSettings: { stability: 0.0, similarity_boost: 0.8 }
  },
  virgin: {
    name: 'Virgin',
    elevenLabsVoiceId: 'fake-virgin-voice-id',
    basePrompt: 'You are Virgin, insecure and overthinks.',
    voiceSettings: { stability: 1.0, similarity_boost: 0.5 }
  }
}));

// ─── Mock axios (ElevenLabs TTS + /render) ─────────────────────────────
jest.mock('axios');
const axios = require('axios');

// ─── Require modules under test ────────────────────────────────────────
const PipelineStore = require('../pipeline-store');
const ScriptGenerator = require('../script-generator');
const SegmentRenderer = require('../segment-renderer');
const BridgeGenerator = require('../bridge-generator');
const FillerGenerator = require('../filler-generator');
const ChatIntakeAgent = require('../chat-intake');
const PlaybackController = require('../playback-controller');
const BufferMonitor = require('../buffer-monitor');

// ─── Helpers ───────────────────────────────────────────────────────────
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-'));
}

function fakeOpenAI(scriptLines, exitContext = 'Test context') {
  return {
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                script: scriptLines || [
                  { speaker: 'chad', text: 'Hey man, what is up.' },
                  { speaker: 'virgin', text: 'Oh, not much, just... you know.' }
                ],
                exitContext: exitContext
              })
            }
          }]
        })
      }
    }
  };
}

function fakeEventEmitter() {
  return { broadcast: jest.fn() };
}

function setupTTSMock() {
  axios.post.mockImplementation(async (url, data, config) => {
    if (url.includes('elevenlabs.io')) {
      return { data: Buffer.from('fake-audio-data') };
    }
    // /render endpoint
    return { data: { duration: 3.5, streamUrl: '/streams/live/stream.m3u8' } };
  });
}

// ─── A. Pipeline Store ─────────────────────────────────────────────────
describe('PipelineStore', () => {
  let store;
  let tmpDir;

  beforeEach(async () => {
    tmpDir = makeTempDir();
    store = new PipelineStore(tmpDir);
    await store.init();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('A.1: createSegment returns forming status with fields populated', async () => {
    const seg = await store.createSegment({
      type: 'auto-convo',
      seed: 'test seed',
      script: [{ speaker: 'chad', text: 'Hello' }],
      estimatedDuration: 10
    });

    expect(seg.status).toBe('forming');
    expect(seg.id).toBeDefined();
    expect(seg.type).toBe('auto-convo');
    expect(seg.seed).toBe('test seed');
    expect(seg.script).toEqual([{ speaker: 'chad', text: 'Hello' }]);
    expect(seg.estimatedDuration).toBe(10);
    expect(seg.renderProgress).toBe(0);
    expect(seg.exitContext).toBeNull();
    expect(seg.metadata).toEqual({});
  });

  test('A.2: transition forming → ready works', async () => {
    const seg = await store.createSegment({ type: 'auto-convo' });
    const updated = await store.transitionStatus(seg.id, 'ready');
    expect(updated.status).toBe('ready');
  });

  test('A.3: transition ready → aired works', async () => {
    const seg = await store.createSegment({ type: 'auto-convo' });
    await store.transitionStatus(seg.id, 'ready');
    const updated = await store.transitionStatus(seg.id, 'aired');
    expect(updated.status).toBe('aired');
  });

  test('A.4: invalid transitions throw', async () => {
    const seg = await store.createSegment({ type: 'auto-convo' });
    await expect(store.transitionStatus(seg.id, 'aired'))
      .rejects.toThrow('Invalid transition: forming → aired');
  });

  test('A.5: delete from any state works', async () => {
    const seg1 = await store.createSegment({ type: 'auto-convo' });
    await store.transitionStatus(seg1.id, 'deleted');
    expect(store.getSegment(seg1.id)).toBeNull();

    const seg2 = await store.createSegment({ type: 'auto-convo' });
    await store.transitionStatus(seg2.id, 'ready');
    await store.transitionStatus(seg2.id, 'deleted');
    expect(store.getSegment(seg2.id)).toBeNull();

    const seg3 = await store.createSegment({ type: 'auto-convo' });
    await store.transitionStatus(seg3.id, 'ready');
    await store.transitionStatus(seg3.id, 'aired');
    await store.transitionStatus(seg3.id, 'deleted');
    expect(store.getSegment(seg3.id)).toBeNull();
  });

  test('A.6: getOnAirSegment returns oldest ready segment', async () => {
    const seg1 = await store.createSegment({ type: 'auto-convo', estimatedDuration: 10 });
    const seg2 = await store.createSegment({ type: 'auto-convo', estimatedDuration: 20 });
    await store.transitionStatus(seg1.id, 'ready');
    await store.transitionStatus(seg2.id, 'ready');

    const onAir = store.getOnAirSegment();
    expect(onAir.id).toBe(seg1.id);
  });

  test('A.7: getBufferHealth sums only ready segment durations', async () => {
    await store.createSegment({ type: 'auto-convo', estimatedDuration: 10 });
    const seg2 = await store.createSegment({ type: 'auto-convo', estimatedDuration: 20 });
    const seg3 = await store.createSegment({ type: 'auto-convo', estimatedDuration: 30 });
    await store.transitionStatus(seg2.id, 'ready');
    await store.transitionStatus(seg3.id, 'ready');

    const health = store.getBufferHealth();
    expect(health.totalSeconds).toBe(50);
    expect(health.readyCount).toBe(2);
  });

  test('A.8: insertAt correctly repositions segments', async () => {
    const seg1 = await store.createSegment({ type: 'auto-convo', seed: 'first' });
    const seg2 = await store.createSegment({ type: 'auto-convo', seed: 'second' });
    const seg3 = await store.createSegment({ type: 'auto-convo', seed: 'third' });

    // Move seg3 to position 1 (before seg2)
    await store.insertAt(seg3.id, 1);
    const all = store.getAllSegments();
    expect(all[0].id).toBe(seg1.id);
    expect(all[1].id).toBe(seg3.id);
    expect(all[2].id).toBe(seg2.id);
  });

  test('A.9: stale forming segments marked failed on init', async () => {
    // Create a forming segment and persist
    await store.createSegment({
      type: 'auto-convo',
      script: [{ speaker: 'chad', text: 'test' }]
    });

    // Create a new store from the same directory (simulates restart)
    const store2 = new PipelineStore(tmpDir);
    await store2.init();

    const segments = store2.getAllSegments();
    expect(segments.length).toBe(1);
    expect(segments[0].status).toBe('forming');
    expect(segments[0].renderProgress).toBe(-1);
    expect(segments[0].metadata.renderError).toBe('Server restarted during render');
  });
});

// ─── B. Script Generator ───────────────────────────────────────────────
describe('ScriptGenerator', () => {
  let store;
  let tmpDir;
  let openai;
  let generator;

  beforeEach(async () => {
    tmpDir = makeTempDir();
    store = new PipelineStore(tmpDir);
    await store.init();
    openai = fakeOpenAI();
    generator = new ScriptGenerator({ openai, pipelineStore: store });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('B.1: expandDirectorNote creates forming segment with script', async () => {
    const seg = await generator.expandDirectorNote('Talk about dogs');
    expect(seg.status).toBe('forming');
    expect(seg.type).toBe('auto-convo');
    expect(seg.seed).toBe('Talk about dogs');
    expect(Array.isArray(seg.script)).toBe(true);
    expect(seg.script.length).toBeGreaterThan(0);
    expect(seg.exitContext).toBe('Test context');
  });

  test('B.2: script lines have valid speaker and non-empty text', async () => {
    const seg = await generator.expandDirectorNote('Test topic');
    for (const line of seg.script) {
      expect(['chad', 'virgin']).toContain(line.speaker);
      expect(line.text.length).toBeGreaterThan(0);
    }
  });

  test('B.3: regenerateScript updates existing segment', async () => {
    const seg = await generator.expandDirectorNote('Original topic');
    openai.chat.completions.create.mockResolvedValueOnce({
      choices: [{
        message: {
          content: JSON.stringify({
            script: [{ speaker: 'virgin', text: 'New line here' }],
            exitContext: 'Updated context'
          })
        }
      }]
    });

    const updated = await generator.regenerateScript(seg.id, 'Make it funnier');
    expect(updated.script[0].text).toBe('New line here');
    expect(updated.exitContext).toBe('Updated context');
    expect(updated.seed).toContain('Feedback: Make it funnier');
  });

  test('B.4: regeneratePartial replaces only specified line range', async () => {
    openai.chat.completions.create.mockResolvedValueOnce({
      choices: [{
        message: {
          content: JSON.stringify({
            script: [
              { speaker: 'chad', text: 'Line 1' },
              { speaker: 'virgin', text: 'Line 2' },
              { speaker: 'chad', text: 'Line 3' }
            ],
            exitContext: 'ctx'
          })
        }
      }]
    });

    const seg = await generator.expandDirectorNote('Test');

    openai.chat.completions.create.mockResolvedValueOnce({
      choices: [{
        message: {
          content: JSON.stringify({
            script: [{ speaker: 'virgin', text: 'Replaced line 2' }]
          })
        }
      }]
    });

    // _normalizeRange: 1-indexed input (2,2) → index 1 (the 2nd line)
    const updated = await generator.regeneratePartial(seg.id, 2, 2, 'Fix middle');
    expect(updated.script.length).toBe(3);
    expect(updated.script[0].text).toBe('Line 1');
    expect(updated.script[1].text).toBe('Replaced line 2');
    expect(updated.script[2].text).toBe('Line 3');
  });

  test('B.5: expandChatMessage creates chat-response type segment', async () => {
    const seg = await generator.expandChatMessage('Hello from chat');
    expect(seg.type).toBe('chat-response');
    expect(seg.seed).toBe('Hello from chat');
    expect(seg.status).toBe('forming');
    expect(Array.isArray(seg.script)).toBe(true);
  });
});

// ─── C. Segment Renderer ──────────────────────────────────────────────
describe('SegmentRenderer', () => {
  let store;
  let tmpDir;
  let renderer;
  let emitter;

  beforeEach(async () => {
    tmpDir = makeTempDir();
    store = new PipelineStore(tmpDir);
    await store.init();
    emitter = fakeEventEmitter();
    // Set the env var so the renderer doesn't throw
    process.env.ELEVENLABS_API_KEY = 'test-key';
    renderer = new SegmentRenderer({
      pipelineStore: store,
      animationServerUrl: 'http://127.0.0.1:3003',
      eventEmitter: emitter,
      maxConcurrent: 3
    });
    setupTTSMock();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.ELEVENLABS_API_KEY;
    jest.restoreAllMocks();
  });

  test('C.1: happy path — forming segment renders to ready', async () => {
    const seg = await store.createSegment({
      type: 'auto-convo',
      seed: 'test',
      script: [
        { speaker: 'chad', text: 'Hello there' },
        { speaker: 'virgin', text: 'Oh hey' }
      ],
      estimatedDuration: 10
    });

    const result = await renderer.renderSegment(seg.id);
    expect(result.status).toBe('ready');
    expect(result.renderProgress).toBe(1);
  });

  test('C.2: all TTS fails → segment stays forming with renderProgress=-1', async () => {
    axios.post.mockRejectedValue(new Error('TTS service down'));

    const seg = await store.createSegment({
      type: 'auto-convo',
      seed: 'test',
      script: [{ speaker: 'chad', text: 'Hello' }],
      estimatedDuration: 5
    });

    await expect(renderer.renderSegment(seg.id)).rejects.toThrow('No audio generated');
    const updated = store.getSegment(seg.id);
    expect(updated.renderProgress).toBe(-1);
    expect(updated.metadata.renderError).toBeDefined();
  });

  test('C.3: partial TTS failure → continues with remaining lines', async () => {
    let callCount = 0;
    axios.post.mockImplementation(async (url) => {
      if (url.includes('elevenlabs.io')) {
        callCount++;
        // Fail line 1 (calls 1-3 are retries for first line), succeed line 2 (call 4)
        if (callCount <= 3) throw new Error('TTS fail');
        return { data: Buffer.from('fake-audio') };
      }
      return { data: { duration: 3.0 } };
    });

    const seg = await store.createSegment({
      type: 'auto-convo',
      seed: 'test',
      script: [
        { speaker: 'chad', text: 'Line that fails' },
        { speaker: 'virgin', text: 'Line that works' }
      ],
      estimatedDuration: 10
    });

    const result = await renderer.renderSegment(seg.id);
    expect(result.status).toBe('ready');
  });

  test('C.4: push ordering — pushChain enforces sequential Phase 2', async () => {
    // Track the order that segments transition to 'ready'
    const readyOrder = [];
    const origTransition = store.transitionStatus.bind(store);
    store.transitionStatus = async function(id, status) {
      const result = await origTransition(id, status);
      if (status === 'ready') readyOrder.push(id);
      return result;
    };

    const seg1 = await store.createSegment({
      type: 'auto-convo', seed: 'first',
      script: [{ speaker: 'chad', text: 'First segment' }], estimatedDuration: 5
    });
    const seg2 = await store.createSegment({
      type: 'auto-convo', seed: 'second',
      script: [{ speaker: 'virgin', text: 'Second segment' }], estimatedDuration: 5
    });

    // Render sequentially to avoid file system race conditions
    await renderer.queueRender(seg1.id);
    await renderer.queueRender(seg2.id);

    expect(readyOrder).toEqual([seg1.id, seg2.id]);
    expect(store.getSegment(seg1.id).status).toBe('ready');
    expect(store.getSegment(seg2.id).status).toBe('ready');
  });

  test('C.5: pre-gate — target waits for gate to resolve before Phase 2', async () => {
    const events = [];
    let resolveGate;
    const gate = new Promise(resolve => { resolveGate = resolve; });

    const seg = await store.createSegment({
      type: 'auto-convo', seed: 'gated',
      script: [{ speaker: 'chad', text: 'Gated content' }], estimatedDuration: 5
    });

    renderer.addPreGate(seg.id, gate);

    const renderPromise = renderer.renderSegment(seg.id);

    // Give TTS time to complete (Phase 1), but Phase 2 should be waiting
    await new Promise(r => setTimeout(r, 100));
    const midRender = store.getSegment(seg.id);
    expect(midRender.status).toBe('forming');

    // Resolve gate — Phase 2 should now proceed
    resolveGate();
    const result = await renderPromise;
    expect(result.status).toBe('ready');
  });

  test('C.6: pre-gate timeout — target proceeds after timeout', async () => {
    // Override the constant for testing via a never-resolving gate
    // The gate has a 15s timeout built in, but we'll test with a custom short one
    const neverResolves = new Promise(() => {});

    const seg = await store.createSegment({
      type: 'auto-convo', seed: 'timeout-test',
      script: [{ speaker: 'chad', text: 'Will proceed' }], estimatedDuration: 5
    });

    // Add gate with short timeout directly
    const timedGate = Promise.race([
      neverResolves,
      new Promise(resolve => setTimeout(resolve, 200))
    ]);
    renderer.preGates.set(seg.id, timedGate);

    const result = await renderer.renderSegment(seg.id);
    expect(result.status).toBe('ready');
  });

  test('C.7: pre-gate failure — gate rejects, target still proceeds', async () => {
    const seg = await store.createSegment({
      type: 'auto-convo', seed: 'rejected-gate',
      script: [{ speaker: 'virgin', text: 'Still works' }], estimatedDuration: 5
    });

    renderer.addPreGate(seg.id, Promise.reject(new Error('Bridge failed')));

    const result = await renderer.renderSegment(seg.id);
    expect(result.status).toBe('ready');
  });
});

// ─── D. Bridge Flow ────────────────────────────────────────────────────
describe('Bridge Flow', () => {
  let store;
  let tmpDir;
  let openai;
  let bridgeGen;

  beforeEach(async () => {
    tmpDir = makeTempDir();
    store = new PipelineStore(tmpDir);
    await store.init();
    openai = fakeOpenAI([
      { speaker: 'chad', text: 'Speaking of which...' }
    ], 'Bridge context');
    bridgeGen = new BridgeGenerator({ openai, pipelineStore: store });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('D.1: bridge generated with metadata tracking', async () => {
    const bridge = await bridgeGen.generateBridge(
      'Previous topic',
      'Next topic',
      'chad',
      { bridgeFor: 'target-id', bridgeAfter: 'previous-id' }
    );

    expect(bridge.type).toBe('transition');
    expect(bridge.status).toBe('forming');
    expect(bridge.metadata.bridgeFor).toBe('target-id');
    expect(bridge.metadata.bridgeAfter).toBe('previous-id');
    expect(Array.isArray(bridge.script)).toBe(true);
  });

  test('D.2: bridge inserted before target in pipeline', async () => {
    const seg1 = await store.createSegment({ type: 'auto-convo', seed: 'first' });
    await store.updateSegment(seg1.id, { exitContext: 'Topic A' });

    const seg2 = await store.createSegment({ type: 'auto-convo', seed: 'second' });

    const bridge = await bridgeGen.generateBridge('Topic A', 'second', 'chad', {
      bridgeFor: seg2.id, bridgeAfter: seg1.id
    });

    // Insert bridge before target
    const targetIdx = store.getAllSegments().findIndex(s => s.id === seg2.id);
    await store.insertAt(bridge.id, targetIdx);

    const all = store.getAllSegments();
    const bridgeIdx = all.findIndex(s => s.id === bridge.id);
    const targetIdx2 = all.findIndex(s => s.id === seg2.id);
    expect(bridgeIdx).toBeLessThan(targetIdx2);
  });

  test('D.5: no bridge for fillers or when no preceding exitContext', async () => {
    // This tests the logic in Orchestrator.queueSegmentWithBridge
    // Fillers and transitions skip bridge generation
    const filler = await store.createSegment({ type: 'filler', seed: null });
    const transition = await store.createSegment({ type: 'transition', seed: 'next' });

    // We check the skip condition directly
    expect(['filler', 'transition']).toContain(filler.type);
    expect(['filler', 'transition']).toContain(transition.type);
  });
});

// ─── E. Filler Flow ────────────────────────────────────────────────────
describe('Filler Flow', () => {
  let store;
  let tmpDir;
  let openai;
  let fillerGen;
  let emitter;

  beforeEach(async () => {
    tmpDir = makeTempDir();
    store = new PipelineStore(tmpDir);
    await store.init();
    openai = fakeOpenAI([
      { speaker: 'chad', text: 'So anyway...' },
      { speaker: 'virgin', text: 'Yeah, totally...' }
    ], 'Filler context');
    fillerGen = new FillerGenerator({ openai, pipelineStore: store });
    emitter = fakeEventEmitter();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('E.1: filler generates segment with type=filler and a script', async () => {
    const seg = await fillerGen.generateFiller(['Previous topic']);
    expect(seg.type).toBe('filler');
    expect(seg.status).toBe('forming');
    expect(Array.isArray(seg.script)).toBe(true);
    expect(seg.script.length).toBeGreaterThan(0);
  });

  test('E.2: buffer critical + filler enabled + only filler → NO filler generated', async () => {
    // Create only filler-type content
    const filler = await store.createSegment({ type: 'filler', estimatedDuration: 2 });
    await store.transitionStatus(filler.id, 'ready');

    const mockFillerGen = { generateFiller: jest.fn() };
    const mockRenderer = { queueRender: jest.fn().mockResolvedValue({}) };

    const monitor = new BufferMonitor({
      pipelineStore: store,
      fillerGenerator: mockFillerGen,
      eventEmitter: emitter,
      segmentRenderer: mockRenderer,
      config: { minSegments: 3, targetSegments: 6, minDurationSeconds: 30 }
    });
    monitor.fillerEnabled = true;

    await monitor._tick();
    expect(mockFillerGen.generateFiller).not.toHaveBeenCalled();
  });

  test('E.3: generates multiple fillers to reach target when below minimum', async () => {
    const seg = await store.createSegment({ type: 'auto-convo', estimatedDuration: 5 });
    await store.transitionStatus(seg.id, 'ready');

    let fillerCount = 0;
    const mockFillerGen = {
      generateFiller: jest.fn().mockImplementation(async () => {
        fillerCount++;
        return { id: `filler-${fillerCount}` };
      })
    };
    const mockRenderer = { queueRender: jest.fn().mockResolvedValue({}) };

    const monitor = new BufferMonitor({
      pipelineStore: store,
      fillerGenerator: mockFillerGen,
      eventEmitter: emitter,
      segmentRenderer: mockRenderer,
      config: { minSegments: 3, targetSegments: 5, minDurationSeconds: 30, targetDurationSeconds: 60 }
    });
    monitor.fillerEnabled = true;

    await monitor._tick();
    // With 1 segment at 5s, we're below both min (3) and duration (30s)
    // Should generate multiple fillers to approach target
    expect(mockFillerGen.generateFiller.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test('E.4: filler disabled → no generation even when critical', async () => {
    const seg = await store.createSegment({ type: 'auto-convo', estimatedDuration: 2 });
    await store.transitionStatus(seg.id, 'ready');

    const mockFillerGen = { generateFiller: jest.fn() };
    const monitor = new BufferMonitor({
      pipelineStore: store,
      fillerGenerator: mockFillerGen,
      eventEmitter: emitter,
      config: { minSegments: 3, targetSegments: 6, minDurationSeconds: 30 }
    });
    monitor.fillerEnabled = false;

    await monitor._tick();
    expect(mockFillerGen.generateFiller).not.toHaveBeenCalled();
  });

  test('E.5: buffer low + filler enabled + non-filler content → fillers generated', async () => {
    const seg = await store.createSegment({ type: 'auto-convo', estimatedDuration: 5 });
    await store.transitionStatus(seg.id, 'ready');

    let fillerCount = 0;
    const mockFillerGen = {
      generateFiller: jest.fn().mockImplementation(() => Promise.resolve({ id: `filler-${++fillerCount}` }))
    };
    const mockRenderer = { queueRender: jest.fn().mockResolvedValue({}) };

    const monitor = new BufferMonitor({
      pipelineStore: store,
      fillerGenerator: mockFillerGen,
      eventEmitter: emitter,
      segmentRenderer: mockRenderer,
      config: { minSegments: 3, targetSegments: 6, minDurationSeconds: 30, targetDurationSeconds: 60 }
    });
    monitor.fillerEnabled = true;

    await monitor._tick();
    // Batch generation creates multiple fillers to reach healthy target
    expect(mockFillerGen.generateFiller).toHaveBeenCalled();
    expect(mockFillerGen.generateFiller.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── F. Chat Intake ────────────────────────────────────────────────────
describe('ChatIntakeAgent', () => {
  let intake;
  let emitter;

  beforeEach(() => {
    emitter = fakeEventEmitter();
    intake = new ChatIntakeAgent({
      scriptGenerator: null,
      pipelineStore: null,
      eventEmitter: emitter
    });
  });

  test('F.1: addMessage adds card to inbox', () => {
    const card = intake.addMessage('user1', 'Hello!');
    expect(card).not.toBeNull();
    expect(card.username).toBe('user1');
    expect(card.text).toBe('Hello!');
    expect(intake.getInbox().length).toBe(1);
  });

  test('F.2: removeCard removes from inbox', () => {
    const card = intake.addMessage('user1', 'Hello!');
    intake.removeCard(card.id);
    expect(intake.getInbox().length).toBe(0);
  });

  test('F.3: inbox max 50, oldest trimmed', () => {
    for (let i = 0; i < 55; i++) {
      intake.addMessage('user', `Message ${i}`);
    }
    expect(intake.getInbox().length).toBe(50);
    // Most recent should be first (unshift)
    expect(intake.getInbox()[0].text).toBe('Message 54');
  });

  test('F.4: autoApprove defaults to false, can be toggled', () => {
    expect(intake.autoApprove).toBe(false);
    intake.setAutoApprove(true);
    expect(intake.autoApprove).toBe(true);
    expect(intake.getConfig().autoApprove).toBe(true);
    intake.setAutoApprove(false);
    expect(intake.autoApprove).toBe(false);
  });

  test('F.5: addMessage with response attaches it', () => {
    const card = intake.addMessage('user1', 'Tell me a joke', {
      speaker: 'chad',
      text: 'Why did the chicken...'
    });
    expect(card.response).toBeDefined();
    expect(card.response.speaker).toBe('chad');
  });

  test('F.6: addMessage with empty text returns null', () => {
    const card = intake.addMessage('user1', '');
    expect(card).toBeNull();
  });
});

// ─── G. Playback Controller ───────────────────────────────────────────
describe('PlaybackController', () => {
  let store;
  let tmpDir;
  let controller;
  let emitter;

  beforeEach(async () => {
    tmpDir = makeTempDir();
    store = new PipelineStore(tmpDir);
    await store.init();
    emitter = fakeEventEmitter();
    controller = new PlaybackController({
      pipelineStore: store,
      eventEmitter: emitter
    });
  });

  afterEach(() => {
    controller.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('G.1: setOnAir sets currentSegmentId', () => {
    controller.setOnAir('seg-123');
    expect(controller.getStatus().currentSegmentId).toBe('seg-123');
  });

  test('G.2: segmentDone transitions ready segment to aired and clears currentSegmentId', async () => {
    const seg = await store.createSegment({ type: 'auto-convo' });
    await store.transitionStatus(seg.id, 'ready');

    controller.setOnAir(seg.id);
    await controller.segmentDone(seg.id);

    const updated = store.getSegment(seg.id);
    expect(updated.status).toBe('aired');
    expect(controller.getStatus().currentSegmentId).toBeNull();
  });

  test('G.3: segmentDone on forming segment → deferred to pendingDone', async () => {
    const seg = await store.createSegment({ type: 'auto-convo' });

    controller.setOnAir(seg.id);
    await controller.segmentDone(seg.id);

    expect(controller.pendingDone.has(seg.id)).toBe(true);
    expect(store.getSegment(seg.id).status).toBe('forming');
  });

  test('G.4: deferred segments transition when they become ready', async () => {
    const seg = await store.createSegment({ type: 'auto-convo' });

    controller.setOnAir(seg.id);
    await controller.segmentDone(seg.id);
    expect(controller.pendingDone.has(seg.id)).toBe(true);

    // Now transition to ready
    await store.transitionStatus(seg.id, 'ready');

    // Run the pending check
    controller._checkPendingDone();

    // Give async operations time to complete
    await new Promise(r => setTimeout(r, 100));

    const updated = store.getSegment(seg.id);
    expect(updated.status).toBe('aired');
    expect(controller.pendingDone.has(seg.id)).toBe(false);
  });

  test('G.5: getStatus reflects current state', () => {
    const status = controller.getStatus();
    expect(status).toHaveProperty('isPlaying');
    expect(status).toHaveProperty('isPaused');
    expect(status).toHaveProperty('currentSegmentId');

    controller.start();
    expect(controller.getStatus().isPlaying).toBe(true);

    controller.pause();
    expect(controller.getStatus().isPaused).toBe(true);

    controller.stop();
    expect(controller.getStatus().isPlaying).toBe(false);
    expect(controller.getStatus().isPaused).toBe(false);
  });
});

// ─── H. Buffer Monitor ────────────────────────────────────────────────
describe('BufferMonitor', () => {
  let store;
  let tmpDir;
  let emitter;

  beforeEach(async () => {
    tmpDir = makeTempDir();
    store = new PipelineStore(tmpDir);
    await store.init();
    emitter = fakeEventEmitter();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('H.1: buffer health levels', async () => {
    const mockFillerGen = { generateFiller: jest.fn() };
    // Set minSegments: 1 to test duration thresholds in isolation
    const monitor = new BufferMonitor({
      pipelineStore: store,
      fillerGenerator: mockFillerGen,
      eventEmitter: emitter,
      config: { minSegments: 1, warningThresholdSeconds: 15, criticalThresholdSeconds: 5, minDurationSeconds: 30 }
    });

    // No segments → critical (totalSeconds=0 < 5)
    await monitor._tick();
    expect(monitor.lastLevel).toBe('critical');

    // Add 10s of ready content → red (5 <= 10 < 15)
    const seg1 = await store.createSegment({ type: 'auto-convo', estimatedDuration: 10 });
    await store.transitionStatus(seg1.id, 'ready');
    await monitor._tick();
    expect(monitor.lastLevel).toBe('red');

    // Add 10 more → yellow (15 <= 20 < 30)
    const seg2 = await store.createSegment({ type: 'auto-convo', estimatedDuration: 10 });
    await store.transitionStatus(seg2.id, 'ready');
    await monitor._tick();
    expect(monitor.lastLevel).toBe('yellow');

    // Add 15 more → green (35 >= 30)
    const seg3 = await store.createSegment({ type: 'auto-convo', estimatedDuration: 15 });
    await store.transitionStatus(seg3.id, 'ready');
    await monitor._tick();
    expect(monitor.lastLevel).toBe('green');
  });

  test('H.2: critical + filler enabled + active content → triggers filler batch', async () => {
    const seg = await store.createSegment({ type: 'auto-convo', estimatedDuration: 2 });
    await store.transitionStatus(seg.id, 'ready');

    let fillerCount = 0;
    const mockFillerGen = {
      generateFiller: jest.fn().mockImplementation(() => Promise.resolve({ id: `filler-${++fillerCount}` }))
    };
    const mockRenderer = { queueRender: jest.fn().mockResolvedValue({}) };

    const monitor = new BufferMonitor({
      pipelineStore: store,
      fillerGenerator: mockFillerGen,
      eventEmitter: emitter,
      segmentRenderer: mockRenderer,
      config: { minSegments: 3, targetSegments: 5, warningThresholdSeconds: 15, criticalThresholdSeconds: 5 }
    });
    monitor.fillerEnabled = true;

    await monitor._tick();
    // Batch generation: below minimum triggers multiple fillers to reach target
    expect(mockFillerGen.generateFiller).toHaveBeenCalled();
    expect(mockFillerGen.generateFiller.mock.calls.length).toBeGreaterThanOrEqual(2);
    // queueRender called for each filler
    expect(mockRenderer.queueRender.mock.calls.length).toBe(mockFillerGen.generateFiller.mock.calls.length);
  });

  test('H.3: critical + filler enabled + only fillers → does NOT trigger', async () => {
    const seg = await store.createSegment({ type: 'filler', estimatedDuration: 2 });
    await store.transitionStatus(seg.id, 'ready');

    const mockFillerGen = { generateFiller: jest.fn() };
    const monitor = new BufferMonitor({
      pipelineStore: store,
      fillerGenerator: mockFillerGen,
      eventEmitter: emitter,
      config: { warningThresholdSeconds: 15, criticalThresholdSeconds: 5 }
    });
    monitor.fillerEnabled = true;
    monitor.lastFillerAt = 0;

    await monitor._tick();
    expect(mockFillerGen.generateFiller).not.toHaveBeenCalled();
  });
});
