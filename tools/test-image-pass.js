'use strict';

/**
 * End-to-end test: tweet image pass → vision description → dialogue generation
 * Usage: node tools/test-image-pass.js <tweet-url>
 */

const path = require('path');
const axios = require('axios');
const OpenAI = require('openai');
const voices = require('../voices');

const TWEET_URL = process.argv[2] || 'https://x.com/RNR_0/status/966473390528843776';
const CT0 = '25c737acee4a04e7c581d153cae5e842987c6dbf0703b24b42995e582278292412eba6cd911dc2a062fdb6c2f0eb38e65b345a4f732b651f1216db8f5ae44c091439d09d470500ddb31d308d1af6aa62';
const AUTH_TOKEN = '28c97aa6c5b0f4a00d200074270a0d87e29cf337';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function scrapeTweet(url) {
  const puppeteer = require('../animation-server/node_modules/puppeteer');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setCookie(
      { name: 'ct0', value: CT0, domain: '.x.com', path: '/' },
      { name: 'auth_token', value: AUTH_TOKEN, domain: '.x.com', path: '/' }
    );

    console.log('Navigating to tweet...');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await page.waitForSelector('article[data-testid="tweet"]', { timeout: 10000 }); } catch {}

    // Target the specific tweet by its status ID, not just the first article on the page
    // (the first article is often the parent tweet being replied to)
    const tweetId = url.match(/\/status\/(\d+)/)?.[1];

    const { text, author, imageUrls } = await page.evaluate((id) => {
      const findArticle = () => {
        if (id) {
          const byLink = document.querySelector(`a[href*="/status/${id}"] time`)?.closest('article[data-testid="tweet"]');
          if (byLink) return byLink;
        }
        return document.querySelector('article[data-testid="tweet"]');
      };

      const article = findArticle();
      if (!article) return { text: '', author: 'unknown', imageUrls: [] };

      const text = article.querySelector('[data-testid="tweetText"]')?.innerText?.trim() || '';
      const author = article.querySelector('[data-testid="User-Name"] span')?.innerText?.trim() || 'unknown';
      const imgs = article.querySelectorAll(
        '[data-testid="tweetPhoto"] img, [data-testid="card.layoutLarge.media"] img'
      );
      const imageUrls = Array.from(imgs).map(img => img.src).filter(Boolean);

      return { text, author, imageUrls };
    }, tweetId);

    console.log(`Author: @${author}`);
    console.log(`Text: ${text || '(none)'}`);
    console.log(`Image URLs found: ${imageUrls.length}`);
    if (imageUrls.length) console.log(`  → ${imageUrls[0].slice(0, 80)}...`);

    let imageBase64 = null;
    let imageMimeType = 'image/jpeg';
    if (imageUrls.length > 0) {
      console.log('Downloading tweet image...');
      const resp = await axios.get(imageUrls[0], { responseType: 'arraybuffer', timeout: 10000 });
      imageBase64 = Buffer.from(resp.data).toString('base64');
      imageMimeType = resp.headers['content-type'] || 'image/jpeg';
      console.log(`Downloaded ${Math.round(imageBase64.length * 0.75 / 1024)}KB image`);
    }

    return { text, author, imageBase64, imageMimeType };
  } finally {
    await browser.close();
  }
}

async function describeImage(imageBase64, imageMimeType) {
  console.log('\nRunning vision pass...');
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe what is in this image in 1-2 sentences. Focus on the meme format, subject matter, any visible text, and what makes it funny or notable. Be concise.' },
        { type: 'image_url', image_url: { url: `data:${imageMimeType};base64,${imageBase64}` } }
      ]
    }],
    max_tokens: 150
  });
  return response.choices?.[0]?.message?.content?.trim() || null;
}

async function generateDialogue({ tweetText, tweetAuthor, imageDescription, source, instruction }) {
  const mandatoryOverride = instruction ? `MANDATORY DIRECTOR OVERRIDE — THIS GOVERNS HOW THE CHARACTERS BEHAVE:
"${instruction}"

Execute this as behaviour, not as a line to recite. The characters must DO what this says through their words, reactions, and tone — they must NOT quote or paraphrase this instruction itself. Character voice describes HOW they deliver it. This takes priority over everything else.

` : '';

  const toneBlock = source === 'community'
    ? `TONE — COMMUNITY MEMBER TWEET:
- This person is inside our $VVC community — treat them like a fellow degen, not a target.
- Chad gives the tweet genuine props. He still keeps his cool and brags a little, but he acknowledges this person is on the right side of the trade. No roasting.
- Virgin is visibly excited and slightly flustered that someone else gets it — he over-validates, adds a tangent, or hypes the point harder than necessary.
- Both characters are on the same team here. Hype up the tweet's idea or sentiment.
- CT language: based, bullish, wagmi, ser, we're so early, this is the play, diamond hands, LFG, on-chain`
    : `TONE — EXTERNAL TWEET:
- React naturally and fully in-character.
- Chad roasts, brags, or dismisses as he sees fit — no obligation to be supportive.
- Virgin gets defensive, counters with niche facts, or spirals into self-doubt.
- Normal dynamic applies.`;

  const systemPrompt = `${mandatoryOverride}You are writing a dialogue script for a 24/7 pump.fun livestream for the $VVC token on Solana.
The hosts are Chad and Virgin (from the Virgin vs Chad meme). They are reacting to a tweet on X (Twitter).

CHARACTER PROFILES (voice/tone only — mandatory override above takes full priority):
CHAD: ${voices.chad.basePrompt}
VIRGIN: ${voices.virgin.basePrompt}

${toneBlock}

RULES:
- React to the specific tweet content — make it feel genuine and contextual
- If an image is described, reference it specifically — the characters can see it on screen
- 2–4 lines total, short punchy lines
- ElevenLabs v3 audio tags encouraged: [laughs], [chuckles], [sighs], [nervous laugh], [clears throat], etc.
- No emojis, no markdown in dialogue text
- Reference the tweet author by name if it adds character
- Crypto / CT language always welcome

Return ONLY valid JSON:
{
  "script": [{ "speaker": "chad|virgin", "text": "..." }],
  "exitContext": "brief topic summary"
}`;

  const imageContext = imageDescription ? `\nATTACHED IMAGE: ${imageDescription}` : '';
  const userPrompt = `Tweet by @${tweetAuthor}:\n"${tweetText}"${imageContext}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.9,
    max_tokens: 300
  });

  const content = completion.choices[0].message.content;
  return JSON.parse(content.replace(/```json\n?|\n?```/g, '').trim());
}

async function main() {
  console.log(`Testing image pass pipeline for: ${TWEET_URL}\n`);

  const { text, author, imageBase64, imageMimeType } = await scrapeTweet(TWEET_URL);

  let imageDescription = null;
  if (imageBase64) {
    imageDescription = await describeImage(imageBase64, imageMimeType);
    console.log(`\nImage description: "${imageDescription}"`);
  } else {
    console.log('\nNo image found — text-only path');
  }

  console.log('\nGenerating dialogue...\n');
  const result = await generateDialogue({
    tweetText: text,
    tweetAuthor: author,
    imageDescription,
    source: 'single',
    instruction: 'absolutely roast this project into the ground, kill all its credibility, make it clear no one should touch it'
  });

  console.log('--- DIALOGUE ---');
  result.script.forEach(l => console.log(`${l.speaker.toUpperCase()}: ${l.text}`));
  console.log(`\nExit context: ${result.exitContext}`);
}

main().catch(console.error);
