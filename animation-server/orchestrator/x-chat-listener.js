/**
 * XChatListener — watches an X (Twitter) live broadcast chat using Puppeteer.
 *
 * Navigates to https://x.com/i/broadcasts/<broadcastId> with auth cookies,
 * injects a MutationObserver to detect new chat messages in real-time,
 * and forwards them to ChatIntakeAgent.
 *
 * Same cookie approach as TwitterIngestService (ct0 + auth_token).
 */
class XChatListener {
  constructor({ chatIntake, onMemeCommand, getCredentials }) {
    this.chatIntake = chatIntake;
    this.onMemeCommand = onMemeCommand || null;
    this.getCredentials = getCredentials || (() => null);
    this.browser = null;
    this.page = null;
    this.running = false;
    this.broadcastId = null;
    this._reconnectAttempts = 0;
    this._restartTimer = null;
  }

  async connect(broadcastId) {
    if (this.running) await this.disconnect();
    this.broadcastId = broadcastId;
    this.running = true;
    this._reconnectAttempts = 0;
    await this._connect();
  }

  async disconnect() {
    this.running = false;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    if (this.browser) {
      try { await this.browser.close(); } catch {}
      this.browser = null;
      this.page = null;
    }
    console.log('[XChat] Disconnected');
  }

  getStatus() {
    const creds = this.getCredentials();
    return {
      running: this.running,
      broadcastId: this.broadcastId,
      connected: !!(this.page && !this.page.isClosed()),
      hasCredentials: !!(creds?.ct0 && creds?.authToken)
    };
  }

