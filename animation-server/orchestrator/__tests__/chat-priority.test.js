const path = require('path');
const fs = require('fs');
const os = require('os');

jest.mock('../../../voices', () => ({
  chad: { name: 'Chad', elevenLabsVoiceId: 'fake-chad' },
  virgin: { name: 'Virgin', elevenLabsVoiceId: 'fake-virgin' }
}));
jest.mock('axios');

const PipelineStore = require('../pipeline-store');
const ChatIntakeAgent = require('../chat-intake');
const SegmentRenderer = require('../segment-renderer');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chat-priority-test-'));
}

const order = store => store.getAllSegments().map(s => s.seed);

describe('Chat airs next, not at the end of the pipeline', () => {
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

  // aired history, one on air, then a ready convo, a forming expand and a filler
  async function buildQueue() {
    const old = await store.createSegment({ type: 'auto-convo', seed: 'old' });
    await store.transitionStatus(old.id, 'ready');
    await store.transitionStatus(old.id, 'aired');
    const onAir = await store.createSegment({ type: 'auto-convo', seed: 'on-air', estimatedDuration: 45 });
    await store.transitionStatus(onAir.id, 'ready');
    const next = await store.createSegment({ type: 'auto-convo', seed: 'next', estimatedDuration: 40 });
    await store.transitionStatus(next.id, 'ready');
    await store.createSegment({ type: 'expand', seed: 'expand' });
    await store.createSegment({ type: 'filler', seed: 'filler' });
  }

  async function chatPair(seed) {
    const cue = await store.createSegment({ type: 'narrator-cue', seed: `${seed}-cue`, metadata: { chatCardId: seed, isNarratorCue: true } });
    const reply = await store.createSegment({ type: 'chat-response', seed: `${seed}-reply`, metadata: { chatCardId: seed, hasNarratorPair: true } });
    return [cue.id, reply.id];
  }

  test('pair lands right after the on-air segment, in order', async () => {
    await buildQueue();
    await store.prioritizeChat(await chatPair('a'));
    expect(order(store)).toEqual(['old', 'on-air', 'a-cue', 'a-reply', 'next', 'expand', 'filler']);
  });

  test('later viewers queue behind earlier ones', async () => {
    await buildQueue();
    await store.prioritizeChat(await chatPair('a'));
    await store.prioritizeChat(await chatPair('b'));
    expect(order(store)).toEqual(['old', 'on-air', 'a-cue', 'a-reply', 'b-cue', 'b-reply', 'next', 'expand', 'filler']);
  });

  test('with nothing on air, goes after the aired history', async () => {
    const old = await store.createSegment({ type: 'auto-convo', seed: 'old' });
    await store.transitionStatus(old.id, 'ready');
    await store.transitionStatus(old.id, 'aired');
    await store.createSegment({ type: 'auto-convo', seed: 'forming' });
    await store.prioritizeChat(await chatPair('a'));
    expect(order(store)).toEqual(['old', 'a-cue', 'a-reply', 'forming']);
  });

  test('does not split a bridge on air from the convo it leads into', async () => {
    const target = await store.createSegment({ type: 'auto-convo', seed: 'target' });
    const bridge = await store.createSegment({ type: 'transition', seed: 'bridge', metadata: { bridgeFor: target.id } });
    await store.insertAt(bridge.id, 0);
    await store.transitionStatus(bridge.id, 'ready');
    await store.prioritizeChat(await chatPair('a'));
    expect(order(store)).toEqual(['bridge', 'target', 'a-cue', 'a-reply']);
  });

  test('auto-approved chat with a written reply is queued next', async () => {
    await buildQueue();
    const queueRender = jest.fn().mockResolvedValue(null);
    const intake = new ChatIntakeAgent({
      pipelineStore: store,
      segmentRenderer: { queueRender },
      eventEmitter: { broadcast: jest.fn() }
    });
    intake.setAutoApprove(true);

    const card = intake.addMessage('viewer', 'yo chad what is good', { speaker: 'chad', text: 'Living the dream.' });
    // Until both renders are queued (a fixed 50ms flaked when the whole suite runs in parallel)
    for (let t = 0; t < 2000 && queueRender.mock.calls.length < 2; t += 10) await new Promise(r => setTimeout(r, 10));

    const segs = store.getAllSegments();
    expect(segs.map(s => s.type)).toEqual(['auto-convo', 'auto-convo', 'narrator-cue', 'chat-response', 'auto-convo', 'expand', 'filler']);
    expect(segs[2].metadata.chatCardId).toBe(card.id);
    expect(segs[3].metadata.chatCardId).toBe(card.id);
    expect(queueRender).toHaveBeenCalledTimes(2);
  });

  test('renderer pushes chat audio before a convo still rendering behind it', async () => {
    await buildQueue();
    const [cueId, replyId] = await chatPair('a');
    await store.prioritizeChat([cueId, replyId]);

    const renderer = new SegmentRenderer({ pipelineStore: store });
    try {
      // The expand and filler are still forming; the chat cue's TTS is done
      renderer.pendingPushes.set(cueId, {});
      expect(renderer._getNextPipelineSegment()).toBe(cueId);
    } finally {
      clearInterval(renderer._dequeueInterval);
    }
  });
});
