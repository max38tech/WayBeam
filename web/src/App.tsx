import { useEffect, useState } from 'react';
import { Header } from './components/Header';
import { LandingView } from './components/LandingView';
import { HostDeck } from './components/HostDeck';
import { ViewerStage } from './components/ViewerStage';
import { normalizeRoomCode } from './lib/firebase';

export type ThemeMode = 'dark' | 'light';
export type RoutePath = '/' | '/host' | '/view';

function parseRoute(): { path: RoutePath; roomParam: string } {
  const rawPath = window.location.pathname.replace(/\/+$/, '') || '/';
  const params = new URLSearchParams(window.location.search);
  const roomParam = normalizeRoomCode(params.get('room') || '');

  if (rawPath === '/host') return { path: '/host', roomParam };
  if (rawPath === '/view') return { path: '/view', roomParam };
  return { path: '/', roomParam };
}

function getInitialTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem('waybeam-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // ignore storage errors
  }
  return 'dark';
}

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [route, setRoute] = useState<{ path: RoutePath; roomParam: string }>(parseRoute);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('waybeam-theme', theme);
    } catch {
      // ignore storage errors
    }
  }, [theme]);

  useEffect(() => {
    const onPopState = () => {
      setRoute(parseRoute());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = (path: RoutePath, roomCode?: string) => {
    const normalized = roomCode ? normalizeRoomCode(roomCode) : '';
    const url = normalized ? `${path}?room=${encodeURIComponent(normalized)}` : path;
    window.history.pushState({}, '', url);
    setRoute({ path, roomParam: normalized });
  };

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  if (route.path === '/view') {
    return (
      <ViewerStage
        roomCode={route.roomParam}
        onDisconnect={() => navigate('/')}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    );
  }

  return (
    <div className="app-shell">
      <Header
        currentPath={route.path}
        theme={theme}
        onToggleTheme={toggleTheme}
        onNavigateHome={() => navigate('/')}
      />
      {route.path === '/host' ? (
        <HostDeck onExit={() => navigate('/')} />
      ) : (
        <LandingView
          initialRoomCode={route.roomParam}
          onJoin={(code) => navigate('/view', code)}
          onHost={() => navigate('/host')}
        />
      )}
    </div>
  );
}
