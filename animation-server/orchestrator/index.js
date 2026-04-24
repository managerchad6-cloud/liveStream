const crypto = require('crypto');
const axios = require('axios');
const ScriptGenerator = require('./script-generator');
const BridgeGenerator = require('./bridge-generator');
const FillerGenerator = require('./filler-generator');
const SegmentRenderer = require('./segment-renderer');
const PlaybackController = require('./playback-controller');
const BufferMonitor = require('./buffer-monitor');
const ChatIntakeAgent = require('./chat-intake');
const PumpChatListener = require('./pump-chat-listener');
const VideoReactionPlanner = require('./video-reaction-planner');
const VideoReactionSession = require('./video-reaction-session');

class Orchestrator {
  constructor({ openai, pipelineStore, mediaLibrary, tvLayerManager, animationServerUrl, eventEmitter, config, onChatMessage, onMemeCommand, onVoteMemeCommand, tvService }) {
    this.pipelineStore = pipelineStore;
    this.openai = openai || null;
    this.animationServerUrl = animationServerUrl;
    this.tvService = tvService || null;

    // Video reaction session state
    this._videoSessions = new Map(); // sessionId → { state, progress, plan, session }
    this.activeVideoSession = null;

    this.scriptGenerator = openai ? new ScriptGenerator({ openai, pipelineStore }) : null;
    this.bridgeGenerator = openai ? new BridgeGenerator({ openai, pipelineStore }) : null;
    this.fillerGenerator = openai ? new FillerGenerator({ openai, pipelineStore }) : null;
    this.segmentRenderer = new SegmentRenderer({
      pipelineStore,
      animationServerUrl,
      eventEmitter,
      maxConcurrent: config?.rendering?.maxConcurrentForming || 3
    });
    this.playbackController = new PlaybackController({
      pipelineStore,
      eventEmitter,
      scriptGenerator: this.scriptGenerator,
      segmentRenderer: this.segmentRenderer
    });

    this.bufferMonitor = new BufferMonitor({
      pipelineStore,
      fillerGenerator: this.fillerGenerator,
      eventEmitter,
      segmentRenderer: this.segmentRenderer,
      config: { ...config?.buffer, enabled: config?.filler?.enabled }
    });

    this.chatIntake = new ChatIntakeAgent({
      scriptGenerator: this.scriptGenerator,
      pipelineStore,
      segmentRenderer: this.segmentRenderer,
      eventEmitter,
      onChatMessage
    });
    this.chatIntake.queueSegmentWithBridge = (segmentId) => this.queueSegmentWithBridge(segmentId);
    this.chatIntakeEnabled = config?.chatIntake?.enabled !== false;

    if (config?.chatIntake?.ratePerMinute) {
      this.chatIntake.setIntakeRate(config.chatIntake.ratePerMinute);
    }
    if (config?.chatIntake?.autoApprove) {
      this.chatIntake.setAutoApprove(config.chatIntake.autoApprove);
    }

    this.pumpChatListener = new PumpChatListener({
      chatIntake: this.chatIntake,
      token: process.env.PUMP_FUN_TOKEN || null,
      onMemeCommand: onMemeCommand || null,
      onVoteMemeCommand: onVoteMemeCommand || null
    });
  }

  init() {
    this.playbackController.start();
    console.log('[Orchestrator] Playback controller auto-started');
    this.bufferMonitor.start();
    if (this.chatIntake && (this.chatIntakeEnabled !== false)) {
      this.chatIntake.start();
    }
    this.pumpChatListener.start();
  }

  setToken(newToken) {
    console.log(`[Orchestrator] Switching pump token to: ${newToken ? newToken.slice(0, 12) + '…' : '(none)'}`);
    this.pumpChatListener.stop();
    this.pumpChatListener.token = newToken || null;
    if (newToken) this.pumpChatListener.start();
  }

