#!/usr/bin/env node
/**
 * discoverer.js — buscador de tendencias del stack SynK-IA.
 *
 * Fuentes (todas se intentan; cada fallo es aislado):
 *   - GitHub   : repos trending + releases recientes de repos seguidos
 *   - Reddit   : r/MachineLearning, r/LocalLLaMA, r/Anthropic, r/artificial
 *   - Discord  : mensajes recientes de canales configurados (requiere
 *                DISCORD_BOT_TOKEN + DISCORD_CHANNELS=id1,id2)
 *   - HackerNews: front page (API pública, sin key)
 *   - arXiv    : cs.AI / cs.CL / cs.LG (RSS)
 *   - HuggingFace: blog (RSS)
 *
 * Persiste cada candidato en MAIND:
 *   app='discoverer', doc_type='erp:topic', category='candidate',
 *   tags='source:<fuente>,<extra>'
 *
 * Política: coste cero (sólo endpoints públicos / APIs gratuitas).
 * Se ejecuta una vez y sale (PM2 lo relanza por cron_restart).
 */
'use strict';
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');

const DB = '/Users/davidnows/sinkia-memory/data/memory.db';
const SQ = '/usr/bin/sqlite3';
const LOG = '/Users/davidnows/.synkia-ai-hub/logs/discoverer.log';
const MAX_ITEMS_PER_SOURCE = 8;
const NTFY_URL = process.env.NTFY_URL || 'http://127.0.0.1:8091';
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'synkia';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {}
}

function fetchUrl(url, { timeoutMs = 12000, headers = {}, json = true } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchUrl(res.headers.location, { timeoutMs, headers, json }).then(resolve, reject);
      }
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        if (!json) return resolve(buf);
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('bad json')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch (_) {} reject(new Error('timeout')); });
  });
}

// ── Fuentes ────────────────────────────────────────────────────────────────
async function githubTrending() {
  // GitHub search API is free (60 req/h unauth). Repos creados recientemente
  // con muchas estrellas ≈ trending.
  const since = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
  const url = `https://api.github.com/search/repositories?q=created:>${since}&sort=stars&order=desc&per_page=${MAX_ITEMS_PER_SOURCE}`;
  const headers = { 'User-Agent': 'synkia-discoverer', 'Accept': 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  const d = await fetchUrl(url, { headers });
  return (d.items || []).map(r => ({
    title: r.full_name + ' — ' + (r.description || '').slice(0, 120),
    url: r.html_url, extra: `stars:${r.stargazers_count},lang:${r.language || 'n/a'}`
  }));
}

async function reddit(subs = ['MachineLearning', 'LocalLLaMA', 'Anthropic', 'artificial']) {
  // Reddit bloquea .json sin OAuth (HTTP 403). El feed RSS sí es público.
  const out = [];
  for (const s of subs) {
    try {
      const xml = await fetchUrl(`https://www.reddit.com/r/${s}/hot/.rss`, {
        json: false,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; synkia-discoverer/1.0)' }
      });
      for (const it of parseRss(xml)) {
        out.push({ title: `r/${s}: ${it.title}`, url: it.url || `https://reddit.com/r/${s}`, extra: `sub:${s}` });
      }
    } catch (e) { log(`  reddit r/${s} falló: ${e.message}`); }
    // Reddit rate-limita por IP: espaciamos las peticiones.
    await new Promise(r => setTimeout(r, 3500));
  }
  return out;
}

async function discord() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channels = (process.env.DISCORD_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!token || channels.length === 0) {
    log('  discord: omitido (falta DISCORD_BOT_TOKEN o DISCORD_CHANNELS)');
    return [];
  }
  const out = [];
  for (const ch of channels) {
    try {
      const d = await fetchUrl(`https://discord.com/api/v10/channels/${ch}/messages?limit=10`,
        { headers: { 'Authorization': `Bot ${token}` } });
      for (const m of (d || [])) {
        if (!m.content) continue;
        out.push({ title: `discord:${ch}: ${m.content.slice(0, 120)}`,
                   url: `https://discord.com/channels/${m.guild_id || '@me'}/${ch}/${m.id}`,
                   extra: `author:${(m.author || {}).username || '?'}` });
      }
    } catch (e) { log(`  discord ${ch} falló: ${e.message}`); }
  }
  return out;
}

