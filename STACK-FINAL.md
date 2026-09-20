# SynK-IA — Stack Final Documentado (18 Sep 2026)

Arquitectura consolidada tras la limpieza de hubs redundantes. **Un solo hub** (OmniRoute) y política cloud-free primero, local como fallback.

## 1. Componentes Up (Verificados con curl)

Puerto | Servicio | PM2 name | Tier | Estado
---|---|---|---|---
**9500** | OmniRoute orchestrator (EL hub) | synk-orchestrator | control-plane | HTTP 200
**9501** | OmniRoute model-selector (resolver) | synk-model-selector | control-plane | HTTP 200
8889 | host-executor (shell/files/Ollama etc) | host-executor | control-plane | HTTP 200
8888 | ORBITAL stack dock only | - | info | -
1234 | LM Studio (7 modelos local-free) | app nativa | local-free | HTTP 200
11435 | synk-ia-ollama (1 modelo local-free) | synk-ia-ollama | local-free | HTTP 200
3120 | sinkia-mcp-server | - | MCP | HTTP 200
3030 | sinkia-openwebui | - | ui | HTTP 200
8787 | hermes-webui | - | ui | HTTP 200
8009-8013 | sinkia-heaven | - | ui | mix
8080 | sinkia-jarvis | - | api | 404

## 2. OmniRoute — Endpoints canónicos

```
GET  /health
GET  /api/orchestrator/status
GET  /api/orchestrator/learning
POST /api/orchestrator/inference {input, taskType, [cloud_free_first], [model_hint], [options]}
GET  /api/orchestrator/resolve?logical=X[&taskType=Y]
GET  /api/orchestrator/discover/openrouter[?force=1]
```

## 3. Política de routing (modelo del usuario)

**Orden de resolución**:
1. **Cloud-free primero** (OpenRouter `:free`) si:
   - taskType ∈ `{coding, chat, reasoning, general, creative, research, analysis, extraction, jobMatching}` o hay `cloud_free_first:true`
2. **Local LM Studio** (`zai-org/glm-4.6v-flash` / `prism-ml/bonsai-27b`) si cloud-free no disponible
3. **Local Ollama** (`llama3.2:3b`) como último fallback

**Excepción**: `taskType ∈ {fast, lightweight, realtime}` → local primario (latencia crítica).

## 4. Modelos actuales (live)

### Cloud-free OpenRouter (cache de 22 modelos, auto-refresh 1h)
```
deepseek/deepseek-v4-flash-0731:free      ← coding top
qwen/qwen3.8-27b:free                     ← 27B coder
qwen/qwen3-coder-32b:free                 ← nuevo
inclusionai/ling-3.0-flash-{vl,fin,sante}:free
nvidia/nemotron-3-ultra-550b-a55b:free
google/gemma-4-26b-a4b-it:free
poolside/laguna-{s-2.1,xs-2.1}:free
nex-agi/nex-n2.5-{mini,pro}:free
thinkingmachines/inkling:free
dots-studio/dots-3-note-preview:free
[+12 más]
```

### LM Studio local (port 1234)
```
prism-ml/bonsai-27b           <- chat (default)
zai-org/glm-4.6v-flash        <- reasoning/coding
deepseek-v4-flash             <- coding (ROTO: SIGSEGV)
qwen/qwen3-vl-4b              <- vision
allenai/olmocr-2-7b           <- OCR
qwen3.8-27b-atlassian-mlx     <- (RAM blocked)
text-embedding-nomic-embed-text-v1.5  <- embeddings
```

### Ollama local (port 11435, contenedor `synk-ia-ollama`)
```
llama3.2:3b                  <- realtime / lightweight
```

## 5. Archivos clave (SSoT — single source of truth)

```
/Users/davidnows/
├── synk-ia-global-config.yaml          ← config unificada global
├── synk-ia-orchestrator.js             ← OmniRoute (THE hub, con /inference + /discover)
├── synk-ia-model-selector.js           ← resolver de modelos lógicos
├── ecosystem.config.js                 ← PM2: 4 servicios
├── bin/
│   ├── synkia-ai-hub                   ← source AI_HUB_URL=9500 (OmniRoute)
│   ├── host-executor-server.js         ← shell/files/etc
│   └── tunnel-up.sh                    ← cloudflare tunnel restart
├── .hermes/.env                        ← OPENROUTER_API_KEY (key real)
└── synkia/repos/synk-ia/
    └── .env.local                      ← env backend
```

