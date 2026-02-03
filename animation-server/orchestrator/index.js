const ScriptGenerator = require('./script-generator');
const BridgeGenerator = require('./bridge-generator');
const FillerGenerator = require('./filler-generator');
const SegmentRenderer = require('./segment-renderer');
const PlaybackController = require('./playback-controller');
const BufferMonitor = require('./buffer-monitor');
const ChatIntakeAgent = require('./chat-intake');

class Orchestrator {
  constructor({ openai, pipelineStore, mediaLibrary, tvLayerManager, animationServerUrl, eventEmitter, config }) {
    this.scriptGenerator = openai ? new ScriptGenerator({ openai, pipelineStore, mediaLibrary }) : null;
    this.bridgeGenerator = openai ? new BridgeGenerator({ openai, pipelineStore }) : null;
    this.fillerGenerator = openai ? new FillerGenerator({ openai, pipelineStore }) : null;
    this.segmentRenderer = new SegmentRenderer({
      pipelineStore,
      animationServerUrl,
      eventEmitter,
      maxConcurrent: config?.rendering?.maxConcurrentForming || 2
    });
    this.playbackController = new PlaybackController({
      pipelineStore,
      tvLayerManager,
      segmentRenderer: this.segmentRenderer,
      animationServerUrl,
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
      openai,
      scriptGenerator: this.scriptGenerator,
      pipelineStore,
      segmentRenderer: this.segmentRenderer,
      eventEmitter
    });
    this.chatIntakeEnabled = config?.chatIntake?.enabled !== false;

    if (config?.chatIntake?.ratePerMinute) {
      this.chatIntake.setIntakeRate(config.chatIntake.ratePerMinute);
    }
    if (typeof config?.chatIntake?.autoApprove !== 'undefined') {
      this.chatIntake.setAutoApprove(config.chatIntake.autoApprove);
    }
  }

  init() {
    this.bufferMonitor.start();
    if (this.chatIntake && (this.chatIntakeEnabled !== false)) {
      this.chatIntake.start();
    }
  }
}

module.exports = Orchestrator;
