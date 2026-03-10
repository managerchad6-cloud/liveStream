'use strict';

const path = require('path');
const fs = require('fs');

// Inline the UMD standalone build so the HTML is fully self-contained —
// avoids all file:// path encoding issues (spaces, Windows drive letters, etc.)
const LWTC_JS = fs.readFileSync(
  path.join(__dirname, 'node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js'),
  'utf8'
);

// ── OHLCV fetching ────────────────────────────────────────────────────────────

/**
 * Bucket raw pump.fun trades into OHLCV candles.
 * Price = sol_amount / token_amount (SOL per token).
 */
function bucketCandles(trades, bucketSecs = 60) {
  const buckets = new Map();
  for (const t of trades) {
    if (!t.sol_amount || !t.token_amount) continue;
    const ts = Math.floor(t.timestamp / bucketSecs) * bucketSecs;
    const price = t.sol_amount / t.token_amount;
    if (!buckets.has(ts)) {
      buckets.set(ts, { time: ts, open: price, high: price, low: price, close: price, volume: t.sol_amount });
    } else {
      const b = buckets.get(ts);
      b.high = Math.max(b.high, price);
      b.low  = Math.min(b.low,  price);
      b.close = price;
      b.volume += t.sol_amount;
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

async function fetchWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'LiveStream/1.0' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Post-migration: GeckoTerminal 5-min OHLCV for a Solana pool */
async function fetchGeckoTerminalOHLCV(poolAddress) {
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/minute?limit=100&aggregate=5`;
  const data = await fetchWithTimeout(url);
  const list = data?.data?.attributes?.ohlcv_list || [];
  // list entries: [timestamp_secs, open, high, low, close, volume]
  return list
    .map(([t, o, h, l, c]) => ({
      time: t,
      open:  parseFloat(o),
      high:  parseFloat(h),
      low:   parseFloat(l),
      close: parseFloat(c),
    }))
    .sort((a, b) => a.time - b.time);
}

/** Pre-migration: pump.fun trades → 1-min buckets */
async function fetchPumpFunCandles(mint) {
  const url = `https://frontend-api.pump.fun/coins/${mint}/trades?limit=200&offset=0`;
  const trades = await fetchWithTimeout(url);
  if (!Array.isArray(trades) || trades.length === 0) return [];
  return bucketCandles(trades, 60);
}

/** Unified OHLCV fetch: uses pairAddress (GeckoTerminal) if available, else pump.fun */
async function fetchOHLCV(tokenAddress, pairAddress) {
  if (pairAddress) {
    return fetchGeckoTerminalOHLCV(pairAddress);
  }
  return fetchPumpFunCandles(tokenAddress);
}

// ── Chart HTML generation ─────────────────────────────────────────────────────

function buildChartHtml(candles, symbol, priceLabel) {
  const candlesJson = JSON.stringify(
    candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close }))
  );

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0b0b12; width:1280px; height:720px; overflow:hidden; font-family:-apple-system,'Segoe UI',sans-serif; }
#header { position:absolute; top:14px; left:18px; z-index:10; pointer-events:none; }
#symbol { font-size:20px; font-weight:700; color:#e0e0e0; letter-spacing:0.06em; }
#price  { font-size:13px; color:#666; margin-top:3px; font-family:monospace; }
#chart  { width:1280px; height:720px; }
</style></head>
<body>
<div id="header">
  <div id="symbol">$${symbol}</div>
  ${priceLabel ? `<div id="price">${priceLabel}</div>` : ''}
</div>
<div id="chart"></div>
<script>${LWTC_JS}</script>
<script>
const chart = LightweightCharts.createChart(document.getElementById('chart'), {
  width: 1280, height: 720,
  layout: { background: { color: '#0b0b12' }, textColor: '#555' },
  grid: { vertLines: { color: '#13131e' }, horzLines: { color: '#13131e' } },
  crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  rightPriceScale: { borderColor: '#1c1c2a' },
  timeScale: { borderColor: '#1c1c2a', timeVisible: true, secondsVisible: false },
});
const series = chart.addSeries(LightweightCharts.CandlestickSeries, {
  upColor: '#26a69a', downColor: '#ef5350',
  borderVisible: false,
  wickUpColor: '#26a69a', wickDownColor: '#ef5350',
});
series.setData(${candlesJson});
chart.timeScale().fitContent();
document.body.setAttribute('data-ready', '1');
</script>
</body></html>`;
}

// ── Puppeteer screenshot ──────────────────────────────────────────────────────

async function renderChartScreenshot(candles, { symbol, priceLabel, tempDir }) {
  const puppeteer = require('puppeteer');
  const html     = buildChartHtml(candles, symbol, priceLabel);
  const htmlPath = path.join(tempDir, `chart_local_${Date.now()}.html`);
  fs.writeFileSync(htmlPath, html, 'utf8');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    // file:// URL — no Cloudflare, no network, instant load
    await page.goto(`file://${htmlPath.replace(/\\/g, '/')}`, { waitUntil: 'load', timeout: 10000 });
    await page.waitForFunction(() => document.body.getAttribute('data-ready') === '1', { timeout: 5000 });
    await new Promise(r => setTimeout(r, 300)); // let canvas paint
    return await page.screenshot({ type: 'png' });
  } finally {
    await browser.close();
    try { fs.unlinkSync(htmlPath); } catch {}
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch OHLCV, render a dark 1280×720 candlestick chart, return PNG buffer.
 * Returns { buffer: Buffer|null, hasChart: boolean }
 */
async function getChartScreenshot({ tokenAddress, pairAddress, symbol = 'TOKEN', tokenData = {}, tempDir }) {
  const priceLabel = tokenData.priceUsd
    ? `$${parseFloat(tokenData.priceUsd).toFixed(parseFloat(tokenData.priceUsd) < 0.001 ? 8 : 4)}`
    : '';

  let candles = [];
  try {
    candles = await fetchOHLCV(tokenAddress, pairAddress);
    console.log(`[ChartRenderer] Fetched ${candles.length} candles for ${pairAddress ? 'GeckoTerminal' : 'pump.fun'}`);
  } catch (err) {
    console.warn('[ChartRenderer] OHLCV fetch failed:', err.message);
  }

  if (candles.length < 2) {
    console.warn('[ChartRenderer] Not enough candles — skipping chart screenshot');
    return { buffer: null, hasChart: false };
  }

  const buffer = await renderChartScreenshot(candles, { symbol, priceLabel, tempDir });
  return { buffer, hasChart: true };
}

module.exports = { getChartScreenshot };
