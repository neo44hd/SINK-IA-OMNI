#!/usr/bin/env node
/**
 * SINKIA HOST EXECUTOR v2.0
 * Servidor que expone herramientas del sistema macOS a agentes IA
 * Puerto: 8889
 */

const http = require('http');
const { execSync, exec } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PORT = 8889;
const HOME = process.env.HOME || '/Users/davidnows';

const log = {
  info:  m => console.log(`[INFO]  ${new Date().toISOString()} ${m}`),
  warn:  m => console.warn(`[WARN]  ${new Date().toISOString()} ${m}`),
  error: m => console.error(`[ERROR] ${new Date().toISOString()} ${m}`)
};

// ─── Catálogo de herramientas ────────────────────────────────────────────────
const TOOLS = [
  { name: 'shell',       method: 'POST', path: '/exec/shell',    desc: 'Ejecutar cualquier comando bash en el host macOS' },
  { name: 'file_read',   method: 'POST', path: '/files/read',    desc: 'Leer contenido de un archivo del sistema' },
  { name: 'file_write',  method: 'POST', path: '/files/write',   desc: 'Escribir o sobreescribir un archivo del sistema' },
  { name: 'file_list',   method: 'POST', path: '/files/list',    desc: 'Listar archivos de un directorio' },
  { name: 'docker',      method: 'POST', path: '/docker/run',    desc: 'Ejecutar comandos docker (ps, logs, restart, exec)' },
  { name: 'search',      method: 'POST', path: '/search',        desc: 'Búsqueda web privada vía SearXNG (localhost:8888)' },
  { name: 'ollama_chat', method: 'POST', path: '/ollama/chat',   desc: 'Chat con cualquier modelo local de Ollama' },
  { name: 'ollama_vision',method:'POST', path: '/ollama/vision', desc: 'Analizar imágenes con llama3.2-vision:11b o glm-ocr' },
  { name: 'tts',         method: 'POST', path: '/tts',           desc: 'Texto a voz en español con say -v Mónica + ffmpeg → OGG' },
  { name: 'transcribe',  method: 'POST', path: '/transcribe',    desc: 'Transcribir audio con Whisper (ruta de archivo local)' },
  { name: 'ocr',         method: 'POST', path: '/ocr',           desc: 'OCR de imagen o PDF con pdftotext + tesseract' },
  { name: 'screenshot',  method: 'POST', path: '/screenshot',    desc: 'Capturar pantalla del Mac y guardar en /tmp' },
  { name: 'notify',      method: 'POST', path: '/notify',        desc: 'Enviar notificación macOS con osascript' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function shell(cmd, cwd) {
  return execSync(cmd, {
    cwd: cwd || HOME,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    shell: '/bin/bash',
    env: { ...process.env, HOME, PATH: '/usr/sbin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:' + HOME + '/bin' }
  });
}

// ─── Seguridad: allowlist de shell + guardas ─────────────────────────────────
// Los agentes IA (cerebros cloud) pueden verse afectados por prompt-injection
// al leer contenido web. Este es el ÚNICO cuello de botella de ejecución:
// se bloquea lo destructivo y (si SHELL_ALLOW está definido) se restringe a
// los binarios permitidos.
const SHELL_ALLOW = (process.env.SHELL_ALLOW || [
  'ls','cat','head','tail','grep','find','wc','file','stat','du','df','ps','top','uptime',
  'git','node','npm','pnpm','yarn','python3','pip3','curl','jq','docker','pm2','launchctl',
  'brew','echo','pwd','whoami','id','date','uname','sw_vers','hostname','env','printenv',
  'mkdir','touch','cp','mv','rm','ln','tar','zip','unzip','sed','awk','sort','uniq','diff',
  'readlink','which','type','sqlite3','say','ffmpeg','tesseract','pdftotext','osascript',
  'pbcopy','pbpaste','base64','shasum','openssl','open'
].join(',')).split(',').map(s => s.trim()).filter(Boolean);

const SHELL_DENY = [
  /\bsudo\b/, /\bsu\s+-/, /\b(shutdown|reboot|halt)\b/,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+\/(\s|$)/, /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r?\s+\/(\s|$)/,
  /\bmkfs\b/, /\bdd\s+[^\n]*of=\/dev\//, /\bdiskutil\s+(erase|reformat|partitionDisk)/,
  /:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:/,                     // fork bomb
  /(curl|wget)[^\n]*\|\s*(ba|z|)?sh/,                      // pipe-to-shell
  /\b(chmod|chown)\s+[^\n]*\s+\/\s*$/,
  />\s*\/dev\/(sd|disk|rdisk)/, /\bnc\s+-l/, /\bncat\s+-l/,
  /\/etc\/(passwd|shadow|sudoers)/, /\bspctl\b/, /\bcsrutil\b/,
  /\bkillall\s+-9\b/, /\bpkill\s+-9\b/,
];

function firstBin(cmd) {
  const toks = String(cmd).trim().split(/\s+/);
  for (const t of toks) { if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) return t; }
  return '';
}

function guardShell(cmd) {
  const s = String(cmd || '');
  for (const re of SHELL_DENY) if (re.test(s)) return `denegado: patrón prohibido en el comando`;
  const bin = firstBin(s).replace(/^.*\//, '');
  if (SHELL_ALLOW.length && !SHELL_ALLOW.includes(bin)) {
    return `comando '${bin}' no está en la allowlist del host-executor`;
  }
  // Si invocan docker por shell, aplicamos también la política de docker
  // (si no, `docker run -v /:/host` esquiva el guard del endpoint /docker/run).
  if (bin === 'docker') {
    const rest = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '').replace(/^\s*docker\s+/, '');
    const d = guardDocker(rest);
    if (d) return `shell→docker: ${d}`;
  }
  return null;
}

const DOCKER_ALLOW = ['ps','logs','inspect','restart','stop','start','exec','stats','images','top','port','version','compose','volume','network','events','pull'];
function guardDocker(cmd) {
  const sub = String(cmd || '').trim().split(/\s+/)[0];
  if (!DOCKER_ALLOW.includes(sub)) return `docker '${sub}' no permitido`;
  if (/\brun\b|\bcreate\b/.test(cmd) && /(-v|--volume|--privileged|\/var\/run)/.test(cmd)) {
    return `docker '${sub}' con montaje/privilegios no permitido`;
  }
  return null;
}

const FILE_ROOTS = (process.env.FILE_ROOTS || `${HOME},/tmp`).split(',').map(s => s.trim()).filter(Boolean);
function guardPath(p) {
  const abs = path.resolve(String(p || ''));
  const okRoot = FILE_ROOTS.some(r => abs === r || abs.startsWith(r + path.sep));
  return okRoot ? null : `ruta fuera de las raíces permitidas (${FILE_ROOTS.join(', ')})`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch(e) { reject(new Error('JSON inválido: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

function ok(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'success', ...data, ts: new Date().toISOString() }));
}

function err(res, msg, code) {
  res.writeHead(code || 400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'error', error: msg, ts: new Date().toISOString() }));
}