## 6. Persistencia tras reinicio

**Antes**: PM2 vacío. Tras reboot los servicios nunca volvían.

**Ahora**:
1. `pm2 save` registra dump.pm2 con los 4 servicios
2. macOS launchd: `pm2 startup launchd -u davidnows --hp /Users/davidnows` registra el LaunchAgent
3. Container `synk-ia-ollama` con `--restart unless-stopped`
4. Container `synk-ia-{backend,postgres,redis}` con `restart: unless-stopped`

**Smoke test pasado** (Sep 18, 03:51):
- `pm2 kill` → todos down (8889/9500/9501 = HTTP 000)
- `pm2 resurrect` → todos up en <8s (8889/9500/9501 = HTTP 200)
- E2E inference operativa inmediatamente después

## 7. Procedimiento de reinicio (manual si launchd falla)

```bash
# Iniciar todos los servicios (si pm2 está vacío)
pm2 start /Users/davidnows/ecosystem.config.js
pm2 save

# Sólo un servicio específico
pm2 restart synk-orchestrator

# Containers (auto-restart por Docker, pero por si)
docker start $(docker ps -a --format '{{.Names}}' | grep -v Exited)
```

## 8. Containers y archive

**Activos (13)**: synk-ia-{backend,ollama,postgres,redis}, sinkia-os-{qdrant,heaven,jarvis,gui}, sinkia-openwebui, odysseus-{odysseus,ntfy}, homelab-monitor, hermes-webui-hermes-webui-1.

**Archivados** (`/Volumes/Disco local/synk-ia-archive/dockers-old/`):
- 8 tar files (13GB total): sinkia-app, sinkia-llm, sinkia-data, sinkia-os-synkia-erp, sinkia-os-remote-machine, sinkia-os-models-centralizer, sinkia-os-sinkmaind-memory, sinkia-os-sinkia-gui:backup-pre-merge
- manifest.txt con metadata y comando `docker load -i`
- **OrbStack limpio**: ninguna imagen de los viejos queda en cache

## 9. Puertos muertos (refs eliminadas)

```diff
- localhost:3020   →  localhost:9500  (hub viejo muerto)
- localhost:7999   →  localhost:9501  (OpenClaw MCP muerto)
- localhost:18789  →  localhost:9500  (OpenClaw dashboard muerto)
- localhost:8889   →  localhost:9500  (hub-ai-local muerto)
```

Archivos parchados:
- ~/bin/batcave-startup.sh, host-executor-server.js, test-openclaw.sh, sinkia-boot.sh
- ~/.claude/CLAUDE_OPTIMIZED.md, INTEGRATION_STATUS.md
- ~/.claude/memory/{LEARNING,OPTIMIZATION_SUMMARY,SESSION_CACHE}.md

Refs residuales: **0**.

## 10. Pendientes menores

1. Cloudflare tunnel: config.yml mapea ingress a `localhost:3020` (muerto). Fix:
   ```yaml
   cockpit.sinkialabs.com → http://localhost:9500
   hub-ai.sinkialabs.com  → http://localhost:9501
   etc.
   ```
2. `OPENROUTER_API_KEY` está en `~/.hermes/.env`; copiar también a `synk-ia/.env.local` para redundancia (OmniRoute ya lo busca allí si no está en env).
3. `sinkia-os-sinkia-gui:latest` (154 MB) y `sinkia-os-sinkia-gui:backup-pre-merge` (ya borrado) — sólo se mantiene la activa.

## 11. Verificación rápida

```bash
# Estado completo en una línea (alias recomendado)
alias synk-status='pm2 list; curl -s -o /dev/null -w "9500=%{http_code} 9501=%{http_code}\n" http://127.0.0.1:9500/health http://127.0.0.1:9501/health; docker ps --format "{{.Names}}" | wc -l'

# Test E2E
curl -X POST http://localhost:9500/api/orchestrator/inference \
  -H "Content-Type: application/json" \
  -d '{"input":"OK","taskType":"chat"}'
```

— Fin de documento.
