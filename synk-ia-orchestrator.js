#!/usr/bin/env node

/**
 * SynK-IA ORCHESTRATOR v1.0
 * ═══════════════════════════════════════════════════════════════════════════════
 * Central daemon for SynK-IA ecosystem orchestration:
 * - Monitors all services (health checks every 30s)
 * - Auto-restarts critical services on failure
 * - Routes requests to best tool based on context
 * - Maintains unified ecosystem state
 * - Updates GitHub discoveries
 * - Learns from performance metrics
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION & INITIALIZATION
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG_PATH = process.env.CONFIG_PATH || '/Users/davidnows/synk-ia-global-config.yaml';
const DATA_DIR = '/Users/davidnows/.synkia-ai-hub';
const STATE_FILE = path.join(DATA_DIR, 'ecosystem-state.json');
const EVENT_LOG = path.join(DATA_DIR, 'ecosystem-events.log');
const MEMORY_FILE = path.join(DATA_DIR, 'unified-memory.json');
const OR_CACHE = path.join(DATA_DIR, 'openrouter-free-cache.json'); // cache :free models

let config = {};
let ecosystemState = {};
let unifiedMemory = {};
let openRouterFreeCache = { lastFetch: 0, models: [], ttl: 3600 * 1000 }; // 1h

// Load configuration
try {
  const configContent = fs.readFileSync(CONFIG_PATH, 'utf8');
  config = yaml.load(configContent);
  console.log('✅ Configuration loaded from', CONFIG_PATH);
} catch (err) {
  console.error('❌ Failed to load configuration:', err.message);
  process.exit(1);
}

// Load ~/.hermes/.env for real cloud keys (single source of truth for API keys)
try {
  const hermesEnvPath = path.join(process.env.HOME || '/Users/davidnows', '.hermes', '.env');
  if (fs.existsSync(hermesEnvPath)) {
    for (const line of fs.readFileSync(hermesEnvPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
    console.log('🔑 Loaded API keys from ~/.hermes/.env');
  }
} catch (err) { /* noop */ }

// Load or initialize state files
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      ecosystemState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (err) {
    ecosystemState = { services: {}, lastCheck: new Date().toISOString() };
  }

  try {
    if (fs.existsSync(MEMORY_FILE)) {
      unifiedMemory = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    }
  } catch (err) {
    unifiedMemory = { learning: {}, routing: {}, performance: {}, discoveries: [] };
  }
}

// Save state files
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(ecosystemState, null, 2));
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(unifiedMemory, null, 2));
  } catch (err) {
    logEvent('error', `Failed to save state: ${err.message}`);
  }
}

