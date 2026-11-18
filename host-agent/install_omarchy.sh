#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USE_VENV=false

for arg in "$@"; do
    case "$arg" in
        --venv)
            USE_VENV=true
            ;;
        -h|--help)
            echo "Usage: $0 [--venv]"
            echo "  --venv    Install Python dependencies into a local .venv instead of system pacman packages"
            exit 0
            ;;
        *)
            echo "Unknown option: $arg" >&2
            exit 1
            ;;
    esac
done

echo "[WayBeam] Installing host-agent dependencies for Omarchy / Hyprland..."

install_venv() {
    echo "[WayBeam] Setting up local Python virtual environment at $SCRIPT_DIR/.venv..."
    python3 -m venv "$SCRIPT_DIR/.venv"
    "$SCRIPT_DIR/.venv/bin/pip" install --upgrade pip
    "$SCRIPT_DIR/.venv/bin/pip" install -r "$SCRIPT_DIR/requirements.txt"
    echo "[WayBeam] Virtual environment ready. Run with: $SCRIPT_DIR/.venv/bin/python $SCRIPT_DIR/waybeam_agent.py"
}

if [ "$USE_VENV" = true ]; then
    install_venv
else
    if command -v pacman >/dev/null 2>&1; then
        echo "[WayBeam] Installing Arch/Omarchy packages via pacman..."
        if ! sudo pacman -S --needed --noconfirm python python-evdev python-websockets python-aiohttp python-dotenv; then
            echo "[WayBeam] pacman installation failed; falling back to local .venv..."
            install_venv
        fi
    else
        echo "[WayBeam] pacman not found; falling back to local .venv..."
        install_venv
    fi
fi

echo "[WayBeam] Configuring udev rule for /dev/uinput..."
UDEV_RULE='KERNEL=="uinput", MODE="0660", GROUP="input", OPTIONS+="static_node=uinput"'
printf '%s\n' "$UDEV_RULE" | sudo tee /etc/udev/rules.d/99-waybeam-uinput.rules >/dev/null

echo "[WayBeam] Reloading udev rules..."
sudo udevadm control --reload-rules
sudo udevadm trigger

echo "[WayBeam] Loading uinput kernel module and persisting across reboots..."
sudo modprobe uinput
printf 'uinput\n' | sudo tee /etc/modules-load.d/uinput.conf >/dev/null

TARGET_USER="${SUDO_USER:-$USER}"
if [ -n "$TARGET_USER" ]; then
    echo "[WayBeam] Ensuring user '$TARGET_USER' is in the 'input' group..."
    sudo usermod -aG input "$TARGET_USER"
fi

ENV_EXAMPLE="$SCRIPT_DIR/.env.example"
ENV_FILE="$SCRIPT_DIR/.env"

if [ ! -f "$ENV_EXAMPLE" ]; then
    echo "[WayBeam] Creating default $ENV_EXAMPLE..."
    cat <<'EOF' > "$ENV_EXAMPLE"
CLOUDFLARE_TURN_KEY_ID=your_cloudflare_turn_key_id_here
CLOUDFLARE_TURN_API_TOKEN=your_cloudflare_turn_api_token_here
WAYBEAM_LOCAL_TOKEN=
WAYBEAM_WS_PORT=8765
EOF
fi

if [ ! -f "$ENV_FILE" ]; then
    echo "[WayBeam] Copying .env.example to $ENV_FILE..."
    cp "$ENV_EXAMPLE" "$ENV_FILE"
else
    echo "[WayBeam] Existing $ENV_FILE preserved."
fi

chmod +x "$SCRIPT_DIR/waybeam_agent.py"

echo ""
echo "[WayBeam] Installation complete!"
echo "  - Edit $ENV_FILE to add your Cloudflare TURN credentials (optional for local/STUN, recommended for NAT traversal)."
echo "  - If '$TARGET_USER' was newly added to the 'input' group, log out and back in (or run 'newgrp input') before starting the agent."
if [ -x "$SCRIPT_DIR/.venv/bin/python" ]; then
    echo "  - Start the agent: $SCRIPT_DIR/.venv/bin/python $SCRIPT_DIR/waybeam_agent.py"
else
    echo "  - Start the agent: $SCRIPT_DIR/waybeam_agent.py"
fi
