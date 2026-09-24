# ===== UTF-8 & LM Studio Configuration =====
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
export LC_CTYPE=en_US.UTF-8

# OpenClaw Completion
source "/Users/davidnows/.openclaw/completions/openclaw.zsh"
export PATH="/Users/davidnows/bin:$PATH"
alias oai='ollama-auto-switch.sh'
alias pm='prompt-manager.sh'
alias pa='prompt-apply.sh'
alias ps='prompt-status.sh'

# Added by LM Studio CLI (lms)
export PATH="$PATH:/Users/davidnows/.lmstudio/bin"
# End of LM Studio CLI section


# opencode
export PATH=/Users/davidnows/.opencode/bin:$PATH
# The following lines have been added by Docker Desktop to enable Docker CLI completions.
fpath=(/Users/davidnows/.docker/completions $fpath)
autoload -Uz compinit
compinit
# End of Docker CLI completions
export PATH="$HOME/Library/Python/3.9/bin:$PATH"

# Claude Code (fork local-claude-code) → gateway maestro LiteLLM (provider unificado :4000)
# Anthropic vars conservadas por compatibilidad si en el futuro usas un proxy real
export ANTHROPIC_AUTH_TOKEN=ollama
export ANTHROPIC_API_KEY=""
# export ANTHROPIC_BASE_URL=http://localhost:11434  # comentado: Ollama NO habla API Anthropic; rompía el `claude` oficial
export OLLAMA_API_BASE=http://localhost:11434

# Variables que lee el binario claude-local (fork local-claude-code).
# Apunta al gateway maestro LiteLLM: mismo provider unificado que usan todos los agentes.
export OLLAMA_URL=http://127.0.0.1:11435     # Ollama real (container synk-ia-ollama). Antes :4000 = LiteLLM (retirado)
export OLLAMA_MODEL=llama3.2:3b              # modelo realmente presente en el Ollama :11435
export OLLAMA_KEEP_ALIVE=5m                 # descarga modelo de RAM tras 5 min sin uso
export OLLAMA_MAX_LOADED_MODELS=1            # 1 modelo local a la vez (no saturar; regla del usuario)
export OLLAMA_NUM_PARALLEL=1                 # 1 request paralelo por modelo

# IMPORTANTE: NO declarar `alias claude-local=...` aquí; el binario real está en
# /opt/homebrew/lib/node_modules/local-claude-code/dist/cli.js y un alias lo enmascararía.

# Alias bajo demanda con los alias UNIFICADOS del gateway (mismos que usan los agentes):
alias claude-fast="claude-local --ollama-model local-fast"             # llama3.2:3b (Ollama)
alias claude-coder="claude-local --ollama-model local-claude-code"           # devstral (LM Studio) + fallbacks
alias claude-coder7="claude-local --ollama-model local-coder-ollama"   # qwen2.5-coder:7b (Ollama)
alias claude-reason="claude-local --ollama-model local-reason"         # deepseek-r1 (LM Studio) + fallbacks
alias claude-big="claude-local --ollama-model local-big"               # 40B local (LM Studio) + fallbacks
alias claude-cloud="claude-local --ollama-model cloud-free-default"            # OpenRouter auto (nube)

# Created by `pipx` on 2026-04-11 04:53:55
export PATH="$PATH:/Users/davidnows/.local/bin"
# SynK-IA Memory
alias memory="~/sinkia-memory/memory"

# SynK-IA Backup & Reinstall
alias backup='~/sinkia-next/backup.sh'
alias backup-now='~/sinkia-next/backup.sh backup'
alias backup-full='~/sinkia-next/backup.sh full'
alias backup-restore='~/sinkia-next/backup.sh list'

# bun completions
[ -s "/Users/davidnows/.bun/_bun" ] && source "/Users/davidnows/.bun/_bun"

# >>> spawn >>>
export PATH="/Users/davidnows/.bun/bin:$PATH"
# <<< spawn <<<
[ -f ~/.spawnrc ] && source ~/.spawnrc
# Token del gateway OpenClaw: fuente canónica = service-env (evita duplicados y desincronización)
[ -f "$HOME/.openclaw/service-env/ai.openclaw.gateway.env" ] && \
  export GATEWAY_AUTH_TOKEN="$( . "$HOME/.openclaw/service-env/ai.openclaw.gateway.env" >/dev/null 2>&1; printf '%s' "$GATEWAY_AUTH_TOKEN" )"