async function hackerNews() {
  const ids = await fetchUrl('https://hacker-news.firebaseio.com/v0/topstories.json');
  const top = (ids || []).slice(0, MAX_ITEMS_PER_SOURCE);
  const out = [];
  for (const id of top) {
    try {
      const it = await fetchUrl(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      if (it && it.title) out.push({ title: `HN: ${it.title}`, url: it.url || `https://news.ycombinator.com/item?id=${id}`, extra: `score:${it.score}` });
    } catch (_) {}
  }
  return out;
}

function parseRss(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>|<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < MAX_ITEMS_PER_SOURCE) {
    const block = m[1] || m[2] || '';
    const t = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '';
    const l = (block.match(/<link[^>]*href="([^"]+)"/) || block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
    if (t) items.push({ title: t.replace(/<!\[CDATA\[|\]\]>/g, '').trim().slice(0, 150), url: l.trim() });
  }
  return items;
}

async function arxiv() {
  const out = [];
  for (const cat of ['cs.AI', 'cs.CL', 'cs.LG']) {
    try {
      const xml = await fetchUrl(`https://arxiv.org/rss/${cat}`, { json: false });
      for (const it of parseRss(xml)) out.push({ ...it, title: `arXiv ${cat}: ${it.title}`, extra: `cat:${cat}` });
    } catch (e) { log(`  arxiv ${cat} falló: ${e.message}`); }
  }
  return out;
}

async function huggingface() {
  try {
    const xml = await fetchUrl('https://huggingface.co/blog/feed.xml', { json: false });
    return parseRss(xml).map(it => ({ ...it, title: `HF: ${it.title}`, extra: 'source:hf' }));
  } catch (e) { log(`  huggingface falló: ${e.message}`); return []; }
}

// ── Persistencia en MAIND ──────────────────────────────────────────────────
function esc(s) { return String(s).replace(/'/g, "''"); }

function store(item, source) {
  return new Promise((resolve) => {
    const now = new Date().toISOString();
    const hash = Buffer.from(item.url || item.title).toString('base64').slice(0, 40);
    const tags = `source:${source}${item.extra ? ',' + item.extra : ''}`;
    const sql = `INSERT INTO documents (content, source, source_path, doc_type, app, category, level, tags, created_at, content_hash)
VALUES ('${esc(item.title)}', '${esc(source)}', '${esc(item.url || '')}', 'erp:topic', 'discoverer', 'candidate', 'info', '${esc(tags)}', '${now}', '${hash}')
ON CONFLICT(content_hash) DO NOTHING;`;
    execFile(SQ, [DB, sql], { timeout: 4000, maxBuffer: 64 * 1024 }, (err) => resolve(!err));
  });
}

// ── Runner ─────────────────────────────────────────────────────────────────
(async () => {
  log('═══ discoverer: inicio ═══');
  const sources = [
    ['github', githubTrending], ['reddit', reddit], ['discord', discord],
    ['hackernews', hackerNews], ['arxiv', arxiv], ['huggingface', huggingface],
  ];
  const summary = {};
  let total = 0;
  for (const [name, fn] of sources) {
    let items = [];
    try { items = await fn(); } catch (e) { log(`  ${name} falló: ${e.message}`); }
    let stored = 0;
    for (const it of items) { if (await store(it, name)) stored++; }
    summary[name] = stored;
    total += stored;
    log(`  ${name}: ${items.length} encontrados, ${stored} nuevos`);
  }
  log(`═══ discoverer: fin — ${total} candidatos nuevos ═══`);

  // Aviso por NTFY sólo si hay algo relevante (>= 5 candidatos nuevos).
  if (total >= 5) {
    try {
      const data = Buffer.from(`Discoverer: ${total} candidatos nuevos\n` +
        Object.entries(summary).map(([k, v]) => `  ${k}: ${v}`).join('\n'));
      const u = new URL(`${NTFY_URL.replace(/\/$/, '')}/${NTFY_TOPIC}`);
      const req = http.request({ method: 'POST', host: u.hostname, port: u.port || 80, path: u.pathname,
        headers: { 'Title': 'Discoverer: nuevos temas', 'Priority': 'default', 'Tags': 'newspaper',
                   'Content-Type': 'text/plain', 'Content-Length': data.length } }, r => r.resume());
      req.on('error', () => {});
      req.write(data); req.end();
    } catch (_) {}
  }
  process.exit(0);
})();
