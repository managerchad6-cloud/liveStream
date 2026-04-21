const { PumpChatClient } = require('pump-chat-client');

/**
 * PumpChatListener - Connects to a pump.fun token chat room and feeds
 * incoming messages into the orchestrator's ChatIntakeAgent.
 *
 * Handles infinite reconnection: when the built-in 5-attempt backoff
 * is exhausted, spawns a fresh client and starts over.
 */
class PumpChatListener {
  constructor({ chatIntake, token, onMemeCommand, onVoteMemeCommand }) {
    this.chatIntake = chatIntake;
    this.token = token;
    this.onMemeCommand = onMemeCommand || null;
    this.onVoteMemeCommand = onVoteMemeCommand || null;
    this.client = null;
    this.running = false;
    this._restartTimer = null;
  }

  start() {
    if (this.running) return;
    if (!this.token) {
      console.warn('[PumpChat] PUMP_FUN_TOKEN not set — listener disabled');
      return;
    }
    this.running = true;
    this._connect();
  }

  stop() {
    this.running = false;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    console.log('[PumpChat] Stopped');
  }

  _connect() {
    if (!this.running) return;

    this.client = new PumpChatClient({
      roomId: this.token,
      username: 'livestream-bot',
      messageHistoryLimit: 1  // We only need live messages, not history
    });

    this.client.on('connected', () => {
      console.log(`[PumpChat] Connected to room ${this.token.slice(0, 12)}...`);
    });

    this.client.on('message', (msg) => {
      const username = String(msg.username || 'anon').trim();
      const text = String(msg.message || msg.text || '').trim();
      if (!text) return;

      console.log(`[PumpChat] ${username}: ${text.substring(0, 80)}`);

      // Route /voteMeme commands
      const voteMemeMatch = text.match(/^\/voteMeme\s+(\d+)/i);
      if (voteMemeMatch) {
        if (this.onVoteMemeCommand) this.onVoteMemeCommand(username, voteMemeMatch[1]);
        return;
      }

      // Route /meme commands to the meme handler instead of chat intake
      const memeMatch = text.match(/^\/meme\s+(.+)/is);
      if (memeMatch) {
        if (this.onMemeCommand) {
          this.onMemeCommand(username, memeMatch[1].trim());
        } else {
          console.warn('[PumpChat] /meme command received but no onMemeCommand handler set');
        }
        return;
      }

      if (this.chatIntake) {
        this.chatIntake.addMessage(username, text);
      }
    });

    // Ignore history — we don't replay old messages into the pipeline
    this.client.on('messageHistory', () => {});

    this.client.on('disconnected', () => {
      console.warn('[PumpChat] Disconnected — built-in reconnect will attempt');
    });

    this.client.on('error', (err) => {
      console.warn(`[PumpChat] Error: ${err.message || err}`);
    });

    this.client.on('serverError', (err) => {
      console.warn(`[PumpChat] Server error: ${JSON.stringify(err)}`);
    });

    // Built-in reconnect exhausted (5 attempts) — spawn a fresh client after 30s
    this.client.on('maxReconnectAttemptsReached', () => {
      console.warn('[PumpChat] Max reconnect attempts reached — restarting in 30s');
      this.client = null;
      if (this.running) {
        this._restartTimer = setTimeout(() => {
          this._restartTimer = null;
          this._connect();
        }, 30_000);
      }
    });

    this.client.connect();
  }
}

module.exports = PumpChatListener;
