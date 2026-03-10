// Simulate chat response LLM calls with the current prompt
// Uses the real OpenAI key and exact prompt from script-generator.js

const OpenAI = require('openai');
const voices = require('../voices');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = 'gpt-4o';
const WPM = 150;

const TEST_MESSAGES = [
  // Greetings / trivial
  { label: 'greeting-hi',        msg: 'hi' },
  { label: 'greeting-sup',       msg: 'sup guys' },
  { label: 'greeting-hey',       msg: 'hey chad' },
  { label: 'reaction-lol',       msg: 'lol' },
  { label: 'reaction-mewmew',    msg: 'MEW MEW' },
  // Simple / casual
  { label: 'simple-weed',        msg: "Chad i need help, this weed don't hit ma nigga" },
  { label: 'simple-gay',         msg: 'virgin youre gay' },
  { label: 'simple-haha',        msg: 'hahahaha' },
  // Substantive
  { label: 'subst-mythology',    msg: 'what is a mythology?' },
  { label: 'subst-vvc-explain',  msg: 'hi guys what is this all about?' },
  { label: 'subst-marvel-dc',    msg: 'yo chad are you into marvel or dc' },
  { label: 'subst-moon',         msg: 'will vvc moon?' },
  { label: 'subst-bondingcurve', msg: 'can you explain how the bonding curve works?' },
];

function wordCount(script) {
  return script
    .filter(l => l.speaker !== 'narrator')
    .reduce((acc, l) => acc + l.text.split(/\s+/).filter(Boolean).length, 0);
}

// Mirrors buildCharacterSystemPrompt() in server.js — the ACTUAL chat path
function buildPrompt(msg, voiceKey) {
  const voice = voices[voiceKey];
  const base = voice.basePrompt + voice.audioTags;
  const freshnessGuard = `\n\nSTYLE GUARDRAILS:\nNEVER use the "I accidentally did X and it turned into Y success" formula. No accidental success stories.\nChad: NEVER give advice or encouragement. No "just wing it", "fake it till you make it", "you gotta", "try X sometime", "you do you", "no worries". You ROAST, brag, or dismiss — never help.\nVirgin: NEVER just be generically sad or agree with Chad. No "I guess", "easier said than done", "if only". Always have a SPECIFIC detail. Get defensive about your hobbies or change the subject.\nKeep each response fresh, punchy, and aligned to the user's intent.\n\nRESPONSE LENGTH — match strictly to the message:\n- Insults, reactions, one-liners ("you're gay", "lol", "hi"): 1 sentence, 5-10 words. Hit and done.\n- Simple questions or casual comments: 1-2 sentences max.\n- Substantive questions with real content: 2-3 sentences max.\nNever rant. Never pad. A short jab beats a long speech every time.`;
  return base + freshnessGuard;
}

// Decide which character responds (mirrors server.js routing logic roughly)
function pickVoice(msg) {
  const low = msg.toLowerCase();
  if (low.includes('virgin')) return 'virgin';
  if (low.includes('chad')) return 'chad';
  return 'chad';
}

async function simulate(label, msg) {
  const voiceKey = pickVoice(msg);
  const systemPrompt = buildPrompt(msg, voiceKey);
  const userPrompt = msg; // server.js sends message directly as user content

  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    max_tokens: 150,
    temperature: 0.7
  });

  const raw = (completion.choices[0].message.content || '').trim();
  const words = raw.split(/\s+/).filter(Boolean).length;
  const secs = Math.round((words / WPM) * 60);

  return { label, msg, voiceKey, words, secs, raw };
}

async function main() {
  console.log('Running ' + TEST_MESSAGES.length + ' simulations...\n');

  const results = [];
  for (const { label, msg } of TEST_MESSAGES) {
    process.stdout.write('  ' + label + '... ');
    const r = await simulate(label, msg);
    results.push(r);
    if (r.error) {
      console.log('ERROR: ' + r.error);
    } else {
      console.log(r.words + 'w ' + r.secs + 's (' + r.lines + ' lines)');
    }
  }

  console.log('\n' + '─'.repeat(80));
  console.log('RESULTS\n');

  for (const r of results) {
    if (r.error) {
      console.log('[' + r.label + '] ERROR: ' + r.error);
      continue;
    }
    const bar = r.secs <= 5 ? '✓ SHORT' : r.secs <= 15 ? '~ OK' : r.secs <= 25 ? '⚠ LONG' : '✗ TOO LONG';
    console.log('[' + r.label + '] [' + r.voiceKey + '] ' + r.words + 'w / ' + r.secs + 's  ' + bar);
    console.log('  msg: "' + r.msg + '"');
    console.log('  reply: ' + r.raw);
    console.log();
  }

  // Summary
  const ok = results.filter(r => !r.error);
  const avgWords = (ok.reduce((a,b) => a + b.words, 0) / ok.length).toFixed(1);
  const avgSecs  = (ok.reduce((a,b) => a + b.secs,  0) / ok.length).toFixed(1);
  const tooLong  = ok.filter(r => r.secs > 25).length;
  const short    = ok.filter(r => r.secs <= 5).length;
  console.log('─'.repeat(80));
  console.log('SUMMARY: avg ' + avgWords + 'w / ' + avgSecs + 's | short(<5s): ' + short + ' | too-long(>25s): ' + tooLong + ' / ' + ok.length);
}

main().catch(console.error);