  /**
   * Queue a segment for rendering, generating a bridge before it if needed.
   * Bridge is not generated for fillers, transitions, or when no preceding exitContext.
   */
  async queueSegmentWithBridge(segmentId) {
    const segment = this.pipelineStore.getSegment(segmentId);
    if (!segment) throw new Error(`Segment not found: ${segmentId}`);

    const skipBridgeTypes = ['filler', 'transition'];
    const needsBridge = !skipBridgeTypes.includes(segment.type) && this.bridgeGenerator;

    if (needsBridge) {
      // Find the preceding segment with exitContext
      const allSegments = this.pipelineStore.getAllSegments();
      const segIndex = allSegments.findIndex(s => s.id === segmentId);
      let precedingExitContext = null;
      let precedingId = null;
      let lastSpeaker = null;
      let precedingType = null;

      // Walk backwards to find the most recent segment with exitContext
      for (let i = segIndex - 1; i >= 0; i--) {
        const prev = allSegments[i];
        if (prev && prev.exitContext) {
          precedingExitContext = prev.exitContext;
          precedingId = prev.id;
          precedingType = prev.type || null;
          // Get last speaker from the preceding segment's script
          const script = prev.script;
          if (Array.isArray(script) && script.length > 0) {
            lastSpeaker = script[script.length - 1].speaker;
          }
          break;
        }
      }

      // Only generate bridges TO auto-convo or custom-script segments (entry points),
      // not FROM them (exit points). This prevents double transitions.
      const targetIsAutoOrScripted = ['auto-convo', 'custom-script'].includes(segment.type);
      const typeChanged = precedingType && precedingType !== segment.type;
      if (targetIsAutoOrScripted && typeChanged && precedingExitContext && segment.seed) {
        try {
          // Gather recent conversation history for context-aware bridging
          // Walk backwards from the bridge point and collect the last ~8 dialogue lines
          const conversationHistory = [];
          for (let i = segIndex - 1; i >= 0 && conversationHistory.length < 8; i--) {
            const prev = allSegments[i];
            if (!prev || !Array.isArray(prev.script)) continue;
            // Skip narrator lines, collect character dialogue only
            const charLines = prev.script.filter(l => l.speaker !== 'narrator');
            for (let j = charLines.length - 1; j >= 0 && conversationHistory.length < 8; j--) {
              conversationHistory.unshift(charLines[j]);
            }
          }

          // Determine who opens the target segment so the bridge uses the opposite speaker
          const targetFirstSpeaker = Array.isArray(segment.script) && segment.script.length > 0
            ? segment.script.find(l => l.speaker !== 'narrator')?.speaker || null
            : null;

          const bridge = await this.bridgeGenerator.generateBridge(
            precedingExitContext,
            segment.seed,
            lastSpeaker || 'chad',
            { bridgeFor: segmentId, bridgeAfter: precedingId, conversationHistory, targetFirstSpeaker }
          );

          // Insert bridge just before the target segment
          const targetIndex = this.pipelineStore.getAllSegments().findIndex(s => s.id === segmentId);
          if (targetIndex > 0) {
            await this.pipelineStore.insertAt(bridge.id, targetIndex);
          }

          // Render bridge with gating — bridge must push audio before target
          this.segmentRenderer.renderAndPushBridge(bridge.id, segmentId).catch(err => {
            console.warn(`[Orchestrator] Bridge render failed: ${err.message}`);
          });
        } catch (err) {
          console.warn(`[Orchestrator] Bridge generation failed, proceeding without: ${err.message}`);
        }
      }
    }

    // Queue the target segment for rendering
    return this.segmentRenderer.queueRender(segmentId);
  }

  setFillerEnabled(enabled) {
    this.bufferMonitor.fillerEnabled = Boolean(enabled);
  }

  getFillerEnabled() {
    return this.bufferMonitor.fillerEnabled;
  }

  // ── Video Reaction ────────────────────────────────────────────────────────────

  /**
   * Begin planning a video reaction session. Returns sessionId immediately;
   * poll getVideoSessionStatus(sessionId) for progress.
   */
  prepareVideoReaction(url) {
    if (!this.openai) throw new Error('OpenAI not configured');
    if (!process.env.ELEVENLABS_API_KEY) throw new Error('ElevenLabs API key not configured');

    const sessionId = crypto.randomUUID();
    const entry = {
      state: 'preparing',
      progress: {},
      plan: null,
      session: null,
      error: null
    };
    this._videoSessions.set(sessionId, entry);

    const planner = new VideoReactionPlanner({
      openai: this.openai,
      elevenLabsApiKey: process.env.ELEVENLABS_API_KEY,
      ttsModel: process.env.AUTO_TTS_MODEL || 'eleven_v3'
    });

    planner.on('progress', update => {
      entry.progress[update.step] = { status: update.status, detail: update.detail || null };
      // As soon as the video is downloaded, pre-load it into the TV playlist so it's
      // fully decoded before the user clicks Start.
      if (update.step === 'download' && update.status === 'done' && update.videoPath) {
        const videoPath = update.videoPath;
        entry.tvPreloadPromise = (async () => {
          await axios.post(`${this.animationServerUrl}/tv/playlist/clear`).catch(() => {});
          await axios.post(`${this.animationServerUrl}/tv/playlist/add`, {
            type: 'video',
            source: videoPath
          });
          await this._waitForTVVideoLoaded();
          console.log('[Orchestrator] TV video pre-load complete');
        })().catch(err => {
          console.warn('[Orchestrator] TV pre-load failed:', err.message);
        });
      }
    });

    planner.plan(url).then(plan => {
      entry.plan = plan;
      entry.state = 'ready';
      console.log(`[Orchestrator] Video reaction plan ready: "${plan.title}" (${plan.beats.length} beats)`);
    }).catch(err => {
      entry.state = 'failed';
      entry.error = err.message;
      console.error(`[Orchestrator] Video reaction plan failed: ${err.message}`);
    });

    return sessionId;
  }

