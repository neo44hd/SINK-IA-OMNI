#!/usr/bin/env node
/**
 * unified-telegram-supervisor.js — UN solo proceso para los 3 bots Telegram.
 *
 *   Velinda   ─►  @Velin_dabot    (token en ~/.openclaw/.env.telegram)
 *   codiy     ─►  @codiy44_bot    (token en ~/.claude-code/.env.telegram)
 *   Diosa     ─►  @Diosa44_bot    (token en ~/.hermes/.env.local)
 *
 * Política:
 *   - Todo mensaje a OmniRoute :9500/api/orchestrator/inference
 *   - TaskType routing automático: chat/coding/fast según detección
 *   - Eventos registrados en MAIND SQLite (audit log / pérdida-cero)
 *   - OWNER_ID (5665555949) tiene SUPER PODERES: tools allowed
 *   - Otros usuarios: chat + listado de modelos
 *   - Retry policy automático (OmniRoute rota entre providers)
 *
 * Uso:
 *   node unified-telegram-supervisor.js
 *
 * @author SynK-IA · 2026-09-19
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
// MAIND persistence: subprocess to /usr/bin/sqlite3 (no npm deps)

// ─────────────────────────────────────────────────────────────────────────
// TELEGRAM INTEGRATION (sin npm install — implementación mínima nativa)
// ─────────────────────────────────────────────────────────────────────────

class TelegramBot {
  constructor(name, token, ownerId) {
    this.name = name;
    this.token = token;
    this.ownerId = String(ownerId);
    this.offset = 0;
    this.running = false;
    this.lastError = null;
  }

  async call(method, body = {}) {
    const data = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${this.token}/${method}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
      }, res => {
        let buf = '';
        res.on('data', d => buf += d);
        res.on('end', () => {
          try {
            const r = JSON.parse(buf);
            if (!r.ok) reject(new Error(`Telegram ${method} error: ${r.description}`));
            else resolve(r);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  async start() {
    this.running = true;
    log(`[${this.name}] ✓ started (token …${this.token.slice(-6)})`);
    // Force polling mode (clear any webhook left by otro proceso)
    try { await this.call('deleteWebhook', { drop_pending_updates: false }); } catch (_) {}
    while (this.running) {
      try {
        const r = await this.call('getUpdates', { offset: this.offset, timeout: 30, allowed_updates: ['message'] });
        for (const update of r.result || []) {
          this.offset = update.update_id + 1;
          if (update.message) await this.handleMessage(update.message);
        }
      } catch (err) {
        this.lastError = err.message;
        log(`[${this.name}] ⚠ poll error: ${err.message}`);
        // Si es el conflicto webhook, forzar limpieza y reintentar ya
        if (/webhook/i.test(err.message)) {
          try { await this.call('deleteWebhook', { drop_pending_updates: false }); } catch (_) {}
          this.offset = 0; // reset para re-recibir pending
        }
        await sleep(3000);
      }
    }
  }

  async send(chatId, text, opts = {}) {
    await this.call('sendMessage', { chat_id: chatId, text, parse_mode: opts.parse_mode || 'Markdown', ...opts });
  }

  async handleMessage(msg) {
    const text = (msg.text || '').trim();
    const fromId = String(msg.from.id);
    const isOwner = fromId === this.ownerId;
    const isCommand = text.startsWith('/');

    log(`[${this.name}] ${fromId}${isOwner ? ' 👑' : ''}: ${text.slice(0, 80)}`);
    await registerMAIND({ bot: this.name, from: fromId, text });

    if (!text) return;

    // Comandos
    if (isCommand) {
      const cmd = text.split(' ')[0].toLowerCase();
      const arg = text.slice(cmd.length).trim();

      if (cmd === '/start' || cmd === '/help') {
        const helpLines = [
          `🤖 *${this.name}* (SynK-IA · OmniRoute)`,
          ``,
          `Comandos OWNER (👑 David id 5665555949):`,
          `/shell <cmd>  · Ejecuta bash en el Mac`,
          `/read <path>   · Lee archivo (cuota: 50KB)`,
          `/write <path> <txt> · Sobrescribe archivo`,
          `/ls <dir>      · Lista directorio`,
          `/pm2 [cmd]     · pm2 status/restart/log`,
          `/docker [cmd]  · Docker ps/exec/inspect`,
          `/web <url>     · Fetch URL (HTTP)`,
          `/omnis         · Lista 22 modelos free live`,
          `/health        · Estado de TODOS los servicios`,
          ``,
          `Cualquier texto → inferencia vía OmniRoute (9500).`,
          `OWNER recibe ⚡ SUPER PODERES; otros: solo chat.`
        ];
        await this.send(msg.chat.id, helpLines.join('\n'));
        return;
      }

      // ── Tool commands: requieren OWNER ──
      if (!isOwner) {
        await this.send(msg.chat.id, `🔒 *${cmd}* es solo para OWNER (👑).`);
        return;
      }

      if (cmd === '/shell')       return await this.cmdShell(msg.chat.id, arg);
      if (cmd === '/read')        return await this.cmdRead(msg.chat.id, arg);
      if (cmd === '/write')       return await this.cmdWrite(msg.chat.id, arg);
      if (cmd === '/ls')          return await this.cmdLs(msg.chat.id, arg || '.');
      if (cmd === '/pm2')         return await this.cmdPm2(msg.chat.id, arg);
      if (cmd === '/docker')      return await this.cmdDocker(msg.chat.id, arg);
      if (cmd === '/web')         return await this.cmdWeb(msg.chat.id, arg);
      if (cmd === '/omnis') {
        try {
          const r = await omni('/api/orchestrator/discover/openrouter');
          const list = (r.models || []).slice(0, 15).map(m => `• ${m.id}`).join('\n');
          await this.send(msg.chat.id, `🌐 **OpenRouter free (${r.count})**:\n${list}`);
        } catch (e) { await this.send(msg.chat.id, `Error: ${e.message}`); }
        return;
      }
      if (cmd === '/health')      return await this.cmdHealth(msg.chat.id);
      if (cmd === '/orch')        text = arg;  // continua al chat con OmniRoute
      else return await this.send(msg.chat.id, `❓ Comando *${cmd}* no reconocido. /help`);
    }

    // Inferencia vía OmniRoute
    try {
      const task = detectTask(text);
      const out = await omni('/api/orchestrator/inference', {
        input: text, taskType: task, options: { max_tokens: 1024, temperature: 0.2 }
      });
      await this.send(msg.chat.id, formatReply(out, isOwner));
    } catch (err) {
      await this.send(msg.chat.id, `❌ Error: ${err.message.slice(0, 200)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// OMNIROUTE & HELPERS
// ─────────────────────────────────────────────────────────────────────────

function omni(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({
      hostname: '127.0.0.1', port: 9500, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error(`bad json: ${buf.slice(0,200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }

function detectTask(text) {
  const t = text.toLowerCase();
  if (/\b(code|coding|bug|fix|función|python|js|sql|api)\b/.test(t)) return 'coding';
  if (/\b(piensa|analiza|why|razona|complex)\b/.test(t)) return 'reasoning';
  if (/^(ok|hola|hello|hi|test|cuenta)\s*$/i.test(text)) return 'fast';
  return 'chat';
}

function formatReply(out, asOwner) {
  const status = out.status === 'ok' ? '✅' : '⚠️';
  const provider = out.provider || '?';
  const model = out.model || '?';
  const latency = out.latency_ms || '?';
  const text = (out.text || '').slice(0, 3800);
  const head = `${status} *${provider}* / *${model}*\n⏱ ${latency}ms\n\n`;
  return head + text;
}

// TOOLS_HELP eliminado (ahora /help muestra el menú completo con todos los tools)

// ─────────────────────────────────────────────────────────────────────────
// TOOL IMPLEMENTATIONS (llamados desde handleMessage; gated by OWNER)
// ─────────────────────────────────────────────────────────────────────────

async function runShell(text, timeout = 30000) {
  return await new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-c', text], { timeout });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('exit', code => resolve({ code, stdout, stderr }));
    proc.on('error', reject);
  });
}

async function runHttp(url, timeout = 15000) {
  return await new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data.slice(0, 4000), headers: res.headers }));
    });
    req.on('error', reject);
  });
}

// Métodos adicionales en la clase TelegramBot (inyectados via prototype)
TelegramBot.prototype.cmdShell = async function (chatId, cmd) {
  if (!cmd) return this.send(chatId, 'uso: /shell <comando bash>');
  try {
    const r = await runShell(cmd);
    const out = (r.stdout || r.stderr || '<empty>').slice(0, 3500);
    await this.send(chatId, `⚡ \`${cmd}\`\n→ exit ${r.code}\n\n\`\`\`\n${out}\n\`\`\``);
  } catch (e) { await this.send(chatId, `❌ ${e.message}`); }
};

TelegramBot.prototype.cmdRead = async function (chatId, path) {
  if (!path) return this.send(chatId, 'uso: /read <path absoluto>');
  const safe = path.replace(/\.\.+/g, '');
  try {
    if (!fs.existsSync(safe)) return this.send(chatId, `❌ no existe: ${safe}`);
    const stat = fs.statSync(safe);
    if (stat.isDirectory()) return this.send(chatId, `❌ es directorio, usa /ls`);
    if (stat.size > 102400) return this.send(chatId, `❌ demasiado grande (${stat.size} bytes, max 100KB)`);
    const content = fs.readFileSync(safe, 'utf8').slice(0, 50000);
    await this.send(chatId, `📄 \`${safe}\` (${stat.size} bytes)\n\n\`\`\`\n${content}\n\`\`\``);
  } catch (e) { await this.send(chatId, `❌ ${e.message}`); }
};

TelegramBot.prototype.cmdWrite = async function (chatId, args) {
  // /write <path> <contenido...>
  const idx = args.indexOf(' ');
  if (idx < 0) return this.send(chatId, 'uso: /write <path> <contenido>');
  const path = args.slice(0, idx).trim().replace(/\.\.+/g, '');
  const content = args.slice(idx + 1);
  try {
    fs.writeFileSync(path, content);
    await this.send(chatId, `✅ escrito ${content.length} bytes en \`${path}\``);
  } catch (e) { await this.send(chatId, `❌ ${e.message}`); }
};

TelegramBot.prototype.cmdLs = async function (chatId, dir) {
  const safe = dir.replace(/\.\.+/g, '');
  try {
    if (!fs.existsSync(safe)) return this.send(chatId, `❌ no existe: ${safe}`);
    const items = fs.readdirSync(safe, { withFileTypes: true });
    const listing = items.slice(0, 50).map(it => `${it.isDirectory() ? '📁' : '📄'} ${it.name}`).join('\n');
    await this.send(chatId, `📂 \`${safe}\` (${items.length} items)\n\n\`\`\`\n${listing}\n\`\`\``);
  } catch (e) { await this.send(chatId, `❌ ${e.message}`); }
};

TelegramBot.prototype.cmdPm2 = async function (chatId, arg) {
  try {
    const r = await runShell(`/opt/homebrew/bin/pm2 ${arg || 'list'} | /usr/bin/head -50`);
    await this.send(chatId, `\`pm2 ${arg || 'list'}\`\n→ exit ${r.code}\n\n\`\`\`\n${r.stdout || r.stderr}\n\`\`\``);
  } catch (e) { await this.send(chatId, `❌ ${e.message}`); }
};

TelegramBot.prototype.cmdDocker = async function (chatId, arg) {
  try {
    const r = await runShell(`/usr/local/bin/docker ${arg || 'ps'} | /usr/bin/head -40`);
    await this.send(chatId, `\`docker ${arg || 'ps'}\`\n→ exit ${r.code}\n\n\`\`\`\n${r.stdout || r.stderr}\n\`\`\``);
  } catch (e) { await this.send(chatId, `❌ ${e.message}`); }
};

TelegramBot.prototype.cmdWeb = async function (chatId, url) {
  if (!url) return this.send(chatId, 'uso: /web <url>');
  if (!/^https?:\/\//.test(url)) return this.send(chatId, '❌ URL debe empezar con http:// o https://');
  try {
    const r = await runHttp(url);
    const head = (r.body.match(/<title>([^<]+)/) || [])[1] || '<no title>';
    await this.send(chatId, `🌐 \`${url}\`\n→ HTTP ${r.statusCode} · ${head}\n\n\`\`\`\n${r.body.slice(0, 3000)}\n\`\`\``);
  } catch (e) { await this.send(chatId, `❌ ${e.message}`); }
};

TelegramBot.prototype.cmdHealth = async function (chatId) {
  const checks = [
    ['OmniRoute 9500', await runShell('/usr/bin/curl -s -o /dev/null -w "%{http_code}" -m 2 http://127.0.0.1:9500/health').then(r => r.stdout.trim())],
    ['Model-Selector 9501', await runShell('/usr/bin/curl -s -o /dev/null -w "%{http_code}" -m 2 http://127.0.0.1:9501/health').then(r => r.stdout.trim())],
    ['host-executor 8889', await runShell('/usr/bin/curl -s -o /dev/null -w "%{http_code}" -m 2 http://127.0.0.1:8889/health').then(r => r.stdout.trim())],
    ['LM Studio 1234', await runShell('/usr/bin/curl -s -o /dev/null -w "%{http_code}" -m 2 http://127.0.0.1:1234/v1/models').then(r => r.stdout.trim())],
    ['Ollama 11435', await runShell('/usr/bin/curl -s -o /dev/null -w "%{http_code}" -m 2 http://127.0.0.1:11435/api/tags').then(r => r.stdout.trim())],
    ['Hermes 8787', await runShell('/usr/bin/curl -s -o /dev/null -w "%{http_code}" -m 2 http://127.0.0.1:8787/health').then(r => r.stdout.trim())],
  ];
  const lines = checks.map(([name, code]) => `  ${code === '200' ? '✅' : '❌'} ${name.padEnd(25)} HTTP ${code}`);
  const om = await runShell("/opt/homebrew/bin/pm2 list 2>/dev/null | /usr/bin/awk 'NR>11 && $4 ~ /synk|host|cloud|telegram/ {printf \"  %s\\\n\", $0}'").then(r => r.stdout).catch(e => '  (no se pudo leer)');
  await this.send(chatId, `🏥 **Stack SynK-IA**\n\n${lines.join('\n')}\n\n🌀 PM2:\n${om}`);
};

// ─────────────────────────────────────────────────────────────────────────
// MAIND — audit log SQLite (zero-loss)
// ─────────────────────────────────────────────────────────────────────────

// MAIND SQLite (zero-loss audit log) — usa sqlite3 CLI
function registerMAIND(entry) {
  const dbPath = '/Users/davidnows/sinkia-memory/data/memory.db';
  try {
    if (!fs.existsSync(dbPath)) return;
    const now = new Date().toISOString();
    const safe = entry.text.replace(/'/g, "''").slice(0, 2000);
    const hashVal = hash(entry.text);
    const sql = `INSERT INTO documents (content,source,source_path,doc_type,app,category,level,tags,created_at,indexed_at,content_hash) VALUES ('${safe}','telegram-supervisor','telegram-supervisor','telegram_msg','opencode','chat','info','bot:${entry.bot};from:${entry.from}','${now}','${now}','${hashVal}');`;
    execSync(`/usr/bin/sqlite3 '${dbPath}' "${sql.replace(/"/g, '\\"')}"`, { timeout: 2000 });
  } catch (err) {
    // graceful — MAIND disponible sí, fallo en escritura no rompe polling
  }
}

function hash(s) {
  let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return String(h);
}

// ─────────────────────────────────────────────────────────────────────────
// LOAD BOTS
// ─────────────────────────────────────────────────────────────────────────

function loadEnvFile(path) {
  const out = {};
  if (!fs.existsSync(path)) return out;
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function main() {
  const BOTS = [
    { name: 'Velinda', envFile: '/Users/davidnows/.openclaw/.env.telegram', expectedName: 'Velinda_bot' },
    { name: 'codiy', envFile: '/Users/davidnows/.claude-code/.env.telegram', expectedName: 'codiy_bot' },
    { name: 'Diosa', envFile: '/Users/davidnows/.hermes/.env.local', expectedName: 'Diosa' }
  ];

  const bots = [];
  for (const def of BOTS) {
    const env = loadEnvFile(def.envFile);
    const token = env.HERMES_TELEGRAM_TOKEN || env.OPENCLAW_TELEGRAM_TOKEN || env.TELEGRAM_BOT_TOKEN;
    const owner = env.OWNER_ID || '5665555949';
    if (!token) {
      console.error(`⚠ ${def.name}: sin token en ${def.envFile}`);
      continue;
    }
    try {
      const bot = new TelegramBot(def.name, token, owner);
      // handshake
      const me = await bot.call('getMe');
      log(`[${def.name}] handshake → @${me.result.username} (id=${me.result.id})`);
      // Set webhook empty (force polling mode)
      await bot.call('deleteWebhook');
      bots.push(bot);
    } catch (err) {
      console.error(`✗ ${def.name}: ${err.message}`);
    }
  }

  log(`━━━ ${bots.length} bots activos ━━━`);
  for (const b of bots) b.start();
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
