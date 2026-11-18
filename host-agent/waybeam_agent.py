#!/usr/bin/env python3
"""
WayBeam Omarchy / Hyprland Local Host Agent.

Runs a strictly localhost-bound WebSocket server that:
1. Manages virtual /dev/uinput pointer and keyboard devices (inspired by harbefas/hyprpad).
2. Enforces a host-side safety gate (control disabled by default, SIGUSR1 kill-switch).
3. Proxies ephemeral Cloudflare TURN credential generation for the Host browser deck.
"""

from __future__ import annotations

import asyncio
import html
import hmac
import json
import logging
import mimetypes
import os
import signal
import sys
from http import HTTPStatus
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import aiohttp
import websockets
from dotenv import load_dotenv

try:
    from websockets.datastructures import Headers as WSHeaders
    from websockets.http11 import Response as WSResponse
except ImportError:
    WSHeaders = None  # type: ignore[assignment,misc]
    WSResponse = None  # type: ignore[assignment,misc]

try:
    import evdev
    from evdev import AbsInfo, UInput, ecodes

    EVDEV_AVAILABLE = True
except ImportError:
    evdev = None  # type: ignore[assignment]
    AbsInfo = None  # type: ignore[assignment,misc]
    UInput = None  # type: ignore[assignment,misc]
    ecodes = None  # type: ignore[assignment]
    EVDEV_AVAILABLE = False

LOG = logging.getLogger("waybeam-agent")

ABS_MAX = 32767
CLOUDFLARE_TURN_URL_TEMPLATE = (
    "https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate-ice-servers"
)
PLACEHOLDER_VALUES = {
    "",
    "your_cloudflare_turn_key_id_here",
    "your_cloudflare_turn_api_token_here",
}
WEB_DIST_DIR = Path(__file__).resolve().parent.parent / "web" / "dist"
STATIC_CONTENT_TYPES: dict[str, str] = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".wasm": "application/wasm",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json; charset=utf-8",
}


def content_type_for_path(file_path: Path) -> str:
    """Return an HTTP Content-Type header value for a static file path."""
    suffix = file_path.suffix.lower()
    if suffix in STATIC_CONTENT_TYPES:
        return STATIC_CONTENT_TYPES[suffix]
    guessed, _ = mimetypes.guess_type(str(file_path))
    if not guessed:
        return "application/octet-stream"
    if guessed.startswith("text/") and "charset=" not in guessed:
        return f"{guessed}; charset=utf-8"
    return guessed


