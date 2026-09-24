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
    default_model: process.env.OPENROUTER_DEFAULT_MODEL || 'nex-agi/nex-n2.5-mini:free',
    tier: 'cloud-free',
    tools_supported: true,
    free_tier: true
  },
  nvidia: {
    type: 'openai',
    base_url: 'https://integrate.api.nvidia.com/v1',
    api_key: process.env.NVIDIA_API_KEY || '',
    // Verified-live NIM models (probed 2026-09-24). Most meta/* and other
    // IDs in the catalog return 404/410; these two respond.
    default_model: process.env.NVIDIA_DEFAULT_MODEL || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
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
  },
  // ──────── NEW PROVIDERS (2026-09-23) ────────
  deepseek: {
    type: 'openai',
    base_url: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    api_key: process.env.DEEPSEEK_API_KEY || '',
    default_model: process.env.DEEPSEEK_DEFAULT_MODEL || 'deepseek-chat',
    tier: 'cloud-free',
    tools_supported: false,
    free_tier: false,
    note: 'Deepseek OpenAI-compat (paid but cheap)'
  },
  qwen: {
    type: 'openai',
    base_url: process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    api_key: process.env.QWEN_API_KEY || '',
    default_model: process.env.QWEN_DEFAULT_MODEL || 'qwen-plus',
    tier: 'cloud-free',
    tools_supported: false,
    free_tier: false,
    note: 'Qwen/DashScope OpenAI-compat'
  },
  siliconflow: {
    type: 'openai',
    base_url: process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1',
    api_key: process.env.SILICONFLOW_API_KEY || '',
    default_model: process.env.SILICONFLOW_DEFAULT_MODEL || 'Qwen/Qwen2.5-7B-Instruct',
    tier: 'cloud-free',
    tools_supported: false,
    free_tier: false,
    note: 'SiliconFlow multi-provider (Qwen/Deepseek/GLM)'
  },
  zai: {
    type: 'openai',
    base_url: process.env.ZAI_BASE_URL || 'https://api.z.ai/api/paas/v4',
    api_key: process.env.ZAI_API_KEY || '',
    default_model: process.env.ZAI_DEFAULT_MODEL || 'glm-4.6',
    tier: 'cloud-free',
    tools_supported: false,
    free_tier: false,
    note: 'Z.AI / Zhipu GLM family'
  },
  mistral: {
    type: 'openai',
    base_url: process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1',
    api_key: process.env.MISTRAL_API_KEY || '',
    default_model: process.env.MISTRAL_DEFAULT_MODEL || 'mistral-small-latest',
    tier: 'cloud-free',
    tools_supported: false,
    free_tier: false,
    note: 'Mistral OpenAI-compat'
  },
  venice: {
    type: 'openai',
    base_url: process.env.VENICE_BASE_URL || 'https://api.venice.ai/api/v1',
    api_key: process.env.VENICE_API_KEY || '',
    default_model: process.env.VENICE_DEFAULT_MODEL || 'venice-uncensored',
    tier: 'cloud-free',
    tools_supported: false,
    free_tier: false,
    note: 'Venice Multi-model (uncensored path)'
  },
  opencode: {
    type: 'openai',
    base_url: process.env.OPENCODE_BASE_URL || 'https://api.opencode.ai/v1',
    api_key: process.env.OPENCODE_API_KEY || '',
    default_model: process.env.OPENCODE_DEFAULT_MODEL || 'opencode-chat',
    tier: 'cloud-free',
    tools_supported: false,
    free_tier: false,
    note: 'OpenCode dev agent API'
  },
  gemini: {
    type: 'gemini',
    base_url: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
    api_key: process.env.GEMINI_API_KEY || '',
    default_model: process.env.GEMINI_DEFAULT_MODEL || 'gemini-flash-latest',
    tier: 'cloud-free',
    tools_supported: false,
    free_tier: true,
    note: 'Google Gemini (different API shape — uses X-goog-api-key + parts:[])'
  }
};

