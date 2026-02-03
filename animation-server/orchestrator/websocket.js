const WebSocket = require('ws');

class OrchestratorSocket {
  constructor(server) {
    this.wss = new WebSocket.Server({ server, path: '/ws/orchestrator' });
    this.wss.on('connection', (ws) => {
      console.log('[WS] Client connected');
      ws.on('close', () => console.log('[WS] Client disconnected'));
    });
  }

  broadcast(event, data) {
    const message = JSON.stringify({ event, data, timestamp: Date.now() });
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }
}

module.exports = OrchestratorSocket;
