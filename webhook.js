require('dotenv').config();
const http = require('http');
const crypto = require('crypto');
const { exec } = require('child_process');

const PORT = process.env.WEBHOOK_PORT || 3001;
const SECRET = process.env.GITHUB_WEBHOOK_SECRET;

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  let body = [];
  req.on('data', chunk => body.push(chunk));
  req.on('end', () => {
    body = Buffer.concat(body);

    if (!SECRET) {
      console.log('GITHUB_WEBHOOK_SECRET not configured');
      res.writeHead(500);
      res.end('Secret not configured');
      return;
    }

    const signature = req.headers['x-hub-signature-256'];
    if (!signature) {
      res.writeHead(401);
      res.end('No signature');
      return;
    }

    const hmac = crypto.createHmac('sha256', SECRET);
    const digest = 'sha256=' + hmac.update(body).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
      console.log('Invalid signature');
      res.writeHead(401);
      res.end('Invalid signature');
      return;
    }

    const event = req.headers['x-github-event'];
    if (event !== 'push') {
      res.writeHead(200);
      res.end(`Ignored: ${event}`);
      return;
    }

    console.log('Push received, pulling...');
    exec('git pull origin master', { cwd: __dirname }, (err, stdout, stderr) => {
      if (err) {
        console.error('Pull failed:', stderr);
        res.writeHead(500);
        res.end('Pull failed');
        return;
      }
      console.log('Pull successful:', stdout.trim());
      res.writeHead(200);
      res.end('Pulled');
    });
  });
});

server.listen(PORT, () => {
  console.log(`Webhook listener running on port ${PORT}`);
});