// ── Provider failover strategy (cost-zero, independent quotas) ─────────────
// Each native provider has its OWN quota, even when the underlying model is
// the same (e.g. nemotron via NVIDIA and via OpenRouter are two quotas).
// So we fail over sequentially through every provider that has a key: if
// OpenRouter exhausts its free tier, Gemini still has its own, then NVIDIA,
// then the reserves. Local (lmstudio/ollama) is always the LAST resort.
//
//  - VERIFIED: keys confirmed live from this host (probe 2026-09-24).
//  - RESERVE : configured keys currently returning 401/402/403/429 (no
//              balance / blocked); kept in the chain so they are used the
//              moment they get quota, at the cost of one short timeout.
const VERIFIED_CLOUD_PROVIDERS = ['openrouter', 'gemini', 'nvidia'];
const RESERVE_CLOUD_PROVIDERS = ['groq', 'cohere', 'zai', 'deepseek', 'mistral',
                                  'qwen', 'siliconflow', 'venice', 'opencode'];
const CLOUD_FAILOVER_CHAIN = [...VERIFIED_CLOUD_PROVIDERS, ...RESERVE_CLOUD_PROVIDERS];
// Backwards-compatible alias.
const ACTIVE_CLOUD_PROVIDERS = CLOUD_FAILOVER_CHAIN;

