# GitHub Webhook + Tunnel Setup

Auto-pull on push: run a small webhook server locally, expose it with a tunnel, and point a GitHub webhook at it. Every push to `master` triggers `git pull` in this repo.

## 1. Env vars (optional)

Add to `.env`:

```bash
# Webhook server
WEBHOOK_PORT=3945
WEBHOOK_SECRET=your_random_secret_here
WEBHOOK_BRANCH=refs/heads/master
```

- **WEBHOOK_PORT** – Port for the webhook server (default `3945`).
- **WEBHOOK_SECRET** – Secret you’ll set in GitHub; used to verify webhook payloads. Omit to disable verification (not recommended if exposed). Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- **WEBHOOK_BRANCH** – Branch to react to (default `refs/heads/master`).

## 2. Start the webhook server

```bash
npm run webhook
```

Runs `webhook-server.js` (separate from the main app). Endpoints:

- `POST /webhook` – GitHub webhook URL (use the **tunnel URL** here).
- `GET /webhook/health` – Health check.

## 3. Expose it with a tunnel

GitHub must reach your machine. Use one of these.

### Option A: localtunnel (no install)

In a separate terminal (webhook server already running):

```bash
npx --yes localtunnel --port 3945
```

Use the URL it prints (e.g. `https://xyz.loca.lt`). Your webhook URL:

```
https://xyz.loca.lt/webhook
```

### Option B: ngrok

1. Install: https://ngrok.com/download or `winget install ngrok`  
2. In another terminal:

   ```bash
   ngrok http 3945
   ```

3. Copy the **HTTPS** URL (e.g. `https://abc123.ngrok.io`). Webhook URL:

   ```
   https://abc123.ngrok.io/webhook
   ```

### Option C: cloudflared (Cloudflare Tunnel)

```bash
cloudflared tunnel --url http://localhost:3945
```

Use the generated `*.trycloudflare.com` URL plus `/webhook`.

---

**Important:** Tunnel URLs change whenever you restart ngrok/localtunnel/cloudflared (unless you use a paid ngrok domain or similar). Update the GitHub webhook URL when that happens.

## 4. Configure GitHub webhook

1. Open your repo on GitHub → **Settings** → **Webhooks** → **Add webhook**.
2. **Payload URL:** `https://YOUR_TUNNEL_URL/webhook`  
   - ngrok example: `https://abc123.ngrok.io/webhook`
3. **Content type:** `application/json`.
4. **Secret:** same value as `WEBHOOK_SECRET` in `.env` (or leave empty if you didn’t set it).
5. **Events:** choose **Just the push event** (or “Send me everything” for debugging).
6. **Active:** checked.
7. **Add webhook**.

## 5. Test

1. Ensure `npm run webhook` is running and your tunnel is up.
2. Push a commit to `master` (or your `WEBHOOK_BRANCH`).
3. Check the webhook server logs; you should see something like:

   ```
   [webhook] Running git pull in /path/to/LiveStream
   [webhook] git pull ok
   ```

4. On GitHub, **Webhooks** → your webhook → **Recent Deliveries** to see requests and responses.

## 6. Run webhook + app + tunnel together

- Terminal 1: `npm start` (main app).
- Terminal 2: `npm run webhook` (webhook server).
- Terminal 3: `npx --yes localtunnel --port 3945` or `ngrok http 3945` (or your chosen tunnel).

Only the webhook port (`3945`) needs to be tunneled. The main app can stay on `localhost:3000` unless you want that exposed too.

## Troubleshooting

| Issue | Check |
|-------|--------|
| `ngrok` not recognized | Use **localtunnel** (Option A) or install ngrok from https://ngrok.com/download |
| GitHub shows “Unable to connect” | Tunnel running? Correct port? URL ends with `/webhook`? |
| 401 from webhook | `WEBHOOK_SECRET` matches the **Secret** in GitHub. |
| Webhook 202 but no pull | Logs of `webhook-server`. Ensure it’s running in the repo directory and `git pull` works there. |
| Tunnel URL changed | Update the webhook **Payload URL** in GitHub. |

## Security

- Use **WEBHOOK_SECRET** and set the same secret in GitHub so only GitHub can trigger pulls.
- Keep the tunnel running only when you need it, or use a fixed domain (e.g. ngrok paid) so you’re not constantly reconfiguring.