# SynK-IA Server Aliases
alias synkia='~/sinkia-next/synkia.sh'
alias synkia-start='~/sinkia-next/synkia.sh start'
alias synkia-stop='~/sinkia-next/synkia.sh stop'
alias synkia-status='~/sinkia-next/synkia.sh status'
alias synkia-logs='~/sinkia-next/synkia.sh logs'
alias synkia-dashboard='~/sinkia-next/synkia.sh dashboard'
alias synkia-info='~/sinkia-next/synkia.sh info'

alias batcave-control='/Users/davidnows/bin/batcave-control.sh'
export PATH="/Users/davidnows/synkia/os/bin:$PATH"

# ── SYNK-OPS Quick Commands ──────────────────────────────────────────────────
alias synk-dashboard="/Users/davidnows/synkia-dashboard.sh"
alias synk-logs="tail -f /Users/davidnows/.synkia-ai-hub/*.log"
alias synk-status="curl -s http://localhost:3001/api/agents/status | jq ."
alias synk-health="curl -s http://localhost:3001/api/system/health | jq ."
alias synk-chat="curl -X POST http://localhost:3001/api/chat -H 'Content-Type: application/json' -d '{\"messages\":[{\"role\":\"user\",\"content\":\"test\"}],\"stream\":false}' | jq ."
alias synk-start="launchctl load ~/Library/LaunchAgents/com.synkia.*.plist"
alias synk-stop="launchctl unload ~/Library/LaunchAgents/com.synkia.*.plist"
alias synk-restart="synk-stop && sleep 2 && synk-start"

alias synk-graph="/Users/davidnows/local-claude-code/sync-knowledge.sh"
alias synk-health="/Users/davidnows/synkia/os/health-check.sh"
alias synk-tunnel='tail -f /Users/davidnows/.cloudflared/logs/tunnel-monitor-out.log'
alias synk-status='/Users/davidnows/synkia/os/status-dashboard.sh'
alias qwen='bash /Users/davidnows/.mcp/qwen-tools/launch-qwen.sh'
alias qwen='bash /Users/davidnows/.mcp/qwen-tools/launch-qwen.sh'
alias qwen='bash /Users/davidnows/.mcp/qwen-tools/launch-qwen.sh'
alias qwen='bash /Users/davidnows/.mcp/qwen-tools/launch-qwen.sh'
alias qwen='bash /Users/davidnows/.mcp/qwen-tools/launch-qwen.sh'
alias qwen='bash /Users/davidnows/.mcp/qwen-tools/launch-qwen.sh'
alias qwen='bash /Users/davidnows/.mcp/qwen-tools/launch-qwen.sh'
alias qwen='bash /Users/davidnows/.mcp/qwen-tools/launch-qwen.sh'
alias qwen='bash /Users/davidnows/.mcp/qwen-tools/launch-qwen.sh'
alias qwen='bash /Users/davidnows/.mcp/qwen-tools/launch-qwen.sh'
alias qwen='bash /Users/davidnows/.mcp/qwen-tools/launch-qwen.sh'
alias qwen='bash /Users/davidnows/.mcp/qwen-tools/launch-qwen.sh'
alias qwen='bash /Users/davidnows/.mcp/qwen-tools/launch-qwen.sh'
alias qwen='bash /Users/davidnows/.mcp/qwen-tools/launch-qwen.sh'
alias qwen='bash /Users/davidnows/.mcp/qwen-tools/launch-qwen.sh'
alias qwen='bash /Users/davidnows/.mcp/qwen-tools/launch-qwen.sh'
alias qwen='bash /Users/davidnows/.mcp/qwen-tools/launch-qwen.sh'
alias qwen='bash /Users/davidnows/.mcp/qwen-tools/launch-qwen.sh'
alias qwen='bash /Users/davidnows/.mcp/qwen-tools/launch-qwen.sh'
alias qwen='bash /Users/davidnows/.mcp/qwen-tools/launch-qwen.sh'

# UNIFIED-HUB keys
[ -f ~/.unified-hub/keys.env ] && source ~/.unified-hub/keys.env

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion

# Added by cua-driver-rs installer — see https://github.com/trycua/cua
export PATH="/Users/davidnows/.local/bin:$PATH"
