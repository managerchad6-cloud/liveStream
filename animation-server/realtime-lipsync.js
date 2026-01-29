// Real-time lip sync analyzer
// Analyzes audio chunks on-the-fly instead of pre-calculating timestamps

class RealtimeLipSync {
  constructor(sampleRate = 16000, fps = 30) {
    this.sampleRate = sampleRate;
    this.fps = fps;
    this.samplesPerFrame = Math.floor(sampleRate / fps); // ~1066 samples at 16kHz/15fps

    // Sub-frame analysis for faster phoneme detection
    this.analysisMultiplier = 6; // Analyze 6x per video frame for quicker phoneme changes
    this.samplesPerAnalysis = Math.floor(this.samplesPerFrame / this.analysisMultiplier);
    this.analysisHop = Math.max(1, Math.floor(this.samplesPerAnalysis / 2)); // 50% overlap

    // Thresholds (tune these based on your audio)
    this.silenceThreshold = 0.015;
    this.lowEnergyThreshold = 0.04;
    this.mediumEnergyThreshold = 0.08;
    this.highEnergyThreshold = 0.12;
    this.fricativeZcrThreshold = 0.35;

    // Reduced smoothing for faster response
    this.lastPhoneme = 'A';
    this.phonemeHoldFrames = 0;
    this.minHoldFrames = 1; // Slightly more persistence to reduce jitter
    this.fricativeHoldFrames = 2;
    this.fricativeHoldCounter = 0;
    this.fricativeHoldCounter = 0;

    // History for advanced analysis
    this.energyHistory = [];
    this.maxHistoryLength = 10;

    // Phoneme priority for sub-frame analysis (more open = higher priority)
    this.phonemePriority = { 'A': 0, 'B': 1, 'F': 2, 'G': 2, 'E': 3, 'C': 4, 'D': 5, 'H': 4 };
  }

  /**
   * Main entry point: analyze a chunk of audio samples
   * Uses sub-frame analysis for better fast-speech detection
   * @param {Float32Array|Array} samples - Audio samples for one frame
   * @returns {string} Phoneme code (A-H)
   */
  analyzeChunk(samples) {
    if (!samples || samples.length === 0) {
      return this.applySmoothing('A');
    }

    // Sub-frame analysis: analyze multiple smaller windows
    // and pick the most significant (most open) phoneme
    let bestPhoneme = 'A';
    let bestScore = 0;

    for (let start = 0; start < samples.length; start += this.analysisHop) {
      const end = Math.min(start + this.samplesPerAnalysis, samples.length);

      if (end <= start) continue;

      const subChunk = samples.slice(start, end);

      // Calculate features for this sub-chunk
      const rms = this.calculateRMS(subChunk);
      const zcr = this.calculateZCR(subChunk);
      const peak = this.calculatePeak(subChunk);

      // Track energy history
      this.updateEnergyHistory(rms);
      const avgEnergy = this.getAverageEnergy();

      // Classify phoneme
      const phoneme = this.classifyPhoneme(rms, zcr, peak, avgEnergy);
      const priority = this.phonemePriority[phoneme] || 0;
      const energyScore = this.highEnergyThreshold > 0
        ? Math.min(1, rms / this.highEnergyThreshold)
        : 0;
      const score = priority + energyScore;

      // Keep the most "open" phoneme from all sub-chunks
      if (score > bestScore) {
        bestScore = score;
        bestPhoneme = phoneme;
      }
    }

    return this.applySmoothing(bestPhoneme);
  }

  /**
   * RMS (Root Mean Square) - measures overall energy/loudness
   */
  calculateRMS(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }

  /**
   * Zero Crossing Rate - how often signal crosses zero
   * High ZCR = noisy/fricative sounds (s, f, sh)
   * Low ZCR = voiced sounds (vowels)
   */
  calculateZCR(samples) {
    let crossings = 0;
    for (let i = 1; i < samples.length; i++) {
      if ((samples[i] >= 0 && samples[i - 1] < 0) ||
          (samples[i] < 0 && samples[i - 1] >= 0)) {
        crossings++;
      }
    }
    return crossings / samples.length;
  }

  /**
   * Peak amplitude - useful for detecting plosives (p, b, t, d)
   */
  calculatePeak(samples) {
    let max = 0;
    for (let i = 0; i < samples.length; i++) {
      const abs = Math.abs(samples[i]);
      if (abs > max) max = abs;
    }
    return max;
  }

  /**
   * Simple spectral centroid - indicates "brightness" of sound
   * Higher = brighter (ee, i sounds)
   * Lower = darker (oo, ah sounds)
   */
  calculateSpectralCentroid(samples) {
    // Simple DFT for first few frequency bins
    const N = Math.min(samples.length, 256);
    let weightedSum = 0;
    let magnitudeSum = 0;

    for (let k = 1; k < N / 2; k++) {
      let real = 0, imag = 0;
      for (let n = 0; n < N; n++) {
        const angle = -2 * Math.PI * k * n / N;
        real += samples[n] * Math.cos(angle);
        imag += samples[n] * Math.sin(angle);
      }
      const magnitude = Math.sqrt(real * real + imag * imag);
      const frequency = k * this.sampleRate / N;
      weightedSum += frequency * magnitude;
      magnitudeSum += magnitude;
    }

    return magnitudeSum > 0 ? weightedSum / magnitudeSum : 0;
  }