// Provider health (success-rate) tracking for the fallback chain
const providerHealth = {};
function noteProviderHealth(name, ok, ms) {
  providerHealth[name] = providerHealth[name] || { ok: 0, fail: 0, last_ms: 0 };
  if (ok) { providerHealth[name].ok++; providerHealth[name].last_ms = ms; }
  else providerHealth[name].fail++;
}
function getHealthyProviders(preferCloud = true) {
  const all = ['openrouter', 'nvidia', 'groq', 'cohere', 'gemini', 'mistral', 'qwen', 'siliconflow', 'zai', 'deepseek', 'venice', 'opencode', 'lmstudio', 'ollama'];
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
  'cloud-free-default': { provider: 'openrouter', model: 'nex-agi/nex-n2.5-mini:free' },

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
  'gemini-flash-latest':           { provider: 'gemini',  model: 'gemini-2.5-flash' },
  'gemini-2.0-flash-exp':          { provider: 'gemini',  model: 'gemini-2.5-flash' },
  'gemini-3.5-flash':              { provider: 'gemini',  model: 'gemini-3.5-flash' },
  'gemini-pro':                    { provider: 'gemini',  model: 'gemini-2.5-flash' },
  'nvidia-nemotron':               { provider: 'nvidia',  model: 'mistralai/mistral-nemotron' },
  'nvidia-nemotron-nano':          { provider: 'nvidia',  model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning' },
  'deepseek-chat':                 { provider: 'deepseek',     model: 'deepseek-chat' },
  'deepseek-reasoner':             { provider: 'deepseek',     model: 'deepseek-reasoner' },
  'qwen-plus':                     { provider: 'qwen',         model: 'qwen-plus' },
  'qwen-turbo':                    { provider: 'qwen',         model: 'qwen-turbo' },
  'mistral-small':                 { provider: 'mistral',      model: 'mistral-small-latest' },
  'mistral-large':                 { provider: 'mistral',      model: 'mistral-large-latest' },
  'glm-4.6':                       { provider: 'zai',          model: 'glm-4.6' },
  'glm-4.5':                       { provider: 'zai',          model: 'glm-4.5' },
  'glm-4.5-air':                   { provider: 'zai',          model: 'glm-4.5-air' },
  'siliconflow-qwen-7b':           { provider: 'siliconflow',  model: 'Qwen/Qwen2.5-7B-Instruct' },
  'siliconflow-deepseek-7b':       { provider: 'siliconflow',  model: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B' },
  'venice-uncensored':             { provider: 'venice',       model: 'venice-uncensored' },
  'opencode-chat':                 { provider: 'opencode',     model: 'opencode-chat' }
};

// Real inference — OpenAI standard con tools + history
// opts: { messages?: [{role,content}], tools?: [{type,function}], max_tokens?, temperature?, system_prompt? }
async function callProvider(providerName, model, prompt, opts = {}) {
  const prov = PROVIDERS[providerName];
  if (!prov) throw new Error(`Unknown provider: ${providerName}`);
  const tStart = Date.now();
  // Failover budget: verified providers get a normal window; reserve providers
  // (currently no balance / blocked) get a short one so a dead link costs
  // little before moving to the next quota. Local gets the longest.
  const isReserve = RESERVE_CLOUD_PROVIDERS.includes(providerName);
  const fetchTimeoutMs = isReserve ? 2000 : 4000;
  logEvent('debug', `→ callProvider start`, { provider: providerName, model, has_key: !!prov.api_key, base_url: prov.base_url, timeout_ms: fetchTimeoutMs });
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
      signal: AbortSignal.timeout(fetchTimeoutMs)
    });
    logEvent('debug', `   ollama HTTP ${res.status} (${Date.now()-tStart}ms)`);
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
    const tFetch = Date.now();
    logEvent('debug', `   openai fetch ${providerName} → ${url} (model=${model})`);
    const res = await fetch(url, {
      method: 'POST', headers, signal: AbortSignal.timeout(fetchTimeoutMs), body: JSON.stringify(body)
    });
    logEvent('debug', `   openai ${providerName} → HTTP ${res.status} (${Date.now()-tFetch}ms)`);
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
  // ──────── Gemini (Google) — uses different shape ────────
  if (prov.type === 'gemini') {
    // Translate OpenAI-style messages → Gemini contents[].parts[]
    // system role becomes instruction; user → contents; assistant → model
    const systemInst = (messages.find(m => m.role === 'system') || {}).content || '';
    const contents = [];
    for (const m of messages.filter(m => m.role !== 'system')) {
      const txt = (m.content == null ? '' : typeof m.content === 'string' ? m.content : '').trim();
      if (!txt) continue;
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: txt }] });
    }
    // If no contents, push a hello from user so Gemini answers
    if (contents.length === 0 && prompt) contents.push({ role: 'user', parts: [{ text: prompt }] });
    const url = `${prov.base_url.replace(/\/$/, '')}/models/${encodeURIComponent(model)}:generateContent`;
    const headers = { 'Content-Type': 'application/json' };
    if (prov.api_key) headers['X-goog-api-key'] = prov.api_key;
    const body = {
      contents,
      generationConfig: {
        temperature: temperature,
        maxOutputTokens: maxTokens,
        ...(systemInst ? { systemInstruction: { role: 'system', parts: [{ text: systemInst }] } } : {})
      }
    };
    const tFetch = Date.now();
    logEvent('debug', `   gemini fetch → ${url} (model=${model})`);
    const res = await fetch(url, {
      method: 'POST', headers, signal: AbortSignal.timeout(fetchTimeoutMs), body: JSON.stringify(body)
    });
    logEvent('debug', `   gemini → HTTP ${res.status} (${Date.now()-tFetch}ms)`);
    if (!res.ok) throw new Error(`gemini HTTP ${res.status}: ${await res.text().then(t => t.slice(0,200))}`);
    const data = await res.json();
    const cand = (data.candidates || [])[0] || {};
    const parts = cand.content?.parts || [];
    const text = parts.map(p => p.text || '').join('\n').trim();
    const um = data.usageMetadata || {};
    return {
      text,
      usage: { prompt_tokens: um.promptTokenCount || 0, completion_tokens: um.candidatesTokenCount || 0, total_tokens: um.totalTokenCount || 0 },
      latency_ms: Date.now() - start,
      tool_calls: null,
      finish_reason: cand.finishReason || 'stop',
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

    // GET /v1/models — OpenAI-compatible model list.
    // Exposes logical ids (LOGICAL_TO_REAL) + each provider's default model, so
    // downstream OpenAI-compat clients (ruflow backend, OpenWebUI, etc.) can
    // enumerate what OmniRoute can serve.
    if (req.url.startsWith('/v1/models') && req.method === 'GET') {
      const created = Math.floor(Date.now() / 1000);
      const seen = new Set();
      const data = [];
      const push = (id, owned_by) => {
        if (!id || seen.has(id)) return;
        seen.add(id);
        data.push({ id, object: 'model', created, owned_by });
      };
      for (const [logical, target] of Object.entries(LOGICAL_TO_REAL)) {
        push(logical, target.provider);
      }
      for (const [name, prov] of Object.entries(PROVIDERS)) {
        if (prov.default_model) push(prov.default_model, name);
      }
      push('auto', 'omniroute');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data }));
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

    // POST /v1/messages — Anthropic-compatible endpoint (usada por Hermes Agent CLI)
    if (req.url.startsWith('/v1/messages') && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          // Anthropic → OpenAI messages: concatenate system + content blocks
          const messages = [];
          if (payload.system) {
            const sysContent = Array.isArray(payload.system) ? payload.system.map(b => b.text || '').join('\n') : payload.system;
            if (sysContent) messages.push({ role: 'system', content: sysContent });
          }
          for (const m of payload.messages || []) {
            const text = (m.content == null) ? ''
              : (typeof m.content === 'string' ? m.content
                 : Array.isArray(m.content) ? m.content.map(b => b.text || '').join('\n')
                 : '');
            if (text || m.role === 'assistant') messages.push({ role: m.role, content: text });
          }
          if (messages.length === 0) throw new Error('Anthropic: messages[] vacío');
          const opts = {
            messages,
            max_tokens: payload.max_tokens || 1024,
            temperature: payload.temperature ?? 0.2,
            tools: payload.tools
          };
          // Mapear modelos Anthropic conocidos a modelos reales del cluster
          let logical = 'local-claude-code';
          const m = (payload.model || '').toLowerCase();
          if (m.includes('haiku') || m.includes('local-fast')) logical = 'local-claude-code';
          else if (m.includes('opus') || m.includes('big') || m.includes('reason')) logical = 'local-big';
          else if (m.includes('sonnet') && m.includes('4-5')) logical = 'local-claude-code';
          else if (m.includes('claude') || m.includes('sonnet')) logical = 'local-claude-code';
          const chosen = LOGICAL_TO_REAL[logical];
          let r, triedProviders = [];
          if (chosen && PROVIDERS[chosen.provider]) {
            try {
              r = await callProvider(chosen.provider, chosen.model, '', opts);
              noteProviderHealth(chosen.provider, true, r.latency_ms);
              triedProviders.push(chosen.provider);
            } catch (err) {
              logEvent('warn', `/v1/messages routed fallback: ${chosen.provider} failed (${err.message.slice(0,140)})`);
              r = null;
            }
          }
          if (!r) {
            // Same cloud-free → local chain as /v1/chat/completions
            const chain = [];
            for (const n of [...ACTIVE_CLOUD_PROVIDERS, 'lmstudio', 'ollama']) {
              const p = PROVIDERS[n];
              if (p && (p.api_key || n === 'lmstudio' || n === 'ollama')) chain.push(n);
            }
            for (const name of chain) {
              const p = PROVIDERS[name]; if (!p) continue;
              triedProviders.push(name);
              try {
                r = await callProvider(name, p.default_model, '', opts);
                noteProviderHealth(name, true, r.latency_ms);
                break;
              } catch (err) {
                noteProviderHealth(name, false, 0);
                logEvent('warn', `/v1/messages chain: ${name} failed (${err.message.slice(0,140)})`);
                continue;
              }
            }
            if (!r) throw new Error(`/v1/messages: ningún provider respondió (${triedProviders.join(', ')})`);
          }
          // OpenAI → Anthropic shape
          const antResp = {
            id: 'msg_' + Date.now(),
            type: 'message',
            role: 'assistant',
            model: chosen ? chosen.model : (PROVIDERS[triedProviders[triedProviders.length-1]] || {}).default_model,
            content: [{ type: 'text', text: r.text || '' }],
            stop_reason: (r.finish_reason === 'tool_calls') ? 'tool_use' : 'end_turn',
            usage: {
              input_tokens: r.usage?.prompt_tokens || 0,
              output_tokens: r.usage?.completion_tokens || 0,
            },
            _omni: { providers: triedProviders }
          };
          if (r.tool_calls && r.tool_calls.length > 0) {
            for (const tc of r.tool_calls) {
              antResp.content.push({
                type: 'tool_use',
                id: tc.id || 'tool_' + Date.now(),
                name: tc.function?.name,
                input: tc.function?.arguments ? (() => { try { return JSON.parse(tc.function.arguments); } catch { return tc.function.arguments; } })() : {}
              });
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(antResp));
        } catch (err) {
          logEvent('error', `v1/messages error: ${err.message}`);
          // Anthropic-style error block (so Hermes doesn’t cuelgue)
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: err.message } }));
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
        // NOTE: triedProviders must be visible in catch() → hoisted out of try.
        const triedProviders = [];
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

          // Build an ordered candidate list.
          //  1. If the model is a known logical id → that provider/model first.
          //  2. Then the cloud-free → local chain as fallback.
          const candidates = [];
          const seenKey = new Set();
          const addCand = (provider, model, source) => {
            const key = `${provider}|${model}`;
            if (seenKey.has(key)) return;
            seenKey.add(key);
            candidates.push({ provider, model, source });
          };

          if (payload.model && LOGICAL_TO_REAL[payload.model]) {
            const t = LOGICAL_TO_REAL[payload.model];
            addCand(t.provider, t.model, 'logical');
          }
          for (const n of ACTIVE_CLOUD_PROVIDERS) {
            const p = PROVIDERS[n];
            if (p && p.api_key) addCand(n, p.default_model, 'chain-cloud');
          }
          addCand('lmstudio', PROVIDERS.lmstudio.default_model, 'chain-local');
          addCand('ollama', PROVIDERS.ollama.default_model, 'chain-local');

          let r = null, chosen = null;
          for (const c of candidates) {
            triedProviders.push(`${c.provider}/${c.model}`);
            try {
              r = await callProvider(c.provider, c.model, '', opts);
              chosen = { provider: c.provider, model: r.raw?.model || c.model };
              noteProviderHealth(c.provider, true, r.latency_ms);
              break;
            } catch (err) {
              noteProviderHealth(c.provider, false, 0);
              logEvent('warn', `v1/chat/completions candidate ${c.provider} failed (${(err.message||'').slice(0,120)})`);
            }
          }
          if (!r) throw new Error(`All providers exhausted: tried ${triedProviders.join(', ')}`);

          // ── Streaming (SSE) support ──────────────────────────────────────
          // Clients like OpenClaw request stream=true and parse SSE. We don't
          // stream token-by-token upstream yet, but we emit a valid
          // chat.completion.chunk sequence so SSE clients work correctly.
          if (payload.stream === true) {
            const cid = 'chatcmpl-' + Date.now();
            const modelName = chosen?.model || payload.model || 'auto';
            const chunk = (delta, finish) => `data: ${JSON.stringify({
              id: cid, object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000), model: modelName,
              choices: [{ index: 0, delta, finish_reason: finish }]
            })}\n\n`;
            res.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'Access-Control-Allow-Origin': '*'
            });
            res.write(chunk({ role: 'assistant', content: '' }, null));
            res.write(chunk({ content: r.text || '' }, null));
            if (r.tool_calls && r.tool_calls.length > 0) {
              res.write(chunk({ tool_calls: r.tool_calls }, null));
            }
            res.write(chunk({}, r.finish_reason || 'stop'));
            res.write('data: [DONE]\n\n');
            res.end();
            return;
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
