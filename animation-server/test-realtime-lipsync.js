#!/usr/bin/env node
// Test script: Compare real-time lip sync vs Rhubarb
// Usage: node test-realtime-lipsync.js <audio-file.mp3>

const path = require('path');
const fs = require('fs');
const RealtimeLipSync = require('./realtime-lipsync');
const { decodeAudio } = require('./audio-decoder');
const { analyzeLipSync } = require('./lipsync');

const FPS = 30;
const SAMPLE_RATE = 16000;
const SAMPLES_PER_FRAME = Math.floor(SAMPLE_RATE / FPS);

async function compareAnalysis(audioPath) {
  console.log('='.repeat(60));
  console.log('Real-time Lip Sync Comparison Test');
  console.log('='.repeat(60));
  console.log(`Audio: ${audioPath}`);
  console.log(`Sample rate: ${SAMPLE_RATE}Hz, FPS: ${FPS}`);
  console.log(`Samples per frame: ${SAMPLES_PER_FRAME}`);
  console.log('');

  // Run both analyses
  console.log('[1/3] Decoding audio...');
  const { samples, duration } = await decodeAudio(audioPath, SAMPLE_RATE);
  console.log(`      Duration: ${duration.toFixed(2)}s, Samples: ${samples.length}`);

  console.log('[2/3] Running Rhubarb analysis...');
  const rhubarbCues = await analyzeLipSync(audioPath);
  console.log(`      Got ${rhubarbCues.length} cues from Rhubarb`);

  console.log('[3/3] Running real-time analysis...');
  const realtimeAnalyzer = new RealtimeLipSync(SAMPLE_RATE, FPS);

  // Optional: calibrate on the audio
  realtimeAnalyzer.calibrate(samples);

  const realtimeCues = [];
  const totalFrames = Math.ceil(samples.length / SAMPLES_PER_FRAME);

  for (let frame = 0; frame < totalFrames; frame++) {
    const start = frame * SAMPLES_PER_FRAME;
    const end = Math.min(start + SAMPLES_PER_FRAME, samples.length);
    const chunk = samples.slice(start, end);

    const phoneme = realtimeAnalyzer.analyzeChunk(chunk);
    const timeStart = frame / FPS;
    const timeEnd = (frame + 1) / FPS;

    realtimeCues.push({ frame, start: timeStart, end: timeEnd, phoneme });
  }

  console.log(`      Generated ${realtimeCues.length} frames of analysis`);
  console.log('');

  // Compare results
  console.log('='.repeat(60));
  console.log('COMPARISON: Real-time vs Rhubarb');
  console.log('='.repeat(60));
  console.log('');

  // Show timeline comparison
  const timelineWidth = 60;
  const secondsPerChar = duration / timelineWidth;

  console.log('Rhubarb timeline:');
  let rhubarbLine = '';
  for (let i = 0; i < timelineWidth; i++) {
    const t = i * secondsPerChar;
    const cue = rhubarbCues.find(c => t >= c.start && t < c.end);
    rhubarbLine += cue ? cue.phoneme : '.';
  }
  console.log(`  [${rhubarbLine}]`);

  console.log('Real-time timeline:');
  let realtimeLine = '';
  for (let i = 0; i < timelineWidth; i++) {
    const t = i * secondsPerChar;
    const cue = realtimeCues.find(c => t >= c.start && t < c.end);
    realtimeLine += cue ? cue.phoneme : '.';
  }
  console.log(`  [${realtimeLine}]`);

  console.log('Match (=) / Mismatch (X):');
  let matchLine = '';
  let matches = 0;
  for (let i = 0; i < timelineWidth; i++) {
    if (rhubarbLine[i] === realtimeLine[i]) {
      matchLine += '=';
      matches++;
    } else {
      matchLine += 'X';
    }
  }
  console.log(`  [${matchLine}]`);
  console.log('');

  // Statistics
  const matchPercent = ((matches / timelineWidth) * 100).toFixed(1);
  console.log(`Exact match: ${matchPercent}%`);

  // Phoneme distribution comparison
  console.log('');
  console.log('Phoneme distribution:');
  console.log('-'.repeat(40));

  const rhubarbDist = {};
  const realtimeDist = {};
  const phonemes = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

  // Count Rhubarb phonemes by duration
  for (const cue of rhubarbCues) {
    const dur = cue.end - cue.start;
    rhubarbDist[cue.phoneme] = (rhubarbDist[cue.phoneme] || 0) + dur;
  }

  // Count realtime phonemes by frame
  for (const cue of realtimeCues) {
    realtimeDist[cue.phoneme] = (realtimeDist[cue.phoneme] || 0) + 1;
  }

  // Normalize to percentages
  const rhubarbTotal = Object.values(rhubarbDist).reduce((a, b) => a + b, 0);
  const realtimeTotal = Object.values(realtimeDist).reduce((a, b) => a + b, 0);

  console.log('Phoneme | Rhubarb | Realtime | Description');
  console.log('-'.repeat(55));
  const descriptions = {
    'A': 'Closed/rest',
    'B': 'M, B, P sounds',
    'C': 'E, I (teeth)',
    'D': 'AH (wide open)',
    'E': 'O (rounded)',
    'F': 'F, V (teeth)',
    'G': 'TH, D sounds',
    'H': 'L (tongue)'
  };

  for (const p of phonemes) {
    const rPct = ((rhubarbDist[p] || 0) / rhubarbTotal * 100).toFixed(1).padStart(5);
    const rtPct = ((realtimeDist[p] || 0) / realtimeTotal * 100).toFixed(1).padStart(5);
    console.log(`   ${p}    |  ${rPct}%  |  ${rtPct}%   | ${descriptions[p]}`);
  }

  // Frame-by-frame comparison for first 2 seconds
  console.log('');
  console.log('='.repeat(60));
  console.log('DETAILED: First 2 seconds (frame by frame)');
  console.log('='.repeat(60));
  console.log('');
  console.log('Frame | Time   | Realtime | Rhubarb | Match');
  console.log('-'.repeat(45));

  const maxFrames = Math.min(60, realtimeCues.length); // First 2 seconds
  let detailMatches = 0;

  for (let i = 0; i < maxFrames; i++) {
    const rt = realtimeCues[i];
    const t = rt.start;
    const rhubarbPhoneme = rhubarbCues.find(c => t >= c.start && t < c.end)?.phoneme || 'A';
    const match = rt.phoneme === rhubarbPhoneme;
    if (match) detailMatches++;

    console.log(
      `  ${String(i).padStart(3)}  | ${t.toFixed(2).padStart(5)}s |    ${rt.phoneme}     |    ${rhubarbPhoneme}    |  ${match ? 'Y' : 'N'}`
    );
  }

  console.log('-'.repeat(45));
  console.log(`First 2s accuracy: ${((detailMatches / maxFrames) * 100).toFixed(1)}%`);

  // Output as JSON for further analysis
  const outputPath = audioPath.replace(/\.[^.]+$/, '_comparison.json');
  const output = {
    audioPath,
    duration,
    fps: FPS,
    sampleRate: SAMPLE_RATE,
    rhubarbCues,
    realtimeCues: realtimeCues.map(c => ({
      frame: c.frame,
      time: c.start,
      phoneme: c.phoneme
    })),
    matchPercent: parseFloat(matchPercent)
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log('');
  console.log(`Full comparison saved to: ${outputPath}`);
}

// Visual waveform with phonemes
async function visualizeAudio(audioPath) {
  const { samples, duration } = await decodeAudio(audioPath, SAMPLE_RATE);
  const realtimeAnalyzer = new RealtimeLipSync(SAMPLE_RATE, FPS);
  realtimeAnalyzer.calibrate(samples);

  console.log('');
  console.log('='.repeat(60));
  console.log('WAVEFORM VISUALIZATION');
  console.log('='.repeat(60));
  console.log('');

  const chunkSize = Math.floor(samples.length / 60);

  for (let i = 0; i < 60; i++) {
    const start = i * chunkSize;
    const chunk = samples.slice(start, start + SAMPLES_PER_FRAME);

    const rms = realtimeAnalyzer.calculateRMS(chunk);
    const zcr = realtimeAnalyzer.calculateZCR(chunk);
    const phoneme = realtimeAnalyzer.analyzeChunk(chunk);

    const barLength = Math.round(rms * 40);
    const bar = '#'.repeat(Math.min(barLength, 40));
    const time = ((i * chunkSize) / SAMPLE_RATE).toFixed(2);

    console.log(`${time.padStart(5)}s [${phoneme}] |${bar.padEnd(40)}| rms=${rms.toFixed(3)} zcr=${zcr.toFixed(2)}`);
  }
}

// Main
async function main() {
  const audioPath = process.argv[2];

  if (!audioPath) {
    console.log('Usage: node test-realtime-lipsync.js <audio-file.mp3>');
    console.log('');
    console.log('This script compares real-time lip sync analysis against Rhubarb.');
    console.log('It helps tune thresholds and validate the real-time approach.');
    process.exit(1);
  }

  if (!fs.existsSync(audioPath)) {
    console.error(`File not found: ${audioPath}`);
    process.exit(1);
  }

  try {
    await compareAnalysis(audioPath);
    await visualizeAudio(audioPath);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
