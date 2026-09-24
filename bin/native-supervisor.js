#!/usr/bin/env node
'use strict';
// native-supervisor.js
//
// Cero "espíritu" / cero PERSONALITIES / cero system-prompt inyectado.
// Cada bot Telegram spawnea el BINARIO NATIVO de su agente y devuelve stdout.
//
//   @Velin_dabot  ─►  /opt/homebrew/bin/openclaw agent --message "<user>" --timeout 60 --inline
//                       (run --local embedded, NO requiere gateway vivo)
//   @codiy44_bot  ─►  /Users/davidnows/bin/claude-shim/claude -p "<user>"
//                       (shim → OmniRoute :9500/v1/chat/completions, model=local-claude-code)
//   @Diosa44_bot  ─►  <venv python> ~/.hermes/hermes-agent/cli.py --query "<user>" --oneshot
//                       (Hermes Agent CLI nativo, --oneshot para answer-and-exit)
//
// Owner-gated por OWNER_ID (David id 5665555949). Sin memoria artificial:
// cada turno Nativo recibe SOLO el mensaje crudo del usuario. La memoria y
// sesiones nativas son responsabilidad del agente nativo (OpenClaw superheroe,
// Claude Code, Hermes Agent CLI).

'use strict';
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const https = require('https');
const http = require('http');
const os = require('os');
const { promisify } = require('util');
const maind = require('./maind-adapter');

const HOME = os.homedir();
const OWNER_ID = '5665555949';
const env = process.env;
const HERMES_PY = `/Users/davidnows/.hermes/hermes-agent/venv/bin/python3`;
const HERMES_CLI = `/Users/davidnows/.hermes/hermes-agent/cli.py`;

const BOTS = [
  {
    name: 'Velinda',
    username: '@Velin_dabot',
    envFile: `${HOME}/.openclaw/.env.telegram`,
    label: 'OpenClaw',
    run: async (text) => runOpenClawNative(text),
  },
  {
    name: 'codiy',
    username: '@codiy44_bot',
    envFile: `${HOME}/.claude-code/.env.telegram`,
    label: 'Claude Code',
    run: async (text) => runClaudeShim(text),
  },
  {
    name: 'Diosa',
    username: '@Diosa44_bot',
    envFile: `${HOME}/.hermes/.env.local`,
    label: 'Hermes Agent',
    run: async (text) => runHermesNative(text),
  },
];

