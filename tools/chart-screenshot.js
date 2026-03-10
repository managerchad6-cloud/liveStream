const puppeteer = require('../animation-server/node_modules/puppeteer');
const path = require('path');

(async () => {
  const url = 'https://pump.fun/coin/8jiVXftnn2ZG6bugK7HAH5j2G3D6TpsG521gqsWwpump';
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for React to mount
  await new Promise(r => setTimeout(r, 5000));

  // Click "I'm ready to pump" button by finding it via text content
  try {
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('ready to pump'));
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 500));
    console.log('Clicked pump button');
  } catch (e) { console.log('Pump button click failed:', e.message); }

  // Click "Accept all" cookie button
  try {
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Accept all');
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 500));
    console.log('Clicked accept cookies');
  } catch (e) { console.log('Cookie button click failed:', e.message); }

  // Nuke any remaining fixed/absolute overlays as backup
  await page.evaluate(() => {
    document.querySelectorAll('*').forEach(el => {
      const s = window.getComputedStyle(el);
      if ((s.position === 'fixed' || s.position === 'absolute') && parseInt(s.zIndex) > 10) el.remove();
    });
    document.body.style.overflow = 'auto';
  });
  console.log('Overlay nuke done');

  // Wait for TradingView iframe and let chart fully render
  try {
    await page.waitForSelector('iframe[id^="tradingview"]', { timeout: 15000 });
    console.log('TradingView iframe found');
  } catch { console.log('TradingView iframe not found in time'); }

  await new Promise(r => setTimeout(r, 5000));

  const outPath = path.join(__dirname, '..', 'chart-test.png');
  const chartIframe = await page.$('iframe[id^="tradingview"]');
  if (chartIframe) {
    await chartIframe.screenshot({ path: outPath });
    const box = await chartIframe.boundingBox();
    console.log(`Saved chart iframe (${Math.round(box.width)}x${Math.round(box.height)}):`, outPath);
  } else {
    await page.screenshot({ path: outPath });
    console.log('Fallback: saved full page screenshot');
  }

  await browser.close();
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
