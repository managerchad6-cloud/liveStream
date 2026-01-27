class BlinkController {
  constructor(fps = 30) {
    this.fps = fps;
    this.isBlinking = false;
    this.blinkStartFrame = 0;
    this.nextBlinkFrame = this.getRandomBlinkFrame(0);
    this.blinkDurationFrames = 4;
  }

  getRandomBlinkFrame(currentFrame) {
    const minFrames = 3 * this.fps;
    const maxFrames = 5 * this.fps;
    return currentFrame + minFrames + Math.floor(Math.random() * (maxFrames - minFrames));
  }

  update(frameNumber, isSpeaking) {
    if (isSpeaking && !this.isBlinking) {
      this.nextBlinkFrame = Math.max(this.nextBlinkFrame, frameNumber + this.fps);
      return false;
    }

    if (!this.isBlinking && frameNumber >= this.nextBlinkFrame) {
      this.isBlinking = true;
      this.blinkStartFrame = frameNumber;
      return true;
    }

    if (this.isBlinking) {
      if (frameNumber >= this.blinkStartFrame + this.blinkDurationFrames) {
        this.isBlinking = false;
        this.nextBlinkFrame = this.getRandomBlinkFrame(frameNumber);
        return false;
      }
      return true;
    }

    return false;
  }

  reset() {
    this.isBlinking = false;
    this.nextBlinkFrame = this.getRandomBlinkFrame(0);
  }
}

module.exports = BlinkController;
