'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CONFIG_PATH = path.join(__dirname, '..', 'twitter-config.json');
const STORE_PATH = path.join(__dirname, '..', 'twitter-tweets.json');


class TwitterIngestService {
  constructor({ tempDir }) {
    this.tempDir = tempDir;
    this._config = this._loadConfig();
    this._store = this._loadStore();
    this._pollTimer = null;
    this._pollLock = false;
    this._lastPolled = null;
    this._pollDeps = null;
    this._onUpdate = null;
  }

  // ── Config ────────────────────────────────────────────────────────────────

  _loadConfig() {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      return {};
    }
  }

  _saveConfig(data) {
    const merged = { ...this._config, ...data };
    const toSave = {};
    if (merged.ct0 !== undefined) toSave.ct0 = merged.ct0;
    if (merged.authToken !== undefined) toSave.authToken = merged.authToken;
    if (merged.communityUrl !== undefined) toSave.communityUrl = merged.communityUrl;
    if (merged.pollIntervalMinutes !== undefined) toSave.pollIntervalMinutes = merged.pollIntervalMinutes;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(toSave, null, 2), 'utf8');
    this._config = toSave;
  }

  getConfig() {
    return {
      communityUrl: this._config.communityUrl || '',
      pollIntervalMinutes: this._config.pollIntervalMinutes ?? 5,
      hasCookies: !!(this._config.ct0 && this._config.authToken)
    };
  }

  setConfig(data) {
    const update = {};
    if (data.ct0 !== undefined) update.ct0 = data.ct0;
    if (data.authToken !== undefined) update.authToken = data.authToken;
    if (data.communityUrl !== undefined) update.communityUrl = data.communityUrl;
    if (data.pollIntervalMinutes !== undefined) update.pollIntervalMinutes = Number(data.pollIntervalMinutes) || 5;
    this._saveConfig(update);
    return this.getConfig();
  }

  // ── Tweet store ───────────────────────────────────────────────────────────

  _loadStore() {
    try {
      return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    } catch {
      return { initialized: false, seen: {} };
    }
  }

  _saveStore() {
    fs.writeFileSync(STORE_PATH, JSON.stringify(this._store, null, 2), 'utf8');
  }

  _isKnown(tweetId) {
    return !!this._store.seen[tweetId];
  }

  _addToStore(tweet, isHistorical) {
    this._store.seen[tweet.id] = {
      id: tweet.id,
      url: tweet.url,
      author: tweet.author,
      text: tweet.text,
      seenAt: new Date().toISOString(),
      isHistorical,
      queued: false
    };
  }

  _markQueued(tweetId) {
    if (this._store.seen[tweetId]) {
      this._store.seen[tweetId].queued = true;
    }
  }

  getHistoricalTweets() {
    return Object.values(this._store.seen)
      .sort((a, b) => new Date(b.seenAt) - new Date(a.seenAt));
  }

  getPollingStatus() {
    return {
      isPolling: this._pollTimer !== null,
      initialized: this._store.initialized,
      seenCount: Object.keys(this._store.seen).length,
      communityUrl: this._config.communityUrl || '',
      lastPolled: this._lastPolled,
      pollIntervalMinutes: this._config.pollIntervalMinutes ?? 5
    };
  }

  // ── Puppeteer helpers ─────────────────────────────────────────────────────

  async _launchBrowser() {
    let puppeteer;
    try {
      puppeteer = require('puppeteer');
    } catch {
      throw new Error('puppeteer not installed — run: cd animation-server && npm install');
    }
    return puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }

  async _openPage(browser) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await this._setCookies(page);
    return page;
  }

  async _setCookies(page) {
    const { ct0, authToken } = this._config;
    if (!ct0 || !authToken) throw new Error('Twitter cookies not configured. Set ct0 and authToken first.');
    await page.setCookie(
      { name: 'ct0', value: ct0, domain: '.x.com', path: '/' },
      { name: 'auth_token', value: authToken, domain: '.x.com', path: '/' }
    );
  }

  // Extract tweet data from all visible articles on the current page
  async _extractArticlesFromPage(page) {
    return page.evaluate(() => {
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      const results = [];
      for (const art of articles) {
        // Prefer the timestamp link — it always points to the article's own tweet,
        // unlike the first [href*="/status/"] which may be a quoted or reply link.
        const linkEl = art.querySelector('a[href*="/status/"] time')?.closest('a')
          || art.querySelector('a[href*="/status/"]');
        if (!linkEl) continue;
        const href = linkEl.href;
        const match = href.match(/\/status\/(\d+)/);
        if (!match) continue;
        const id = match[1];
        const textEl = art.querySelector('[data-testid="tweetText"]');
        const text = textEl ? textEl.innerText.trim() : '';
        const nameEl = art.querySelector('[data-testid="User-Name"] span');
        const author = nameEl ? nameEl.innerText.trim() : 'unknown';
        results.push({ id, url: href, author, text });
      }
      // Deduplicate by id
      const seen = new Set();
      return results.filter(r => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      });
    });
  }

  async _scrollPage(page, times) {
    for (let i = 0; i < times; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  async _removeBanners(page) {
    await page.evaluate(() => {
      const SELECTORS = [
        'div[data-testid="BottomBar"]',
        'div[data-testid="sheetDialog"]',
        '[class*="cookie"]',
        '[class*="consent"]',
        '[class*="gdpr"]',
        '[id*="cookie"]',
        '[id*="consent"]',
        '[id*="gdpr"]',
      ];
      for (const sel of SELECTORS) {
        document.querySelectorAll(sel).forEach(el => el.remove());
      }
    });
  }

  async _screenshotPage(page, outputPath, tweetId = null) {
    await this._removeBanners(page);
    const box = await page.evaluate((id) => {
      const findArticle = () => {
        if (id) {
          const byLink = document.querySelector(`a[href*="/status/${id}"] time`)?.closest('article[data-testid="tweet"]');
          if (byLink) return byLink;
        }
        return document.querySelector('article[data-testid="tweet"]');
      };
      const el = findArticle();
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, tweetId);
    const clip = box && box.width > 10 && box.height > 10
      ? { x: Math.max(0, box.x), y: Math.max(0, box.y), width: box.width, height: box.height }
      : { x: 0, y: 0, width: 1280, height: 720 };
    await page.screenshot({ path: outputPath, clip, type: 'png' });
  }

  async _processScreenshot(rawPath, mediaLibrary) {
    // Store the raw clipped screenshot as-is — the TV service handles all resizing/animation
    const item = await mediaLibrary.addFile(rawPath, `tweet_${Date.now()}.png`, 'image/png');
    return item.id;
  }

  // Navigate to a tweet URL, screenshot it, return { mediaId, text, author }
  async _scrapeTweetPage(page, url, mediaLibrary) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try {
      await page.waitForSelector('article[data-testid="tweet"]', { timeout: 8000 });
    } catch {}

    // Target the specific tweet by status ID — avoids grabbing the parent/reply-context tweet
    // which is always the first article on a tweet detail page
    const tweetId = url.match(/\/status\/(\d+)/)?.[1];

    const { text, author } = await page.evaluate((id) => {
      const findArticle = () => {
        if (id) {
          const byLink = document.querySelector(`a[href*="/status/${id}"] time`)?.closest('article[data-testid="tweet"]');
          if (byLink) return byLink;
        }
        return document.querySelector('article[data-testid="tweet"]');
      };
      const article = findArticle();
      if (!article) return { text: '', author: 'unknown' };
      return {
        text: article.querySelector('[data-testid="tweetText"]')?.innerText?.trim() || '',
        author: article.querySelector('[data-testid="User-Name"] span')?.innerText?.trim() || 'unknown'
      };
    }, tweetId);

    const tmpRaw = path.join(this.tempDir, `tweet_raw_${Date.now()}.png`);
    await this._screenshotPage(page, tmpRaw, tweetId);

    let mediaId = null;
    try {
      mediaId = await this._processScreenshot(tmpRaw, mediaLibrary);
    } catch (err) {
      console.warn('[TwitterIngest] Screenshot processing failed:', err.message);
    }
    try { fs.unlinkSync(tmpRaw); } catch {}

    // Extract embedded tweet image URLs (actual photo content, not avatars/icons)
    const imageUrls = await page.evaluate((id) => {
      const findArticle = () => {
        if (id) {
          const byLink = document.querySelector(`a[href*="/status/${id}"] time`)?.closest('article[data-testid="tweet"]');
          if (byLink) return byLink;
        }
        return document.querySelector('article[data-testid="tweet"]');
      };
      const article = findArticle();
      if (!article) return [];
      const imgs = article.querySelectorAll(
        '[data-testid="tweetPhoto"] img, [data-testid="card.layoutLarge.media"] img'
      );
      return Array.from(imgs).map(img => img.src).filter(Boolean);
    }, tweetId);

    // Download first image as base64 for LLM vision pass
    let imageBase64 = null;
    let imageMimeType = 'image/jpeg';
    if (imageUrls.length > 0) {
      try {
        const response = await axios.get(imageUrls[0], { responseType: 'arraybuffer', timeout: 10000 });
        imageBase64 = Buffer.from(response.data).toString('base64');
        imageMimeType = response.headers['content-type'] || 'image/jpeg';
        console.log(`[TwitterIngest] Downloaded tweet image for vision pass (${imageUrls[0].slice(0, 60)}...)`);
      } catch (err) {
        console.warn('[TwitterIngest] Failed to download tweet image:', err.message);
      }
    }

    return { mediaId, text, author, imageBase64, imageMimeType };
  }

  // Create pipeline segment and queue it (shared by poll + queueHistorical + fetchSingle)
  // source: 'community' = hype/supportive tone, 'single' = normal in-character
  // instruction: optional freeform director note (e.g. "roast this guy", "call a RAID")
  async _createAndQueueSegment(entry, mediaId, scriptGenerator, { pipelineStore, segmentRenderer, orchestrator }, source = 'single', instruction = null) {
    const generated = await scriptGenerator.generateTweetResponseScript({
      tweetText: entry.text,
      tweetAuthor: entry.author,
      source,
      instruction,
      imageBase64: entry.imageBase64 || null,
      imageMimeType: entry.imageMimeType || 'image/jpeg'
    });

    const segment = await pipelineStore.createSegment({
      type: 'tweet-response',
      seed: `@${entry.author}: ${entry.text.slice(0, 60)}`,
      script: generated.script,
      estimatedDuration: generated.estimatedDuration
    });

    await pipelineStore.updateSegment(segment.id, {
      exitContext: generated.exitContext,
      metadata: {
        ...(segment.metadata || {}),
        source: 'twitter',
        tweetUrl: entry.url,
        tweetAuthor: entry.author,
        ...(mediaId ? { attachedMediaId: mediaId } : {})
      }
    });

    const queueFn = orchestrator?.queueSegmentWithBridge
      ? id => orchestrator.queueSegmentWithBridge(id)
      : id => segmentRenderer.queueRender(id);
    queueFn(segment.id);

    return segment.id;
  }

  // ── Community listing scrape ───────────────────────────────────────────────

  async _clickLatestTab(page) {
    try {
      const clicked = await page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
        const latest = tabs.find(t => /^latest$/i.test(t.textContent.trim()));
        if (latest) { latest.click(); return true; }
        return false;
      });
      if (clicked) {
        // Wait for the feed to reload after switching to Latest
        await new Promise(r => setTimeout(r, 2500));
        await page.waitForSelector('article[data-testid="tweet"]', { timeout: 8000 }).catch(() => {});
      } else {
        console.warn('[TwitterIngest] Latest tab not found — using default sort');
      }
    } catch (err) {
      console.warn('[TwitterIngest] Could not click Latest tab:', err.message);
    }
  }

  async _scrapeCommunityListing(page, scrolls) {
    const url = this._config.communityUrl;
    if (!url) throw new Error('communityUrl not configured');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try {
      await page.waitForSelector('article[data-testid="tweet"]', { timeout: 10000 });
    } catch {}
    await this._clickLatestTab(page);
    await this._scrollPage(page, scrolls);
    return this._extractArticlesFromPage(page);
  }

  // ── Community initialization (historical metadata only, no screenshots) ───

  /**
   * First-time run: scrape existing community tweets, save metadata as historical.
   * Does NOT screenshot or generate scripts — just marks them as known.
   */
  async initializeCommunity() {
    if (this._store.initialized) {
      return { skipped: true, seenCount: Object.keys(this._store.seen).length };
    }
    if (!this._config.communityUrl) throw new Error('communityUrl not configured');

    console.log('[TwitterIngest] Initializing community — scraping historical tweet metadata...');
    const browser = await this._launchBrowser();
    try {
      const page = await this._openPage(browser);
      const articles = await this._scrapeCommunityListing(page, 5);
      let count = 0;
      for (const art of articles) {
        if (!art.text) continue;
        this._addToStore(art, true);
        count++;
      }
      this._store.initialized = true;
      this._saveStore();
      console.log(`[TwitterIngest] Initialized with ${count} historical tweets`);
      return { count };
    } finally {
      await browser.close();
    }
  }

  // ── Polling ────────────────────────────────────────────────────────────────

  async _poll(deps) {
    if (this._pollLock) {
      console.log('[TwitterIngest] Poll skipped — previous poll still running');
      return;
    }
    if (!this._config.communityUrl) return;

    this._pollLock = true;
    const browser = await this._launchBrowser();
    try {
      console.log('[TwitterIngest] Polling for new tweets...');
      const page = await this._openPage(browser);
      const articles = await this._scrapeCommunityListing(page, 2);
      const newArticles = articles.filter(a => a.text && !this._isKnown(a.id));
      console.log(`[TwitterIngest] ${newArticles.length} new tweet(s) found`);

      // Save all new articles as seen so they don't pile up on future polls
      for (const art of newArticles) {
        this._addToStore(art, false);
      }

      // Only queue the single most recent new tweet (first in DOM order = newest)
      const toQueue = newArticles[0];
      if (toQueue) {
        try {
          await page.goto(toQueue.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          try { await page.waitForSelector('article[data-testid="tweet"]', { timeout: 8000 }); } catch {}

          const tmpRaw = path.join(this.tempDir, `tweet_raw_${Date.now()}.png`);
          await this._screenshotPage(page, tmpRaw, toQueue.id);
          let mediaId = null;
          try {
            mediaId = await this._processScreenshot(tmpRaw, deps.mediaLibrary);
          } catch (err) {
            console.warn('[TwitterIngest] Screenshot failed:', err.message);
          }
          try { fs.unlinkSync(tmpRaw); } catch {}

          // Extract embedded tweet images for vision pass
          const pollTweetId = toQueue.url.match(/\/status\/(\d+)/)?.[1];
          const pollImageUrls = await page.evaluate((id) => {
            const findArticle = () => {
              if (id) {
                const byLink = document.querySelector(`a[href*="/status/${id}"] time`)?.closest('article[data-testid="tweet"]');
                if (byLink) return byLink;
              }
              return document.querySelector('article[data-testid="tweet"]');
            };
            const article = findArticle();
            if (!article) return [];
            const imgs = article.querySelectorAll(
              '[data-testid="tweetPhoto"] img, [data-testid="card.layoutLarge.media"] img'
            );
            return Array.from(imgs).map(img => img.src).filter(Boolean);
          }, pollTweetId);
          let pollImageBase64 = null;
          let pollImageMimeType = 'image/jpeg';
          if (pollImageUrls.length > 0) {
            try {
              const resp = await axios.get(pollImageUrls[0], { responseType: 'arraybuffer', timeout: 10000 });
              pollImageBase64 = Buffer.from(resp.data).toString('base64');
              pollImageMimeType = resp.headers['content-type'] || 'image/jpeg';
            } catch (err) {
              console.warn('[TwitterIngest] Poll image download failed:', err.message);
            }
          }
          toQueue.imageBase64 = pollImageBase64;
          toQueue.imageMimeType = pollImageMimeType;

          const segmentId = await this._createAndQueueSegment(toQueue, mediaId, deps.scriptGenerator, deps, 'community');
          this._markQueued(toQueue.id);
          console.log(`[TwitterIngest] Tweet ${toQueue.id} → segment ${segmentId}`);
        } catch (err) {
          console.warn(`[TwitterIngest] Failed to process tweet ${toQueue.id}:`, err.message);
        }
      }

      this._saveStore();
      this._lastPolled = new Date().toISOString();
      if (newArticles.length > 0 && this._onUpdate) this._onUpdate();
    } catch (err) {
      console.error('[TwitterIngest] Poll error:', err.message);
    } finally {
      this._pollLock = false;
      await browser.close();
    }
  }

  /**
   * Initialize community if needed, then start automatic polling.
   */
  async startPolling(deps, onUpdate) {
    if (!this._config.communityUrl) throw new Error('communityUrl not configured');
    if (!this._config.ct0 || !this._config.authToken) throw new Error('Twitter cookies not configured');

    this._pollDeps = deps;
    this._onUpdate = onUpdate;

    if (!this._store.initialized) {
      await this.initializeCommunity();
      if (onUpdate) onUpdate();
    }

    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }

    const intervalMs = (this._config.pollIntervalMinutes ?? 5) * 60 * 1000;
    this._pollTimer = setInterval(() => this._poll(this._pollDeps), intervalMs);

    // First poll immediately
    setImmediate(() => this._poll(this._pollDeps));

    console.log(`[TwitterIngest] Polling started every ${this._config.pollIntervalMinutes ?? 5} min`);
  }

  stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    console.log('[TwitterIngest] Polling stopped');
  }

  // ── Queue a historical tweet on-demand ────────────────────────────────────

  async queueHistoricalTweet(tweetId, deps) {
    const entry = this._store.seen[tweetId];
    if (!entry) throw new Error(`Tweet not found in store: ${tweetId}`);

    const browser = await this._launchBrowser();
    try {
      const page = await this._openPage(browser);
      const { mediaId, imageBase64, imageMimeType } = await this._scrapeTweetPage(page, entry.url, deps.mediaLibrary);
      entry.imageBase64 = imageBase64;
      entry.imageMimeType = imageMimeType;
      const segmentId = await this._createAndQueueSegment(entry, mediaId, deps.scriptGenerator, deps, 'community');
      this._markQueued(tweetId);
      this._saveStore();
      return { segmentId };
    } finally {
      await browser.close();
    }
  }

  // ── Single tweet → directly to pipeline ──────────────────────────────────

  async fetchSingleTweet({ tweetUrl, instruction, mediaLibrary, scriptGenerator, pipelineStore, segmentRenderer, orchestrator }) {
    if (!this._config.ct0 || !this._config.authToken) throw new Error('Twitter cookies not configured');

    const browser = await this._launchBrowser();
    try {
      const page = await this._openPage(browser);
      const { mediaId, text, author, imageBase64, imageMimeType } = await this._scrapeTweetPage(page, tweetUrl, mediaLibrary);

      const match = tweetUrl.match(/\/status\/(\d+)/);
      const tweetId = match ? match[1] : Date.now().toString();
      const entry = { id: tweetId, url: tweetUrl, author, text, imageBase64, imageMimeType };

      const segmentId = await this._createAndQueueSegment(
        entry, mediaId, scriptGenerator,
        { pipelineStore, segmentRenderer, orchestrator },
        'single',
        instruction
      );
      return { segmentId };
    } finally {
      await browser.close();
    }
  }
}

module.exports = TwitterIngestService;
