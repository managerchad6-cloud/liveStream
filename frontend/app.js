const chatbox = document.getElementById('chatbox');
const submitBtn = document.getElementById('submitBtn');
const messageHistory = document.getElementById('messageHistory');
const modeSelect = document.getElementById('modeSelect');
const voiceSelect = document.getElementById('voiceSelect');
const modelSelect = document.getElementById('modelSelect');
const tempSlider = document.getElementById('tempSlider');
const tempValue = document.getElementById('tempValue');
const delaySlider = document.getElementById('delaySlider');
const delayValue = document.getElementById('delayValue');
const characterStream = document.getElementById('character-stream');

let hlsPlayer = null;
let audioPlayer = null;
let currentDelayLevel = parseInt(delaySlider.value, 10) || 3;

tempSlider.addEventListener('input', () => {
  tempValue.textContent = tempSlider.value;
});

function getDelayConfig(level) {
  const table = {
    1: { lowLatencyMode: true, liveSyncDuration: 1, liveMaxLatencyDuration: 3, maxBufferLength: 3, maxMaxBufferLength: 5, backBufferLength: 1 },
    2: { lowLatencyMode: true, liveSyncDuration: 2, liveMaxLatencyDuration: 5, maxBufferLength: 5, maxMaxBufferLength: 8, backBufferLength: 2 },
    3: { lowLatencyMode: true, liveSyncDuration: 3, liveMaxLatencyDuration: 8, maxBufferLength: 8, maxMaxBufferLength: 14, backBufferLength: 4 },
    4: { lowLatencyMode: false, liveSyncDuration: 5, liveMaxLatencyDuration: 12, maxBufferLength: 12, maxMaxBufferLength: 20, backBufferLength: 6 },
    5: { lowLatencyMode: false, liveSyncDuration: 8, liveMaxLatencyDuration: 20, maxBufferLength: 20, maxMaxBufferLength: 30, backBufferLength: 10 }
  };
  return table[level] || table[3];
}

function updateDelayState() {
  currentDelayLevel = parseInt(delaySlider.value, 10) || 3;
  delayValue.textContent = String(currentDelayLevel);
  if (hlsPlayer) {
    reconnectStream();
  }
}

delaySlider.addEventListener('input', updateDelayState);
updateDelayState();

function updateModeState() {
  const isRouterMode = modeSelect.value === 'router';
  const isAutoMode = modeSelect.value === 'auto';
  const hideVoice = isRouterMode || isAutoMode;
  voiceSelect.disabled = hideVoice;
  const voiceRow = voiceSelect.closest('.control-row') || voiceSelect.parentElement;
  if (voiceRow) {
    voiceRow.style.display = hideVoice ? 'none' : '';
  }
  voiceSelect.title = isRouterMode
    ? 'Voice is chosen automatically by the router'
    : '';
}

modeSelect.addEventListener('change', updateModeState);
updateModeState();