def build_key_code_map() -> dict[str, int]:
    """Build complete JS KeyboardEvent.code -> Linux ecodes.KEY_* mapping."""
    if not EVDEV_AVAILABLE or ecodes is None:
        return {}

    mapping: dict[str, int] = {}

    # Letters KeyA..KeyZ
    for ch in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
        code_name = f"KEY_{ch}"
        if hasattr(ecodes, code_name):
            mapping[f"Key{ch}"] = getattr(ecodes, code_name)

    # Digits Digit0..Digit9
    for d in "0123456789":
        code_name = f"KEY_{d}"
        if hasattr(ecodes, code_name):
            mapping[f"Digit{d}"] = getattr(ecodes, code_name)

    # Function keys F1..F24
    for n in range(1, 25):
        code_name = f"KEY_F{n}"
        if hasattr(ecodes, code_name):
            mapping[f"F{n}"] = getattr(ecodes, code_name)

    # Modifiers, Navigation, Arrows, Punctuation, Numpad
    explicit: dict[str, str] = {
        # Modifiers
        "ShiftLeft": "KEY_LEFTSHIFT",
        "ShiftRight": "KEY_RIGHTSHIFT",
        "ControlLeft": "KEY_LEFTCTRL",
        "ControlRight": "KEY_RIGHTCTRL",
        "AltLeft": "KEY_LEFTALT",
        "AltRight": "KEY_RIGHTALT",
        "MetaLeft": "KEY_LEFTMETA",
        "MetaRight": "KEY_RIGHTMETA",
        "OSLeft": "KEY_LEFTMETA",
        "OSRight": "KEY_RIGHTMETA",
        # Navigation & Editing
        "ArrowUp": "KEY_UP",
        "ArrowDown": "KEY_DOWN",
        "ArrowLeft": "KEY_LEFT",
        "ArrowRight": "KEY_RIGHT",
        "Home": "KEY_HOME",
        "End": "KEY_END",
        "PageUp": "KEY_PAGEUP",
        "PageDown": "KEY_PAGEDOWN",
        "Insert": "KEY_INSERT",
        "Delete": "KEY_DELETE",
        "Backspace": "KEY_BACKSPACE",
        "Tab": "KEY_TAB",
        "Enter": "KEY_ENTER",
        "Escape": "KEY_ESC",
        "Space": "KEY_SPACE",
        "CapsLock": "KEY_CAPSLOCK",
        "PrintScreen": "KEY_SYSRQ",
        "ScrollLock": "KEY_SCROLLLOCK",
        "Pause": "KEY_PAUSE",
        "ContextMenu": "KEY_COMPOSE",
        # Punctuation
        "Minus": "KEY_MINUS",
        "Equal": "KEY_EQUAL",
        "BracketLeft": "KEY_LEFTBRACE",
        "BracketRight": "KEY_RIGHTBRACE",
        "Backslash": "KEY_BACKSLASH",
        "Semicolon": "KEY_SEMICOLON",
        "Quote": "KEY_APOSTROPHE",
        "Backquote": "KEY_GRAVE",
        "Comma": "KEY_COMMA",
        "Period": "KEY_DOT",
        "Slash": "KEY_SLASH",
        "IntlBackslash": "KEY_102ND",
        # Numpad
        "NumLock": "KEY_NUMLOCK",
        "Numpad0": "KEY_KP0",
        "Numpad1": "KEY_KP1",
        "Numpad2": "KEY_KP2",
        "Numpad3": "KEY_KP3",
        "Numpad4": "KEY_KP4",
        "Numpad5": "KEY_KP5",
        "Numpad6": "KEY_KP6",
        "Numpad7": "KEY_KP7",
        "Numpad8": "KEY_KP8",
        "Numpad9": "KEY_KP9",
        "NumpadAdd": "KEY_KPPLUS",
        "NumpadSubtract": "KEY_KPMINUS",
        "NumpadMultiply": "KEY_KPASTERISK",
        "NumpadDivide": "KEY_KPSLASH",
        "NumpadDecimal": "KEY_KPDOT",
        "NumpadEnter": "KEY_KPENTER",
        "NumpadEqual": "KEY_KPEQUAL",
        "NumpadComma": "KEY_KPCOMMA",
    }

    for js_code, linux_name in explicit.items():
        if hasattr(ecodes, linux_name):
            mapping[js_code] = getattr(ecodes, linux_name)

    return mapping


def build_button_map() -> dict[int, int]:
    """Map Web MouseEvent.button (0, 1, 2) to Linux BTN_* codes."""
    if not EVDEV_AVAILABLE or ecodes is None:
        return {0: 0x110, 1: 0x112, 2: 0x111}
    return {
        0: ecodes.BTN_LEFT,
        1: ecodes.BTN_MIDDLE,
        2: ecodes.BTN_RIGHT,
    }


def clamp01(value: Any) -> float:
    """Clamp numeric input to [0.0, 1.0]."""
    try:
        num = float(value)
    except (TypeError, ValueError):
        return 0.0
    if num < 0.0:
        return 0.0
    if num > 1.0:
        return 1.0
    return num


def is_allowed_origin(origin: str | None) -> bool:
    """
    Validate WebSocket Origin header.

    Allows:
    - Empty / missing Origin (local CLI tools)
    - http://localhost* and http://127.0.0.1* (and http://[::1]*)
    - https://* (hosted Firebase / Vercel SPA connecting to localhost agent)
    """
    if not origin:
        return True
    parsed = urlparse(origin)
    scheme = (parsed.scheme or "").lower()
    hostname = (parsed.hostname or "").lower()
    if scheme == "https" and bool(hostname):
        return True
    if scheme == "http" and hostname in {"localhost", "127.0.0.1", "::1"}:
        return True
    return False


