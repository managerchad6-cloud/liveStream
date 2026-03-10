const fs = require('fs');
const entries = fs.readFileSync('C:/Users/Money Getting Mfucka/Dev/vvc/LiveStream/logs/dialogue.jsonl', 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l));

const lastStart = '2026-02-26T13:39:36.008Z';
const session = entries.filter(function(e) { return e.at > lastStart && e.event === 'aired'; });

session.forEach(function(e) {
  const text = (e.script || []).map(function(l) { return l.speaker + ': ' + l.text.slice(0, 70); }).join(' // ');
  const mx = e.metadata && typeof e.metadata.maxExpands !== 'undefined' ? e.metadata.maxExpands : 'n/a';
  const exFrom = e.metadata && e.metadata.expandFrom ? e.metadata.expandFrom.slice(0, 8) : '-';
  console.log('[' + e.type + '] maxExpands=' + mx + ' expandFrom=' + exFrom + '\n  ' + text + '\n');
});

console.log('Total aired segments in this session:', session.length);
console.log('  chat-response:', session.filter(function(e) { return e.type === 'chat-response'; }).length);
console.log('  expand:', session.filter(function(e) { return e.type === 'expand'; }).length);