  /**
   * Map audio features to phoneme/mouth shape
   *
   * Mouth shapes (Preston Blair phoneme set):
   * A - Closed/rest (M, B, P at rest, silence)
   * B - Slightly open (M, B, P during sound)
   * C - Open with teeth (E, I sounds)
   * D - Wide open (A, AH sounds)
   * E - Rounded (O sounds)
   * F - Upper teeth on lip (F, V sounds)
   * G - Tongue behind teeth (TH, L sounds)
   * H - Wide with tongue (L sounds)
   *
   * Strategy: Match Rhubarb's distribution more closely by:
   * - Using B more for medium energy (Rhubarb uses it ~33%)
   * - Using C for sustained medium-high energy
   * - Using D sparingly for peaks only
   */
  classifyPhoneme(rms, zcr, peak, avgEnergy) {
    const silence = avgEnergy > 0 ? Math.min(this.silenceThreshold, avgEnergy * 0.3) : this.silenceThreshold;
    const low = avgEnergy > 0 ? Math.min(this.lowEnergyThreshold, avgEnergy * 0.7) : this.lowEnergyThreshold;
    const medium = avgEnergy > 0 ? Math.min(this.mediumEnergyThreshold, avgEnergy * 1.1) : this.mediumEnergyThreshold;
    const high = avgEnergy > 0 ? Math.min(this.highEnergyThreshold, avgEnergy * 1.4) : this.highEnergyThreshold;

    // Silence -> closed mouth
    if (rms < silence) {
      if (peak > silence * 3) {
        return 'B';
      }
      return 'A';
    }

    // Very low energy: avoid misclassifying as fricatives
    if (rms < low) {
      return 'B';
    }

    // Fricatives (s, f, sh, th) - high ZCR with enough energy
    // Require a minimum RMS to avoid detecting gaps as hiss
    if (zcr > this.fricativeZcrThreshold && rms > medium * 0.7) {
      return 'F'; // Upper teeth visible
    }

    // Very high energy = wide open (D) - use sparingly
    if (rms > high * 1.3) {
      return 'D';
    }

    // High energy with low ZCR = clear vowel
    if (rms > high && zcr < 0.15) {
      return 'C'; // Open with teeth (like Rhubarb's common choice)
    }

    // Medium-high energy = partial open
    if (rms > medium) {
      // Slightly higher ZCR suggests front vowels (E, I)
      if (zcr > 0.12) {
        return 'C';
      }
      // Lower ZCR suggests back/rounded vowels (O, U)
      return 'E';
    }

    // Medium energy = B (most common in speech)
    if (rms > low) {
      return 'B';
    }

    return 'A'; // Default to closed
  }

  /**
   * Smooth phoneme transitions to prevent jitter
   */
  applySmoothing(newPhoneme) {
    if (this.lastPhoneme === 'F' && newPhoneme !== 'F') {
      if (this.fricativeHoldCounter < this.fricativeHoldFrames) {
        this.fricativeHoldCounter++;
        return this.lastPhoneme;
      }
    }

    if (newPhoneme === 'F') {
      this.fricativeHoldCounter = 0;
    } else if (this.lastPhoneme !== 'F') {
      this.fricativeHoldCounter = 0;
    }


    // If same phoneme, reset hold counter
    if (newPhoneme === this.lastPhoneme) {
      this.phonemeHoldFrames = 0;
      return newPhoneme;
    }

    // If different, only change if we've held long enough
    this.phonemeHoldFrames++;
    if (this.phonemeHoldFrames >= this.minHoldFrames) {
      this.lastPhoneme = newPhoneme;
      this.phonemeHoldFrames = 0;
      return newPhoneme;
    }

    // Hold previous phoneme
    return this.lastPhoneme;
  }

  /**
   * Track energy history for dynamic threshold adjustment
   */
  updateEnergyHistory(rms) {
    this.energyHistory.push(rms);
    if (this.energyHistory.length > this.maxHistoryLength) {
      this.energyHistory.shift();
    }
  }

  /**
   * Get average energy (useful for adaptive thresholds)
   */
  getAverageEnergy() {
    if (this.energyHistory.length === 0) return 0;
    return this.energyHistory.reduce((a, b) => a + b, 0) / this.energyHistory.length;
  }

  /**
   * Reset state (call when starting new audio)
   */
  reset() {
    this.lastPhoneme = 'A';
    this.phonemeHoldFrames = 0;
    this.energyHistory = [];
  }

  /**
   * Tune thresholds based on audio characteristics
   * Only samples first 1 second for speed (speech energy is consistent)
   */
  calibrate(samples) {
    const chunkSize = this.samplesPerAnalysis;
    const energies = [];

    // Only sample first 1 second (16000 samples at 16kHz) for speed
    const maxSamples = Math.min(samples.length, this.sampleRate);

    for (let i = 0; i < maxSamples - chunkSize; i += chunkSize) {
      const chunk = samples.slice(i, i + chunkSize);
      const rms = this.calculateRMS(chunk);
      if (rms > 0.001) {
        energies.push(rms);
      }
    }

    if (energies.length === 0) return;

    energies.sort((a, b) => a - b);

    const p10 = energies[Math.floor(energies.length * 0.1)];
    const p50 = energies[Math.floor(energies.length * 0.5)];
    const p75 = energies[Math.floor(energies.length * 0.75)];
    const p90 = energies[Math.floor(energies.length * 0.9)];

    this.silenceThreshold = p10 * 0.5;
    this.lowEnergyThreshold = p50 * 0.8;
    this.mediumEnergyThreshold = p75 * 0.9;
    this.highEnergyThreshold = p90 * 0.9;

    console.log('[RealtimeLipSync] Calibrated (1s sample):', {
      silence: this.silenceThreshold.toFixed(4),
      low: this.lowEnergyThreshold.toFixed(4),
      medium: this.mediumEnergyThreshold.toFixed(4),
      high: this.highEnergyThreshold.toFixed(4)
    });
  }
}

module.exports = RealtimeLipSync;