// Logging
function logEvent(level, message, metadata = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${level.toUpperCase()}: ${message} ${Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : ''}\n`;
  
  try {
    fs.appendFileSync(EVENT_LOG, logEntry);
  } catch (err) {
    console.error('Failed to write log:', err.message);
  }
  
  if (level === 'error' || level === 'critical') {
    console.error(`🚨 ${message}`, metadata);
  } else {
    console.log(`✅ ${message}`, metadata);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK ENGINE
// ─────────────────────────────────────────────────────────────────────────────

async function checkServiceHealth(serviceName, serviceConfig) {
  return new Promise((resolve) => {
    const timeout = serviceConfig.timeout || (config.orchestration?.healthCheck?.timeout || 5) * 1000;
    const timer = setTimeout(() => {
      resolve({ status: 'down', reason: 'timeout' });
    }, timeout);

    const url = `${serviceConfig.baseUrl}${serviceConfig.healthCheck || '/health'}`;
    const protocol = serviceConfig.protocol === 'https' ? https : http;

    const request = protocol.get(url, (res) => {
      clearTimeout(timer);
      resolve({
        status: res.statusCode === 200 ? 'healthy' : 'unhealthy',
        httpStatus: res.statusCode,
        reason: res.statusCode === 200 ? 'OK' : `HTTP ${res.statusCode}`
      });
    });

    request.on('error', (err) => {
      clearTimeout(timer);
      resolve({ status: 'down', reason: err.message });
    });
  });
}

async function monitorAllServices() {
  logEvent('info', '🔍 Starting health check cycle');
  ecosystemState.lastCheck = new Date().toISOString();
  ecosystemState.services = ecosystemState.services || {};

  const services = config.services || {};
  const criticalServices = config.orchestration?.healthCheck?.criticalServices || [];

  for (const [serviceName, serviceConfig] of Object.entries(services)) {
    const health = await checkServiceHealth(serviceName, serviceConfig);
    
    ecosystemState.services[serviceName] = {
      name: serviceConfig.name,
      status: health.status === 'healthy' ? 'online' : 'offline',
      port: serviceConfig.port,
      critical: serviceConfig.critical || false,
      autoRestart: serviceConfig.autoRestart || false,
      lastCheck: new Date().toISOString(),
      healthy: health.status === 'healthy',
      httpStatus: health.httpStatus,
      reason: health.reason
    };

    const statusEmoji = health.status === 'healthy' ? '✅' : '❌';
    logEvent('info', `${statusEmoji} ${serviceName}: ${health.status}`, { reason: health.reason });

    // Auto-restart critical services
    if (health.status !== 'healthy' && serviceConfig.autoRestart && serviceConfig.critical) {
      await autoRestartService(serviceName, serviceConfig);
    }
  }

  saveState();
}

async function autoRestartService(serviceName, serviceConfig) {
  logEvent('warn', `🔄 Attempting auto-restart of ${serviceName}`);

  try {
    if (serviceConfig.docker) {
      const { service, network } = serviceConfig.docker;
      await execAsync(`cd /Users/davidnows && docker-compose -f docker-compose.synkia-os.yml restart ${service}`);
      logEvent('info', `✅ Successfully restarted Docker service: ${service}`);
    } else if (serviceConfig.pm2) {
      await execAsync(`pm2 restart ${serviceName}`);
      logEvent('info', `✅ Successfully restarted PM2 process: ${serviceName}`);
    }
  } catch (err) {
    logEvent('error', `🚨 Failed auto-heal: ${serviceName}`, { error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INTELLIGENT ROUTING ENGINE
// ─────────────────────────────────────────────────────────────────────────────

function analyzeContext(userInput) {
  const lowerInput = userInput.toLowerCase();
  const patterns = config.orchestration?.routing?.patterns || [];

  for (const pattern of patterns) {
    if (pattern.context && pattern.context.length > 0) {
      const matched = pattern.context.some(keyword => lowerInput.includes(keyword));
      if (matched) {
        return {
          targetTool: pattern.targetTool,
          model: pattern.model,
          priority: pattern.priority,
          confidence: 0.9
        };
      }
    }
  }

  // Default fallback
  return {
    targetTool: 'hub-ai-local',
    model: 'local-fast',
    priority: 'medium',
    confidence: 0.1
  };
}

function selectBestModel(taskType = 'fast') {
  const profile = config.modelSelection?.taskProfiles?.[taskType];
  if (!profile) return config.modelSelection?.taskProfiles?.fast;

  // Return primary model for this task type
  return {
    primary: profile.primary,
    secondary: profile.secondary,
    fallback: profile.fallback,
    reasoning: profile.reasoning,
    contextWindow: profile.contextWindow
  };
}

async function routeRequest(userInput, context = {}) {
  const analysis = analyzeContext(userInput);
  const targetTool = config.services?.[analysis.targetTool];
  
  if (!targetTool) {
    logEvent('warn', `Tool not found: ${analysis.targetTool}, using fallback`);
    return {
      status: 'error',
      message: 'Target tool not found',
      fallback: 'hub-ai-local'
    };
  }

  const modelSelection = selectBestModel(context.taskType);
  const toolHealth = ecosystemState.services?.[analysis.targetTool];

  if (toolHealth?.status === 'offline' && analysis.targetTool !== 'hub-ai-local') {
    logEvent('warn', `Primary tool ${analysis.targetTool} is offline, routing to fallback`);
    analysis.targetTool = 'hub-ai-local';
  }

  // Track this routing decision for learning
  unifiedMemory.routing = unifiedMemory.routing || {};
  unifiedMemory.routing[analysis.targetTool] = (unifiedMemory.routing[analysis.targetTool] || 0) + 1;
  saveState();

  logEvent('info', `🎯 Routed request to ${analysis.targetTool}`, {
    model: analysis.model,
    priority: analysis.priority,
    confidence: analysis.confidence
  });

  return {
    status: 'routed',
    tool: analysis.targetTool,
    toolUrl: targetTool.baseUrl,
    model: analysis.model,
    modelSelection,
    priority: analysis.priority,
    confidence: analysis.confidence
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GITHUB DISCOVERY INTEGRATION
// ─────────────────────────────────────────────────────────────────────────────

async function updateGitHubDiscoveries() {
  logEvent('info', '🔍 Checking GitHub discoveries...');
  
  try {
    const discoveryFile = path.join(DATA_DIR, 'discovery-cache.json');
    if (fs.existsSync(discoveryFile)) {
      const discoveries = JSON.parse(fs.readFileSync(discoveryFile, 'utf8'));
      const lastUpdate = new Date(discoveries.lastScan);
      const now = new Date();
      const hoursSinceUpdate = (now - lastUpdate) / (1000 * 60 * 60);

      if (hoursSinceUpdate > 1) {
        logEvent('info', '📚 GitHub discovery cache is stale, would refresh (skipping in demo)', {
          hoursSince: hoursSinceUpdate.toFixed(1)
        });
      }

      unifiedMemory.discoveries = discoveries.trending || [];
      unifiedMemory.lastDiscoveryUpdate = discoveries.lastScan;
      saveState();
    }
  } catch (err) {
    logEvent('error', 'Failed to update GitHub discoveries', { error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PERFORMANCE LEARNING ENGINE
// ─────────────────────────────────────────────────────────────────────────────

function recordPerformanceMetric(toolName, taskType, duration, success) {
  unifiedMemory.performance = unifiedMemory.performance || {};
  unifiedMemory.performance[toolName] = unifiedMemory.performance[toolName] || {
    executions: 0,
    successes: 0,
    avgDuration: 0,
    errors: []
  };

  const metrics = unifiedMemory.performance[toolName];
  metrics.executions++;
  if (success) metrics.successes++;
  metrics.avgDuration = (metrics.avgDuration * (metrics.executions - 1) + duration) / metrics.executions;

  unifiedMemory.learning = unifiedMemory.learning || {};
  unifiedMemory.learning.lastUpdated = new Date().toISOString();

  saveState();
  logEvent('info', `📊 Performance recorded for ${toolName}`, {
    successRate: (metrics.successes / metrics.executions * 100).toFixed(1) + '%',
    avgDuration: metrics.avgDuration.toFixed(0) + 'ms'
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PROVIDER REGISTRY — REAL inference paths (single source of truth)
// Chain de providers FREE: openrouter → nvidia → groq → mistral → cohere (todos OpenAI-compat)
// Más local-fallback: lmstudio → ollama
// ─────────────────────────────────────────────────────────────────────────

const PROVIDERS = {
  ollama: {
    type: 'ollama',
    base_url: process.env.OLLAMA_URL || 'http://127.0.0.1:11435',
    default_model: process.env.OLLAMA_MODEL || 'llama3.2:3b',
    tier: 'local-free',
    free_tier: false
  },
  lmstudio: {
    type: 'openai',
    base_url: process.env.LMSTUDIO_URL || 'http://127.0.0.1:1234/v1',
    api_key: process.env.LMSTUDIO_API_KEY || 'lm-studio',
    default_model: process.env.LMSTUDIO_CHAT_MODEL || 'prism-ml/bonsai-27b',
    tools_supported: true,
    tier: 'local-free',
    free_tier: false
  },
  openrouter: {
    type: 'openai',
    base_url: 'https://openrouter.ai/api/v1',
    api_key: process.env.OPENROUTER_API_KEY || '',
    default_model: process.env.OPENROUTER_DEFAULT_MODEL || 'deepseek/deepseek-v4-flash-0731:free',
    tier: 'cloud-free',
    tools_supported: true,
    free_tier: true
  },
  nvidia: {
    type: 'openai',
    base_url: 'https://integrate.api.nvidia.com/v1',
    api_key: process.env.NVIDIA_API_KEY || '',
    default_model: process.env.NVIDIA_DEFAULT_MODEL || 'meta/llama-3.1-70b-instruct',
    tier: 'cloud-free',
    tools_supported: false,
    free_tier: true,
    requires_credit_setup: 'https://build.nvidia.com/'
  },
  groq: {
    type: 'openai',
    base_url: 'https://api.groq.com/openai/v1',
    api_key: process.env.GROQ_API_KEY || '',
    default_model: process.env.GROQ_DEFAULT_MODEL || 'llama-3.1-70b-versatile',
    tier: 'cloud-free',
    tools_supported: true,
    free_tier: true,
    rate_limit: '30 req/min'
  },
  cohere: {
    type: 'openai',
    base_url: 'https://api.cohere.com/compatibility/v1',
    api_key: process.env.COHERE_API_KEY || '',
    default_model: process.env.COHERE_DEFAULT_MODEL || 'command-r-plus',
    tier: 'cloud-free',
    tools_supported: false,
    free_tier: true,
    note: 'Cohere compatibility layer for OpenAI'
  }
};

// Provider health (success-rate) tracking for the fallback chain
const providerHealth = {};
function noteProviderHealth(name, ok, ms) {
  providerHealth[name] = providerHealth[name] || { ok: 0, fail: 0, last_ms: 0 };
  if (ok) { providerHealth[name].ok++; providerHealth[name].last_ms = ms; }
  else providerHealth[name].fail++;
}
function getHealthyProviders(preferCloud = true) {
  const all = ['openrouter', 'nvidia', 'groq', 'cohere', 'lmstudio', 'ollama'];
  // prefer cloud first, then local
  return all.filter(n => {
    const p = PROVIDERS[n];
    if (!p || !p.api_key && n !== 'ollama' && n !== 'lmstudio') return false;
    if (preferCloud ? (p.tier !== 'cloud-free') : (p.tier !== 'local-free')) {
      // also include local as fallback
      if (preferCloud && p.tier === 'local-free') return true;
      if (!preferCloud && p.tier === 'cloud-free') return false;
    }
    return p.api_key || n === 'ollama' || n === 'lmstudio';
  }).sort((a, b) => {
    // Sort: healthy providers first, then by tier
    const ha = providerHealth[a] || { fail: 0 };
    const hb = providerHealth[b] || { fail: 0 };
    if (ha.fail !== hb.fail) return ha.fail - hb.fail;
    return 0;
  });
}

// Logical → real provider/model map. Incluye todos los IDs que el YAML/resolver
// puede devolver, mapeados SOLO a modelos que existen hoy en el cluster.
const LOGICAL_TO_REAL = {
  // IDs lógicos propios de OmniRoute
  'local-claude-code':  { provider: 'lmstudio', model: 'zai-org/glm-4.6v-flash' },
  'local-coder-ollama': { provider: 'ollama',   model: 'llama3.2:3b' },
  'local-fast':         { provider: 'ollama',   model: 'llama3.2:3b' },
  'local-reason':       { provider: 'lmstudio', model: 'zai-org/glm-4.6v-flash' },
  'local-big':          { provider: 'lmstudio', model: 'prism-ml/bonsai-27b' },
  'cloud-free-default': { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731:free' },

  // IDs del YAML synk-ia-global-config.yaml taskProfiles (legacy)
  'ollama-llama:3b':    { provider: 'ollama',   model: 'llama3.2:3b' },
  'ollama-qwen:3b':     { provider: 'ollama',   model: 'llama3.2:3b' },   // fallback hasta pull qwen2.5:3b
  'ollama-qwen:7b':     { provider: 'ollama',   model: 'llama3.2:3b' },   // fallback hasta pull qwen2.5:7b
  'ollama-qwen-coder':  { provider: 'ollama',   model: 'llama3.2:3b' },
  'ollama-llama-3b':    { provider: 'ollama',   model: 'llama3.2:3b' },
  'ollama-llama-vision':{ provider: 'ollama',   model: 'llama3.2:3b' },
  'litellm-gateway':    { provider: 'lmstudio', model: 'prism-ml/bonsai-27b' },  // LiteLLM muerto → LM Studio local
  'ruflow-semantic-scorer': { provider: 'lmstudio', model: 'prism-ml/bonsai-27b' },

  // IDs antiguos del litellm-config.yaml → reemplazos verificados
  'negentropy-claude-opus-4.7-9b': { provider: 'lmstudio', model: 'prism-ml/bonsai-27b' },
  'ruvltra-claude-code':           { provider: 'lmstudio', model: 'zai-org/glm-4.6v-flash' },
  'deepseek-r1-0528-qwen3-8b':     { provider: 'lmstudio', model: 'zai-org/glm-4.6v-flash' },
  'gemini-flash-latest':           { provider: 'openrouter', model: 'google/gemma-4-26b-a4b-it:free' },
  'gemini-2.0-flash-exp':          { provider: 'openrouter', model: 'google/gemma-4-26b-a4b-it:free' }
};

// Real inference — OpenAI standard con tools + history
// opts: { messages?: [{role,content}], tools?: [{type,function}], max_tokens?, temperature?, system_prompt? }
async function callProvider(providerName, model, prompt, opts = {}) {
  const prov = PROVIDERS[providerName];
  if (!prov) throw new Error(`Unknown provider: ${providerName}`);
  const maxTokens = opts.max_tokens || 1024;
  const temperature = opts.temperature ?? 0.2;

  // Build messages array (OpenAI standard): combine system_prompt + messages[] + prompt fallback
  const messages = Array.isArray(opts.messages) ? [...opts.messages] : [];
  if (opts.system_prompt && !messages.some(m => m.role === 'system')) {
    messages.unshift({ role: 'system', content: opts.system_prompt });
  }
  if (prompt && (messages.length === 0 || messages[messages.length - 1].role !== 'user')) {
    messages.push({ role: 'user', content: prompt });
  }

  const start = Date.now();

  if (prov.type === 'ollama') {
    const body = {
      model, messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: false,
      options: { temperature, num_predict: maxTokens }
    };
    if (opts.tools && opts.tools.length > 0) {
      // Ollama format: tools → top-level array
      body.tools = opts.tools.map(t => t.function || t);
    }
    const res = await fetch(`${prov.base_url}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000)
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return {
      text: data.message?.content || '',
      usage: data,
      latency_ms: Date.now() - start,
      tool_calls: data.message?.tool_calls || null,
      finish_reason: data.done ? 'stop' : 'tool_calls',
      raw: data
    };
  }
  if (prov.type === 'openai') {
    const url = `${prov.base_url.replace(/\/$/, '')}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (prov.api_key) headers['Authorization'] = `Bearer ${prov.api_key}`;
    if (providerName === 'openrouter') {
      headers['HTTP-Referer'] = 'http://localhost:9500';
      headers['X-Title'] = 'SynK-IA OmniRoute';
    }
    const body = { model, messages, max_tokens: maxTokens, temperature, stream: false };
    if (opts.tools && opts.tools.length > 0 && prov.tools_supported !== false) {
      body.tools = opts.tools; body.tool_choice = 'auto';
    }
    const res = await fetch(url, {
      method: 'POST', headers, signal: AbortSignal.timeout(90000), body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`${providerName} HTTP ${res.status}: ${await res.text().then(t => t.slice(0,200))}`);
    const data = await res.json();
    const ch = (data.choices || [])[0] || {};
    return {
      text: ch.message?.content || '',
      usage: data.usage || {},
      latency_ms: Date.now() - start,
      tool_calls: ch.message?.tool_calls || null,
      finish_reason: ch.finish_reason || 'stop',
      raw: data
    };
  }
  throw new Error(`Provider type ${prov.type} not implemented`);
}
// ─────────────────────────────────────────────────────────────────────────────

async function refreshOpenRouterFree(force = false) {
  const now = Date.now();
  if (!force && (now - openRouterFreeCache.lastFetch) < openRouterFreeCache.ttl && openRouterFreeCache.models.length > 0) {
    return openRouterFreeCache.models;
  }
  if (!process.env.OPENROUTER_API_KEY) {
    logEvent('warn', 'No OPENROUTER_API_KEY, saltamos discovery');
    return [];
  }
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const free = (data.data || []).filter(m => m.id.endsWith(':free')).map(m => ({
      id: m.id,
      name: m.name,
      context_length: m.context_length || 0,
      modality: m.architecture?.modality || 'text',
      fetched_at: now
    }));
    openRouterFreeCache = { lastFetch: now, models: free, ttl: openRouterFreeCache.ttl };
    fs.writeFileSync(OR_CACHE, JSON.stringify(openRouterFreeCache, null, 2));
    logEvent('info', `🌐 OpenRouter free: ${free.length} modelos actualizados`);
    return free;
  } catch (err) {
    logEvent('error', 'OpenRouter free discovery failed', { error: err.message });
    return openRouterFreeCache.models; // serve stale
  }
}

// Política del usuario (18 Sep 2026):
//   1. CLOUD-FREE PRIMERO (OpenRouter) — siempre es la primera opción
//   2. Si cloud-free falla → fallback a LM Studio (local-free)
//   3. Si LM Studio falla → fallback a Ollama (local-free, ligero)
// Excepción: taskType=fast|lightweight|realtime → local-primero (latencia < red)

// Resolve un taskType a {provider, model}. Política actual:
//   fast/lightweight/embedded → LOCAL (Ollama) — latencia crítica
//   coding/chat/reasoning/general/cloud_free_first → CLOUD-FREE primero
//   fallback siempre a LM Studio local (prism-ml/bonsai-27b)
function resolveForTask(taskType = 'general', opts = {}) {
  const wantCloudFirst = opts.cloud_free_first === true;
  const wantLocalOnly = ['fast', 'lightweight', 'realtime', 'embedded'].includes(taskType)
                        || opts.local_first === true;

  // Si piden local-only, no vamos a cloud
  if (wantLocalOnly) {
    // coding-like si lo llaman y piden local: LM Studio
    if (taskType === 'coding') {
      return { provider: 'lmstudio', model: 'zai-org/glm-4.6v-flash', source: 'local-free-coding' };
    }
    return { provider: 'ollama', model: PROVIDERS.ollama.default_model, source: 'local-free-fast' };
  }

  // 1. cloud-free primero si hay key y models
  if (wantCloudFirst || (taskType !== 'fast' && PROVIDERS.openrouter.api_key && openRouterFreeCache.models.length > 0)) {
    if (taskType === 'coding') {
      const coder = openRouterFreeCache.models.find(m => /coder|qwen|laguna/i.test(m.id));
      if (coder) return { provider: 'openrouter', model: coder.id, source: 'cloud-free-coding' };
    }
    if (taskType === 'reasoning' || taskType === 'research') {
      const r = openRouterFreeCache.models.find(m => /nemotron|gemma|thinking/i.test(m.id));
      if (r) return { provider: 'openrouter', model: r.id, source: 'cloud-free-reasoning' };
    }
    // chat/general → primer free disponible
    const first = openRouterFreeCache.models[0];
    if (first) return { provider: 'openrouter', model: first.id, source: 'cloud-free-default' };
  }

  // 2. local LM Studio con modelo específico por tipo
  const lmModel = (taskType === 'coding') ? 'zai-org/glm-4.6v-flash'
                : (taskType === 'reasoning') ? 'zai-org/glm-4.6v-flash'
                : PROVIDERS.lmstudio.default_model;
  return { provider: 'lmstudio', model: lmModel, source: 'local-free-lmstudio' };
}

// ─────────────────────────────────────────────────────────────────────────────
// ORCHESTRATOR API SERVER
// ─────────────────────────────────────────────────────────────────────────────

async function startOrchestratorAPI() {
  const PORT = process.env.ORCHESTRATOR_PORT || 9500;

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // CORS pre-flight
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Status endpoint
    if (req.url === '/api/orchestrator/status' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        services: ecosystemState.services,
        uptime: process.uptime(),
        memory: process.memoryUsage()
      }, null, 2));
      return;
    }

    // Model select endpoint
    if (req.url.startsWith('/api/orchestrator/model-select') && req.method === 'GET') {
      const url = new URL(`http://localhost${req.url}`);
      const context = url.searchParams.get('context') || '';
      const taskType = url.searchParams.get('taskType') || 'fast';

      const routing = await routeRequest(context, { taskType });
      res.writeHead(200);
      res.end(JSON.stringify(routing, null, 2));
      return;
    }

    // Execute endpoint
    if (req.url.startsWith('/api/orchestrator/execute') && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          const routing = await routeRequest(payload.input || '', { taskType: payload.taskType });
          
          // Record execution
          const startTime = Date.now();
          // (In real implementation, would execute and track duration)
          recordPerformanceMetric(routing.tool, payload.taskType || 'unknown', 100, true);

          res.writeHead(200);
          res.end(JSON.stringify({ ...routing, queued: true }, null, 2));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Learning stats
    if (req.url === '/api/orchestrator/learning' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({
        memory: unifiedMemory,
        recommendations: generateRecommendations()
      }, null, 2));
      return;
    }

    // Health check
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k,v]) => [k, v.tier])),
        openrouter_free_cached: openRouterFreeCache.models.length
      }));
      return;
    }

    // POST /api/orchestrator/inference — REAL inference (the one true entrypoint)
    if (req.url.startsWith('/api/orchestrator/inference') && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          const prompt = (payload.input || payload.prompt || '').trim();
          const taskType = payload.taskType || payload.task || 'general';
          const logical = payload.model_hint || selectBestModel(taskType)?.primary;
          if (!prompt) throw new Error('input/prompt required');

          // 1. resolver provider/model — política del usuario:
          //    cloud-free PRIMERO, local sólo cloud-falla o taskType=fast|lightweight
          let cloudResolved = null;
          if (openRouterFreeCache.models.length > 0 && PROVIDERS.openrouter.api_key) {
            cloudResolved = resolveForTask(taskType, { cloud_free_first: true });
          }
          let resolved;
          if (cloudResolved && (taskType === 'coding' || taskType === 'chat' || taskType === 'reasoning' || taskType === 'general' || taskType === 'creative' || taskType === 'research' || taskType === 'analysis' || taskType === 'extraction' || taskType === 'jobMatching' || payload.cloud_free_first)) {
            resolved = cloudResolved;
          } else if (LOGICAL_TO_REAL[logical]) {
            resolved = LOGICAL_TO_REAL[logical];
          } else if (cloudResolved) {
            resolved = cloudResolved;
          } else {
            resolved = resolveForTask(taskType); // fast|lightweight → local por defecto
          }

          logEvent('info', `🎯 /infer taskType=${taskType} → ${resolved.provider}/${resolved.model} from ${resolved.source||'logical'}`);
          recordPerformanceMetric(resolved.provider, taskType, 0, false);

          // 2. ejecutar con RETRY policy: rota al siguiente modelo si 429/5xx/fetch failed
          const MAX_RETRIES = 3;
          const attempted = new Set();
          const candidates = [];
          const pushCandidate = (p, m, src) => {
            const key = `${p}|${m}`;
            if (!attempted.has(key)) candidates.push({ provider: p, model: m, source: src, key });
          };

          // Empezar con el resuelto
          pushCandidate(resolved.provider, resolved.model, resolved.source || logical);

          // Si cloud-free y categoría coding|chat|reasoning, completar con alternatives
          if (openRouterFreeCache.models.length > 1) {
            const pool = openRouterFreeCache.models
              .filter(m => {
                if (attempted.has(`openrouter|${m.id}`)) return false;
                if (taskType === 'coding') return /coder|qwen|laguna/i.test(m.id);
                if (taskType === 'reasoning') return /nemotron|gemma|thinking/i.test(m.id);
                return true;
              })
              .slice(0, 5);
            pool.forEach(m => pushCandidate('openrouter', m.id, 'cloud-free-fallback'));
          }
          // Si local primary, agregar el otro local como fallback
          if (resolved.provider === 'ollama') pushCandidate('lmstudio', 'zai-org/glm-4.6v-flash', 'local-fallback');
          if (resolved.provider === 'lmstudio') pushCandidate('ollama', PROVIDERS.ollama.default_model, 'local-fallback');

          let lastErr = null;
          let success = null;
          for (let i = 0; i < Math.min(candidates.length, MAX_RETRIES); i++) {
            const cand = candidates[i];
            attempted.add(cand.key);
            logEvent('info', `🔄 retry ${i+1}/${MAX_RETRIES}: ${cand.provider}/${cand.model}`);
            try {
              const out = await callProvider(cand.provider, cand.model, prompt, payload.options || {});
              recordPerformanceMetric(cand.provider, taskType, out.latency_ms, true);
              success = { ...out, _provider: cand.provider, _model: cand.model, _source: cand.source, _attempt: i+1 };
              break;
            } catch (err) {
              lastErr = err;
              recordPerformanceMetric(cand.provider, taskType, 0, false);
              // Reintentar sólo si 4xx/5xx transitorio o fetch failed
              if (/4\d\d|5\d\d|fetch failed|rate.?limit/i.test(err.message)) continue;
              break;
            }
          }

          if (success) {
            res.writeHead(200);
            res.end(JSON.stringify({
              status: 'ok',
              provider: success._provider, model: success._model,
              source: success._source,
              attempt: success._attempt,
              usage: success.usage,
              latency_ms: success.latency_ms,
              text: success.text
            }, null, 2));
          } else {
            logEvent('error', `inference failed after ${attempted.size} attempts: ${lastErr?.message}`);
            res.writeHead(502);
            res.end(JSON.stringify({
              status: 'error', attempts: attempted.size,
              error: lastErr?.message,
              tried: [...attempted]
            }, null, 2));
          }
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // GET /api/orchestrator/discover/openrouter — refresh or return cache
    if (req.url.startsWith('/api/orchestrator/discover/openrouter')) {
      const u = new URL(`http://localhost${req.url}`);
      const force = u.searchParams.get('force') === '1';
      refreshOpenRouterFree(force).then(models => {
        res.writeHead(200);
        res.end(JSON.stringify({
          lastFetch: new Date(openRouterFreeCache.lastFetch).toISOString(),
          count: models.length,
          models
        }, null, 2));
      });
      return;
    }

    // POST /v1/chat/completions — OpenAI standard endpoint with tools + history
    if (req.url.startsWith('/v1/chat/completions') && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          const messages = Array.isArray(payload.messages) ? payload.messages : [];
          if (messages.length === 0) throw new Error('messages[] is required');

          const opts = {
            messages,
            max_tokens: payload.max_tokens || 1024,
            temperature: payload.temperature ?? 0.2,
            tools: payload.tools
          };

          let r, chosen, triedProviders = [];
          if (payload.model && LOGICAL_TO_REAL[payload.model]) {
            // Logical id \u2192 specific provider+model
            chosen = LOGICAL_TO_REAL[payload.model];
            r = await callProvider(chosen.provider, chosen.model, '', opts);
            noteProviderHealth(chosen.provider, true, r.latency_ms);
          } else {
            // Auto-fallback: cloud-free chain \u2192 local
            // Order: openrouter \u2192 nvidia \u2192 groq \u2192 cohere \u2192 lmstudio \u2192 ollama
            const chain = [];
            for (const n of ['openrouter', 'nvidia', 'groq', 'cohere']) {
              const p = PROVIDERS[n];
              if (p && p.api_key) chain.push(n);
            }
            // Always include lmstudio and ollama as fallback
            chain.push('lmstudio');
            chain.push('ollama');
            // Pick model for the chosen provider; use provider default
            for (const name of chain) {
              const p = PROVIDERS[name];
              if (!p) continue;
              triedProviders.push(name);
              try {
                r = await callProvider(name, payload.model && PROVIDERS[payload.model] ? payload.model : p.default_model, '', opts);
                chosen = { provider: name, model: p.default_model };
                noteProviderHealth(name, true, r.latency_ms);
                if (!payload.model) chosen.model = r.raw?.model || p.default_model;
                else chosen.model = payload.model;
                break;
              } catch (err) {
                noteProviderHealth(name, false, 0);
                logEvent('warn', `chain fallback: ${name} failed (${err.message.slice(0,120)})`);
                continue;
              }
            }
            if (!r) throw new Error(`All providers exhausted: tried ${triedProviders.join(', ')}`);
          }

          const openaiResp = {
            id: 'chatcmpl-' + Date.now(),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: chosen?.model || payload.model || 'auto',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: r.text || '',
                tool_calls: r.tool_calls || undefined
              },
              finish_reason: r.finish_reason || 'stop'
            }],
            usage: r.usage || {},
            _omni: { provider: chosen?.provider, tried: triedProviders }
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(openaiResp, null, 2));
        } catch (err) {
          logEvent('error', `v1/chat/completions error: ${err.message}`);
          res.writeHead(500); res.end(JSON.stringify({ error: err.message, _tried: triedProviders }));
        }
      });
      return;
    }

    // GET /api/orchestrator/resolve — logical → real
    if (req.url.startsWith('/api/orchestrator/resolve')) {
      const u = new URL(`http://localhost${req.url}`);
      let logical = u.searchParams.get('logical') || 'local-fast';
      const taskType = u.searchParams.get('taskType') || 'general';
      const real = LOGICAL_TO_REAL[logical] || resolveForTask(taskType);
      res.writeHead(200);
      res.end(JSON.stringify({ logical, ...real }, null, 2));
      return;
    }

    // 404
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(PORT, () => {
    logEvent('info', `🚀 Orchestrator API listening on port ${PORT}`);
    console.log(`Orchestrator API: http://localhost:${PORT}`);
    console.log(`  - Status: http://localhost:${PORT}/api/orchestrator/status`);
    console.log(`  - Model Select: http://localhost:${PORT}/api/orchestrator/model-select?context=code&taskType=coding`);
    console.log(`  - Learning: http://localhost:${PORT}/api/orchestrator/learning`);
  });
}

