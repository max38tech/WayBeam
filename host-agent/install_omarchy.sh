#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USE_VENV=false
DESKTOP_ONLY=false

for arg in "$@"; do
    case "$arg" in
        --venv)
            USE_VENV=true
            ;;
        --desktop-only)
            DESKTOP_ONLY=true
            ;;
        -h|--help)
            echo "Usage: $0 [--venv] [--desktop-only]"
            echo "  --venv          Install Python dependencies into a local .venv instead of system pacman packages"
            echo "  --desktop-only  Only install systemd user service, icon, .desktop launchers, and waybeam-ctl symlink"
            exit 0
            ;;
        *)
            echo "Unknown option: $arg" >&2
            exit 1
            ;;
    esac
done

TARGET_USER="${SUDO_USER:-$USER}"
if [ -n "$TARGET_USER" ] && [ "${EUID:-$(id -u)}" -eq 0 ] && command -v getent >/dev/null 2>&1; then
    TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
else
    TARGET_HOME="$HOME"
fi

ENV_EXAMPLE="$SCRIPT_DIR/.env.example"
ENV_FILE="$SCRIPT_DIR/.env"

if [ "$DESKTOP_ONLY" = false ]; then
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

if [ -n "$TARGET_USER" ]; then
    echo "[WayBeam] Ensuring user '$TARGET_USER' is in the 'input' group..."
    sudo usermod -aG input "$TARGET_USER"
fi

echo "[WayBeam] Loading uinput kernel module and persisting across reboots..."
sudo modprobe uinput
printf 'uinput\n' | sudo tee /etc/modules-load.d/uinput.conf >/dev/null

echo "[WayBeam] Configuring udev rule for /dev/uinput..."
UDEV_RULE='KERNEL=="uinput", MODE="0660", GROUP="input", TAG+="uaccess", OPTIONS+="static_node=uinput"'
printf '%s\n' "$UDEV_RULE" | sudo tee /etc/udev/rules.d/99-waybeam-uinput.rules >/dev/null

echo "[WayBeam] Reloading udev rules..."
sudo udevadm control --reload-rules
sudo udevadm trigger --sysname-match=uinput

echo "[WayBeam] Applying immediate /dev/uinput permissions for current session..."
sudo chgrp input /dev/uinput || true
sudo chmod 0660 /dev/uinput || true
if command -v setfacl >/dev/null 2>&1 && [ -n "$TARGET_USER" ]; then
    sudo setfacl -m "u:${TARGET_USER}:rw" /dev/uinput || true
fi

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
fi # end DESKTOP_ONLY=false

chmod +x "$SCRIPT_DIR/waybeam_agent.py" "$SCRIPT_DIR/waybeam-ctl.sh"

install_desktop_integration() {
    local python_bin
    if [ -x "$SCRIPT_DIR/.venv/bin/python" ]; then
        python_bin="$SCRIPT_DIR/.venv/bin/python"
    else
        python_bin="$(command -v python3 || echo /usr/bin/python3)"
    fi

    local systemd_dir="$TARGET_HOME/.config/systemd/user"
    local icon_dir="$TARGET_HOME/.local/share/icons/hicolor/scalable/apps"
    local apps_dir="$TARGET_HOME/.local/share/applications"
    local bin_dir="$TARGET_HOME/.local/bin"

    echo "[WayBeam] Installing systemd user service into $systemd_dir..."
    mkdir -p "$systemd_dir"
    cat <<EOF > "$systemd_dir/waybeam-agent.service"
[Unit]
Description=WayBeam Local Host Agent (/dev/uinput & TURN proxy)
After=graphical-session.target

[Service]
Type=simple
WorkingDirectory=$SCRIPT_DIR
ExecStart=$python_bin $SCRIPT_DIR/waybeam_agent.py
Restart=on-failure
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=5

[Install]
WantedBy=default.target
EOF

    if command -v systemctl >/dev/null 2>&1; then
        systemctl --user daemon-reload >/dev/null 2>&1 || true
    fi

    echo "[WayBeam] Installing icon to $icon_dir/waybeam.svg..."
    mkdir -p "$icon_dir"
    cp "$SCRIPT_DIR/waybeam.svg" "$icon_dir/waybeam.svg"
    if command -v gtk-update-icon-cache >/dev/null 2>&1; then
        gtk-update-icon-cache -f -t "$TARGET_HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true
    fi

    echo "[WayBeam] Installing desktop launchers into $apps_dir..."
    mkdir -p "$apps_dir"

    cat <<EOF > "$apps_dir/waybeam-host.desktop"
[Desktop Entry]
Version=1.0
Type=Application
Name=WayBeam Host
Comment=Start WayBeam Host Agent and open Host Control Deck
Exec=$SCRIPT_DIR/waybeam-ctl.sh launch
Icon=waybeam
Terminal=false
Categories=Network;RemoteAccess;Utility;
Actions=ToggleAgent;StopAgent;KillSwitch;

[Desktop Action ToggleAgent]
Name=Toggle Host Agent (Start / Stop)
Exec=$SCRIPT_DIR/waybeam-ctl.sh toggle

[Desktop Action StopAgent]
Name=Stop Host Agent
Exec=$SCRIPT_DIR/waybeam-ctl.sh stop

[Desktop Action KillSwitch]
Name=Emergency Kill-Switch (Revoke Control)
Exec=$SCRIPT_DIR/waybeam-ctl.sh kill-switch
EOF

    cat <<EOF > "$apps_dir/waybeam-agent-toggle.desktop"
[Desktop Entry]
Version=1.0
Type=Application
Name=WayBeam Agent (Start / Stop)
Comment=Toggle the local WayBeam /dev/uinput background daemon on or off
Exec=$SCRIPT_DIR/waybeam-ctl.sh toggle
Icon=waybeam
Terminal=false
Categories=Utility;System;
EOF

    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$apps_dir" >/dev/null 2>&1 || true
    fi

    echo "[WayBeam] Symlinking waybeam-ctl into $bin_dir..."
    mkdir -p "$bin_dir"
    ln -sf "$SCRIPT_DIR/waybeam-ctl.sh" "$bin_dir/waybeam-ctl"
}

install_desktop_integration

echo ""
echo "[WayBeam] Installation complete!"
echo "  - Edit $ENV_FILE to add your Cloudflare TURN credentials (optional for local/STUN, recommended for NAT traversal)."
echo "  - If '$TARGET_USER' was newly added to the 'input' group, log out and back in (or run 'newgrp input') before starting the agent."
echo "  - Launch from Omarchy app launcher (Super + Space): 'WayBeam Host' or 'WayBeam Agent (Start / Stop)'."
echo "  - CLI control helper: waybeam-ctl {start|stop|toggle|launch|kill-switch|status}"