  getVideoSessionStatus(sessionId) {
    const entry = this._videoSessions.get(sessionId);
    if (!entry) return null;
    return {
      state: entry.state,
      progress: entry.progress,
      error: entry.error,
      plan: entry.plan ? {
        title: entry.plan.title,
        uploader: entry.plan.uploader,
        videoDuration: entry.plan.videoDuration,
        beatCount: entry.plan.beats.length
      } : null,
      session: entry.session ? entry.session.getStatus() : null
    };
  }

  /**
   * Add the intro segment to the pipeline and arm the session.
   * The session activates when the intro goes on-air.
   */
  async startVideoReaction(sessionId) {
    if (!this.tvService) throw new Error('TV service not available');
    const entry = this._videoSessions.get(sessionId);
    if (!entry) throw new Error('Session not found');
    if (entry.state !== 'ready') throw new Error(`Session not ready (state: ${entry.state})`);
    if (this.activeVideoSession) throw new Error('Another video reaction session is already active');

    const plan = entry.plan;

    // Wait for TV video to finish loading (pre-load started when download finished).
    // If pre-load somehow didn't happen, fall back to loading now.
    if (entry.tvPreloadPromise) {
      await entry.tvPreloadPromise;
    } else {
      await axios.post(`${this.animationServerUrl}/tv/playlist/clear`).catch(() => {});
      await axios.post(`${this.animationServerUrl}/tv/playlist/add`, {
        type: 'video',
        source: plan.tempVideoPath
      });
      await this._waitForTVVideoLoaded();
    }

    // Create intro segment in the normal pipeline
    const introSegment = await this.pipelineStore.createSegment({
      type: 'video-reaction-intro',
      seed: plan.title,
      script: plan.intro.script,
      estimatedDuration: plan.intro.estimatedDuration,
      exitContext: `video reaction: "${plan.title}"`
    });

    // Build and wire the session
    const session = new VideoReactionSession({
      plan,
      animationServerUrl: this.animationServerUrl,
      tvService: this.tvService,
      playbackController: this.playbackController
    });

    entry.session = session;
    entry.state = 'active';
    this.activeVideoSession = session;

    // On-air hook: activate session when the intro segment starts playing
    const hookFn = (segId) => {
      if (segId === introSegment.id) {
        session.activate();
        this._onSessionActive();
      }
    };
    this.playbackController.registerOnAirHook(hookFn);

    // Done hook: start TV as soon as the intro audio finishes (no word-count guessing).
    // HLS latency is the same for both audio and video frames, so they stay in sync.
    let introDone = false;
    const introDoneHook = (segId) => {
      if (!introDone && segId === introSegment.id) {
        introDone = true;
        session.startTV();
      }
    };
    this.playbackController.registerSegmentDoneHook(introDoneHook);
    entry.introDoneHook = introDoneHook;

    session.on('done', () => this._onSessionDone(sessionId));

    // Prioritize intro to front of queue (after any currently on-air segment)
    await this.pipelineStore.prioritizeSegment(introSegment.id);

    // Queue intro for TTS + render (goes through normal SegmentRenderer flow)
    this.segmentRenderer.queueRender(introSegment.id).catch(err => {
      console.error(`[Orchestrator] Intro render failed: ${err.message}`);
    });

    console.log(`[Orchestrator] Video reaction queued: "${plan.title}"`);
    return { introSegmentId: introSegment.id };
  }

  async _waitForTVVideoLoaded(timeoutMs = 10 * 60 * 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const item = this.tvService?.playlist?.[0];
      if (item?.loaded) return;
      if (item?.error) throw new Error(`TV video load failed: ${item.error}`);
      await new Promise(r => setTimeout(r, 1000));
    }
    console.warn('[Orchestrator] TV video load timed out — proceeding anyway');
  }

  cancelVideoReaction() {
    if (this.activeVideoSession) {
      this.activeVideoSession.cancel();
      // _onSessionDone will fire via 'done' event
    }
    // Cancel any preparing sessions too
    for (const [, entry] of this._videoSessions) {
      if (entry.state === 'preparing' || entry.state === 'ready') {
        entry.state = 'cancelled';
      }
    }
  }

  _onSessionActive() {
    // Suppress expand generation during the session
    this.playbackController.pause();
    // Hold chat auto-queue
    if (this.chatIntake) this.chatIntake.setHoldMode(true);
    console.log('[Orchestrator] Video session active — pipeline suppressed');
  }

  _onSessionDone(sessionId) {
    this.activeVideoSession = null;
    const entry = this._videoSessions.get(sessionId);
    if (entry) {
      entry.state = 'done';
      if (entry.introDoneHook) {
        this.playbackController.removeSegmentDoneHook(entry.introDoneHook);
        entry.introDoneHook = null;
      }
    }

    // Resume normal pipeline
    this.playbackController.start();

    // Flush any held chat messages
    if (this.chatIntake) this.chatIntake.flushHeld();

    console.log('[Orchestrator] Video session done — pipeline resumed');
  }
}

module.exports = Orchestrator;