def is_localhost_peer(remote_address: Any) -> bool:
    """Check that the TCP peer is strictly loopback (127.0.0.1 or ::1)."""
    if not remote_address or not isinstance(remote_address, tuple):
        return False
    peer_ip = str(remote_address[0]).split("%", 1)[0]
    return peer_ip in {"127.0.0.1", "::1"}


def extract_request_info(websocket: Any) -> tuple[Any, str]:
    """Extract headers and path across websockets v12 and v13+."""
    req = getattr(websocket, "request", None)
    if req is not None:
        return req.headers, getattr(req, "path", "/") or "/"
    headers = getattr(websocket, "request_headers", {})
    raw_path = getattr(websocket, "path", "/") or "/"
    return headers, raw_path


def normalize_ice_servers(raw_ice: Any) -> list[dict[str, Any]]:
    """Normalize Cloudflare iceServers field (list or single object) to a list."""
    if isinstance(raw_ice, list):
        return [item for item in raw_ice if isinstance(item, dict)]
    if isinstance(raw_ice, dict):
        return [raw_ice]
    return []


class VirtualInputDeviceManager:
    """Manages /dev/uinput virtual pointer and keyboard devices with dry-run fallback."""

    def __init__(self) -> None:
        self.key_code_map: dict[str, int] = build_key_code_map()
        self.button_map: dict[int, int] = build_button_map()
        self.pressed_keys: set[int] = set()
        self.pressed_buttons: set[int] = set()
        self.pointer: Any = None
        self.keyboard: Any = None
        self.uinput_ready: bool = False
        self._init_devices()

    def _init_devices(self) -> None:
        if not EVDEV_AVAILABLE or UInput is None or ecodes is None or AbsInfo is None:
            LOG.warning(
                "python-evdev is not installed; running in dry-run mode (uinputReady=false)."
            )
            return

        pointer_caps = {
            ecodes.EV_ABS: [
                (
                    ecodes.ABS_X,
                    AbsInfo(value=0, min=0, max=ABS_MAX, fuzz=0, flat=0, resolution=0),
                ),
                (
                    ecodes.ABS_Y,
                    AbsInfo(value=0, min=0, max=ABS_MAX, fuzz=0, flat=0, resolution=0),
                ),
            ],
            ecodes.EV_KEY: [
                ecodes.BTN_LEFT,
                ecodes.BTN_RIGHT,
                ecodes.BTN_MIDDLE,
            ],
            ecodes.EV_REL: [
                ecodes.REL_WHEEL,
                ecodes.REL_HWHEEL,
            ],
        }

        key_max = getattr(ecodes, "KEY_MAX", 0x2FF)
        kb_keys = sorted(
            {
                code
                for name, code in ecodes.ecodes.items()
                if name.startswith("KEY_")
                and not name.startswith(("KEY_MAX", "KEY_CNT", "KEY_MIN_"))
                and isinstance(code, int)
                and 0 < code < key_max
            }
            | set(self.key_code_map.values())
        )
        keyboard_caps = {
            ecodes.EV_KEY: kb_keys,
        }

        try:
            self.pointer = UInput(events=pointer_caps, name="WayBeam Virtual Pointer")
            self.keyboard = UInput(events=keyboard_caps, name="WayBeam Virtual Keyboard")
            self.uinput_ready = True
            LOG.info(
                "Initialized /dev/uinput devices: WayBeam Virtual Pointer & WayBeam Virtual Keyboard"
            )
        except Exception as exc:
            self.close()
            self.uinput_ready = False
            LOG.warning(
                "Unable to open /dev/uinput (%s). Falling back to dry-run mode (uinputReady=false). "
                "Run host-agent/install_omarchy.sh and ensure your user is in the 'input' group.",
                exc,
            )

    def move_pointer(self, x: float, y: float) -> None:
        abs_x = int(clamp01(x) * ABS_MAX)
        abs_y = int(clamp01(y) * ABS_MAX)
        if not self.uinput_ready or self.pointer is None or ecodes is None:
            return
        self.pointer.write(ecodes.EV_ABS, ecodes.ABS_X, abs_x)
        self.pointer.write(ecodes.EV_ABS, ecodes.ABS_Y, abs_y)
        self.pointer.syn()

    def set_mouse_button(
        self, button: int, pressed: bool, x: float | None = None, y: float | None = None
    ) -> None:
        btn_code = self.button_map.get(button)
        if btn_code is None:
            return

        if pressed:
            self.pressed_buttons.add(btn_code)
        else:
            self.pressed_buttons.discard(btn_code)

        if not self.uinput_ready or self.pointer is None or ecodes is None:
            return

        if x is not None and y is not None:
            self.pointer.write(ecodes.EV_ABS, ecodes.ABS_X, int(clamp01(x) * ABS_MAX))
            self.pointer.write(ecodes.EV_ABS, ecodes.ABS_Y, int(clamp01(y) * ABS_MAX))
        self.pointer.write(ecodes.EV_KEY, btn_code, 1 if pressed else 0)
        self.pointer.syn()

    def scroll_wheel(self, dx: float, dy: float) -> None:
        if not self.uinput_ready or self.pointer is None or ecodes is None:
            return

        wrote = False
        if dy > 0:
            self.pointer.write(ecodes.EV_REL, ecodes.REL_WHEEL, -1)
            wrote = True
        elif dy < 0:
            self.pointer.write(ecodes.EV_REL, ecodes.REL_WHEEL, 1)
            wrote = True

        if dx > 0:
            self.pointer.write(ecodes.EV_REL, ecodes.REL_HWHEEL, 1)
            wrote = True
        elif dx < 0:
            self.pointer.write(ecodes.EV_REL, ecodes.REL_HWHEEL, -1)
            wrote = True

        if wrote:
            self.pointer.syn()

    def set_key(self, js_code: str, pressed: bool) -> None:
        key_code = self.key_code_map.get(js_code)
        if key_code is None:
            return

        if pressed:
            self.pressed_keys.add(key_code)
        else:
            self.pressed_keys.discard(key_code)

        if not self.uinput_ready or self.keyboard is None or ecodes is None:
            return

        self.keyboard.write(ecodes.EV_KEY, key_code, 1 if pressed else 0)
        self.keyboard.syn()

    def release_all_inputs(self) -> None:
        """Release every currently held key and mouse button and sync uinput."""
        if self.pressed_keys:
            if self.uinput_ready and self.keyboard is not None and ecodes is not None:
                for key_code in list(self.pressed_keys):
                    self.keyboard.write(ecodes.EV_KEY, key_code, 0)
                self.keyboard.syn()
            self.pressed_keys.clear()

        if self.pressed_buttons:
            if self.uinput_ready and self.pointer is not None and ecodes is not None:
                for btn_code in list(self.pressed_buttons):
                    self.pointer.write(ecodes.EV_KEY, btn_code, 0)
                self.pointer.syn()
            self.pressed_buttons.clear()

    def close(self) -> None:
        self.release_all_inputs()
        for dev_attr in ("pointer", "keyboard"):
            dev = getattr(self, dev_attr, None)
            if dev is not None:
                try:
                    dev.close()
                except Exception:
                    pass
                setattr(self, dev_attr, None)


