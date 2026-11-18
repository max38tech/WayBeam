import { ArrowLeft, Monitor, Moon, Sun, Wifi } from 'lucide-react';
import { isFirebaseConfigured } from '../lib/firebase';
import type { RoutePath, ThemeMode } from '../App';

interface HeaderProps {
  currentPath: RoutePath;
  theme: ThemeMode;
  onToggleTheme: () => void;
  onNavigateHome: () => void;
}

export function Header({ currentPath, theme, onToggleTheme, onNavigateHome }: HeaderProps) {
  const firebaseReady = isFirebaseConfigured();

  return (
    <header className="wb-header">
      <div className="wb-header-left">
        <button
          type="button"
          className="wb-brand"
          onClick={onNavigateHome}
          aria-label="WayBeam Home"
        >
          <span className="wb-logo-mark">
            <Monitor size={17} strokeWidth={2.2} />
          </span>
          <span>WayBeam</span>
        </button>

        <span className="wb-badge" style={{ display: 'inline-flex' }}>
          Omarchy · Hyprland · WebRTC
        </span>

        {!firebaseReady && (
          <span
            className="wb-badge wb-badge-amber"
            title="VITE_FIREBASE_* env vars not set; using local BroadcastChannel demo signaling"
          >
            <Wifi size={12} />
            Local Demo Mode
          </span>
        )}
      </div>

      <div className="wb-header-right">
        {currentPath !== '/' && (
          <button
            type="button"
            className="wb-btn wb-btn-ghost"
            onClick={onNavigateHome}
          >
            <ArrowLeft size={15} />
            Home
          </button>
        )}

        <button
          type="button"
          className="wb-btn wb-btn-icon"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </div>
    </header>
  );
}
