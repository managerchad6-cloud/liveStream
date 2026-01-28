const chatbox = document.getElementById('chatbox');
const submitBtn = document.getElementById('submitBtn');
const messageHistory = document.getElementById('messageHistory');
const modeSelect = document.getElementById('modeSelect');
const voiceSelect = document.getElementById('voiceSelect');
const modelSelect = document.getElementById('modelSelect');
const tempSlider = document.getElementById('tempSlider');
const tempValue = document.getElementById('tempValue');
const characterStream = document.getElementById('character-stream');

let hlsPlayer = null;
let audioPlayer = null;

tempSlider.addEventListener('input', () => {
  tempValue.textContent = tempSlider.value;
});

function updateModeState() {
  const isRouterMode = modeSelect.value === 'router';
  voiceSelect.disabled = isRouterMode;
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

function removeStatus() {
  const statusMsgs = messageHistory.querySelectorAll('.status-message');
  statusMsgs.forEach(msg => msg.remove());
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

    hlsPlayer = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      liveSyncDuration: 2,          // Stay 2s behind (1 segment)
      liveMaxLatencyDuration: 5,
      liveDurationInfinity: true,
      highBufferWatchdogPeriod: 1,
      maxBufferLength: 8,
      maxMaxBufferLength: 12,
      backBufferLength: 4,
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

    hlsPlayer.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        console.error('HLS fatal error:', data);
        // Try to reconnect after a delay
        setTimeout(connectToLiveStream, 3000);
      }
    });
  } else if (characterStream.canPlayType('application/vnd.apple.mpegurl')) {
    characterStream.src = streamUrl;
    characterStream.play().catch(e => console.warn('Autoplay blocked:', e));
  } else {
    addMessage('HLS not supported in this browser', 'error');
  }
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

async function sendMessage() {
  const message = chatbox.value.trim();
  if (!message) return;

  chatbox.disabled = true;
  submitBtn.disabled = true;
  chatbox.value = '';

  addMessage(message, 'user');
  const statusMsg = addMessage('Generating response...');

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
        removeStatus();
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
    const { audioUrl, duration, streamMode } = renderData;
    removeStatus();

    // Step 3: Play audio
    if (streamMode === 'synced' || !audioUrl) {
      // SYNCED MODE: Audio is embedded in the HLS video stream
      // Just make sure video is unmuted
      characterStream.muted = false;
      characterStream.volume = 1.0;
      addMessage(`Playing ${selectedVoice} response (${duration.toFixed(1)}s)...`);
    } else {
      // SEPARATE MODE: Play audio file separately
      const fullAudioUrl = CONFIG.ANIMATION_SERVER_URL
        ? `${CONFIG.ANIMATION_SERVER_URL}${audioUrl}`
        : audioUrl;
      playAudio(fullAudioUrl);
      addMessage(`Playing ${selectedVoice} response (${duration.toFixed(1)}s)...`);
    }

    // Remove status after audio ends
    setTimeout(() => {
      removeStatus();
    }, duration * 1000 + 500);

  } catch (error) {
    console.error('Error:', error);
    removeStatus();
    addMessage(`Error: ${error.message}`, 'error');
  } finally {
    chatbox.disabled = false;
    submitBtn.disabled = false;
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
  // Small delay to ensure HLS.js is loaded
  setTimeout(connectToLiveStream, 500);
  // Remind user to enable audio
  addMessage('Click anywhere to enable audio', 'status');
});

// Focus on load
chatbox.focus();
