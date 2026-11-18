#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"

ENV_FILE="$SCRIPT_DIR/.env"
if [ -z "${WAYBEAM_WS_PORT:-}" ] && [ -f "$ENV_FILE" ]; then
    PORT_FROM_ENV="$(grep -E '^WAYBEAM_WS_PORT=' "$ENV_FILE" | tail -n 1 | cut -d'=' -f2- | tr -d '[:space:]"'\''' || true)"
    if [ -n "$PORT_FROM_ENV" ]; then
        WAYBEAM_WS_PORT="$PORT_FROM_ENV"
    fi
fi

PORT="${WAYBEAM_WS_PORT:-8765}"
HOST_URL="${WAYBEAM_HOST_URL:-https://waybeam-2083.web.app/host}"
SYSTEMD_UNIT="waybeam-agent.service"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}"
PID_FILE="$RUNTIME_DIR/waybeam-agent.pid"
LOG_FILE="$RUNTIME_DIR/waybeam-agent.log"

notify() {
    local title="$1"
    local body="$2"
    if command -v notify-send >/dev/null 2>&1; then
        notify-send -i waybeam "$title" "$body" >/dev/null 2>&1 || true
    fi
}

has_systemd_unit() {
    command -v systemctl >/dev/null 2>&1 || return 1
    local load_state
    load_state="$(systemctl --user show -p LoadState --value "$SYSTEMD_UNIT" 2>/dev/null || true)"
    [ "$load_state" = "loaded" ]
}

is_port_listening() {
    python3 - "$PORT" <<'PY' >/dev/null 2>&1
import socket, sys
port = int(sys.argv[1])
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
    s.settimeout(0.2)
    sys.exit(0 if s.connect_ex(("127.0.0.1", port)) == 0 else 1)
PY
}

is_running() {
    if has_systemd_unit && systemctl --user is-active --quiet "$SYSTEMD_UNIT" 2>/dev/null; then
        return 0
    fi
    if [ -f "$PID_FILE" ]; then
        local pid
        pid="$(cat "$PID_FILE" 2>/dev/null || true)"
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
    fi
    if pgrep -f "waybeam_agent\.py" >/dev/null 2>&1; then
        return 0
    fi
    return 1
}

python_bin() {
    if [ -x "$SCRIPT_DIR/.venv/bin/python" ]; then
        printf '%s\n' "$SCRIPT_DIR/.venv/bin/python"
    else
        command -v python3
    fi
}

cmd_start() {
    if ! is_running; then
        if has_systemd_unit; then
            systemctl --user start "$SYSTEMD_UNIT"
        else
            local py
            py="$(python_bin)"
            nohup "$py" "$SCRIPT_DIR/waybeam_agent.py" >>"$LOG_FILE" 2>&1 &
            echo $! > "$PID_FILE"
        fi
    fi

    local i=0
    while [ "$i" -lt 50 ]; do
        if is_port_listening; then
            echo "[WayBeam] Agent started (127.0.0.1:${PORT})."
            notify "WayBeam Agent Started" "Listening on 127.0.0.1:${PORT} (/dev/uinput ready)"
            return 0
        fi
        sleep 0.1
        i=$((i + 1))
    done

    echo "[WayBeam] Error: Agent failed to listen on 127.0.0.1:${PORT} within 5s." >&2
    return 1
}

cmd_stop() {
    if has_systemd_unit && systemctl --user is-active --quiet "$SYSTEMD_UNIT" 2>/dev/null; then
        systemctl --user stop "$SYSTEMD_UNIT"
    fi

    if [ -f "$PID_FILE" ]; then
        local pid
        pid="$(cat "$PID_FILE" 2>/dev/null || true)"
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            kill -TERM "$pid" 2>/dev/null || true
        fi
        rm -f "$PID_FILE"
    fi

    pkill -TERM -f "waybeam_agent\.py" 2>/dev/null || true

    local i=0
    while [ "$i" -lt 20 ]; do
        if ! pgrep -f "waybeam_agent\.py" >/dev/null 2>&1; then
            break
        fi
        sleep 0.1
        i=$((i + 1))
    done

    echo "[WayBeam] Agent stopped."
    notify "WayBeam Agent Stopped" "Background daemon stopped and all virtual inputs released."
}

cmd_toggle() {
    if is_running; then
        cmd_stop
    else
        cmd_start
    fi
}

cmd_launch() {
    if ! is_running; then
        cmd_start
    fi

    if command -v omarchy-launch-webapp >/dev/null 2>&1; then
        nohup omarchy-launch-webapp "$HOST_URL" >/dev/null 2>&1 &
    elif command -v xdg-open >/dev/null 2>&1; then
        nohup xdg-open "$HOST_URL" >/dev/null 2>&1 &
    else
        echo "[WayBeam] Error: Neither omarchy-launch-webapp nor xdg-open found on PATH." >&2
        return 1
    fi
}

cmd_kill_switch() {
    if pkill -USR1 -f "waybeam_agent\.py" 2>/dev/null; then
        echo "[WayBeam] Kill-switch signal (SIGUSR1) sent."
        notify "WayBeam Kill-Switch" "Remote control revoked immediately."
    else
        echo "[WayBeam] Agent is not running." >&2
        return 1
    fi
}

cmd_status() {
    if is_running; then
        local pids port_state="not listening" unit_state="standalone"
        pids="$(pgrep -d ',' -f "waybeam_agent\.py" 2>/dev/null || true)"
        if is_port_listening; then
            port_state="listening on 127.0.0.1:${PORT}"
        fi
        if has_systemd_unit && systemctl --user is-active --quiet "$SYSTEMD_UNIT" 2>/dev/null; then
            unit_state="systemd user service active"
        fi
        echo "WayBeam Agent: running (${unit_state}, pid=${pids:-unknown}, ${port_state})"
        return 0
    else
        echo "WayBeam Agent: stopped"
        return 1
    fi
}

usage() {
    cat <<EOF
Usage: $(basename "$0") <command>

Commands:
  start        Start the WayBeam host agent and verify port ${PORT}
  stop         Stop the WayBeam host agent cleanly
  toggle       Toggle the WayBeam host agent on or off
  launch       Start the agent (if needed) and open ${HOST_URL}
  kill-switch  Send SIGUSR1 to revoke remote control immediately
  status       Show whether the WayBeam host agent is running
EOF
}

case "${1:-}" in
    start)       cmd_start ;;
    stop)        cmd_stop ;;
    toggle)      cmd_toggle ;;
    launch)      cmd_launch ;;
    kill-switch) cmd_kill_switch ;;
    status)      cmd_status ;;
    -h|--help|"")
        usage
        [ -n "${1:-}" ] || exit 1
        ;;
    *)
        echo "Unknown command: $1" >&2
        usage >&2
        exit 1
        ;;
esac
