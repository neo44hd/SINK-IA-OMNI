#!/usr/bin/env node
// maind-adapter.js — lee y escribe turnos por chatId/bot al sqlite MAIND.
// Reemplaza a readMAINDHistory / recallMAIND del viejo supervisor.
'use strict';
const { execFile } = require('child_process');
const DB = '/Users/davidnows/sinkia-memory/data/memory.db';
const SQ = '/usr/bin/sqlite3';

function esc(s) { return String(s).replace(/'/g, "''"); }

// Devuelve array ordenado (más antiguo primero) [{role, content}]
function readHistory(botName, chatId, n = 8) {
  return new Promise((resolve) => {
    const sql = `
SELECT content, tags
FROM documents
WHERE app = 'native-supervisor'
  AND category = 'conversation'
  AND tags LIKE 'chat:${esc(chatId)}:%'
ORDER BY created_at DESC
LIMIT ${n * 2};
`;
    execFile(SQ, ['-separator', '|', '-noheader', DB, sql],
      { timeout: 3000, maxBuffer: 1024 * 256 },
      (err, stdout) => {
        if (err) return resolve([]);
        const rows = stdout.trim().split('\n').filter(Boolean).map(l => {
          const [content, tags] = l.split('|');
          const role = (tags || '').split(',').find(t => t.startsWith('role:'));
          return { content, role: role ? role.slice(5) : 'user' };
        }).reverse();
        resolve(rows);
      });
  });
}

// Inserta par (user, assistant) con tags chat:xxx:bot + role:user|assistant
function storeTurn(botName, chatId, userText, assistantText) {
  return new Promise((resolve) => {
    const now = new Date().toISOString();
    const tagsUser = `chat:${chatId}:${botName},role:user`;
    const tagsAsst = `chat:${chatId}:${botName},role:assistant`;
    const hashU = Buffer.from(userText + botName + chatId + now).toString('base64').slice(0, 32);
    const hashA = Buffer.from((assistantText || '') + botName + chatId + now).toString('base64').slice(0, 32);
    const sql = `
INSERT INTO documents (content, source, source_path, doc_type, app, category, level, tags, created_at, content_hash)
VALUES
  ('${esc(userText)}', 'telegram', 'bot:${botName}', 'msg', 'native-supervisor', 'conversation', 'info', '${tagsUser}', '${now}', '${hashU}'),
  ('${esc(assistantText || '')}', 'telegram', 'bot:${botName}', 'msg', 'native-supervisor', 'conversation', 'info', '${tagsAsst}', '${now}', '${hashA}')
ON CONFLICT(content_hash) DO NOTHING;
`;
    execFile(SQ, [DB, sql], { timeout: 3000, maxBuffer: 1024 * 64 },
      (err, stdout, stderr) => resolve({ ok: !err, stderr }));
  });
}

// CLI: maind-adapter.js read <bot> <chatId> [n]
//      maind-adapter.js write <bot> <chatId> <user> <assistant>
//      maind-adapter.js ping
module.exports = { readHistory, storeTurn, DB };
if (require.main === module) {
const argv = process.argv.slice(2);
const cmd = argv[0];
if (cmd === 'ping') {
  execFile(SQ, ['-noheader', DB, 'SELECT COUNT(*) FROM documents;'], (e, o) => {
    if (e) { console.error('ERR', e.message); process.exit(1); }
    console.log(`MAIND docs=${o.trim()}`);
    process.exit(0);
  });
} else if (cmd === 'read') {
  readHistory(argv[1], argv[2], parseInt(argv[3] || '8', 10))
    .then(rows => { console.log(JSON.stringify(rows)); process.exit(0); })
    .catch(e => { console.error(e.message); process.exit(1); });
} else if (cmd === 'write') {
  const [bot, chatId, user, assistant] = argv.slice(1);
  storeTurn(bot, chatId, user, assistant)
    .then(r => { console.log(r.ok ? 'OK' : 'ERR: ' + r.stderr); process.exit(r.ok ? 0 : 1); });
} else {
  console.log('uso: maind-adapter.js {ping|read|write} ...');
  process.exit(2);
}
} // end if (require.main === module)
