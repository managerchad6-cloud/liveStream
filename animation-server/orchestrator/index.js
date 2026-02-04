const ScriptGenerator = require('./script-generator');
const BridgeGenerator = require('./bridge-generator');
const FillerGenerator = require('./filler-generator');
const SegmentRenderer = require('./segment-renderer');
const PlaybackController = require('./playback-controller');
const BufferMonitor = require('./buffer-monitor');
const ChatIntakeAgent = require('./chat-intake');

class Orchestrator {
  constructor({ openai, pipelineStore, mediaLibrary, tvLayerManager, animationServerUrl, eventEmitter, config }) {
    this.pipelineStore = pipelineStore;

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
      eventEmitter
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
      eventEmitter
    });
    this.chatIntake.queueSegmentWithBridge = (segmentId) => this.queueSegmentWithBridge(segmentId);
    this.chatIntakeEnabled = config?.chatIntake?.enabled !== false;

    if (config?.chatIntake?.ratePerMinute) {
      this.chatIntake.setIntakeRate(config.chatIntake.ratePerMinute);
    }
    if (config?.chatIntake?.autoApprove) {
      this.chatIntake.setAutoApprove(config.chatIntake.autoApprove);
    }
  }

  init() {
    this.playbackController.start();
    console.log('[Orchestrator] Playback controller auto-started');
    this.bufferMonitor.start();
    if (this.chatIntake && (this.chatIntakeEnabled !== false)) {
      this.chatIntake.start();
    }
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

      const typeChanged = precedingType && precedingType !== segment.type;
      if (typeChanged && precedingExitContext && segment.seed) {
        try {
          const bridge = await this.bridgeGenerator.generateBridge(
            precedingExitContext,
            segment.seed,
            lastSpeaker || 'chad',
            { bridgeFor: segmentId, bridgeAfter: precedingId }
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
}

module.exports = Orchestrator;
