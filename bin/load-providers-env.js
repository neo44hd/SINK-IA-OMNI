// bin/load-providers-env.js
// Loaded by synk-orchestrator via PM2 `node_args: ['-r', ...]`.
// Reads /Users/davidnows/.synkia-ai-hub/.env.providers once and exports its
// variables into process.env BEFORE the orchestrator body runs.
// Commented lines (#) and empty lines are ignored.
'use strict';
const fs = require('fs');
const path = '/Users/davidnows/.synkia-ai-hub/.env.providers';
try {
  const content = fs.readFileSync(path, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch (e) {
  // No file, no keys, do nothing.
}