  /**
   * Capture a screenshot + DOM snapshot of the current page for debugging.
   * Returns { screenshotBase64, url, title, testIds, bodyHtml }
   */
  async debug() {
    if (!this.page || this.page.isClosed()) {
      throw new Error('No active page — call connect() first');
    }
    const screenshotBuf = await this.page.screenshot({ type: 'png', fullPage: false });
    const info = await this.page.evaluate(() => {
      const testIds = [...new Set(
        Array.from(document.querySelectorAll('[data-testid]'))
          .map(el => el.getAttribute('data-testid'))
          .filter(Boolean)
      )];
      // Grab the inner HTML of the most likely chat container (first 4000 chars)
      const chatSelectors = [
        '[data-testid="liveVideoChat"]', '[data-testid="liveVideo-chat"]',
        '[data-testid="LiveVideoChat"]', '[data-testid="chat"]',
        '[aria-label="Chat"]', '[aria-label="Live chat"]', '[role="log"]'
      ];
      let chatHtml = null;
      let chatSelector = null;
      for (const sel of chatSelectors) {
        const el = document.querySelector(sel);
        if (el) { chatHtml = el.innerHTML.slice(0, 4000); chatSelector = sel; break; }
      }
      return {
        url: location.href,
        title: document.title,
        testIds,
        chatSelector,
        chatHtml: chatHtml || document.body.innerHTML.slice(0, 4000)
      };
    });
    return { ...info, screenshotBase64: screenshotBuf.toString('base64') };
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  async _connect() {
    if (!this.running) return;
    try {
      const creds = this.getCredentials();
      if (!creds?.ct0 || !creds?.authToken) {
        throw new Error(
          'No ct0/authToken credentials. Set them via POST /api/orchestrator/twitter/config'
        );
      }
      await this._launchAndWatch(creds);
    } catch (err) {
      console.warn(`[XChat] Connect failed: ${err.message}`);
      this._scheduleReconnect();
    }
  }

  async _launchAndWatch(creds) {
    const puppeteer = require('puppeteer');

    this.browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--no-zygote',
      ],
    });

    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1280, height: 900 });

    // Inject auth cookies — same pattern as TwitterIngestService
    await this.page.setCookie(
      { name: 'ct0',        value: creds.ct0,        domain: '.x.com', path: '/' },
      { name: 'auth_token', value: creds.authToken,   domain: '.x.com', path: '/' }
    );

    // Bridge: page context calls this Node function for every new chat message
    await this.page.exposeFunction('__xChatOnMessage', (username, text) => {
      if (!text || !username) return;
      console.log(`[XChat] ${username}: ${text.substring(0, 80)}`);

      const memeMatch = text.match(/^\/meme\s+(.+)/is);
      if (memeMatch) {
        if (this.onMemeCommand) this.onMemeCommand(username, memeMatch[1].trim());
        return;
      }

      if (this.chatIntake) this.chatIntake.addMessage(username, text);
    });

    const url = `https://x.com/i/broadcasts/${this.broadcastId}`;
    console.log(`[XChat] Navigating to ${url}`);
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Give the React app time to hydrate
    await new Promise(r => setTimeout(r, 3000));

    // Dismiss cookie/consent banner — must happen before chat renders
    await this._acceptCookies();

    // Wait for chat to appear after consent is cleared
    await new Promise(r => setTimeout(r, 3000));

    await this._setupObserver();

    this.page.on('close', () => {
      console.warn('[XChat] Page closed unexpectedly');
      this.page = null;
      if (this.running) this._scheduleReconnect();
    });

    this.browser.on('disconnected', () => {
      console.warn('[XChat] Browser disconnected');
      this.browser = null;
      this.page = null;
      if (this.running) this._scheduleReconnect();
    });

    this._reconnectAttempts = 0;
    console.log(`[XChat] Watching broadcast ${this.broadcastId} for chat`);
  }

  async _acceptCookies() {
    try {
      const clicked = await this.page.evaluate(() => {
        // X's own GDPR accept button (most reliable)
        const gdpr = document.querySelector('[data-testid="GDPR-accept"]');
        if (gdpr) { gdpr.click(); return 'GDPR-accept'; }

        // Generic "Accept all" / "Accept" buttons
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        const accept = buttons.find(b => /^accept( all)?$/i.test(b.innerText?.trim()));
        if (accept) { accept.click(); return accept.innerText.trim(); }

        return null;
      });
      if (clicked) {
        console.log(`[XChat] Cookie banner dismissed: "${clicked}"`);
        await new Promise(r => setTimeout(r, 1500));
      } else {
        console.log('[XChat] No cookie banner found');
      }
    } catch (err) {
      console.warn(`[XChat] Cookie dismiss failed: ${err.message}`);
    }
  }

  async _setupObserver() {
    // Log what we can see on the page to help diagnose selector issues
    const diagnostics = await this.page.evaluate(() => {
      const testIds = Array.from(document.querySelectorAll('[data-testid]'))
        .map(el => el.getAttribute('data-testid'))
        .filter(Boolean);
      const unique = [...new Set(testIds)].slice(0, 60);
      return {
        title: document.title,
        url: location.href,
        testIds: unique,
        bodyText: document.body.innerText.slice(0, 200)
      };
    });
    console.log(`[XChat] Page loaded: "${diagnostics.title}"`);
    console.log(`[XChat] Visible testIds: ${diagnostics.testIds.join(', ')}`);

    // Ordered list of selectors to try for the chat scroll container
    const CHAT_SELECTORS = [
      '[data-testid="liveVideoChat"]',
      '[data-testid="liveVideo-chat"]',
      '[data-testid="LiveVideoChat"]',
      '[data-testid="chat"]',
      '[aria-label="Chat"]',
      '[aria-label="Live chat"]',
      '[role="log"]',
      '[data-testid="cellInnerDiv"]'   // fallback — general feed
    ];

    // Find which selector actually matches
    const foundSelector = await this.page.evaluate((selectors) => {
      for (const sel of selectors) {
        if (document.querySelector(sel)) return sel;
      }
      return null;
    }, CHAT_SELECTORS);

    if (foundSelector) {
      console.log(`[XChat] Chat container matched: "${foundSelector}"`);
    } else {
      console.warn('[XChat] No known chat selector matched — observing <body> (may produce noise)');
    }

    // Inject MutationObserver into the live page
    await this.page.evaluate((containerSelector) => {
      const container = containerSelector
        ? document.querySelector(containerSelector)
        : document.body;

      if (!container) {
        console.warn('[XChat observer] Container not found, falling back to body');
      }

      const root = container || document.body;

      // Dedup buffer: remember last 200 username:text pairs
      const seen = new Set();
      const addSeen = (key) => {
        seen.add(key);
        if (seen.size > 200) {
          const first = seen.values().next().value;
          seen.delete(first);
        }
      };

      /**
       * Try to extract { username, text } from a DOM node that represents
       * a single chat message. Returns null if the node doesn't look like a message.
       *
       * X live chat messages typically have:
       *   - A display name span (dir="ltr" or data-testid with "user"/"author")
       *   - A message text span (dir="auto" or data-testid with "text"/"message")
       */
      const extractMessage = (node) => {
        if (!(node instanceof Element)) return null;

        // Strategy A: data-testid attributes (most reliable when present)
        const usernameA = node.querySelector('[data-testid*="User-Name"] span')
          || node.querySelector('[data-testid*="username"]')
          || node.querySelector('[data-testid*="author"]');
        const textA = node.querySelector('[data-testid*="tweetText"]')
          || node.querySelector('[data-testid*="messageText"]')
          || node.querySelector('[data-testid*="chat-message-text"]');

        if (usernameA && textA) {
          const u = usernameA.innerText.trim();
          const t = textA.innerText.trim();
          if (u && t && t !== u) return { username: u, text: t };
        }

        // Strategy B: dir attributes — X uses dir="ltr" for names, dir="auto" for content
        const spans = Array.from(node.querySelectorAll('span'));
        const ltrSpans = spans.filter(s => s.getAttribute('dir') === 'ltr' && s.innerText.trim());
        const autoSpans = spans.filter(s => s.getAttribute('dir') === 'auto' && s.innerText.trim());

        if (ltrSpans.length > 0 && autoSpans.length > 0) {
          const u = ltrSpans[0].innerText.trim();
          const t = autoSpans[0].innerText.trim();
          if (u && t && t !== u && t.length > 0) return { username: u, text: t };
        }

        // Strategy C: structured children — first bold-ish span is name, rest is text
        const allSpans = spans.filter(s => s.innerText.trim() && !s.querySelector('span'));
        if (allSpans.length >= 2) {
          const u = allSpans[0].innerText.trim();
          const t = allSpans.slice(1).map(s => s.innerText.trim()).join(' ').trim();
          if (u && t && t !== u && t.length > 1 && u.length < 60) {
            return { username: u, text: t };
          }
        }

        return null;
      };

      const handleNode = (node) => {
        const msg = extractMessage(node);
        if (!msg) return;
        const key = `${msg.username}\x00${msg.text}`;
        if (seen.has(key)) return;
        addSeen(key);
        window.__xChatOnMessage(msg.username, msg.text);
      };

      const observer = new MutationObserver((mutations) => {
        for (const mut of mutations) {
          for (const node of mut.addedNodes) {
            handleNode(node);
            if (node instanceof Element) {
              // Walk immediate children — avoids re-walking deeply nested nodes
              for (const child of node.children) {
                handleNode(child);
              }
            }
          }
        }
      });

      observer.observe(root, { childList: true, subtree: true });
      window.__xChatObserver = observer;
      console.log('[XChat observer] MutationObserver armed on', root.tagName, containerSelector || '(body)');
    }, foundSelector);
  }

  _scheduleReconnect() {
    if (!this.running) return;
    this._reconnectAttempts++;
    const delay = Math.min(30_000, 2000 * Math.pow(2, this._reconnectAttempts - 1));
    console.log(`[XChat] Reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempts})`);
    this._restartTimer = setTimeout(async () => {
      this._restartTimer = null;
      if (this.browser) {
        try { await this.browser.close(); } catch {}
        this.browser = null;
        this.page = null;
      }
      await this._connect();
    }, delay);
  }
}

module.exports = XChatListener;
