const fs = require('fs');
const lines = fs.readFileSync('C:/Users/Money Getting Mfucka/Dev/vvc/LiveStream/logs/dialogue.jsonl', 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l));

const weedIds = [
  '8f8477c4-66a0-491e-9fd9-9bccb61d43a0',
  'f0ca4c5d-d835-4d1b-a6a2-930003b351ec'
];

weedIds.forEach(rootId => {
  const rootCreated = lines.find(e => e.id === rootId && e.event === 'created');
  const rootAired = lines.find(e => e.id === rootId && e.event === 'aired');
  const seed = rootCreated ? rootCreated.seed : '(unknown)';
  console.log('\n=== "' + seed + '" ===');
  console.log('Aired: ' + (rootAired ? rootAired.at : 'NOT AIRED'));

  // Walk expand chain by expandFrom
  const chainIds = new Set([rootId]);
  let frontier = [rootId];
  const expands = [];

  while (frontier.length > 0) {
    const next = [];
    lines
      .filter(e => e.event === 'aired' && e.type === 'expand' && frontier.indexOf(e.metadata && e.metadata.expandFrom) !== -1)
      .forEach(e => {
        if (!chainIds.has(e.id)) {
          chainIds.add(e.id);
          next.push(e.id);
          expands.push(e);
        }
      });
    frontier = next;
  }

  console.log('Expand count: ' + expands.length);
  expands.forEach(function(e, i) {
    const text = (e.script || []).map(function(l) { return l.speaker + ': ' + l.text; }).join(' // ');
    console.log('  [' + (i+1) + '] expandFrom=' + (e.metadata && e.metadata.expandFrom || '').slice(0,8) + ' | ' + text.slice(0, 150));
  });

  // Show maxExpands from first expand's metadata
  const firstExpandCreated = lines.find(e => e.type === 'expand' && e.event === 'created' && e.metadata && e.metadata.expandFrom === rootId);
  if (firstExpandCreated) {
    console.log('maxExpands set by LLM: ' + (firstExpandCreated.metadata.maxExpands !== undefined ? firstExpandCreated.metadata.maxExpands : '(not set — old run, before this field existed)'));
  } else {
    console.log('No expand found referencing this root directly.');
  }
});
