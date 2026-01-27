const chatbox = document.getElementById('chatbox');
const submitBtn = document.getElementById('submitBtn');
const messageHistory = document.getElementById('messageHistory');
const voiceSelect = document.getElementById('voiceSelect');
const modelSelect = document.getElementById('modelSelect');
const tempSlider = document.getElementById('tempSlider');
const tempValue = document.getElementById('tempValue');
const characterStream = document.getElementById('character-stream');
const loadingIndicator = document.getElementById('loading-indicator');

let hlsPlayer = null;

tempSlider.addEventListener('input', () => {
  tempValue.textContent = tempSlider.value;
});

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

function showLoading(show) {
  if (loadingIndicator) {
    loadingIndicator.style.display = show ? 'block' : 'none';
  }
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
        temperature: parseFloat(tempSlider.value)
      }),
    });

    if (!chatResponse.ok) {
      const errorData = await chatResponse.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(errorData.error || `HTTP ${chatResponse.status}`);
    }

    const audioBlob = await chatResponse.blob();
    statusMsg.textContent = 'Rendering animation...';
    showLoading(true);

    // Step 2: Send audio to animation server
    const formData = new FormData();
    formData.append('audio', audioBlob, 'audio.mp3');
    formData.append('character', voiceSelect.value);

    const animUrl = CONFIG.ANIMATION_SERVER_URL ? `${CONFIG.ANIMATION_SERVER_URL}/render` : '/render';

    const renderResponse = await fetch(animUrl, {
      method: 'POST',
      body: formData
    });

    if (!renderResponse.ok) {
      const errorData = await renderResponse.json().catch(() => ({ error: 'Render failed' }));
      throw new Error(errorData.error || 'Animation render failed');
    }

    const { streamUrl } = await renderResponse.json();
    removeStatus();

    // Step 3: Play video stream
    const fullStreamUrl = CONFIG.ANIMATION_SERVER_URL
      ? `${CONFIG.ANIMATION_SERVER_URL}${streamUrl}`
      : streamUrl;

    playStream(fullStreamUrl);
    addMessage('Playing response...');

  } catch (error) {
    console.error('Error:', error);
    removeStatus();
    addMessage(`Error: ${error.message}`, 'error');
    showLoading(false);
  } finally {
    chatbox.disabled = false;
    submitBtn.disabled = false;
    chatbox.focus();
  }
}

function playStream(url) {
  showLoading(false);

  // Clean up previous player
  if (hlsPlayer) {
    hlsPlayer.destroy();
    hlsPlayer = null;
  }

  if (Hls.isSupported()) {
    hlsPlayer = new Hls({
      enableWorker: true,
      lowLatencyMode: true
    });
    hlsPlayer.loadSource(url);
    hlsPlayer.attachMedia(characterStream);
    hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
      characterStream.play().catch(e => console.warn('Autoplay blocked:', e));
    });
    hlsPlayer.on(Hls.Events.ERROR, (event, data) => {
      console.error('HLS error:', data);
      if (data.fatal) {
        addMessage('Video playback error', 'error');
      }
    });
  } else if (characterStream.canPlayType('application/vnd.apple.mpegurl')) {
    // Native HLS support (Safari)
    characterStream.src = url;
    characterStream.play().catch(e => console.warn('Autoplay blocked:', e));
  } else {
    addMessage('HLS not supported in this browser', 'error');
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

// Focus on load
chatbox.focus();