// ── Spawn helpers ───────────────────────────────────────────────────
function spawnP(bin, args, opts = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(bin, args, {
      env: { ...process.env, OMNI_BASE_URL: 'http://127.0.0.1:9500', ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    const t = setTimeout(() => { try { p.kill('SIGTERM'); } catch (_) {} }, opts.timeoutMs || 90000);
    p.stdout.on('data', c => out += c);
    p.stderr.on('data', c => err += c);
    p.on('error', e => { clearTimeout(t); resolve({ ok: false, error: e.message, code: -1, out, err, ms: Date.now() - t0 }); });
    p.on('close', code => {
      clearTimeout(t);
      resolve({ ok: code === 0, code, out, err, ms: Date.now() - t0 });
    });
  });
}

// 1) OpenClaw NATIVO. Shim decide por probe: usa Gateway si está vivo, si
//    no fallback a --local. Pasamos el prompt por env OC_PROMPT para que el
//    shim lo recoja sin quoting fragile en argv.
async function runOpenClawNative(text) {
  const r = await spawnP('/Users/davidnows/bin/openclaw-shim/openclaw', ['agent'], {
    env: { OC_PROMPT: text, OC_TIMEOUT: '60' },
    timeoutMs: 110000,
  });
  if (r.ok && r.out.trim()) return r.out.trim();
  if (!r.ok) {
    if (r.error && /timeout/i.test(r.error)) return `(OpenClaw: timeout tras 60s)`;
    const tail = (r.err || r.out || '').toString().slice(0, 380);
    return `(OpenClaw error: code=${r.code} · ${tail || 'sin detalle'})`;
  }
  return '(OpenClaw sin salida)';
}

// 2) Claude Code NATIVO via shim → OmniRoute.
async function runClaudeShim(text) {
  // El shim parsea `claude -p "<prompt>"` y enruta a OmniRoute.
  const r = await spawnP('/Users/davidnows/bin/claude-shim/claude', ['-p', text], { timeoutMs: 120000 });
  if (r.ok && r.out.trim()) return r.out.trim();
  if (!r.ok) {
    return `(Claude error: code=${r.code}; ${(r.err || r.out || '').toString().slice(0, 380)})`;
  }
  return '(Claude sin salida)';
}

// 3) Hermes Agent CLI NATIVO vía hermes-shim. El shim fija
//    ANTHROPIC_BASE_URL=http://127.0.0.1:9500 para que Hermes use OmniRoute
//    (model free cloud / local) en lugar de Opus-4 directo (sin API key).
async function runHermesNative(text) {
  const r = await spawnP('/Users/davidnows/bin/hermes-shim/hermes', ['--query', text], { timeoutMs: 130000 });
  if (r.ok && r.out.trim()) return r.out.trim();
  if (!r.ok) {
    if (r.code === 124 || /timeout/i.test(r.error || '')) return `(Hermes: timeout tras 110s)`;
    return `(Hermes error: code=${r.code} · ${(r.err || r.out || '').toString().slice(0, 460)})`;
  }
  return '(Hermes sin salida)';
}

// ── Cliente Telegram mínimo ─────────────────────────────────────────
class Tg {
  constructor(name, token, owner) { this.name = name; this.token = token; this.ownerId = owner; this.offset = 0; }
  api(method, params) {
    return new Promise((resolve, reject) => {
      const url = `https://api.telegram.org/bot${this.token}/${method}`;
      const body = new URLSearchParams(params || {}).toString();
      const r = require('https').request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('Bad JSON ' + d.slice(0,200))); } });
      });
      r.on('error', reject);
      if (body) r.write(body);
      r.end();
    });
  }
  send(chatId, text) {
    const chunks = [];
    for (let i = 0; i < text.length; i += 3800) chunks.push(text.slice(i, i + 3800));
    return chunks.reduce((p, c) => p.then(() => this.api('sendMessage', { chat_id: chatId, text: c })), Promise.resolve());
  }
  async poll() {
    while (true) {
      try {
        const r = await this.api('getUpdates', {
          offset: this.offset,
          timeout: 25,
          allowed_updates: JSON.stringify(['message']),
        });
        if (!r.ok) { await sleep(2000); continue; }
        for (const u of r.result || []) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          if (u.message && u.message.text) await this.handleMessage(u.message);
        }
      } catch (e) {
        log(`[${this.name}] poll error: ${(e.message || '').slice(0,180)}`);
        await sleep(4000);
      }
    }
  }
  async handleMessage(msg) {
    const text = (msg.text || '').trim();
    const isOwner = String(msg.from && msg.from.id) === this.ownerId;
        if (!isOwner) {
      await this.send(msg.chat.id, '🔒 Este bot solo responde a su OWNER.');
      return;
    }
    const bot = BOTS.find(b => b.name === this.name);
    if (/^\/start\b/i.test(text)) { await this.send(msg.chat.id, `Bot ${this.name} (${bot.label}). Escribe un mensaje, lo paso al agente nativo.`); return; }
    if (/^\/ping\b/i.test(text)) { await this.send(msg.chat.id, `pong · pid=${process.pid} · native=${bot.label}`); return; }
    log(`[${this.name}] ${msg.from.id} → "${text.slice(0, 80)}"`);
    log(`[${this.name}] spawn ${bot.label} native …`);
    // MAIND read: traer últimos N turnos (cross-session) como contexto inline
    let contextBlock = '';
    try {
      const rows = await maind.readHistory(this.name, String(msg.chat.id), 6);
      if (rows.length) {
        const slim = rows.map(r => ({ role: r.role, txt: (r.content || '').slice(0, 480) }));
        contextBlock = '\n\n— Contexto previo (MAIND, últimos ' + slim.length + ' turnos) —\n' +
          slim.map(r => `[${r.role}] ${r.txt.replace(/\n+/g, ' ')}`).join('\n');
      }
    } catch (e) { /* MAIND opcional, no rompe */ }
    const t0 = Date.now();
    const reply = await bot.run(text + contextBlock);
    const elapsed = Math.round((Date.now() - t0) / 1000);
    log(`[${this.name}] ← ${reply.length} chars in ${elapsed}s`);
    // MAIND store: persistir el turno (no bloquea si falla)
    maind.storeTurn(this.name, String(msg.chat.id), text, reply)
      .then(r => log(`[${this.name}] MAIND storeTurn ok=${r.ok} user+assistant`))
      .catch(e => log(`[${this.name}] MAIND ERR ${e.message}`));
    // Prefijo de origen
    const head = `◆ ${bot.label}  ·  ${elapsed}s\n`;
    await this.send(msg.chat.id, (head + (reply || '(sin respuesta)').slice(0, 3700)));
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(s) { console.log(`[${new Date().toISOString()}] ${s}`); }

(async () => {
  for (const def of BOTS) {
    let envText = '';
    try { envText = fs.readFileSync(def.envFile, 'utf8'); } catch (e) {
      log(`⚠ ${def.name}: no puedo leer ${def.envFile}`);
      continue;
    }
    const envObj = Object.fromEntries(
      envText.split('\n').filter(Boolean).map(line => {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        return m ? [m[1], m[2].replace(/^['"]|['"]$/g, '')] : null;
      }).filter(Boolean)
    );
    const token = envObj.TELEGRAM_BOT_TOKEN || envObj.OPENCLAW_TELEGRAM_TOKEN || envObj.HERMES_TELEGRAM_TOKEN;
    if (!token) { log(`⚠ ${def.name}: sin token en ${def.envFile}`); continue; }
    const bg = new Tg(def.name, token, OWNER_ID);
  log(`━━━ ${def.name} ${def.username}  →  ${def.label}  token…${token.slice(-6)} ━━━  (MAIND read+write vía ${os.path.basename(maind.DB || '')})`);
    bg.poll().catch(e => log(`[${def.name}] poll crashed: ${e.message}`));
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
