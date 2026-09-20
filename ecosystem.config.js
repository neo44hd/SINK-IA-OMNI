module.exports = {
  apps: [
    {
      name: 'synk-orchestrator',
      script: '/Users/davidnows/synk-ia-orchestrator.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        CONFIG_PATH: '/Users/davidnows/synk-ia-global-config.yaml',
        ORCHESTRATOR_PORT: 9500
      },
      max_memory_restart: '500M',
      error_file: '/Users/davidnows/.synkia-ai-hub/logs/orchestrator-error.log',
      out_file: '/Users/davidnows/.synkia-ai-hub/logs/orchestrator-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      autorestart: true,
      watch: false,
      ignore_watch: ['node_modules', '.git', 'logs'],
      merge_logs: true,
      max_restarts: 10,
      min_uptime: '10s'
    },
    {
      name: 'synk-model-selector',
      script: '/Users/davidnows/synk-ia-model-selector.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        CONFIG_PATH: '/Users/davidnows/synk-ia-global-config.yaml',
        MODEL_SELECTOR_PORT: 9501
      },
      max_memory_restart: '500M',
      error_file: '/Users/davidnows/.synkia-ai-hub/logs/model-selector-error.log',
      out_file: '/Users/davidnows/.synkia-ai-hub/logs/model-selector-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      autorestart: true,
      watch: false,
      ignore_watch: ['node_modules', '.git', 'logs'],
      merge_logs: true,
      max_restarts: 10,
      min_uptime: '10s'
    },
    {
      name: 'host-executor',
      script: '/Users/davidnows/bin/host-executor-server.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 8889
      },
      max_memory_restart: '300M',
      error_file: '/Users/davidnows/.synkia-ai-hub/logs/host-executor-error.log',
      out_file: '/Users/davidnows/.synkia-ai-hub/logs/host-executor-out.log',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '10s'
    },
    {
      name: 'cloudflared-tunnel',
      script: '/usr/local/bin/cloudflared',
      args: 'tunnel --config /Users/davidnows/.cloudflared/config.yml run /Users/davidnows/.cloudflared/aa3e380e-4a72-4cda-b3bc-055cce0d555f.json',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '200M',
      error_file: '/Users/davidnows/.synkia-ai-hub/logs/cloudflared-error.log',
      out_file: '/Users/davidnows/.synkia-ai-hub/logs/cloudflared-out.log',
      max_restarts: 10,
      min_uptime: '10s'
    },
    {
      name: 'telegram-supervisor',
      script: '/Users/davidnows/bin/unified-telegram-supervisor.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production'
      },
      max_memory_restart: '300M',
      error_file: '/Users/davidnows/.synkia-ai-hub/logs/telegram-supervisor-error.log',
      out_file: '/Users/davidnows/.synkia-ai-hub/logs/telegram-supervisor-out.log',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '10s'
    }
  ]
};
