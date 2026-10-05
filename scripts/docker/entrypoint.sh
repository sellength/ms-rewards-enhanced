#!/usr/bin/env bash
set -euo pipefail

# Ensure Playwright uses preinstalled browsers
export PLAYWRIGHT_BROWSERS_PATH=0

SCRIPT_DIR="/usr/src/microsoft-rewards-script"

IS_ROOT=false
if [ "$(id -u)" = "0" ]; then
  IS_ROOT=true
fi

# 1. Timezone: default to UTC if not provided
: "${TZ:=UTC}"
if [ "$IS_ROOT" = "true" ]; then
  ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime
  echo "$TZ" > /etc/timezone
  dpkg-reconfigure -f noninteractive tzdata 2>/dev/null || true
fi

# 2. Validate CRON_SCHEDULE (not required in API mode or WEB mode)
if [ "${API_MODE:-false}" != "true" ] && [ "${WEB_MODE:-false}" != "true" ]; then
  if [ -z "${CRON_SCHEDULE:-}" ]; then
    echo "ERROR: CRON_SCHEDULE environment variable is not set." >&2
    echo "Please set CRON_SCHEDULE (e.g., \"0 2 * * *\")." >&2
    echo "       To run the API server instead, set API_MODE=true." >&2
    echo "       To run the Fluent Web console instead, set WEB_MODE=true." >&2
    exit 1
  fi
fi

mapfile -t account_indexes < <(
  compgen -e | sed -n 's/^ACCOUNT_\([1-9][0-9]*\)_EMAIL$/\1/p' | sort -n -u
)

acct_count=0
for i in "${account_indexes[@]}"; do
  email_var="ACCOUNT_${i}_EMAIL"
  [ -z "${!email_var:-}" ] && continue

  acct_count=$((acct_count + 1))
done

if [ "$acct_count" -eq 0 ]; then
  echo "WARNING: No ACCOUNT_N_EMAIL found in environment - the script will fail." >&2
  echo "         Set at least one ACCOUNT_N_EMAIL in your .env file." >&2
else
  echo "[entrypoint] Found $acct_count account(s) in environment"
fi

CONFIG_FILE="$SCRIPT_DIR/config/config.json"
CONFIG_EXAMPLE="$SCRIPT_DIR/config.example.json"

if ! [ -f "$CONFIG_EXAMPLE" ]; then
  echo "ERROR: config.example.json not found at $CONFIG_EXAMPLE - image may be corrupt." >&2
  exit 1
fi

if [ -d "$CONFIG_FILE" ]; then
  echo "ERROR: $CONFIG_FILE is a directory, not a file." >&2
  echo "       ./config.json likely did not exist on the host when the container" >&2
  echo "       started, so Docker created it as a folder. Remove it and create the" >&2
  echo "       file first:  cp config.example.json config.json" >&2
  exit 1
fi

SYNC_ARGS=(--config "$CONFIG_FILE" --example "$CONFIG_EXAMPLE")
if [ "${CONFIG_AUTO_SYNC:-false}" = "true" ]; then
  SYNC_ARGS+=(--patch)
fi
if ! node "$SCRIPT_DIR/dist/util/ConfigSync.js" sync "${SYNC_ARGS[@]}"; then
  echo "ERROR: config sync failed - see above." >&2
  exit 1
fi

echo "[entrypoint] Applying CONFIG_* environment variable overrides..."
if ! node "$SCRIPT_DIR/dist/util/ConfigEnvOverrides.js" apply --config "$CONFIG_FILE"; then
  echo "ERROR: applying CONFIG_* overrides failed - see above." >&2
  exit 1
fi

echo "[entrypoint] Config ready."

# Link the generated config back to the root so the app script can find it
ln -sf "$CONFIG_FILE" "$SCRIPT_DIR/config.json"

# Ensure permissions and snapshot environment for non-root execution
RUN_AS_NODE=""
if [ "$IS_ROOT" = "true" ]; then
  mkdir -p "$SCRIPT_DIR/config" "$SCRIPT_DIR/sessions"
  chown -R node:node "$SCRIPT_DIR/config" "$SCRIPT_DIR/sessions" "$CONFIG_FILE" "$SCRIPT_DIR/config.json" 2>/dev/null || true
  export -p > /etc/container_env
  chown node:node /etc/container_env 2>/dev/null || true
  chmod 600 /etc/container_env
  RUN_AS_NODE="gosu node"
