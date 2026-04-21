/**
 * Dry-run SFX matching test — no audio, no streams.
 * Runs a batch of realistic segments through SfxMatcher and prints a
 * results table showing which sound each segment gets (and why).
 *
 * Usage:
 *   node tools/test-sfx-matching.js
 *
 * Requires OPENAI_API_KEY in the environment (or .env at project root).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const OpenAI   = require('openai');
const SfxMatcher = require('../animation-server/orchestrator/sfx-matcher');
const SfxService = require('../animation-server/sfx-service');

// ── Segments to test ─────────────────────────────────────────────────────────

const SEGMENTS = [
  {
    type: 'chat-response',
    script: [
      { speaker: 'chad', text: "Yeah I just made forty grand on that trade. Didn't even check the chart, just vibes." }
    ]
  },
  {
    type: 'chat-response',
    script: [
      { speaker: 'virgin', text: "I-I tried to flirt with her but I accidentally said 'you too' when she said enjoy your meal. I was the waiter." }
    ]
  },
  {
    type: 'auto-convo',
    script: [
      { speaker: 'chad', text: "Bro have you even read Nietzsche?" },
      { speaker: 'virgin', text: "Nietzsche... isn't that a cheese?" }
    ]
  },
  {
    type: 'chat-response',
    script: [
      { speaker: 'chad', text: "The dev literally rugged the project in the same tweet where he said 'this is not a rug pull'. Classic." }
    ]
  },
  {
    type: 'auto-convo',
    script: [
      { speaker: 'virgin', text: "I invested my entire savings into a token called BONK2 and it went to zero in four hours." },
      { speaker: 'chad', text: "...I don't even know where to start." }
    ]
  },
  {
    type: 'chat-response',
    script: [
      { speaker: 'chad', text: "She texted me first. Again. I'm telling you, effortless." }
    ]
  },
  {
    type: 'chat-response',
    script: [
      { speaker: 'virgin', text: "I've been working on this app for three years and I just realized I've been spelling 'authentication' wrong the entire time. In every variable name." }
    ]
  },
  {
    type: 'auto-convo',
    script: [
      { speaker: 'chad', text: "Actually, if you think about it, every action you take is simultaneously the only thing you could have done and also a complete coincidence." },
      { speaker: 'virgin', text: "That's... wait. Is that Schopenhauer or did you just make that up?" },
      { speaker: 'chad', text: "Both. Neither. Does it matter?" }
    ]
  },
  {
    type: 'chat-response',
    script: [
      { speaker: 'chad', text: "The server crashed during the demo in front of the entire board. In front of the CEO. During the pitch for the Series A." }
    ]
  },
  {
    type: 'chat-response',
    script: [
      { speaker: 'virgin', text: "I said 'I love you' to my Uber driver on accident. He said 'thanks man' and then drove the rest of the way in complete silence." }
    ]
  },
  {
    type: 'auto-convo',
    script: [
      { speaker: 'chad', text: "Okay so hear me out. What if the real blue chip was the friends we made along the way." },
      { speaker: 'virgin', text: "Chad that's not how tokenomics works." }
    ]
  },
  {
    type: 'chat-response',
    script: [
      { speaker: 'chad', text: "He said my code was unreadable. I said it's not unreadable, it's encrypted against mediocrity." }
    ]
  },
  {
    type: 'chat-response',
    script: [
      { speaker: 'virgin', text: "I spent six months building a product that solves a problem nobody has. The pitch is going great." }
    ]
  },
  {
    type: 'auto-convo',
    script: [
      { speaker: 'chad', text: "You should go to the gym. Seriously. It changes everything." },
      { speaker: 'virgin', text: "I went once. I pulled a muscle opening my water bottle." }
    ]
  },
  {
    type: 'chat-response',
    script: [
      { speaker: 'chad', text: "She's literally a 10. 10. And she keeps texting me. I don't even reply that fast." }
    ]
  },
  {
    type: 'chat-response',
    script: [
      { speaker: 'virgin', text: "I asked my crush if she wanted to hang out and she said 'maybe' and then I googled 'does maybe mean yes' for forty-five minutes." }
    ]
  },
  {
    type: 'auto-convo',
    script: [
      { speaker: 'chad', text: "Real talk, Bitcoin is going to 200k by end of year." },
      { speaker: 'virgin', text: "You said the same thing last year. And the year before." },
      { speaker: 'chad', text: "And I was early both times." }
    ]
  },
  {
    type: 'chat-response',
    script: [
      { speaker: 'virgin', text: "My startup just got rejected from Y Combinator for the third time. The feedback just said 'no.'" }
    ]
  },
  {
    type: 'chat-response',
    script: [
      { speaker: 'chad', text: "I just closed the deal. Wire hit this morning. Different league, different timezone, different everything." }
    ]
  },
  {
    type: 'auto-convo',
    script: [
      { speaker: 'virgin', text: "What if we just... deleted all the tests? They keep failing and it slows down the deploy." },
      { speaker: 'chad', text: "I genuinely cannot believe you just said that out loud." }
    ]
  },
  {
    type: 'chat-response',
    script: [
      { speaker: 'chad', text: "It's hypocritical to call yourself anti-consumerist while posting on a device made by the largest company in the world." }
    ]
  },
  {
    type: 'chat-response',
    script: [
      { speaker: 'virgin', text: "I tried to do a backflip at the party. I did not land the backflip." }
    ]
  },
  {
    type: 'auto-convo',
    script: [
      { speaker: 'chad', text: "Bro just drink water, work out, and read. That's literally the whole secret." },
      { speaker: 'virgin', text: "I drink water. I'm fine." },
      { speaker: 'chad', text: "You just told me you've been awake for 38 hours editing a Minecraft video." }
    ]
  },
  {
    type: 'chat-response',
    script: [
      { speaker: 'chad', text: "The market opened, I hit my target by 9:32, closed the laptop and went surfing. Simple." }
    ]
  },
  {
    type: 'chat-response',
    script: [
      { speaker: 'virgin', text: "I deployed to production on a Friday. I'm fine. It's fine. Everything is fine." }
    ]
  },
  {
    type: 'auto-convo',
    script: [
      { speaker: 'chad', text: "Actually this whole conversation has been very well-documented. You said several things tonight that deserve to be preserved forever." },
      { speaker: 'virgin', text: "Please don't." },
      { speaker: 'chad', text: "Already posted." }
    ]
  },
  {
    type: 'chat-response',
    script: [
      { speaker: 'virgin', text: "My doctor said I need to go outside more. I told him I go outside every time DoorDash arrives. He didn't laugh." }
    ]
  },
  {
    type: 'auto-convo',
    script: [
      { speaker: 'chad', text: "I honestly feel bad for people who don't have the confidence to just walk up and talk to anyone." },
      { speaker: 'virgin', text: "I once stood outside a coffee shop for twenty minutes deciding whether to go in." }
    ]
  },
  {
    type: 'chat-response',
    script: [
      { speaker: 'chad', text: "Listen. The token chart looked exactly like this in 2021 right before it 10x'd. I'm just saying." }
    ]
  },
  {
    type: 'chat-response',
    script: [
      { speaker: 'virgin', text: "I wrote 2000 lines of code this week and shipped nothing because I kept refactoring. The feature still isn't done. It's perfect though. Theoretically." }
    ]
  },
];

// ── Setup ─────────────────────────────────────────────────────────────────────

const openai     = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const sfxService = new SfxService();
const matcher    = new SfxMatcher({ sfxService, openai, pipelineStore: null });

// ── Run ───────────────────────────────────────────────────────────────────────

async function run() {
  const sounds = sfxService.list();
  console.log(`\nLoaded ${sounds.length} sounds — running ${SEGMENTS.length} segments through SfxMatcher\n`);

  const results = [];
  const distribution = {};

  for (let i = 0; i < SEGMENTS.length; i++) {
    const seg = SEGMENTS[i];
    const preview = seg.script.map(l => `[${l.speaker}] ${l.text}`).join(' / ').slice(0, 80);
    process.stdout.write(`[${String(i + 1).padStart(2)}/${SEGMENTS.length}] ${preview}...\n`);

    const result = await matcher.match(seg);

    if (result) {
      matcher.trackPlayed(result.sfxId);
      distribution[result.sfxId] = (distribution[result.sfxId] || 0) + 1;
    }

    results.push({ seg, result });

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 400));
  }

  // ── Results table ───────────────────────────────────────────────────────────
  console.log('\n\n══════════════════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('══════════════════════════════════════════════════════════════════════\n');

  for (let i = 0; i < results.length; i++) {
    const { seg, result } = results[i];
    const speakers = [...new Set(seg.script.map(l => l.speaker))].join(' + ');
    const text = seg.script.map(l => l.text).join(' / ').slice(0, 90);

    if (result) {
      console.log(`  ${String(i + 1).padStart(2)}. [${speakers}] "${text}"`);
      console.log(`      → ${result.sfxId} (${result.placement}, ${result.score.toFixed(2)}) — ${result.reason}\n`);
    } else {
      console.log(`  ${String(i + 1).padStart(2)}. [${speakers}] "${text}"`);
      console.log(`      → (no match)\n`);
    }
  }

  // ── Distribution ────────────────────────────────────────────────────────────
  const matched = results.filter(r => r.result).length;
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(`  DISTRIBUTION  (${matched}/${SEGMENTS.length} segments got an SFX)`);
  console.log('══════════════════════════════════════════════════════════════════════\n');

  const sorted = Object.entries(distribution).sort((a, b) => b[1] - a[1]);
  for (const [sfxId, count] of sorted) {
    const bar = '█'.repeat(count);
    console.log(`  ${bar.padEnd(10)} ${count}x  ${sfxId}`);
  }

  const unused = sounds.filter(s => !distribution[s.id]);
  console.log(`\n  Sounds not triggered (${unused.length}): ${unused.map(s => s.id).join(', ')}\n`);
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
