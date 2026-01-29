// Example: How to integrate real-time lip sync with the animation server
// This shows the architectural changes needed

/*
 * CURRENT ARCHITECTURE (timestamp-based):
 * ========================================
 *
 *   POST /render
 *       ↓
 *   analyzeLipSync(audio) ← Rhubarb (entire file, blocking)
 *       ↓
 *   Returns [{start, end, phoneme}, ...]
 *       ↓
 *   animationState.startSpeaking(cues)
 *       ↓
 *   renderFrame() → getPhonemeAtTime(elapsed) → lookup in pre-calculated array
 *
 *
 * NEW ARCHITECTURE (real-time):
 * =============================
 *
 *   POST /render
 *       ↓
 *   decodeAudio(audio) ← Just decode to samples (fast)
 *       ↓
 *   syncedPlayback.load(samples)
 *       ↓
 *   syncedPlayback.start()
 *       ↓
 *   renderFrame() → syncedPlayback.tick() → analyze CURRENT chunk → immediate phoneme
 *
 *
 * The key difference: phoneme is determined BY the current audio chunk,
 * not looked up from a pre-calculated timestamp table.
 */

const SyncedPlayback = require('./synced-playback');

// Example modified render frame callback
function createRealtimeRenderCallback(compositor, blinkControllers) {
  const syncedPlayback = new SyncedPlayback(16000, 30);

  // This replaces the current renderFrame function
  async function renderFrame(frameNumber) {
    // Get real-time lip sync result
    const { phoneme, character, done } = syncedPlayback.tick();

    // Determine mouth shapes
    const chadPhoneme = character === 'chad' ? phoneme : 'A';
    const virginPhoneme = character === 'virgin' ? phoneme : 'A';

    // Blinking (same as before)
    const chadBlinking = blinkControllers.chad.update(frameNumber, character === 'chad');
    const virginBlinking = blinkControllers.virgin.update(frameNumber, character === 'virgin');

    // Composite frame
    const buffer = await compositor.compositeFrame({
      chadPhoneme,
      virginPhoneme,
      chadBlinking,
      virginBlinking
    });

    return buffer;
  }

  // This replaces the /render endpoint logic
  async function handleRenderRequest(audioPath, character) {
    // Fast: just decode audio, no Rhubarb
    const { duration, totalFrames } = await syncedPlayback.load(audioPath, character);

    // Start synchronized playback
    syncedPlayback.start();

    return { duration, totalFrames };
  }

  return {
    renderFrame,
    handleRenderRequest,
    syncedPlayback
  };
}

/*
 * FULL INTEGRATION EXAMPLE
 * ========================
 *
 * Here's how the modified server.js would look:
 */

const exampleServerCode = `
// In server.js - replace the /render endpoint:

const SyncedPlayback = require('./synced-playback');
const syncedPlayback = new SyncedPlayback(16000, 30);

// Modified frame renderer - uses real-time analysis
async function renderFrame(frame) {
  frameCount = frame;

  // CHANGED: Get phoneme from real-time analysis, not timestamp lookup
  const { phoneme, character, done } = syncedPlayback.tick();

  const chadPhoneme = character === 'chad' ? phoneme : 'A';
  const virginPhoneme = character === 'virgin' ? phoneme : 'A';

  const chadBlinking = blinkControllers.chad.update(frame, character === 'chad');
  const virginBlinking = blinkControllers.virgin.update(frame, character === 'virgin');

  if (frame % 30 === 0) {
    const stateStr = character ? \`\${character} speaking (\${phoneme})\` : 'idle';
    console.log(\`[Frame \${frame}] \${stateStr}\`);
  }

  try {
    const buffer = await compositeFrame({
      chadPhoneme,
      virginPhoneme,
      chadBlinking,
      virginBlinking
    });
    return buffer;
  } catch (err) {
    console.error('[Render] Frame error:', err.message);
    return null;
  }
}

// Modified /render endpoint
app.post('/render', upload.single('audio'), async (req, res) => {
  const character = req.body.character || 'chad';

  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' });
  }

  const audioPath = req.file.path;
  const audioId = crypto.randomBytes(8).toString('hex');
  const audioMp3Path = path.join(AUDIO_DIR, \`\${audioId}.mp3\`);

  try {
    fs.renameSync(audioPath, audioMp3Path);

    // CHANGED: Use real-time playback instead of Rhubarb analysis
    console.log(\`[Render] Loading audio for \${character}...\`);
    const { duration, totalFrames } = await syncedPlayback.load(audioMp3Path, character);

    console.log(\`[Render] Duration: \${duration.toFixed(2)}s, Frames: \${totalFrames}\`);

    // Start synchronized playback
    syncedPlayback.start();

    // Schedule cleanup
    setTimeout(() => {
      try { fs.unlinkSync(audioMp3Path); } catch (e) {}
    }, (duration + 5) * 1000);

    res.json({
      streamUrl: streamManager.getStreamUrl(),
      audioUrl: \`/audio/\${audioId}.mp3\`,
      duration
    });

  } catch (error) {
    console.error('[Render] Error:', error);
    res.status(500).json({ error: error.message });
    try { fs.unlinkSync(audioMp3Path); } catch (e) {}
  }
});
`;

/*
 * BENEFITS OF THIS APPROACH:
 * ==========================
 *
 * 1. NO PRE-CALCULATION: Phonemes determined in real-time
 *
 * 2. INHERENT SYNC: The mouth shape is caused by the current audio,
 *    not looked up from a table that might drift
 *
 * 3. FASTER STARTUP: No waiting for Rhubarb analysis
 *    - Rhubarb: ~2-5 seconds for a 10-second audio
 *    - Real-time: ~50ms to decode audio
 *
 * 4. SIMPLER STATE: No timestamp tracking needed
 *    - Just call tick() each frame
 *    - Phoneme comes directly from current audio
 *
 * 5. FUTURE: Could work with streaming audio
 *    - Process chunks as they arrive from ElevenLabs
 *    - Start animation before full audio is ready
 */

/*
 * COMPARISON: ACCURACY vs RHUBARB
 * ===============================
 *
 * Run the test script to compare:
 *
 *   node test-realtime-lipsync.js path/to/audio.mp3
 *
 * Expected results:
 * - Exact match: 40-60% (different algorithms)
 * - Visual quality: Comparable (both drive convincing lip sync)
 * - Latency: Real-time wins (no pre-analysis)
 *
 * The real-time analyzer won't match Rhubarb exactly because:
 * - Rhubarb uses phonetic recognition (understands speech)
 * - Real-time uses acoustic features (energy, frequency)
 *
 * But for animation purposes, what matters is:
 * - Mouth opens during loud vowels (both do this)
 * - Mouth closes during silence (both do this)
 * - Transitions look natural (both do this)
 */

module.exports = { createRealtimeRenderCallback };
