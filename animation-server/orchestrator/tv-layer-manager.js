class TVLayerManager {
  constructor(tvService, mediaLibrary) {
    this.tvService = tvService;
    this.mediaLibrary = mediaLibrary;

    this.defaultMediaId = null;
    this.currentOverride = null;   // { mediaId, source: 'segment'|'manual' }
    this.manualOverride = false;
  }

  async setDefault(mediaId) {
    const item = this.mediaLibrary.get(mediaId);
    if (!item) {
      throw new Error(`Media item not found: ${mediaId}`);
    }

    this.defaultMediaId = mediaId;
    console.log(`[TVLayer] Default set to: ${mediaId} (${item.originalName})`);

    if (!this.currentOverride && !this.manualOverride) {
      await this._pushToTV(mediaId);
    }
  }

  async pushOverride(mediaId) {
    if (this.manualOverride) {
      console.log('[TVLayer] Manual override active, ignoring segment override');
      return;
    }

    const item = this.mediaLibrary.get(mediaId);
    if (!item) {
      throw new Error(`Media item not found: ${mediaId}`);
    }

    this.currentOverride = { mediaId, source: 'segment' };
    console.log(`[TVLayer] Segment override: ${mediaId} (${item.originalName})`);
    await this._pushToTV(mediaId);
  }

  async pushManualOverride(mediaId) {
    const item = this.mediaLibrary.get(mediaId);
    if (!item) {
      throw new Error(`Media item not found: ${mediaId}`);
    }

    this.manualOverride = true;
    this.currentOverride = { mediaId, source: 'manual' };
    console.log(`[TVLayer] Manual override: ${mediaId} (${item.originalName})`);
    await this._pushToTV(mediaId);
  }

  async releaseOverride() {
    if (this.currentOverride && this.currentOverride.source === 'segment') {
      this.currentOverride = null;
      console.log('[TVLayer] Segment override released');
    }

    if (!this.manualOverride && this.defaultMediaId) {
      await this._pushToTV(this.defaultMediaId);
    }
  }

  async clearManualOverride() {
    this.manualOverride = false;

    if (this.currentOverride && this.currentOverride.source === 'manual') {
      this.currentOverride = null;
    }

    console.log('[TVLayer] Manual override cleared');

    // Revert to segment override if one exists, otherwise default
    if (this.currentOverride && this.currentOverride.source === 'segment') {
      await this._pushToTV(this.currentOverride.mediaId);
    } else if (this.defaultMediaId) {
      await this._pushToTV(this.defaultMediaId);
    }
  }

  getState() {
    let effectiveMediaId = null;
    if (this.manualOverride && this.currentOverride) {
      effectiveMediaId = this.currentOverride.mediaId;
    } else if (this.currentOverride) {
      effectiveMediaId = this.currentOverride.mediaId;
    } else {
      effectiveMediaId = this.defaultMediaId;
    }

    return {
      defaultMediaId: this.defaultMediaId,
      currentOverride: this.currentOverride,
      manualOverride: this.manualOverride,
      effectiveMediaId
    };
  }

  async _pushToTV(mediaId) {
    const item = this.mediaLibrary.get(mediaId);
    if (!item) return;

    const filePath = this.mediaLibrary.getOriginalPath(mediaId);
    if (!filePath) return;

    this.tvService.clear();
    await this.tvService.addItem({
      type: item.type,
      source: filePath,
      mediaId: mediaId
    });
    this.tvService.play();

    console.log(`[TVLayer] Pushed to TV: ${mediaId} (${item.originalName})`);
  }
}

module.exports = TVLayerManager;
