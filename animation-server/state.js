// Animation state manager - tracks current animation state for live streaming

class AnimationState {
  constructor() {
    this.speakingCharacter = null;  // 'chad' | 'virgin' | null
    this.currentPhoneme = 'A';      // Current mouth shape
    this.phonemeCues = [];          // Lip-sync timeline
    this.audioStartTime = null;     // When current audio started
    this.audioDuration = 0;         // Duration of current audio
    this.audioPath = null;          // Path to current audio file
    this.isPlaying = false;
  }

  startSpeaking(character, cues, audioPath, duration) {
    this.speakingCharacter = character;
    this.phonemeCues = cues;
    this.audioStartTime = Date.now();
    this.audioDuration = duration * 1000; // Convert to ms
    this.audioPath = audioPath;
    this.isPlaying = true;
    this.currentPhoneme = 'A';
    console.log(`[State] ${character} started speaking (${duration.toFixed(2)}s)`);
  }

  update() {
    if (!this.isPlaying || !this.audioStartTime) {
      this.currentPhoneme = 'A';
      return;
    }

    const elapsed = (Date.now() - this.audioStartTime) / 1000; // seconds

    // Check if audio finished
    if (elapsed >= this.audioDuration / 1000) {
      this.stopSpeaking();
      return;
    }

    // Find current phoneme from cues
    for (const cue of this.phonemeCues) {
      if (elapsed >= cue.start && elapsed < cue.end) {
        this.currentPhoneme = cue.phoneme;
        return;
      }
    }

    this.currentPhoneme = 'A';
  }

  stopSpeaking() {
    console.log(`[State] ${this.speakingCharacter} stopped speaking`);
    this.speakingCharacter = null;
    this.phonemeCues = [];
    this.audioStartTime = null;
    this.audioDuration = 0;
    this.audioPath = null;
    this.isPlaying = false;
    this.currentPhoneme = 'A';
  }

  getState() {
    this.update();
    return {
      speakingCharacter: this.speakingCharacter,
      phoneme: this.currentPhoneme,
      isPlaying: this.isPlaying,
      audioPath: this.audioPath
    };
  }
}

module.exports = AnimationState;
