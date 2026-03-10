const axios = require('axios');
const WebSocket = require('ws');

// Twitter/X public web-app bearer token (app-level, no user auth required)
const TWITTER_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I%2BxUDpqWY%3DEUo6I7TgknKM6PYKzrkFkBpREF1HrGlbVb%2FnRU9LCQN8VkfkAI';

/**
 * XChatListener — connects to an X (Twitter) live broadcast chat room via the
 * Periscope WebSocket API and feeds messages into ChatIntakeAgent.
 *
 * Usage:
 *   const listener = new XChatListener({ chatIntake, onMemeCommand });
 *   await listener.connect('<broadcast_id>');   // e.g. "1lDxLadMQYkGm"
 *   listener.disconnect();
 *
 * The broadcast ID is visible in X Media Studio when you go live, or in the
 * viewer URL: https://twitter.com/i/broadcasts/<broadcast_id>
 *
 * Reconnect strategy: exponential backoff (2s → 4s → 8s … capped at 30s).
 * Re-fetches a fresh guest token and room ID on each reconnect attempt.
 */
class XChatListener {
  constructor({ chatIntake, onMemeCommand }) {
    this.chatIntake = chatIntake;
    this.onMemeCommand = onMemeCommand || null;
    this.ws = null;
    this.running = false;
    this.broadcastId = null;
    this._roomId = null;
    this._reconnectAttempts = 0;
    this._restartTimer = null;
  }

  async connect(broadcastId) {
    if (this.running) this.disconnect();
    this.broadcastId = broadcastId;
    this._roomId = null;
    this.running = true;
    this._reconnectAttempts = 0;
    await this._connect();
  }

  disconnect() {
    this.running = false;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    console.log('[XChat] Disconnected');
  }

  getStatus() {
    return {
      running: this.running,
      broadcastId: this.broadcastId,
      roomId: this._roomId,
      connected: this.ws?.readyState === WebSocket.OPEN
    };
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  async _connect() {
    if (!this.running) return;
    try {
      this._roomId = await this._resolveRoomId(this.broadcastId);
      this._openWebSocket(this._roomId);
    } catch (err) {
      console.warn(`[XChat] Connect failed: ${err.message}`);
      this._scheduleReconnect();
    }
  }

  async _resolveRoomId(broadcastId) {
    // Step 1: get a guest token (no user credentials required)
    const guestRes = await axios.post(
      'https://api.twitter.com/1.1/guest/activate.json',
      null,
      {
        headers: { Authorization: `Bearer ${TWITTER_BEARER}` },
        timeout: 10_000
      }
    );
    const guestToken = guestRes.data?.guest_token;
    if (!guestToken) throw new Error('Failed to obtain guest token from Twitter');

    // Step 2: resolve broadcast → room_id via Periscope API
    const broadcastRes = await axios.get(
      `https://api.pscp.tv/v1/broadcastByBroadcastId?broadcastId=${encodeURIComponent(broadcastId)}&hl=en`,
      {
        headers: {
          Authorization: `Bearer ${TWITTER_BEARER}`,
          'x-guest-token': guestToken,
          'x-periscope-user-agent': 'Twitter/m5'
        },
        timeout: 10_000
      }
    );

    const broadcast = broadcastRes.data?.broadcast || broadcastRes.data;
    const roomId = broadcast?.room_id || broadcast?.roomId || broadcast?.chat?.room_id;
    if (!roomId) {
      throw new Error(
        `No room_id in Periscope response. Check that the broadcast is live and the ID is correct.\n` +
        `Response: ${JSON.stringify(broadcastRes.data).slice(0, 300)}`
      );
    }
    return roomId;
  }

  _openWebSocket(roomId) {
    const wsUrl = `wss://chatman-us-east-1.pscp.tv/chatapi/v1/listen?room_id=${encodeURIComponent(roomId)}&cursor=`;

    this.ws = new WebSocket(wsUrl, {
      headers: {
        Origin: 'https://twitter.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    this.ws.on('open', () => {
      console.log(`[XChat] Connected — broadcast ${this.broadcastId}, room ${roomId}`);
      this._reconnectAttempts = 0;
      // Subscribe to the chat room
      this.ws.send(JSON.stringify({
        payload: JSON.stringify({ room: roomId, cursor: '' }),
        service: 'Social',
        kind: 1
      }));
    });

    this.ws.on('message', (raw) => {
      try {
        const frame = JSON.parse(raw.toString());
        // kind 1 = chat message; other kinds are control frames (heartbeat, etc.)
        if (frame.kind !== 1) return;
        const payload = typeof frame.payload === 'string'
          ? JSON.parse(frame.payload)
          : frame.payload;

        const username = String(payload.displayName || payload.username || 'anon').trim();
        const text = String(payload.body || '').trim();
        if (!text) return;

        console.log(`[XChat] ${username}: ${text.substring(0, 80)}`);

        // Route /meme commands
        const memeMatch = text.match(/^\/meme\s+(.+)/is);
        if (memeMatch) {
          if (this.onMemeCommand) this.onMemeCommand(username, memeMatch[1].trim());
          return;
        }

        if (this.chatIntake) this.chatIntake.addMessage(username, text);
      } catch (_) {
        // malformed frame — silently ignore
      }
    });

    this.ws.on('close', (code) => {
      console.warn(`[XChat] WebSocket closed (code ${code})`);
      if (this.running) this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.warn(`[XChat] WebSocket error: ${err.message}`);
      // 'close' fires after 'error', so reconnect is handled there
    });
  }

  _scheduleReconnect() {
    if (!this.running) return;
    this._reconnectAttempts++;
    const delay = Math.min(30_000, 2000 * Math.pow(2, this._reconnectAttempts - 1));
    console.log(`[XChat] Reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempts})`);
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      this._connect();
    }, delay);
  }
}

module.exports = XChatListener;
