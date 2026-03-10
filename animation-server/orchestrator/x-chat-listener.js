const axios = require('axios');
const WebSocket = require('ws');

// Twitter/X public web-app bearer token (app-level)
const TWITTER_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I%2BxUDpqWY%3DEUo6I7TgknKM6PYKzrkFkBpREF1HrGlbVb%2FnRU9LCQN8VkfkAI';

/**
 * XChatListener — connects to an X (Twitter) live broadcast chat room via the
 * Periscope WebSocket API and feeds messages into ChatIntakeAgent.
 *
 * Requires X auth cookies (ct0 + authToken) — the same credentials used by
 * TwitterIngestService. Without them the Periscope API rejects the request.
 *
 * Usage:
 *   const listener = new XChatListener({
 *     chatIntake,
 *     onMemeCommand,
 *     getCredentials: () => twitterIngest.getConfig()  // { ct0, authToken }
 *   });
 *   await listener.connect('<broadcast_id>');
 *
 * The broadcast ID is the last segment of the viewer URL:
 *   https://twitter.com/i/broadcasts/<broadcast_id>
 *
 * Reconnect: exponential backoff (2s → 4s → 8s … capped at 30s).
 */
class XChatListener {
  constructor({ chatIntake, onMemeCommand, getCredentials }) {
    this.chatIntake = chatIntake;
    this.onMemeCommand = onMemeCommand || null;
    this.getCredentials = getCredentials || (() => null);
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
    const creds = this.getCredentials();
    return {
      running: this.running,
      broadcastId: this.broadcastId,
      roomId: this._roomId,
      connected: this.ws?.readyState === WebSocket.OPEN,
      hasCredentials: !!(creds?.ct0 && creds?.authToken)
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

  _authHeaders(guestToken, ct0, authToken) {
    const headers = {
      Authorization: `Bearer ${TWITTER_BEARER}`,
      'x-guest-token': guestToken,
      'x-periscope-user-agent': 'Twitter/m5',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
    if (ct0 && authToken) {
      headers['Cookie'] = `ct0=${ct0}; auth_token=${authToken}`;
      headers['X-Csrf-Token'] = ct0;
    }
    return headers;
  }

  async _resolveRoomId(broadcastId) {
    const creds = this.getCredentials();
    const { ct0, authToken } = creds || {};

    if (!ct0 || !authToken) {
      console.warn(
        '[XChat] No ct0/authToken credentials — Periscope API will likely reject the request.\n' +
        '        Set Twitter cookies via POST /api/orchestrator/twitter/config first.'
      );
    }

    // Step 1: guest token (always needed as a base)
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

    const headers = this._authHeaders(guestToken, ct0, authToken);

    // Step 2a: try the Twitter API live_video_stream endpoint first (more stable)
    try {
      const res = await axios.get(
        `https://api.twitter.com/1.1/live_video_stream/status/${encodeURIComponent(broadcastId)}`,
        { headers, timeout: 10_000 }
      );
      const roomId = res.data?.broadcast?.room_id || res.data?.room_id;
      if (roomId) {
        console.log(`[XChat] Resolved room_id via live_video_stream: ${roomId}`);
        return roomId;
      }
      console.warn(`[XChat] live_video_stream response had no room_id: ${JSON.stringify(res.data).slice(0, 200)}`);
    } catch (err) {
      console.warn(`[XChat] live_video_stream lookup failed (${err.response?.status || err.message}) — trying Periscope API`);
    }

    // Step 2b: fall back to Periscope API
    const broadcastRes = await axios.get(
      `https://api.pscp.tv/v1/broadcastByBroadcastId?broadcastId=${encodeURIComponent(broadcastId)}&hl=en`,
      { headers, timeout: 10_000 }
    );

    const broadcast = broadcastRes.data?.broadcast || broadcastRes.data;
    const roomId = broadcast?.room_id || broadcast?.roomId || broadcast?.chat?.room_id;
    if (!roomId) {
      throw new Error(
        `No room_id found. Ensure the broadcast is live and the ID is correct.\n` +
        `Periscope response: ${JSON.stringify(broadcastRes.data).slice(0, 300)}`
      );
    }
    console.log(`[XChat] Resolved room_id via Periscope API: ${roomId}`);
    return roomId;
  }

  _openWebSocket(roomId) {
    const wsUrl = `wss://chatman-us-east-1.pscp.tv/chatapi/v1/listen?room_id=${encodeURIComponent(roomId)}&cursor=`;

    const creds = this.getCredentials();
    const wsHeaders = {
      Origin: 'https://twitter.com',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
    if (creds?.ct0 && creds?.authToken) {
      wsHeaders['Cookie'] = `ct0=${creds.ct0}; auth_token=${creds.authToken}`;
    }

    this.ws = new WebSocket(wsUrl, { headers: wsHeaders });

    this.ws.on('open', () => {
      console.log(`[XChat] Connected — broadcast ${this.broadcastId}, room ${roomId}`);
      this._reconnectAttempts = 0;
      this.ws.send(JSON.stringify({
        payload: JSON.stringify({ room: roomId, cursor: '' }),
        service: 'Social',
        kind: 1
      }));
    });

    this.ws.on('message', (raw) => {
      try {
        const frame = JSON.parse(raw.toString());
        if (frame.kind !== 1) return; // kind 1 = chat message
        const payload = typeof frame.payload === 'string'
          ? JSON.parse(frame.payload)
          : frame.payload;

        const username = String(payload.displayName || payload.username || 'anon').trim();
        const text = String(payload.body || '').trim();
        if (!text) return;

        console.log(`[XChat] ${username}: ${text.substring(0, 80)}`);

        const memeMatch = text.match(/^\/meme\s+(.+)/is);
        if (memeMatch) {
          if (this.onMemeCommand) this.onMemeCommand(username, memeMatch[1].trim());
          return;
        }

        if (this.chatIntake) this.chatIntake.addMessage(username, text);
      } catch (_) {}
    });

    this.ws.on('close', (code) => {
      console.warn(`[XChat] WebSocket closed (code ${code})`);
      if (this.running) this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.warn(`[XChat] WebSocket error: ${err.message}`);
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
