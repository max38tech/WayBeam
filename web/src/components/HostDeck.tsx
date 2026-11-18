import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Check,
  Clipboard,
  Copy,
  Link2,
  Monitor,
  MonitorOff,
  Radio,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Terminal,
  Wifi,
} from 'lucide-react';
import {
  deleteRoom,
  formatRoomCode,
  generateRoomCode,
  updateControlState,
} from '../lib/firebase';
import { LocalAgentClient, WebRTCManager } from '../lib/webrtcManager';
import type {
  ControlPacket,
  LocalAgentStatus,
  QualityPreset,
  RoomDocument,
  TelemetryData,
} from '../lib/types';

interface HostDeckProps {
  onExit: () => void;
}

const INITIAL_TELEMETRY: TelemetryData = {
  connectionMode: 'Disconnected',
  iceState: 'new',
  latencyMs: null,
  fps: null,
  resolution: null,
  bitrateKbps: null,
  viewerConnected: false,
};

const PRESET_OPTIONS: { id: QualityPreset; label: string; sub: string }[] = [
  { id: 'sharp', label: 'Sharp Text', sub: 'Maintain Res' },
  { id: 'balanced', label: 'Balanced', sub: '60 FPS' },
  { id: 'low', label: 'Low Bandwidth', sub: 'Saver' },
];

