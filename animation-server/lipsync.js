const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { RHUBARB_PATH, isWindows } = require('./platform');

const execAsync = promisify(exec);

const PHONEME_MAP = {
  'A': 'A',
  'B': 'B',
  'C': 'C',
  'D': 'D',
  'E': 'E',
  'F': 'F',
  'G': 'G',
  'H': 'H',
  'X': 'A'
};

async function analyzeLipSync(audioPath) {
  const outputPath = audioPath.replace(/\.(mp3|wav|ogg)$/i, '_lipsync.json');
  let wavPath = null;
  let audioForRhubarb = audioPath;

  // Convert MP3 to WAV (Rhubarb only supports WAV and OGG)
  if (audioPath.toLowerCase().endsWith('.mp3')) {
    wavPath = audioPath.replace(/\.mp3$/i, '.wav');
    const convertCmd = `ffmpeg -y -i '${audioPath}' -ar 16000 -ac 1 '${wavPath}'`;
    try {
      console.log('Converting MP3 to WAV:', convertCmd);
      await execAsync(convertCmd, { timeout: 30000 });
      audioForRhubarb = wavPath;
    } catch (err) {
      console.error('FFmpeg conversion failed:', err.message);
      return [{ start: 0, end: 10, phoneme: 'A' }];
    }
  }

  // Quote paths for shell safety
  const quotedAudio = isWindows ? `"${audioForRhubarb}"` : `'${audioForRhubarb}'`;
  const quotedOutput = isWindows ? `"${outputPath}"` : `'${outputPath}'`;
  const quotedRhubarb = isWindows ? `"${RHUBARB_PATH}"` : RHUBARB_PATH;

  // Use phonetic recognizer (faster than pocketSphinx)
  const cmd = `${quotedRhubarb} -r phonetic -f json ${quotedAudio} -o ${quotedOutput}`;

  try {
    console.log('Running Rhubarb:', cmd);
    await execAsync(cmd, { timeout: 60000 });

    if (!fs.existsSync(outputPath)) {
      throw new Error('Rhubarb did not produce output file');
    }

    const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));

    // Clean up
    try { fs.unlinkSync(outputPath); } catch (e) {}
    if (wavPath) try { fs.unlinkSync(wavPath); } catch (e) {}

    return result.mouthCues.map(cue => ({
      start: cue.start,
      end: cue.end,
      phoneme: PHONEME_MAP[cue.value] || 'A'
    }));
  } catch (error) {
    console.error('Rhubarb error:', error.message);
    // Clean up on error
    try { fs.unlinkSync(outputPath); } catch (e) {}
    if (wavPath) try { fs.unlinkSync(wavPath); } catch (e) {}
    // Return default closed mouth
    return [{ start: 0, end: 10, phoneme: 'A' }];
  }
}

function getPhonemeAtTime(cues, timeInSeconds) {
  for (const cue of cues) {
    if (timeInSeconds >= cue.start && timeInSeconds < cue.end) {
      return cue.phoneme;
    }
  }
  return 'A';
}

module.exports = { analyzeLipSync, getPhonemeAtTime };