fi

if [ "${RUN_ON_START:-false}" = "true" ]; then
  echo "[entrypoint] Starting initial run in background at $(date)"
  (
    cd "$SCRIPT_DIR" || {
      echo "[entrypoint-bg] ERROR: Unable to cd to $SCRIPT_DIR" >&2
      exit 1
    }
    if [ -n "$RUN_AS_NODE" ]; then
      SKIP_RANDOM_SLEEP=true $RUN_AS_NODE scripts/docker/run_daily.sh
    else
      SKIP_RANDOM_SLEEP=true scripts/docker/run_daily.sh
    fi
    echo "[entrypoint-bg] Initial run completed at $(date)"
  ) &
  echo "[entrypoint] Background process started (PID: $!)"
fi

: "${API_HOST:=0.0.0.0}"
export API_HOST

if [ "${API_MODE:-false}" = "true" ]; then
  export TZ

  SCHEDULE_OVERRIDE="${SCHEDULE_FILE:-$SCRIPT_DIR/config/schedule.json}"

  if [ -f "$SCHEDULE_OVERRIDE" ]; then
    echo "[entrypoint] Found $SCHEDULE_OVERRIDE - applying it (overrides CRON_SCHEDULE)."
    if node scripts/api/apply-schedule.js; then
      cron -f &
      echo "[entrypoint] Cron started in background (schedule: from schedule.json, TZ: $TZ)"
    else
      echo "ERROR: Could not apply $SCHEDULE_OVERRIDE." >&2
      exit 1
    fi
  elif [ -n "${CRON_SCHEDULE:-}" ]; then
    if [ ! -f /etc/cron.d/microsoft-rewards-cron.template ]; then
      echo "ERROR: Cron template /etc/cron.d/microsoft-rewards-cron.template not found." >&2
      exit 1
    fi
    envsubst < /etc/cron.d/microsoft-rewards-cron.template > /etc/cron.d/microsoft-rewards-cron
    chmod 0644 /etc/cron.d/microsoft-rewards-cron
    if [ "$IS_ROOT" = "true" ]; then
      crontab -u node /etc/cron.d/microsoft-rewards-cron
    else
      crontab /etc/cron.d/microsoft-rewards-cron 2>/dev/null || true
    fi
    cron -f &
    echo "[entrypoint] Cron started in background (schedule: $CRON_SCHEDULE, TZ: $TZ)"
  else
    echo "[entrypoint] No CRON_SCHEDULE set and no schedule.json override - runs must be triggered manually via POST /start, or scheduled from the dashboard."
  fi
  echo "[entrypoint] Starting control API on ${API_HOST}:${API_PORT:-3010} as unprivileged node user at $(date)"
  if [ -n "$RUN_AS_NODE" ]; then
    exec $RUN_AS_NODE node scripts/api/server.js
  else
    exec node scripts/api/server.js
  fi
fi

if [ "${WEB_MODE:-false}" = "true" ]; then
  export HOST="${HOST:-0.0.0.0}"
  export PORT="${PORT:-3888}"
  echo "[entrypoint] Starting Fluent Web Console on ${HOST}:${PORT} as unprivileged node user at $(date)"
  if [ -n "$RUN_AS_NODE" ]; then
    exec $RUN_AS_NODE node web.mjs
  else
    exec node web.mjs
  fi
fi

# Scheduler-only mode (default): cron calls npm start directly.
if [ ! -f /etc/cron.d/microsoft-rewards-cron.template ]; then
  echo "ERROR: Cron template /etc/cron.d/microsoft-rewards-cron.template not found." >&2
  exit 1
fi

export TZ
envsubst < /etc/cron.d/microsoft-rewards-cron.template > /etc/cron.d/microsoft-rewards-cron
chmod 0644 /etc/cron.d/microsoft-rewards-cron
if [ "$IS_ROOT" = "true" ]; then
  crontab -u node /etc/cron.d/microsoft-rewards-cron
else
  crontab /etc/cron.d/microsoft-rewards-cron 2>/dev/null || true
fi

echo "[entrypoint] Cron configured with schedule: $CRON_SCHEDULE and timezone: $TZ; starting cron at $(date)"

# 7. Start cron in foreground (PID 1)
exec cron -f
