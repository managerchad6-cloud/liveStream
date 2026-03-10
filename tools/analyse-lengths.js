const fs = require('fs');
const entries = fs.readFileSync('C:/Users/Money Getting Mfucka/Dev/vvc/LiveStream/logs/dialogue.jsonl', 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l));

// Only look at aired segments with scripts
const aired = entries.filter(e => e.event === 'aired' && Array.isArray(e.script) && e.script.length > 0);

const WPM = 150; // approximate spoken WPM

function wordsInScript(script) {
  return script
    .filter(l => l.speaker !== 'narrator')
    .reduce((acc, l) => acc + l.text.split(/\s+/).filter(Boolean).length, 0);
}

function estimateSecs(words) {
  return Math.round((words / WPM) * 60);
}

const rows = aired.map(e => {
  const words = wordsInScript(e.script);
  const secs = estimateSecs(words);
  const seed = (e.seed || '').replace(/\n/g, ' ').slice(0, 60);
  return { type: e.type, words, secs, seed };
});

// Group by type
const types = ['chat-response', 'expand', 'auto-convo', 'custom-script', 'transition', 'filler'];
types.forEach(type => {
  const group = rows.filter(r => r.type === type);
  if (!group.length) return;
  const wordsList = group.map(r => r.words).sort((a,b) => a-b);
  const secsList = group.map(r => r.secs).sort((a,b) => a-b);
  const avg = arr => (arr.reduce((a,b) => a+b, 0) / arr.length).toFixed(1);
  const median = arr => arr[Math.floor(arr.length/2)];
  console.log('\n[' + type + '] n=' + group.length);
  console.log('  words — min:' + wordsList[0] + ' med:' + median(wordsList) + ' avg:' + avg(wordsList) + ' max:' + wordsList[wordsList.length-1]);
  console.log('  secs  — min:' + secsList[0] + 's med:' + median(secsList) + 's avg:' + avg(secsList) + 's max:' + secsList[secsList.length-1] + 's');

  // Show longest 3
  const sorted = group.slice().sort((a,b) => b.words - a.words);
  console.log('  Longest:');
  sorted.slice(0,3).forEach(r => console.log('    ' + r.words + 'w (' + r.secs + 's) seed="' + r.seed + '"'));
  console.log('  Shortest:');
  sorted.slice(-3).reverse().forEach(r => console.log('    ' + r.words + 'w (' + r.secs + 's) seed="' + r.seed + '"'));
});

// Distribution buckets for chat-response
const cr = rows.filter(r => r.type === 'chat-response');
console.log('\n[chat-response word distribution]');
const buckets = [[0,20],[21,40],[41,60],[61,80],[81,120],[121,999]];
buckets.forEach(([lo,hi]) => {
  const count = cr.filter(r => r.words >= lo && r.words <= hi).length;
  const bar = '█'.repeat(count);
  console.log('  ' + lo + '-' + (hi>200?'∞':hi) + 'w: ' + bar + ' (' + count + ')');
});
