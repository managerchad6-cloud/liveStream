# Share LiveStream via Cloudflare Tunnel

Use Cloudflare's quick tunnel to expose your **local** app so a friend can open a link in their browser (no account required for trycloudflare.com).

## 1. Install cloudflared (one-time)

**Windows (PowerShell):**

```powershell
winget install Cloudflare.cloudflared
```

Or download: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/

**macOS:** `brew install cloudflared`

**Linux:** See [Cloudflare docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/).

## 2. Start your app locally

In one terminal:

```powershell
cd "c:\Users\Money Getting Mfucka\Dev\vvc\LiveStream"
npm start
```

In a second terminal:

```powershell
cd "c:\Users\Money Getting Mfucka\Dev\vvc\LiveStream"
npm run animation
```

Leave both running. Chat API = port 3002, Animation = port 3003.

## 3. Create two tunnels

**Terminal 3 – tunnel for Chat + Frontend (3002):**

```powershell
cloudflared tunnel --url http://localhost:3002
```

Copy the **HTTPS** URL it prints, e.g. `https://abc-xyz-12-34.trycloudflare.com` → this is your **app URL**.

**Terminal 4 – tunnel for Animation (3003):**

```powershell
cloudflared tunnel --url http://localhost:3003
```

Copy that HTTPS URL too, e.g. `https://def-uvw-56-78.trycloudflare.com` → this is your **animation URL**.

## 4. Build the share link

Use:

```
<app URL>?anim=<animation URL>
```

Example:

```
https://abc-xyz-12-34.trycloudflare.com?anim=https://def-uvw-56-78.trycloudflare.com
```

Send that single link to your friend. They open it in the browser; chat and video stream will use the animation tunnel automatically.

## 5. Optional: API on a different URL

If you ever put the chat API on its own tunnel, use:

```
<app URL>?api=<api URL>&anim=<animation URL>
```

## Notes

- Tunnels and share link only work while your **local** app and both `cloudflared` processes are running.
- The `trycloudflare.com` URLs change each time you start a new tunnel.
- For a stable, always-on URL, use Cloudflare Tunnel with a custom domain (and a Cloudflare account).