// ─── Servidor ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  log.info(`${req.method} ${req.url}`);

  // ── Health ──────────────────────────────────────────────────────────────
  if (req.url === '/health') {
    return ok(res, { service: 'host-executor', hostname: os.hostname(), tools: TOOLS.length });
  }

  // ── Catálogo ─────────────────────────────────────────────────────────────
  if (req.url === '/tools/list' || req.url === '/tools') {
    return ok(res, { tools: TOOLS, system: {
      hostname: os.hostname(), platform: os.platform(), arch: os.arch(),
      home: HOME,
      ollama_models: shell('ollama list 2>/dev/null | tail -n +2 | awk \'{print $1}\'').trim().split('\n').filter(Boolean),
      services: {
        searxng: 'http://localhost:8888',
        ollama:  'http://localhost:11434',
        openclaw:'http://localhost:9501',
        n8n:     'http://localhost:5678',
        openwebui:'http://localhost:3030',
        qdrant:  'http://localhost:6333'
      }
    }});
  }

  let body = {};
  try { body = await readBody(req); } catch(e) { return err(res, e.message); }

  // ── Shell ────────────────────────────────────────────────────────────────
  if (req.url === '/exec/shell') {
    if (!body.command) return err(res, 'Campo "command" requerido');
    { const d = guardShell(body.command); if (d) { log.warn(`SHELL DENEGADO: ${body.command} — ${d}`); return err(res, d, 403); } }
    log.info(`SHELL: ${body.command}`);
    try {
      const output = shell(body.command, body.cwd);
      return ok(res, { command: body.command, output });
    } catch(e) {
      return ok(res, { command: body.command, status: 'error',
        output: (e.stdout||'').toString(), error: e.message, exit_code: e.status||1 });
    }
  }

  // ── Archivos: leer ───────────────────────────────────────────────────────
  if (req.url === '/files/read') {
    if (!body.path) return err(res, 'Campo "path" requerido');
    { const d = guardPath(body.path); if (d) return err(res, d, 403); }
    try {
      const content = fs.readFileSync(body.path, 'utf8');
      return ok(res, { path: body.path, content, size: content.length });
    } catch(e) { return err(res, e.message); }
  }

  // ── Archivos: escribir ───────────────────────────────────────────────────
  if (req.url === '/files/write') {
    if (!body.path || body.content === undefined) return err(res, 'Campos "path" y "content" requeridos');
    { const d = guardPath(body.path); if (d) return err(res, d, 403); }
    try {
      fs.mkdirSync(path.dirname(body.path), { recursive: true });
      fs.writeFileSync(body.path, body.content, 'utf8');
      return ok(res, { path: body.path, bytes: body.content.length });
    } catch(e) { return err(res, e.message); }
  }

  // ── Archivos: listar ─────────────────────────────────────────────────────
  if (req.url === '/files/list') {
    const dir = body.path || HOME;
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true }).map(f => ({
        name: f.name, type: f.isDirectory() ? 'dir' : 'file',
        path: path.join(dir, f.name)
      }));
      return ok(res, { path: dir, items, count: items.length });
    } catch(e) { return err(res, e.message); }
  }

  // ── Docker ───────────────────────────────────────────────────────────────
  if (req.url === '/docker/run') {
    if (!body.command) return err(res, 'Campo "command" requerido (ej: "ps", "logs nginx", "restart api")');
    { const d = guardDocker(body.command); if (d) { log.warn(`DOCKER DENEGADO: ${body.command} — ${d}`); return err(res, d, 403); } }
    log.info(`DOCKER: ${body.command}`);
    try {
      const output = shell(`docker ${body.command}`);
      return ok(res, { command: `docker ${body.command}`, output });
    } catch(e) {
      return ok(res, { status: 'error', command: `docker ${body.command}`,
        output: (e.stdout||'').toString(), error: e.message });
    }
  }

  // ── Búsqueda web ─────────────────────────────────────────────────────────
  if (req.url === '/search') {
    if (!body.query) return err(res, 'Campo "query" requerido');
    log.info(`SEARCH: ${body.query}`);
    try {
      const q = encodeURIComponent(body.query);
      const lang = body.lang || 'es';
      const out = shell(`curl -s "http://localhost:8888/search?q=${q}&format=json&language=${lang}" | jq '{results:[.results[:10][]|{title,url,content}]}'`);
      return ok(res, { query: body.query, ...JSON.parse(out) });
    } catch(e) { return err(res, 'SearXNG error: ' + e.message); }
  }

  // ── Ollama chat ──────────────────────────────────────────────────────────
  if (req.url === '/ollama/chat') {
    if (!body.prompt) return err(res, 'Campo "prompt" requerido');
    const model = body.model || 'phi4-mini:latest';
    log.info(`OLLAMA CHAT: ${model} — ${body.prompt.substring(0,60)}...`);
    try {
      const payload = JSON.stringify({ model, prompt: body.prompt, stream: false });
      const out = shell(`curl -s -X POST http://localhost:11434/api/generate -H 'Content-Type: application/json' -d '${payload.replace(/'/g, "'\\''")}'`);
      const result = JSON.parse(out);
      return ok(res, { model, prompt: body.prompt, response: result.response, eval_count: result.eval_count });
    } catch(e) { return err(res, 'Ollama error: ' + e.message); }
  }

  // ── Ollama visión ────────────────────────────────────────────────────────
  if (req.url === '/ollama/vision') {
    if (!body.image_path && !body.image_base64) return err(res, 'Campo "image_path" o "image_base64" requerido');
    const model = body.model || 'llama3.2-vision:11b';
    const prompt = body.prompt || 'Describe this image in detail';
    log.info(`OLLAMA VISION: ${model}`);
    try {
      let b64;
      if (body.image_path) b64 = fs.readFileSync(body.image_path).toString('base64');
      else b64 = body.image_base64;
      const payload = JSON.stringify({ model, prompt, images: [b64], stream: false });
      const tmpFile = `/tmp/vision_payload_${Date.now()}.json`;
      fs.writeFileSync(tmpFile, payload);
      const out = shell(`curl -s -X POST http://localhost:11434/api/generate -H 'Content-Type: application/json' -d @${tmpFile}`);
      fs.unlinkSync(tmpFile);
      const result = JSON.parse(out);
      return ok(res, { model, response: result.response });
    } catch(e) { return err(res, 'Vision error: ' + e.message); }
  }

  // ── TTS ──────────────────────────────────────────────────────────────────
  if (req.url === '/tts') {
    if (!body.text) return err(res, 'Campo "text" requerido');
    const voice = body.voice || 'Mónica';
    const outFile = body.output || `/tmp/tts_${Date.now()}.ogg`;
    log.info(`TTS: ${body.text.substring(0,50)}...`);
    try {
      const tmpAiff = outFile.replace('.ogg', '.aiff');
      shell(`say -v "${voice}" -o "${tmpAiff}" "${body.text.replace(/"/g, '\\"')}"`);
      shell(`ffmpeg -y -i "${tmpAiff}" -c:a libvorbis "${outFile}" 2>/dev/null`);
      shell(`rm -f "${tmpAiff}"`);
      return ok(res, { text: body.text, voice, output: outFile, exists: fs.existsSync(outFile) });
    } catch(e) { return err(res, 'TTS error: ' + e.message); }
  }

  // ── Transcripción ────────────────────────────────────────────────────────
  if (req.url === '/transcribe') {
    if (!body.audio_path) return err(res, 'Campo "audio_path" requerido');
    log.info(`TRANSCRIBE: ${body.audio_path}`);
    try {
      const whisper = `${HOME}/Library/Python/3.9/bin/whisper`;
      const lang = body.language || 'es';
      const out = shell(`"${whisper}" "${body.audio_path}" --language ${lang} --output_format txt --output_dir /tmp 2>/dev/null && cat /tmp/${path.basename(body.audio_path, path.extname(body.audio_path))}.txt`);
      return ok(res, { audio_path: body.audio_path, language: lang, text: out.trim() });
    } catch(e) { return err(res, 'Transcripción error: ' + e.message); }
  }

  // ── OCR / PDF ────────────────────────────────────────────────────────────
  if (req.url === '/ocr') {
    if (!body.file_path) return err(res, 'Campo "file_path" requerido');
    log.info(`OCR: ${body.file_path}`);
    try {
      const ext = path.extname(body.file_path).toLowerCase();
      let text;
      if (ext === '.pdf') {
        text = shell(`pdftotext "${body.file_path}" - 2>/dev/null || tesseract "${body.file_path}" stdout 2>/dev/null`);
      } else {
        text = shell(`tesseract "${body.file_path}" stdout -l spa+eng 2>/dev/null`);
      }
      return ok(res, { file_path: body.file_path, text: text.trim(), chars: text.length });
    } catch(e) { return err(res, 'OCR error: ' + e.message); }
  }

  // ── Screenshot ───────────────────────────────────────────────────────────
  if (req.url === '/screenshot') {
    const outFile = body.output || `/tmp/screenshot_${Date.now()}.png`;
    log.info(`SCREENSHOT → ${outFile}`);
    try {
      shell(`screencapture -x "${outFile}"`);
      const size = fs.statSync(outFile).size;
      return ok(res, { output: outFile, size_bytes: size });
    } catch(e) { return err(res, 'Screenshot error: ' + e.message); }
  }

  // ── Notificación ─────────────────────────────────────────────────────────
  if (req.url === '/notify') {
    if (!body.message) return err(res, 'Campo "message" requerido');
    const title = body.title || 'SynkIA';
    log.info(`NOTIFY: ${title} — ${body.message}`);
    try {
      shell(`osascript -e 'display notification "${body.message.replace(/"/g,'\\"')}" with title "${title.replace(/"/g,'\\"')}"'`);
      return ok(res, { title, message: body.message });
    } catch(e) { return err(res, 'Notify error: ' + e.message); }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint no encontrado', available: TOOLS.map(t => t.method + ' ' + t.path) }));
});

server.listen(PORT, '0.0.0.0', () => {
  log.info(`SINKIA HOST EXECUTOR v2.0 corriendo en :${PORT}`);
  log.info(`${TOOLS.length} herramientas disponibles → GET /tools/list`);
});

process.on('SIGINT', () => { server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