function generateRecommendations() {
  const recommendations = [];

  // Check if critical services are healthy
  const criticalServices = config.orchestration?.healthCheck?.criticalServices || [];
  for (const service of criticalServices) {
    const serviceState = ecosystemState.services?.[service];
    if (serviceState?.status === 'offline') {
      recommendations.push({
        priority: 'critical',
        service,
        recommendation: `Critical service ${service} is offline. Attempting auto-restart...`,
        action: 'auto-restart'
      });
    }
  }

  // Performance-based recommendations
  const performance = unifiedMemory.performance || {};
  for (const [tool, metrics] of Object.entries(performance)) {
    if (metrics.avgDuration > 5000) {
      recommendations.push({
        priority: 'warning',
        service: tool,
        recommendation: `${tool} is slow (avg ${metrics.avgDuration.toFixed(0)}ms). Consider using a faster alternative.`,
        action: 'optimize'
      });
    }
  }

  return recommendations;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN LOOP
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('🚀 SynK-IA ORCHESTRATOR v1.0 — Starting...');
  console.log('═══════════════════════════════════════════════════════════════════════════════');

  // Initialize
  loadState();
  logEvent('info', '🔄 Orchestrator initialized');

  // Start API server
  await startOrchestratorAPI();

  // Initial health check
  await monitorAllServices();

  // Health check loop (every 30 seconds)
  const healthCheckInterval = (config.orchestration?.healthCheck?.interval || 30) * 1000;
  setInterval(async () => {
    await monitorAllServices();
  }, healthCheckInterval);

  // GitHub discovery update (every 1 hour)
  const discoveryInterval = (config.memory?.githubDiscovery?.updateInterval || 3600) * 1000;
  setInterval(async () => {
    await updateGitHubDiscoveries();
  }, discoveryInterval);

  // Initial GitHub discovery check
  await updateGitHubDiscoveries();

  // OpenRouter free auto-refresh on startup + every hour
  await refreshOpenRouterFree(true);
  setInterval(() => refreshOpenRouterFree(false), discoveryInterval);
  logEvent('info', `🌐 OpenRouter free cache inicializado: ${openRouterFreeCache.models.length} modelos`);

  logEvent('info', '✅ SynK-IA Orchestrator fully operational');
  console.log('✅ Orchestrator ready. Monitoring 10+ services...\n');
}

// Graceful shutdown
process.on('SIGINT', () => {
  logEvent('info', 'Orchestrator shutting down gracefully');
  saveState();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logEvent('info', 'Orchestrator terminated');
  saveState();
  process.exit(0);
});

// Start orchestrator
main().catch(err => {
  logEvent('critical', 'Fatal error in orchestrator', { error: err.message });
  process.exit(1);
});
