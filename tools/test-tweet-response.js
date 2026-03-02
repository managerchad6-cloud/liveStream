const OpenAI = require('openai');
const voices = require('../voices');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const tweetText = 'This looks like a Richard Stallman vs Terry Davis meme.\n\nNot 100% sure but that "CIA" & schizophrenia gives it away.';
const tweetAuthor = 'RNR_0';
const source = 'community';
const instruction = 'this is a collaborator of our community who posted this VVC meme about a specific topic, hype him up';

const mandatoryOverride = `MANDATORY DIRECTOR OVERRIDE — EXECUTE THIS EXPLICITLY:
"${instruction}"

At least one character MUST state this directly in the dialogue. Do not imply it, hint at it, or let it fade into the background. Character voice and tone rules below describe HOW they deliver this — they do not override WHAT must be said. This instruction takes priority over everything else.

`;

const toneBlock = `TONE — COMMUNITY MEMBER TWEET:
- This person is inside our $VVC community — treat them like a fellow degen, not a target.
- Chad gives the tweet genuine props. He still keeps his cool and brags a little, but he acknowledges this person is on the right side of the trade. No roasting.
- Virgin is visibly excited and slightly flustered that someone else gets it — he over-validates, adds a tangent, or hypes the point harder than necessary.
- Both characters are on the same team here. Hype up the tweet's idea or sentiment.
- CT language: based, bullish, wagmi, ser, we're so early, this is the play, diamond hands, LFG, on-chain`;

const systemPrompt = `${mandatoryOverride}You are writing a dialogue script for a 24/7 pump.fun livestream for the $VVC token on Solana.
The hosts are Chad and Virgin (from the Virgin vs Chad meme). They are reacting to a tweet on X (Twitter).

CHARACTER PROFILES (voice/tone only — mandatory override above takes full priority):
CHAD: ${voices.chad.basePrompt}
VIRGIN: ${voices.virgin.basePrompt}

${toneBlock}

RULES:
- React to the specific tweet content — make it feel genuine and contextual
- 2–4 lines total, short punchy lines
- ElevenLabs v3 audio tags encouraged: [laughs], [chuckles], [sighs], [nervous laugh], [clears throat], etc.
- No emojis, no markdown in dialogue text
- Reference the tweet author by name if it adds character
- Crypto / CT language always welcome

Return ONLY valid JSON:
{
  "script": [
    { "speaker": "chad|virgin", "text": "..." }
  ],
  "exitContext": "brief topic summary"
}`;

const userPrompt = `Tweet by @${tweetAuthor}:\n"${tweetText}"`;

async function run() {
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
  const parsed = JSON.parse(content.replace(/```json\n?|\n?```/g, '').trim());
  parsed.script.forEach(l => console.log(l.speaker.toUpperCase() + ': ' + l.text));
}

run().catch(console.error);