function addMessage(text, type = 'status') {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${type}-message`;
  messageDiv.textContent = text;
  messageHistory.appendChild(messageDiv);
  messageHistory.scrollTop = messageHistory.scrollHeight;
  return messageDiv;
}

function removeStatus(msg) {
  if (msg) {
    msg.remove();
    return;
  }
  const statusMsgs = messageHistory.querySelectorAll('.status-message');
  statusMsgs.forEach(status => status.remove());
}


// Connect to live stream on page load
function connectToLiveStream() {
  const animUrl = CONFIG.ANIMATION_SERVER_URL || '';
  const streamUrl = `${animUrl}/streams/live/stream.m3u8`;

  console.log('Connecting to live stream:', streamUrl);

  if (Hls.isSupported()) {
    if (hlsPlayer) {
      hlsPlayer.destroy();
    }

    const delayConfig = getDelayConfig(currentDelayLevel);
    hlsPlayer = new Hls({
      enableWorker: true,
      lowLatencyMode: delayConfig.lowLatencyMode,
      liveSyncDuration: delayConfig.liveSyncDuration,
      liveMaxLatencyDuration: delayConfig.liveMaxLatencyDuration,
      liveDurationInfinity: true,
      highBufferWatchdogPeriod: 2,
      maxBufferLength: delayConfig.maxBufferLength,
      maxMaxBufferLength: delayConfig.maxMaxBufferLength,
      backBufferLength: delayConfig.backBufferLength,
      maxLiveSyncPlaybackRate: 1.5,
      startLevel: -1,
      autoStartLoad: true,
      startFragPrefetch: true
    });

    hlsPlayer.loadSource(streamUrl);
    hlsPlayer.attachMedia(characterStream);

    hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
      console.log('Live stream connected');
      // Start muted for autoplay to work, will unmute on user interaction
      characterStream.play().catch(e => {
        console.warn('Autoplay blocked, click to play');
        addMessage('Click anywhere to start video', 'status');
      });
    });

    attachLiveCatchup(hlsPlayer, characterStream);
  } else if (characterStream.canPlayType('application/vnd.apple.mpegurl')) {
    characterStream.src = streamUrl;
    characterStream.play().catch(e => console.warn('Autoplay blocked:', e));
    attachLiveCatchup(null, characterStream);
  } else {
    addMessage('HLS not supported in this browser', 'error');
  }
}

function reconnectStream() {
  if (hlsPlayer) {
    hlsPlayer.destroy();
    hlsPlayer = null;
  }
  connectToLiveStream();
}

function attachLiveCatchup(hls, video) {
  const MAX_LATENCY = 8;
  const JUMP_BACK = 2;

  const maybeCatchUp = () => {
    if (!video.duration || !Number.isFinite(video.duration)) return;
    const latency = video.duration - video.currentTime;
    if (latency > MAX_LATENCY) {
      const target = Math.max(0, video.duration - JUMP_BACK);
      video.currentTime = target;
    }
  };

  if (hls) {
    hls.on(Hls.Events.FRAG_CHANGED, maybeCatchUp);
    hls.on(Hls.Events.LEVEL_UPDATED, maybeCatchUp);
    hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        console.error('HLS fatal error:', data);
        setTimeout(reconnectStream, 1500);
      }
    });
  }

  video.addEventListener('stalled', maybeCatchUp);
  video.addEventListener('waiting', () => setTimeout(maybeCatchUp, 500));
}

// Play audio synchronized with video
function playAudio(audioUrl) {
  if (audioPlayer) {
    audioPlayer.pause();
    audioPlayer = null;
  }

  audioPlayer = new Audio(audioUrl);
  audioPlayer.play().catch(e => console.warn('Audio play failed:', e));

  audioPlayer.onended = () => {
    audioPlayer = null;
  };
}

function isSlashCommand(text) {
  return typeof text === 'string' && text.trim().startsWith('/') && text.trim().length > 1;
}

async function sendMessage() {
  const message = chatbox.value.trim();
  if (!message) return;
  const isRouterMode = modeSelect.value === 'router';
  const isAutoMode = modeSelect.value === 'auto';
  const isCommand = isSlashCommand(message);

  if (!isRouterMode && !isAutoMode) {
    chatbox.disabled = true;
    submitBtn.disabled = true;
  }
  chatbox.value = '';

  addMessage(message, 'user');
  const statusMsg = addMessage(isCommand ? 'Recording vote...' : 'Generating response...');

  if (isCommand) {
    try {
      const apiUrl = CONFIG.API_BASE_URL ? `${CONFIG.API_BASE_URL}/api/commands` : '/api/commands';
      const commandResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: message })
      });
      const data = await commandResponse.json().catch(() => ({}));
      if (!commandResponse.ok) {
        throw new Error(data.error || 'Failed to record command');
      }
      removeStatus(statusMsg);
      addMessage(`Vote registered: ${data.command} (${data.count})`, 'status');
    } catch (error) {
      console.error('Error:', error);
      removeStatus(statusMsg);
      addMessage(`Error: ${error.message}`, 'error');
    } finally {
      if (!isRouterMode) {
        chatbox.disabled = false;
        submitBtn.disabled = false;
      }
      chatbox.focus();
    }
    return;
  }

  if (isAutoMode) {
    try {
      const apiUrl = CONFIG.API_BASE_URL ? `${CONFIG.API_BASE_URL}/api/auto` : '/api/auto';
      const autoResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          seed: message,
          turns: 12,
          temperature: parseFloat(tempSlider.value)
        })
      });

      if (!autoResponse.ok) {
        const errorData = await autoResponse.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(errorData.error || `HTTP ${autoResponse.status}`);
      }

      const autoData = await autoResponse.json();
      statusMsg.textContent = `Auto conversation started (${autoData.turns || 0} turns)...`;
    } catch (error) {
      console.error('Error:', error);
      removeStatus(statusMsg);
      addMessage(`Error: ${error.message}`, 'error');
    } finally {
      chatbox.focus();
    }
    return;
  }

  try {
    // Step 1: Get audio from chat API
    const apiUrl = CONFIG.API_BASE_URL ? `${CONFIG.API_BASE_URL}/api/chat` : '/api/chat';

    const chatResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        voice: voiceSelect.value,
        model: modelSelect.value,
        temperature: parseFloat(tempSlider.value),
        mode: modeSelect.value
      }),
    });

    if (!chatResponse.ok) {
      const errorData = await chatResponse.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(errorData.error || `HTTP ${chatResponse.status}`);
    }

    const contentType = chatResponse.headers.get('Content-Type') || '';
    if (contentType.includes('application/json')) {
      const data = await chatResponse.json();
      if (data.filtered) {
        removeStatus(statusMsg);
        addMessage(data.reason || 'Router skipped this message due to high volume.', 'status');
        return;
      }
    }

    const audioBlob = await chatResponse.blob();
    statusMsg.textContent = 'Starting animation...';
    const selectedVoice = chatResponse.headers.get('X-Selected-Voice') || voiceSelect.value;

    // Step 2: Send audio to animation server
    const formData = new FormData();
    formData.append('audio', audioBlob, 'audio.mp3');
    formData.append('character', selectedVoice);
    formData.append('message', message);
    formData.append('mode', modeSelect.value);

    const animUrl = CONFIG.ANIMATION_SERVER_URL ? `${CONFIG.ANIMATION_SERVER_URL}/render` : '/render';

    const renderResponse = await fetch(animUrl, {
      method: 'POST',
      body: formData
    });

    if (!renderResponse.ok) {
      const errorData = await renderResponse.json().catch(() => ({ error: 'Render failed' }));
      throw new Error(errorData.error || 'Animation render failed');
    }

    const renderData = await renderResponse.json();
    const { audioUrl, duration, streamMode, queued, queuePosition } = renderData;
    if (queued) {
      statusMsg.textContent = `Queued ${selectedVoice} response (#${queuePosition})...`;
    } else {
      removeStatus(statusMsg);
    }

    // Step 3: Play audio
    if (streamMode === 'synced' || !audioUrl) {
      // SYNCED MODE: Audio is embedded in the HLS video stream
      // Just make sure video is unmuted
      characterStream.muted = false;
      characterStream.volume = 1.0;
      if (!queued) {
        addMessage(`Playing ${selectedVoice} response (${duration.toFixed(1)}s)...`);
      }
    } else {
      // SEPARATE MODE: Play audio file separately
      const fullAudioUrl = CONFIG.ANIMATION_SERVER_URL
        ? `${CONFIG.ANIMATION_SERVER_URL}${audioUrl}`
        : audioUrl;
      playAudio(fullAudioUrl);
      if (!queued) {
        addMessage(`Playing ${selectedVoice} response (${duration.toFixed(1)}s)...`);
      }
    }

    // Remove status after audio ends
    setTimeout(() => {
      if (!queued) {
        removeStatus(statusMsg);
      }
    }, duration * 1000 + 500);

  } catch (error) {
    console.error('Error:', error);
    removeStatus(statusMsg);
    addMessage(`Error: ${error.message}`, 'error');
  } finally {
    if (!isRouterMode) {
      chatbox.disabled = false;
      submitBtn.disabled = false;
    }
    chatbox.focus();
  }
}

// Event listeners
submitBtn.addEventListener('click', sendMessage);

chatbox.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Click to play and unmute (for autoplay restrictions)
document.addEventListener('click', () => {
  if (characterStream.paused) {
    characterStream.play().catch(() => {});
  }
  // Unmute on first user interaction
  characterStream.muted = false;
  characterStream.volume = 1.0;
  console.log('User interaction - video unmuted');
}, { once: true });

// Connect to live stream on page load
window.addEventListener('load', () => {
  connectToLiveStream();
  addMessage('Click anywhere to enable audio', 'status');
});

// Focus on load
chatbox.focus();
