import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Clipboard,
  Hand,
  LogOut,
  Maximize2,
  Minimize2,
  Moon,
  Radio,
  ShieldCheck,
  Sun,
} from 'lucide-react';
import { formatRoomCode, normalizeRoomCode } from '../lib/firebase';
import { attachInputBridge } from '../lib/inputBridge';
import { WebRTCManager } from '../lib/webrtcManager';
import type { ControlPacket, RoomDocument, TelemetryData } from '../lib/types';
import type { ThemeMode } from '../App';

interface ViewerStageProps {
  roomCode: string;
  onDisconnect: () => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
}

const INITIAL_TELEMETRY: TelemetryData = {
  connectionMode: 'Connecting',
  iceState: 'new',
  latencyMs: null,
  fps: null,
  resolution: null,
  bitrateKbps: null,
  viewerConnected: false,
};

export function ViewerStage({
  roomCode,
  onDisconnect,
  theme,
  onToggleTheme,
}: ViewerStageProps) {
  const normalizedCode = normalizeRoomCode(roomCode);
  const [streamReady, setStreamReady] = useState(false);
  const [telemetry, setTelemetry] = useState<TelemetryData>(INITIAL_TELEMETRY);
  const [room, setRoom] = useState<RoomDocument | null>(null);
  const [controlGranted, setControlGranted] = useState(false);
  const [controlRequested, setControlRequested] = useState(false);
  const [toolbarVisible, setToolbarVisible] = useState(true);
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const [clipboardInput, setClipboardInput] = useState('');
  const [receivedClipboard, setReceivedClipboard] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const webrtcRef = useRef<WebRTCManager | null>(null);
  const controlActiveRef = useRef(false);
  const hideTimerRef = useRef<number | null>(null);

  useEffect(() => {
    controlActiveRef.current = controlGranted;
  }, [controlGranted]);

  // Connect WebRTCManager as viewer
  useEffect(() => {
    if (!normalizedCode) {
      setError('No room code provided.');
      return;
    }

    const manager = new WebRTCManager({
      role: 'viewer',
      roomCode: normalizedCode,
      onRemoteStream: (stream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
        setStreamReady(true);
      },
      onTelemetry: (t) => setTelemetry(t),
      onRoomUpdate: (r) => {
        setRoom(r);
        if (r) {
          setControlGranted(r.controlGranted);
          setControlRequested(r.controlRequested);
        }
      },
      onControlPacket: (pkt: ControlPacket) => {
        if (pkt.t === 'control_state') {
          setControlGranted(pkt.enabled);
          if (!pkt.enabled) setControlRequested(false);
        } else if (pkt.t === 'clipboard') {
          setReceivedClipboard(pkt.text);
        }
      },
      onError: (msg) => setError(msg),
    });

    webrtcRef.current = manager;
    manager.startViewer().catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to join session.');
    });

    return () => {
      manager.destroy().catch(() => {});
    };
  }, [normalizedCode]);

  // Attach input bridge to video element
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl || !streamReady) return;

    const detach = attachInputBridge({
      videoElement: videoEl,
      containerElement: stageRef.current ?? undefined,
      isControlActive: () => controlActiveRef.current && !clipboardOpen,
      sendPacket: (pkt) => {
        webrtcRef.current?.sendControlPacket(pkt);
      },
    });

    return detach;
  }, [streamReady, clipboardOpen]);

  // Auto-hide toolbar when stream is active and mouse moves away from top
  const revealToolbar = useCallback(() => {
    setToolbarVisible(true);
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    if (streamReady && !clipboardOpen) {
      hideTimerRef.current = window.setTimeout(() => {
        setToolbarVisible(false);
      }, 2800);
    }
  }, [streamReady, clipboardOpen]);

  useEffect(() => {
    revealToolbar();
    return () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, [revealToolbar]);

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const handleControlButton = async () => {
    if (!webrtcRef.current) return;
    if (controlGranted) {
      await webrtcRef.current.releaseControl();
      setControlGranted(false);
      setControlRequested(false);
    } else if (!controlRequested) {
      await webrtcRef.current.requestControl();
      setControlRequested(true);
    }
  };

  const handleToggleFullscreen = async () => {
    if (!stageRef.current) return;
    if (!document.fullscreenElement) {
      await stageRef.current.requestFullscreen().catch(() => {});
    } else {
      await document.exitFullscreen().catch(() => {});
    }
  };

  const handleSendClipboard = () => {
    if (!clipboardInput.trim()) return;
    webrtcRef.current?.sendClipboard(clipboardInput);
    setClipboardInput('');
  };

  const connectionBadgeClass =
    telemetry.connectionMode === 'P2P Direct (STUN)'
      ? 'wb-badge wb-badge-emerald'
      : telemetry.connectionMode === 'Relayed (Cloudflare TURN)'
        ? 'wb-badge wb-badge-cyan'
        : 'wb-badge wb-badge-amber';

  return (
    <div
      ref={stageRef}
      className={`wb-viewer-stage ${controlGranted ? 'control-active' : ''}`}
      onMouseMove={(e) => {
        if (e.clientY <= 90 || !streamReady) {
          revealToolbar();
        }
      }}
    >
      {/* Floating Glassmorphic Toolbar */}
      <div className={`wb-viewer-toolbar ${toolbarVisible || !streamReady || clipboardOpen ? '' : 'hidden'}`}>
        <span className="wb-badge mono" style={{ fontWeight: 600 }}>
          {formatRoomCode(normalizedCode || '------')}
        </span>

        <span className={connectionBadgeClass}>
          <Radio size={12} />
          {telemetry.connectionMode}
        </span>

        <span className="wb-metric-item mono" style={{ fontSize: 12 }}>
          <Activity size={12} />
          {telemetry.latencyMs !== null ? `${telemetry.latencyMs}ms` : '—'}
        </span>

        <span className="wb-metric-item mono" style={{ fontSize: 12 }}>
          {telemetry.fps !== null ? `${telemetry.fps}fps` : '—'}
          {telemetry.resolution ? ` · ${telemetry.resolution}` : ''}
        </span>

        <button
          type="button"
          className={`wb-btn ${
            controlGranted
              ? 'wb-btn-emerald'
              : controlRequested
                ? ''
                : 'wb-btn-primary'
          }`}
          style={{ padding: '6px 12px', fontSize: 12.5 }}
          onClick={handleControlButton}
          disabled={!streamReady}
        >
          {controlGranted ? (
            <>
              <ShieldCheck size={14} />
              Release Control
            </>
          ) : controlRequested ? (
            <>
              <Hand size={14} />
              Control Pending...
            </>
          ) : (
            <>
              <Hand size={14} />
              Request Control
            </>
          )}
        </button>

        <button
          type="button"
          className="wb-btn"
          style={{ padding: '6px 10px', fontSize: 12.5 }}
          onClick={() => setClipboardOpen((v) => !v)}
          title="Clipboard Sync"
        >
          <Clipboard size={14} />
          Clipboard
        </button>

        <button
          type="button"
          className="wb-btn wb-btn-icon"
          style={{ width: 32, height: 32 }}
          onClick={handleToggleFullscreen}
          title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
        >
          {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>

        <button
          type="button"
          className="wb-btn wb-btn-icon"
          style={{ width: 32, height: 32 }}
          onClick={onToggleTheme}
          title="Toggle Theme"
        >
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>

        <button
          type="button"
          className="wb-btn wb-btn-danger"
          style={{ padding: '6px 12px', fontSize: 12.5 }}
          onClick={onDisconnect}
        >
          <LogOut size={14} />
          Disconnect
        </button>
      </div>

      {/* Clipboard Popover */}
      {clipboardOpen && (
        <div className="wb-popover">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <strong style={{ fontSize: 13.5 }}>Clipboard Sync</strong>
            <button
              type="button"
              className="wb-btn wb-btn-ghost"
              style={{ padding: '2px 8px', fontSize: 12 }}
              onClick={() => setClipboardOpen(false)}
            >
              Close
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              className="wb-input"
              placeholder="Send text to host clipboard..."
              value={clipboardInput}
              onChange={(e) => setClipboardInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSendClipboard();
              }}
            />
            <button type="button" className="wb-btn wb-btn-primary" onClick={handleSendClipboard}>
              Send
            </button>
          </div>
          {receivedClipboard !== null && (
            <div
              style={{
                marginTop: 10,
                padding: '8px 10px',
                borderRadius: 8,
                background: 'var(--bg-primary)',
                border: '1px solid var(--border-subtle)',
                fontSize: 12.5,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                Host: {receivedClipboard}
              </span>
              <button
                type="button"
                className="wb-btn wb-btn-ghost"
                style={{ padding: '4px 8px', fontSize: 12 }}
                onClick={() => navigator.clipboard?.writeText(receivedClipboard)}
              >
                Copy
              </button>
            </div>
          )}
        </div>
      )}

      <video ref={videoRef} className="wb-viewer-video" autoPlay playsInline />

      {/* Waiting / Error Overlay */}
      {!streamReady && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            background: 'rgba(9, 9, 11, 0.85)',
            color: '#f4f4f5',
            padding: 24,
            textAlign: 'center',
          }}
        >
          {error ? (
            <>
              <div style={{ color: 'var(--accent-red)', fontWeight: 600, fontSize: 16 }}>
                {error}
              </div>
              <button type="button" className="wb-btn" onClick={onDisconnect}>
                Back to Home
              </button>
            </>
          ) : (
            <>
              <span className="wb-pulse-dot" style={{ width: 12, height: 12, background: 'var(--accent-indigo)' }} />
              <div style={{ fontSize: 17, fontWeight: 600 }}>
                Connecting to room <span className="mono">{formatRoomCode(normalizedCode)}</span>...
              </div>
              <div style={{ fontSize: 13.5, color: '#a1a1aa', maxWidth: 420 }}>
                {room
                  ? 'Negotiating WebRTC P2P connection (automatic Cloudflare TURN fallback after 4.5s if needed).'
                  : 'Waiting for host to start screen sharing.'}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