class WayBeamHostAgent:
    """Local WebSocket host agent for WayBeam."""

    def __init__(self, port: int, local_token: str) -> None:
        self.port = port
        self.local_token = local_token
        self.control_enabled: bool = False
        self.input_mgr = VirtualInputDeviceManager()
        self.clients: set[Any] = set()
        self._stop_event: asyncio.Event | None = None

    @property
    def uinput_ready(self) -> bool:
        return self.input_mgr.uinput_ready

    def status_payload(self) -> dict[str, Any]:
        return {
            "type": "status",
            "connected": True,
            "controlEnabled": self.control_enabled,
            "uinputReady": self.uinput_ready,
        }

    async def broadcast_status(self) -> None:
        if not self.clients:
            return
        payload = json.dumps(self.status_payload())
        stale: list[Any] = []
        for ws in list(self.clients):
            try:
                await ws.send(payload)
            except Exception:
                stale.append(ws)
        for ws in stale:
            self.clients.discard(ws)

    def trigger_kill_switch_sync(self) -> None:
        """Emergency kill-switch invoked from SIGUSR1."""
        LOG.warning("SIGUSR1 kill-switch triggered! Revoking control and releasing all inputs.")
        self.control_enabled = False
        self.input_mgr.release_all_inputs()
        asyncio.create_task(self.broadcast_status())

    def trigger_shutdown_sync(self, sig_name: str) -> None:
        """Clean shutdown invoked from SIGINT / SIGTERM."""
        LOG.info("Received %s; releasing all inputs and shutting down...", sig_name)
        self.control_enabled = False
        self.input_mgr.release_all_inputs()
        if self._stop_event is not None:
            self._stop_event.set()

    async def fetch_turn_credentials(self) -> dict[str, Any]:
        key_id = os.environ.get("CLOUDFLARE_TURN_KEY_ID", "").strip()
        api_token = os.environ.get("CLOUDFLARE_TURN_API_TOKEN", "").strip()

        if key_id in PLACEHOLDER_VALUES or api_token in PLACEHOLDER_VALUES:
            return {
                "type": "turn_credentials",
                "iceServers": [],
                "error": "Cloudflare TURN credentials are not configured in .env",
            }

        url = CLOUDFLARE_TURN_URL_TEMPLATE.format(key_id=key_id)
        headers = {
            "Authorization": f"Bearer {api_token}",
            "Content-Type": "application/json",
        }

        try:
            timeout = aiohttp.ClientTimeout(total=10)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(url, headers=headers, json={"ttl": 3600}) as resp:
                    body = await resp.json(content_type=None)
                    if resp.status >= 400:
                        return {
                            "type": "turn_credentials",
                            "iceServers": [],
                            "error": f"Cloudflare TURN API returned HTTP {resp.status}",
                        }
                    ice_servers = normalize_ice_servers(body.get("iceServers"))
                    return {
                        "type": "turn_credentials",
                        "iceServers": ice_servers,
                    }
        except Exception as exc:
            LOG.warning("Cloudflare TURN credential request failed: %s", exc)
            return {
                "type": "turn_credentials",
                "iceServers": [],
                "error": str(exc),
            }

    def handle_input_packet(self, packet: dict[str, Any]) -> None:
        if not self.control_enabled:
            return

        kind = packet.get("t") or packet.get("type")
        if kind == "move":
            self.input_mgr.move_pointer(packet.get("x", 0.0), packet.get("y", 0.0))
        elif kind == "mousedown":
            self.input_mgr.set_mouse_button(
                int(packet.get("button", 0)),
                True,
                packet.get("x"),
                packet.get("y"),
            )
        elif kind == "mouseup":
            self.input_mgr.set_mouse_button(
                int(packet.get("button", 0)),
                False,
                packet.get("x"),
                packet.get("y"),
            )
        elif kind == "wheel":
            self.input_mgr.scroll_wheel(
                float(packet.get("dx", 0.0)),
                float(packet.get("dy", 0.0)),
            )
        elif kind == "keydown":
            code = packet.get("code")
            if isinstance(code, str):
                self.input_mgr.set_key(code, True)
        elif kind == "keyup":
            code = packet.get("code")
            if isinstance(code, str):
                self.input_mgr.set_key(code, False)
        elif kind == "release_all":
            self.input_mgr.release_all_inputs()

    def _check_token(self, candidate: str | None) -> bool:
        if not self.local_token:
            return True
        if not candidate:
            return False
        return hmac.compare_digest(candidate, self.local_token)

    async def handle_client(self, websocket: Any) -> None:
        if not is_localhost_peer(getattr(websocket, "remote_address", None)):
            LOG.warning("Rejected non-localhost connection from %s", websocket.remote_address)
            await websocket.close(1008, "Localhost connections only")
            return

        headers, raw_path = extract_request_info(websocket)
        origin = headers.get("Origin") if hasattr(headers, "get") else None
        if not is_allowed_origin(origin):
            LOG.warning("Rejected connection with disallowed Origin: %s", origin)
            await websocket.close(1008, "Origin not allowed")
            return

        authenticated = not bool(self.local_token)
        if self.local_token:
            query_params = parse_qs(urlparse(raw_path).query)
            query_tokens = query_params.get("token")
            if query_tokens:
                if self._check_token(query_tokens[0]):
                    authenticated = True
                else:
                    await websocket.close(1008, "Invalid token")
                    return

        if authenticated:
            self.clients.add(websocket)
            await websocket.send(json.dumps(self.status_payload()))

        try:
            async for raw_message in websocket:
                if not isinstance(raw_message, str):
                    continue
                try:
                    msg = json.loads(raw_message)
                except json.JSONDecodeError:
                    continue
                if not isinstance(msg, dict):
                    continue

                msg_type = msg.get("type")

                if not authenticated:
                    if msg_type == "auth" and self._check_token(msg.get("token")):
                        authenticated = True
                        self.clients.add(websocket)
                        await websocket.send(json.dumps(self.status_payload()))
                    else:
                        await websocket.close(1008, "Authentication required")
                        return
                    continue

                if msg_type == "auth":
                    await websocket.send(json.dumps(self.status_payload()))
                elif msg_type == "ping":
                    await websocket.send(
                        json.dumps(
                            {
                                "type": "pong",
                                "controlEnabled": self.control_enabled,
                                "uinputReady": self.uinput_ready,
                            }
                        )
                    )
                elif msg_type == "set_control":
                    self.control_enabled = bool(msg.get("enabled", False))
                    if not self.control_enabled:
                        self.input_mgr.release_all_inputs()
                    await self.broadcast_status()
                elif msg_type == "kill_switch":
                    self.control_enabled = False
                    self.input_mgr.release_all_inputs()
                    await self.broadcast_status()
                elif msg_type == "get_turn_credentials":
                    turn_resp = await self.fetch_turn_credentials()
                    await websocket.send(json.dumps(turn_resp))
                elif msg_type == "input":
                    event_payload = msg.get("event")
                    if isinstance(event_payload, dict):
                        self.handle_input_packet(event_payload)
                elif msg.get("t") in {
                    "move",
                    "mousedown",
                    "mouseup",
                    "wheel",
                    "keydown",
                    "keyup",
                    "release_all",
                } or msg_type in {
                    "move",
                    "mousedown",
                    "mouseup",
                    "wheel",
                    "keydown",
                    "keyup",
                    "release_all",
                }:
                    self.handle_input_packet(msg)
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            self.clients.discard(websocket)
            self.input_mgr.release_all_inputs()

    def _fallback_status_html(self) -> bytes:
        page = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WayBeam Host Agent</title>
  <style>
    body {{ font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 2rem; }}
    main {{ max-width: 640px; margin: 2rem auto; background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 1.5rem 2rem; }}
    h1 {{ margin-top: 0; font-size: 1.35rem; }}
    code {{ background: #0f172a; padding: 0.15rem 0.4rem; border-radius: 4px; color: #38bdf8; }}
    pre {{ background: #0f172a; padding: 0.75rem 1rem; border-radius: 8px; overflow-x: auto; }}
  </style>
</head>
<body>
  <main>
    <h1>WayBeam Host Agent Running</h1>
    <p>WebSocket endpoint: <code>ws://127.0.0.1:{self.port}</code></p>
    <p>Status: <code>uinputReady={html.escape(str(self.uinput_ready).lower())}</code>, <code>controlEnabled={html.escape(str(self.control_enabled).lower())}</code></p>
    <p>The built Web UI was not found at <code>{html.escape(str(WEB_DIST_DIR / "index.html"))}</code>.</p>
    <p>Build or run the Web UI with:</p>
    <pre>cd web &amp;&amp; npm run build
# or for development:
cd web &amp;&amp; npm run dev</pre>
  </main>
</body>
</html>
"""
        return page.encode("utf-8")

    def _resolve_http_response(self, raw_path: str) -> tuple[str, bytes]:
        """Resolve an HTTP request path to (content_type, body) from web/dist."""
        url_path = unquote(urlparse(raw_path).path or "/")
        rel_path = url_path.lstrip("/")
        dist_root = WEB_DIST_DIR.resolve()

        if rel_path:
            candidate = (dist_root / rel_path).resolve()
            if candidate.is_relative_to(dist_root) and candidate.is_file():
                return content_type_for_path(candidate), candidate.read_bytes()

        index_file = dist_root / "index.html"
        if index_file.is_file():
            return "text/html; charset=utf-8", index_file.read_bytes()

        return "text/html; charset=utf-8", self._fallback_status_html()

    def process_http_request(self, arg1: Any, arg2: Any) -> Any:
        """
        Serve built Web UI static files on normal HTTP requests while letting
        WebSocket upgrades proceed to handle_client.

        Compatible with both websockets v13+ (connection, request) -> Response | None
        and websockets v12 (path, request_headers) -> (HTTPStatus, headers, body) | None.
        """
        is_legacy_v12 = isinstance(arg1, str)
        if is_legacy_v12:
            raw_path = arg1 or "/"
            headers = arg2
            method = "GET"
        else:
            raw_path = getattr(arg2, "path", "/") or "/"
            headers = getattr(arg2, "headers", {})
            method = getattr(arg2, "method", "GET") or "GET"

        upgrade = ""
        if hasattr(headers, "get"):
            upgrade = headers.get("Upgrade") or headers.get("upgrade") or ""
        if str(upgrade).strip().lower() == "websocket":
            return None

        content_type, body = self._resolve_http_response(raw_path)
        content_length = len(body)
        if method.upper() == "HEAD":
            body = b""

        cache_control = (
            "no-cache"
            if content_type.startswith("text/html")
            else "public, max-age=31536000, immutable"
        )
        header_pairs = [
            ("Content-Type", content_type),
            ("Content-Length", str(content_length)),
            ("Cache-Control", cache_control),
        ]

        if not is_legacy_v12 and WSResponse is not None and WSHeaders is not None:
            return WSResponse(
                HTTPStatus.OK.value,
                HTTPStatus.OK.phrase,
                WSHeaders(header_pairs),
                body,
            )

        return (HTTPStatus.OK, header_pairs, body)

    async def run(self) -> None:
        self._stop_event = asyncio.Event()
        loop = asyncio.get_running_loop()

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, self.trigger_shutdown_sync, sig.name)
            except NotImplementedError:
                pass

        if hasattr(signal, "SIGUSR1"):
            try:
                loop.add_signal_handler(signal.SIGUSR1, self.trigger_kill_switch_sync)
            except NotImplementedError:
                pass

        async with websockets.serve(
            self.handle_client,
            "127.0.0.1",
            self.port,
            process_request=self.process_http_request,
        ):
            LOG.info(
                "WayBeam Host Agent listening on http://127.0.0.1:%d (Web UI + ws://127.0.0.1:%d, uinputReady=%s, controlEnabled=%s)",
                self.port,
                self.port,
                self.uinput_ready,
                self.control_enabled,
            )
            await self._stop_event.wait()

        self.input_mgr.close()
        LOG.info("WayBeam Host Agent stopped.")


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    env_path = Path(__file__).resolve().parent / ".env"
    if env_path.exists():
        load_dotenv(env_path)

    port_raw = os.environ.get("WAYBEAM_WS_PORT", "8765").strip()
    try:
        port = int(port_raw)
    except ValueError:
        LOG.warning("Invalid WAYBEAM_WS_PORT=%r; defaulting to 8765", port_raw)
        port = 8765

    local_token = os.environ.get("WAYBEAM_LOCAL_TOKEN", "").strip()
    agent = WayBeamHostAgent(port=port, local_token=local_token)

    try:
        asyncio.run(agent.run())
    except KeyboardInterrupt:
        agent.input_mgr.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
