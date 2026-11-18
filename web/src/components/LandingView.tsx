import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, MonitorUp, ShieldCheck, Sparkles, Terminal } from 'lucide-react';
import { formatRoomCode, normalizeRoomCode } from '../lib/firebase';

interface LandingViewProps {
  initialRoomCode?: string;
  onJoin: (roomCode: string) => void;
  onHost: () => void;
}

export function LandingView({ initialRoomCode = '', onJoin, onHost }: LandingViewProps) {
  const [codeInput, setCodeInput] = useState(() =>
    initialRoomCode ? formatRoomCode(initialRoomCode) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initialRoomCode) {
      setCodeInput(formatRoomCode(initialRoomCode));
    }
  }, [initialRoomCode]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const normalized = normalizeRoomCode(codeInput);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (normalized.length !== 6) {
      setError('Enter a valid 6-character room code (e.g. WB-8492).');
      inputRef.current?.focus();
      return;
    }
    setError(null);
    onJoin(normalized);
  };

  const handleCodeChange = (val: string) => {
    setError(null);
    const cleaned = normalizeRoomCode(val).slice(0, 6);
    if (cleaned.length > 2) {
      setCodeInput(`${cleaned.slice(0, 2)}-${cleaned.slice(2)}`);
    } else {
      setCodeInput(cleaned);
    }
  };

  return (
    <main className="wb-container">
      <section className="wb-hero">
        <span className="wb-badge wb-badge-indigo">
          <Sparkles size={13} />
          Zero-Install Wayland Screen Share &amp; Control
        </span>
        <h1>
          Stream your Hyprland desktop.
          <br />
          Control it from any browser.
        </h1>
        <p>
          Low-latency 60 FPS WebRTC screen sharing from Omarchy / Wayland with automatic
          Cloudflare TURN fallback and kernel-level <code className="mono">/dev/uinput</code>{' '}
          remote control.
        </p>
      </section>

      <section className="wb-role-grid">
        {/* Primary Guest / Viewer Card */}
        <div className="wb-card wb-card-highlight">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <span className="wb-badge wb-badge-cyan">Windows / Browser Guest</span>
            <ShieldCheck size={18} style={{ color: 'var(--accent-cyan)' }} />
          </div>
          <h2 style={{ margin: '0 0 8px', fontSize: 20, fontWeight: 600 }}>Join a Session</h2>
          <p style={{ margin: '0 0 20px', fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            Enter the 6-character room code shared by the Linux host to view the stream and
            optionally request mouse &amp; keyboard control.
          </p>

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <input
                ref={inputRef}
                type="text"
                className="wb-code-input"
                placeholder="WB-8492"
                value={codeInput}
                onChange={(e) => handleCodeChange(e.target.value)}
                aria-label="6-character room code"
                autoComplete="off"
                spellCheck={false}
              />
              {error && (
                <div style={{ color: 'var(--accent-red)', fontSize: 12.5, marginTop: 8 }}>
                  {error}
                </div>
              )}
            </div>

            <button
              type="submit"
              className="wb-btn wb-btn-primary"
              style={{ width: '100%', padding: '12px 18px', fontSize: 14.5 }}
            >
              Connect to Stream
              <ArrowRight size={16} />
            </button>
          </form>
        </div>

        {/* Host Card */}
        <div className="wb-card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <span className="wb-badge wb-badge-indigo">Linux / Omarchy Host</span>
              <MonitorUp size={18} style={{ color: 'var(--accent-indigo)' }} />
            </div>
            <h2 style={{ margin: '0 0 8px', fontSize: 20, fontWeight: 600 }}>Host Screen</h2>
            <p style={{ margin: '0 0 6px', fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Share a Hyprland monitor or workspace directly via PipeWire and grant explicit
              per-session remote control.
            </p>

            <ul className="wb-checklist">
              <li>
                <CheckCircle2 size={16} style={{ color: 'var(--accent-emerald)', flexShrink: 0 }} />
                <span>60 FPS PipeWire / Hyprland capture</span>
              </li>
              <li>
                <CheckCircle2 size={16} style={{ color: 'var(--accent-cyan)', flexShrink: 0 }} />
                <span>STUN-first with 4.5s Cloudflare TURN auto-fallback</span>
              </li>
              <li>
                <CheckCircle2 size={16} style={{ color: 'var(--accent-indigo)', flexShrink: 0 }} />
                <span>
                  <code className="mono">/dev/uinput</code> low-latency control + instant{' '}
                  <code className="mono">Esc</code> kill-switch
                </span>
              </li>
            </ul>
          </div>

          <div>
            <button
              type="button"
              className="wb-btn"
              onClick={onHost}
              style={{ width: '100%', padding: '12px 18px', fontSize: 14.5 }}
            >
              <Terminal size={16} />
              Launch Host Deck
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
