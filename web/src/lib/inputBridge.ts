import type { ControlPacket } from './types';

export interface AttachInputBridgeOptions {
  videoElement: HTMLVideoElement;
  containerElement?: HTMLElement;
  isControlActive: () => boolean;
  sendPacket: (packet: ControlPacket) => void;
}

interface NormalizedPoint {
  x: number;
  y: number;
}

function getNormalizedVideoCoords(
  videoElement: HTMLVideoElement,
  clientX: number,
  clientY: number,
): NormalizedPoint | null {
  const rect = videoElement.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const vw = videoElement.videoWidth;
  const vh = videoElement.videoHeight;
  if (vw <= 0 || vh <= 0) return null;

  const elementAspect = rect.width / rect.height;
  const videoAspect = vw / vh;

  let renderWidth: number;
  let renderHeight: number;
  let offsetX: number;
  let offsetY: number;

  if (videoAspect > elementAspect) {
    // Letterboxed top and bottom
    renderWidth = rect.width;
    renderHeight = rect.width / videoAspect;
    offsetX = rect.left;
    offsetY = rect.top + (rect.height - renderHeight) / 2;
  } else {
    // Pillarboxed left and right
    renderHeight = rect.height;
    renderWidth = rect.height * videoAspect;
    offsetX = rect.left + (rect.width - renderWidth) / 2;
    offsetY = rect.top;
  }

  const x = (clientX - offsetX) / renderWidth;
  const y = (clientY - offsetY) / renderHeight;

  if (x < 0 || x > 1 || y < 0 || y > 1) {
    return null;
  }

  return { x, y };
}

function toMouseButton(button: number): 0 | 1 | 2 | null {
  if (button === 0 || button === 1 || button === 2) {
    return button;
  }
  return null;
}

export function attachInputBridge(options: AttachInputBridgeOptions): () => void {
  const { videoElement, containerElement, isControlActive, sendPacket } = options;
  const target: HTMLElement = containerElement ?? videoElement;

  let rafId: number | null = null;
  let pendingMove: NormalizedPoint | null = null;
  let wasActive = isControlActive();

  const flushMove = () => {
    rafId = null;
    if (!isControlActive()) {
      if (wasActive) {
        wasActive = false;
        sendPacket({ t: 'release_all' });
      }
      pendingMove = null;
      return;
    }
    wasActive = true;
    if (pendingMove) {
      sendPacket({ t: 'move', x: pendingMove.x, y: pendingMove.y });
      pendingMove = null;
    }
  };

  const checkActiveOrRelease = (): boolean => {
    const active = isControlActive();
    if (!active) {
      if (wasActive) {
        wasActive = false;
        sendPacket({ t: 'release_all' });
      }
      return false;
    }
    wasActive = true;
    return true;
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!checkActiveOrRelease()) return;
    const coords = getNormalizedVideoCoords(videoElement, e.clientX, e.clientY);
    if (!coords) return;

    pendingMove = coords;
    if (rafId === null) {
      rafId = requestAnimationFrame(flushMove);
    }
  };

  const onMouseDown = (e: MouseEvent) => {
    if (!checkActiveOrRelease()) return;
    const coords = getNormalizedVideoCoords(videoElement, e.clientX, e.clientY);
    if (!coords) return;

    const button = toMouseButton(e.button);
    if (button === null) return;

    e.preventDefault();
    sendPacket({ t: 'mousedown', button, x: coords.x, y: coords.y });
  };

  const onMouseUp = (e: MouseEvent) => {
    if (!checkActiveOrRelease()) return;
    const coords = getNormalizedVideoCoords(videoElement, e.clientX, e.clientY);
    if (!coords) return;

    const button = toMouseButton(e.button);
    if (button === null) return;

    e.preventDefault();
    sendPacket({ t: 'mouseup', button, x: coords.x, y: coords.y });
  };

  const onContextMenu = (e: MouseEvent) => {
    if (!checkActiveOrRelease()) return;
    const coords = getNormalizedVideoCoords(videoElement, e.clientX, e.clientY);
    if (!coords) return;
    e.preventDefault();
  };

  const onWheel = (e: WheelEvent) => {
    if (!checkActiveOrRelease()) return;
    const coords = getNormalizedVideoCoords(videoElement, e.clientX, e.clientY);
    if (!coords) return;

    e.preventDefault();
    sendPacket({ t: 'wheel', dx: e.deltaX, dy: e.deltaY });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!checkActiveOrRelease()) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    sendPacket({ t: 'keydown', code: e.code, key: e.key });
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (!checkActiveOrRelease()) return;
    e.preventDefault();
    e.stopPropagation();
    sendPacket({ t: 'keyup', code: e.code, key: e.key });
  };

  const onBlur = () => {
    if (isControlActive() || wasActive) {
      wasActive = false;
      sendPacket({ t: 'release_all' });
    }
  };

  const onVisibilityChange = () => {
    if (document.hidden && (isControlActive() || wasActive)) {
      wasActive = false;
      sendPacket({ t: 'release_all' });
    }
  };

  target.addEventListener('mousemove', onMouseMove);
  target.addEventListener('mousedown', onMouseDown);
  target.addEventListener('mouseup', onMouseUp);
  target.addEventListener('contextmenu', onContextMenu);
  target.addEventListener('wheel', onWheel, { passive: false });

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    target.removeEventListener('mousemove', onMouseMove);
    target.removeEventListener('mousedown', onMouseDown);
    target.removeEventListener('mouseup', onMouseUp);
    target.removeEventListener('contextmenu', onContextMenu);
    target.removeEventListener('wheel', onWheel);

    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onVisibilityChange);

    if (wasActive || isControlActive()) {
      sendPacket({ t: 'release_all' });
    }
  };
}