export function HostDeck({ onExit }: HostDeckProps) {
  const [roomCode] = useState<string>(() => generateRoomCode());
  const [preset, setPreset] = useState<QualityPreset>('sharp');
  const [sharing, setSharing] = useState(false);
  const [controlGranted, setControlGranted] = useState(false);
  const [room, setRoom] = useState<RoomDocument | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryData>(INITIAL_TELEMETRY);
  const [agentStatus, setAgentStatus] = useState<LocalAgentStatus>({
    connected: false,
    controlEnabled: false,
    uinputReady: false,
  });
  const [copiedType, setCopiedType] = useState<'code' | 'link' | 'cmd' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clipboardText, setClipboardText] = useState('');
  const [receivedClipboard, setReceivedClipboard] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const agentRef = useRef<LocalAgentClient | null>(null);
  const webrtcRef = useRef<WebRTCManager | null>(null);

  const copyText = useCallback((text: string, type: 'code' | 'link' | 'cmd') => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedType(type);
    window.setTimeout(() => setCopiedType((prev) => (prev === type ? null : prev)), 2000);
  }, []);

  // Initialize LocalAgentClient and WebRTCManager
  useEffect(() => {
    const agentUrl = import.meta.env.VITE_WAYBEAM_AGENT_URL || 'ws://127.0.0.1:8765';
    const agentToken = import.meta.env.VITE_WAYBEAM_LOCAL_TOKEN || undefined;

    const agent = new LocalAgentClient({
      url: agentUrl,
      token: agentToken,
      onStatusChange: (status) => setAgentStatus(status),
    });
    agent.connect();
    agentRef.current = agent;

    const manager = new WebRTCManager({
      role: 'host',
      roomCode,
      localAgent: agent,
      onTelemetry: (t) => setTelemetry(t),
      onRoomUpdate: (r) => {
        setRoom(r);
        if (r) {
          setControlGranted(r.controlGranted);
        }
      },
      onControlPacket: (pkt: ControlPacket) => {
        if (pkt.t === 'clipboard') {
          setReceivedClipboard(pkt.text);
        }
      },
      onError: (msg) => setError(msg),
    });
    webrtcRef.current = manager;

    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      manager.destroy().catch(() => {});
      deleteRoom(roomCode).catch(() => {});
      agent.disconnect();
    };
  }, [roomCode]);

  const handleRevokeControl = useCallback(async () => {
    setControlGranted(false);
    agentRef.current?.killSwitch();
    try {
      await webrtcRef.current?.setControlGranted(false);
      await updateControlState(roomCode, { controlGranted: false, controlRequested: false });
    } catch {
      // ignore cleanup errors
    }
  }, [roomCode]);

  const handleToggleControl = useCallback(
    async (next: boolean) => {
      setControlGranted(next);
      try {
        await webrtcRef.current?.setControlGranted(next);
        await updateControlState(roomCode, {
          controlGranted: next,
          controlRequested: false,
        });
        if (!next) {
          agentRef.current?.killSwitch();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update control state.');
      }
    },
    [roomCode],
  );

  // Global Escape key emergency kill-switch on Host Deck
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (controlGranted || room?.controlRequested)) {
        e.preventDefault();
        handleRevokeControl();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controlGranted, room?.controlRequested, handleRevokeControl]);

  const handleStartOrSwitchShare = async () => {
    setError(null);
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 60 },
        audio: false,
      });

      const videoTrack = displayStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => {
          setSharing(false);
          streamRef.current = null;
          if (videoRef.current) videoRef.current.srcObject = null;
          handleRevokeControl();
        };
      }

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      streamRef.current = displayStream;

      if (videoRef.current) {
        videoRef.current.srcObject = displayStream;
      }

      if (!sharing) {
        await webrtcRef.current?.startHost(displayStream, preset);
        setSharing(true);
      } else {
        await webrtcRef.current?.replaceStream(displayStream);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        return; // user cancelled picker
      }
      setError(err instanceof Error ? err.message : 'Could not capture screen.');
    }
  };

  const handleStopShare = async () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setSharing(false);
    await handleRevokeControl();
  };

  const handlePresetChange = async (next: QualityPreset) => {
    setPreset(next);
    try {
      await webrtcRef.current?.applyQualityPreset(next);
    } catch {
      // ignore if stream not active yet
    }
  };

  const handleSendClipboard = () => {
    if (!clipboardText.trim()) return;
    webrtcRef.current?.sendClipboard(clipboardText);
    setClipboardText('');
  };

  const formattedCode = formatRoomCode(roomCode);
  const inviteLink = `${window.location.origin}/?room=${formattedCode}`;

  const connectionBadgeClass =
    telemetry.connectionMode === 'P2P Direct (STUN)'
      ? 'wb-badge wb-badge-emerald'
      : telemetry.connectionMode === 'Relayed (Cloudflare TURN)'
        ? 'wb-badge wb-badge-cyan'
        : telemetry.connectionMode === 'Connecting'
          ? 'wb-badge wb-badge-amber'
          : 'wb-badge';

  return (
    <main className="wb-container">
      {/* Top Status & Telemetry Bar */}
      <div className="wb-telemetry-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className={connectionBadgeClass}>
            <Radio size={13} />
            {telemetry.connectionMode}
          </span>

          {agentStatus.connected ? (
            <span
              className={`wb-badge ${agentStatus.uinputReady ? 'wb-badge-emerald' : 'wb-badge-amber'}`}
            >
              <Terminal size={13} />
              {agentStatus.uinputReady
                ? 'Agent Connected (/dev/uinput Ready)'
                : 'Agent Connected (Dry-Run)'}
            </span>
          ) : (
            <span className="wb-badge wb-badge-red">
              <Terminal size={13} />
              Agent Offline
            </span>
          )}
        </div>

        <div className="wb-telemetry-metrics mono">
          <span className="wb-metric-item">
            <Activity size={13} />
            RTT:{' '}
            <span className="wb-metric-value">
              {telemetry.latencyMs !== null ? `${telemetry.latencyMs} ms` : '—'}
            </span>
          </span>
          <span className="wb-metric-item">
            FPS:{' '}
            <span className="wb-metric-value">
              {telemetry.fps !== null ? telemetry.fps : '—'}
            </span>
          </span>
          <span className="wb-metric-item">
            Res:{' '}
            <span className="wb-metric-value">{telemetry.resolution ?? '—'}</span>
          </span>
          <span className="wb-metric-item">
            Bitrate:{' '}
            <span className="wb-metric-value">
              {telemetry.bitrateKbps !== null ? `${telemetry.bitrateKbps} kbps` : '—'}
            </span>
          </span>
          <span className="wb-metric-item">
            <Wifi size={13} />
            Viewer:{' '}
            <span className="wb-metric-value">
              {telemetry.viewerConnected ? 'Connected' : 'Waiting'}
            </span>
          </span>
        </div>
      </div>

      {/* Offline Agent Helper */}
      {!agentStatus.connected && (
        <div
          className="wb-card"
          style={{
            marginBottom: 20,
            borderColor: 'rgba(245, 158, 11, 0.35)',
            background: 'var(--accent-amber-soft)',
            padding: '14px 18px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13.5 }}>
            <AlertTriangle size={17} style={{ color: 'var(--accent-amber)', flexShrink: 0 }} />
            <span>
              Local host agent not detected on <code className="mono">127.0.0.1:8765</code>.
              Screen sharing works, but <code className="mono">/dev/uinput</code> control &amp;
              Cloudflare TURN fallback require the agent.
            </span>
          </div>
          <button
            type="button"
            className="wb-btn"
            onClick={() => copyText('./host-agent/waybeam_agent.py', 'cmd')}
          >
            {copiedType === 'cmd' ? <Check size={14} /> : <Copy size={14} />}
            <code className="mono" style={{ fontSize: 12 }}>
              ./host-agent/waybeam_agent.py
            </code>
          </button>
        </div>
      )}

      {/* Incoming Control Request Alert */}
      {room?.controlRequested && !controlGranted && (
        <div
          className="wb-card"
          style={{
            marginBottom: 20,
            borderColor: 'rgba(245, 158, 11, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span
              className="wb-pulse-dot"
              style={{ background: 'var(--accent-amber)' }}
            />
            <div>
              <div style={{ fontWeight: 600, fontSize: 15 }}>
                Guest is requesting Remote Control
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                Approving allows mouse, scroll, and keyboard input on your Hyprland desktop.
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              className="wb-btn"
              onClick={() => handleToggleControl(false)}
            >
              Deny
            </button>
            <button
              type="button"
              className="wb-btn wb-btn-emerald"
              onClick={() => handleToggleControl(true)}
            >
              <ShieldCheck size={16} />
              Approve Control
            </button>
          </div>
        </div>
      )}

      {error && (
        <div
          className="wb-card"
          style={{
            marginBottom: 20,
            borderColor: 'rgba(239, 68, 68, 0.4)',
            color: 'var(--accent-red)',
            padding: '12px 16px',
            fontSize: 13.5,
          }}
        >
          {error}
        </div>
      )}

      <div className="wb-deck-grid">
        {/* Left: Screen Preview & Stream Controls */}
        <div className="wb-card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Screen Capture</h2>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2 }}>
                PipeWire / xdg-desktop-portal-hyprland
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="wb-btn wb-btn-primary"
                onClick={handleStartOrSwitchShare}
              >
                <Monitor size={15} />
                {sharing ? 'Switch Screen' : 'Start Screen Share'}
              </button>
              {sharing && (
                <button
                  type="button"
                  className="wb-btn"
                  onClick={handleStopShare}
                >
                  <MonitorOff size={15} />
                  Stop
                </button>
              )}
            </div>
          </div>

          <div className="wb-preview-box">
            <video ref={videoRef} autoPlay muted playsInline />
            {!sharing && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                  color: 'var(--text-muted)',
                  padding: 24,
                  textAlign: 'center',
                }}
              >
                <Monitor size={36} strokeWidth={1.5} />
                <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
                  Click <strong>Start Screen Share</strong> to select a Hyprland monitor or window.
                </div>
              </div>
            )}
          </div>

          <div>
            <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-secondary)', marginBottom: 8 }}>
              Quality Preset
            </div>
            <div className="wb-preset-group">
              {PRESET_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`wb-preset-btn ${preset === opt.id ? 'active' : ''}`}
                  onClick={() => handlePresetChange(opt.id)}
                >
                  <div style={{ fontWeight: 600 }}>{opt.label}</div>
                  <div style={{ fontSize: 11, opacity: 0.75 }}>{opt.sub}</div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right: Invite Card, Remote Control Gate & Clipboard */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Shareable Invite Card */}
          <div className="wb-card">
            <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-secondary)', marginBottom: 10 }}>
              Session Room Code
            </div>
            <div className="wb-room-code-display mono">{formattedCode}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
              <button
                type="button"
                className="wb-btn wb-btn-primary"
                onClick={() => copyText(inviteLink, 'link')}
              >
                {copiedType === 'link' ? <Check size={15} /> : <Link2 size={15} />}
                {copiedType === 'link' ? 'Link Copied' : 'Copy Invite Link'}
              </button>
              <button
                type="button"
                className="wb-btn"
                onClick={() => copyText(formattedCode, 'code')}
              >
                {copiedType === 'code' ? <Check size={15} /> : <Copy size={15} />}
                {copiedType === 'code' ? 'Code Copied' : 'Copy Code'}
              </button>
            </div>
          </div>

          {/* Remote Control Permission Banner */}
          <div
            className="wb-card"
            style={{
              borderColor: controlGranted
                ? 'rgba(16, 185, 129, 0.45)'
                : 'var(--border-subtle)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  className="wb-pulse-dot"
                  style={{
                    background: controlGranted
                      ? 'var(--accent-emerald)'
                      : 'var(--accent-amber)',
                  }}
                />
                <span style={{ fontWeight: 600, fontSize: 15 }}>Remote Control</span>
              </div>
              <span
                className={`wb-badge ${controlGranted ? 'wb-badge-emerald' : 'wb-badge-amber'}`}
              >
                {controlGranted ? 'Remote Control Enabled' : 'View Only'}
              </span>
            </div>

            <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {controlGranted
                ? 'Guest input events are currently forwarded to /dev/uinput.'
                : 'Input forwarding is disabled. Guest can view the stream only.'}
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button
                type="button"
                className={`wb-btn ${controlGranted ? '' : 'wb-btn-emerald'}`}
                onClick={() => handleToggleControl(!controlGranted)}
                disabled={!sharing}
                style={{ width: '100%' }}
              >
                {controlGranted ? <ShieldOff size={15} /> : <ShieldCheck size={15} />}
                {controlGranted ? 'Switch to View Only' : 'Enable Remote Control'}
              </button>

              <button
                type="button"
                className="wb-btn wb-btn-danger"
                onClick={handleRevokeControl}
                style={{ width: '100%' }}
              >
                <ShieldAlert size={15} />
                Revoke Control (Esc)
              </button>
            </div>
          </div>

          {/* Clipboard Sync */}
          <div className="wb-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontSize: 14, fontWeight: 600 }}>
              <Clipboard size={15} />
              Clipboard Sync
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                className="wb-input"
                placeholder="Send text to guest clipboard..."
                value={clipboardText}
                onChange={(e) => setClipboardText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSendClipboard();
                }}
              />
              <button type="button" className="wb-btn" onClick={handleSendClipboard}>
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
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  Guest: {receivedClipboard}
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

          <button type="button" className="wb-btn wb-btn-ghost" onClick={onExit}>
            End Host Session
          </button>
        </div>
      </div>
    </main>
  );
}
