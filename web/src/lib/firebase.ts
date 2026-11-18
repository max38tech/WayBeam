import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  arrayUnion,
  type Firestore,
} from 'firebase/firestore';
import type {
  IceCandidatePayload,
  IceServerConfig,
  QualityPreset,
  RoomDocument,
  SessionDescriptionPayload,
} from './types';

const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY?.trim() ?? '',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN?.trim() ?? '',
  projectId: env.VITE_FIREBASE_PROJECT_ID?.trim() ?? '',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET?.trim() ?? '',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID?.trim() ?? '',
  appId: env.VITE_FIREBASE_APP_ID?.trim() ?? '',
};

export function isFirebaseConfigured(): boolean {
  return Boolean(firebaseConfig.projectId && firebaseConfig.apiKey);
}

let cachedApp: FirebaseApp | null = null;
let cachedDb: Firestore | null = null;

function getDb(): Firestore {
  if (!cachedDb) {
    if (!cachedApp) {
      cachedApp = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
    }
    cachedDb = getFirestore(cachedApp);
  }
  return cachedDb;
}

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomCode(): string {
  let suffix = '';
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = new Uint8Array(4);
    cryptoObj.getRandomValues(bytes);
    for (let i = 0; i < 4; i++) {
      suffix += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
    }
  } else {
    for (let i = 0; i < 4; i++) {
      suffix += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
    }
  }
  return `WB${suffix}`;
}

export function normalizeRoomCode(raw: string): string {
  return raw.replace(/[\s-]+/g, '').toUpperCase();
}

export function formatRoomCode(code: string): string {
  const norm = normalizeRoomCode(code);
  if (norm.length === 6) {
    return `${norm.slice(0, 2)}-${norm.slice(2)}`;
  }
  return norm;
}

// ---------------------------------------------------------------------------
// Local in-memory / BroadcastChannel / localStorage fallback when Firebase
// is not configured in .env (enables instant same-browser multi-tab testing).
// ---------------------------------------------------------------------------

const LOCAL_STORAGE_PREFIX = 'waybeam_room_';
const localMemoryRooms = new Map<string, RoomDocument>();
const localSubscribers = new Map<string, Set<(room: RoomDocument | null) => void>>();
let broadcastChannel: BroadcastChannel | null = null;

function getBroadcastChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!broadcastChannel) {
    broadcastChannel = new BroadcastChannel('waybeam-signaling');
    broadcastChannel.onmessage = (event: MessageEvent<{ roomCode: string; room: RoomDocument | null }>) => {
      const { roomCode, room } = event.data ?? {};
      if (!roomCode) return;
      if (room) {
        localMemoryRooms.set(roomCode, room);
      } else {
        localMemoryRooms.delete(roomCode);
      }
      notifyLocalSubscribers(roomCode, room);
    };
  }
  return broadcastChannel;
}

function readLocalRoom(roomCode: string): RoomDocument | null {
  const mem = localMemoryRooms.get(roomCode);
  if (mem) return mem;
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(`${LOCAL_STORAGE_PREFIX}${roomCode}`);
      if (raw) {
        const parsed = JSON.parse(raw) as RoomDocument;
        localMemoryRooms.set(roomCode, parsed);
        return parsed;
      }
    } catch {
      // Ignore storage errors
    }
  }
  return null;
}

function writeLocalRoom(roomCode: string, room: RoomDocument | null): void {
  if (room) {
    localMemoryRooms.set(roomCode, room);
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(`${LOCAL_STORAGE_PREFIX}${roomCode}`, JSON.stringify(room));
      } catch {
        // Ignore storage errors
      }
    }
  } else {
    localMemoryRooms.delete(roomCode);
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(`${LOCAL_STORAGE_PREFIX}${roomCode}`);
      } catch {
        // Ignore storage errors
      }
    }
  }
  notifyLocalSubscribers(roomCode, room);
  try {
    getBroadcastChannel()?.postMessage({ roomCode, room });
  } catch {
    // Ignore channel errors
  }
}

function notifyLocalSubscribers(roomCode: string, room: RoomDocument | null): void {
  const subs = localSubscribers.get(roomCode);
  if (!subs) return;
  const snapshot = room ? (JSON.parse(JSON.stringify(room)) as RoomDocument) : null;
  for (const cb of subs) {
    cb(snapshot);
  }
}

// ---------------------------------------------------------------------------
// Serialization helpers (Firestore rejects undefined values)
// ---------------------------------------------------------------------------

function serializeCandidate(candidate: RTCIceCandidateInit): IceCandidatePayload {
  return {
    candidate: candidate.candidate ?? '',
    sdpMid: candidate.sdpMid ?? null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    usernameFragment: candidate.usernameFragment ?? null,
  };
}

function serializeDescription(
  desc: RTCSessionDescriptionInit,
  fallbackType: 'offer' | 'answer',
): SessionDescriptionPayload {
  return {
    type: (desc.type as 'offer' | 'answer') ?? fallbackType,
    sdp: desc.sdp ?? '',
    updatedAt: Date.now(),
  };
}

function serializeIceServers(servers: IceServerConfig[]): IceServerConfig[] {
  return servers.map((s) => {
    const out: IceServerConfig = { urls: s.urls };
    if (s.username !== undefined) out.username = s.username;
    if (s.credential !== undefined) out.credential = s.credential;
    return out;
  });
}

// ---------------------------------------------------------------------------
// Public Signaling API
// ---------------------------------------------------------------------------

export async function createRoom(
  roomCode: string,
  qualityPreset: QualityPreset = 'balanced',
): Promise<void> {
  const code = normalizeRoomCode(roomCode);
  const now = Date.now();
  const roomDoc: RoomDocument = {
    roomCode: code,
    offer: null,
    answer: null,
    viewerSessionId: null,
    hostCandidates: [],
    viewerCandidates: [],
    turnIceServers: null,
    controlGranted: false,
    controlRequested: false,
    qualityPreset,
    createdAt: now,
    updatedAt: now,
  };

  if (!isFirebaseConfigured()) {
    writeLocalRoom(code, roomDoc);
    return;
  }

  const db = getDb();
  await setDoc(doc(db, 'rooms', code), roomDoc);
}

export async function getRoom(roomCode: string): Promise<RoomDocument | null> {
  const code = normalizeRoomCode(roomCode);
  if (!isFirebaseConfigured()) {
    return readLocalRoom(code);
  }

  const db = getDb();
  const snap = await getDoc(doc(db, 'rooms', code));
  if (!snap.exists()) return null;
  return snap.data() as RoomDocument;
}

export function subscribeToRoom(
  roomCode: string,
  onUpdate: (room: RoomDocument | null) => void,
  onError?: (err: Error) => void,
): () => void {
  const code = normalizeRoomCode(roomCode);

  if (!isFirebaseConfigured()) {
    getBroadcastChannel();
    let subs = localSubscribers.get(code);
    if (!subs) {
      subs = new Set();
      localSubscribers.set(code, subs);
    }
    subs.add(onUpdate);

    // Emit initial state asynchronously to mirror Firestore onSnapshot
    const timer = setTimeout(() => {
      onUpdate(readLocalRoom(code));
    }, 0);

    const onStorage = (e: StorageEvent) => {
      if (e.key === `${LOCAL_STORAGE_PREFIX}${code}`) {
        const next = e.newValue ? (JSON.parse(e.newValue) as RoomDocument) : null;
        if (next) {
          localMemoryRooms.set(code, next);
        } else {
          localMemoryRooms.delete(code);
        }
        onUpdate(next);
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', onStorage);
    }

    return () => {
      clearTimeout(timer);
      subs?.delete(onUpdate);
      if (subs && subs.size === 0) {
        localSubscribers.delete(code);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('storage', onStorage);
      }
    };
  }

  const db = getDb();
  return onSnapshot(
    doc(db, 'rooms', code),
    (snap) => {
      onUpdate(snap.exists() ? (snap.data() as RoomDocument) : null);
    },
    (err) => {
      onError?.(err);
    },
  );
}

export async function writeOffer(
  roomCode: string,
  offer: RTCSessionDescriptionInit,
): Promise<void> {
  const code = normalizeRoomCode(roomCode);
  const payload = serializeDescription(offer, 'offer');

  if (!isFirebaseConfigured()) {
    const existing = readLocalRoom(code);
    if (!existing) return;
    writeLocalRoom(code, {
      ...existing,
      offer: payload,
      answer: null,
      viewerCandidates: [],
      updatedAt: Date.now(),
    });
    return;
  }

  const db = getDb();
  await updateDoc(doc(db, 'rooms', code), {
    offer: payload,
    answer: null,
    viewerCandidates: [],
    updatedAt: Date.now(),
  });
}

export async function writeAnswer(
  roomCode: string,
  answer: RTCSessionDescriptionInit,
  viewerSessionId?: string,
): Promise<void> {
  const code = normalizeRoomCode(roomCode);
  const payload = serializeDescription(answer, 'answer');

  if (!isFirebaseConfigured()) {
    const existing = readLocalRoom(code);
    if (!existing) return;
    writeLocalRoom(code, {
      ...existing,
      answer: payload,
      ...(viewerSessionId !== undefined ? { viewerSessionId } : {}),
      updatedAt: Date.now(),
    });
    return;
  }

  const db = getDb();
  const update: Record<string, unknown> = {
    answer: payload,
    updatedAt: Date.now(),
  };
  if (viewerSessionId !== undefined) {
    update.viewerSessionId = viewerSessionId;
  }
  await updateDoc(doc(db, 'rooms', code), update);
}

export async function requestViewerReconnect(
  roomCode: string,
  viewerSessionId: string,
): Promise<void> {
  const code = normalizeRoomCode(roomCode);

  if (!isFirebaseConfigured()) {
    const existing = readLocalRoom(code);
    if (!existing) return;
    writeLocalRoom(code, {
      ...existing,
      viewerSessionId,
      updatedAt: Date.now(),
    });
    return;
  }

  const db = getDb();
  await updateDoc(doc(db, 'rooms', code), {
    viewerSessionId,
    updatedAt: Date.now(),
  });
}

export async function addHostCandidate(
  roomCode: string,
  candidate: RTCIceCandidateInit,
): Promise<void> {
  const code = normalizeRoomCode(roomCode);
  const payload = serializeCandidate(candidate);

  if (!isFirebaseConfigured()) {
    const existing = readLocalRoom(code);
    if (!existing) return;
    writeLocalRoom(code, {
      ...existing,
      hostCandidates: [...existing.hostCandidates, payload],
      updatedAt: Date.now(),
    });
    return;
  }

  const db = getDb();
  await updateDoc(doc(db, 'rooms', code), {
    hostCandidates: arrayUnion(payload),
    updatedAt: Date.now(),
  });
}

export async function addViewerCandidate(
  roomCode: string,
  candidate: RTCIceCandidateInit,
): Promise<void> {
  const code = normalizeRoomCode(roomCode);
  const payload = serializeCandidate(candidate);

  if (!isFirebaseConfigured()) {
    const existing = readLocalRoom(code);
    if (!existing) return;
    writeLocalRoom(code, {
      ...existing,
      viewerCandidates: [...existing.viewerCandidates, payload],
      updatedAt: Date.now(),
    });
    return;
  }

  const db = getDb();
  await updateDoc(doc(db, 'rooms', code), {
    viewerCandidates: arrayUnion(payload),
    updatedAt: Date.now(),
  });
}

export async function writeTurnIceServers(
  roomCode: string,
  iceServers: IceServerConfig[],
): Promise<void> {
  const code = normalizeRoomCode(roomCode);
  const payload = serializeIceServers(iceServers);

  if (!isFirebaseConfigured()) {
    const existing = readLocalRoom(code);
    if (!existing) return;
    writeLocalRoom(code, {
      ...existing,
      turnIceServers: payload,
      updatedAt: Date.now(),
    });
    return;
  }

  const db = getDb();
  await updateDoc(doc(db, 'rooms', code), {
    turnIceServers: payload,
    updatedAt: Date.now(),
  });
}

export async function updateControlState(
  roomCode: string,
  patch: { controlGranted?: boolean; controlRequested?: boolean },
): Promise<void> {
  const code = normalizeRoomCode(roomCode);
  const update: Record<string, unknown> = { updatedAt: Date.now() };
  if (patch.controlGranted !== undefined) update.controlGranted = patch.controlGranted;
  if (patch.controlRequested !== undefined) update.controlRequested = patch.controlRequested;

  if (!isFirebaseConfigured()) {
    const existing = readLocalRoom(code);
    if (!existing) return;
    writeLocalRoom(code, {
      ...existing,
      ...(patch.controlGranted !== undefined ? { controlGranted: patch.controlGranted } : {}),
      ...(patch.controlRequested !== undefined ? { controlRequested: patch.controlRequested } : {}),
      updatedAt: Date.now(),
    });
    return;
  }

  const db = getDb();
  await updateDoc(doc(db, 'rooms', code), update);
}

export async function deleteRoom(roomCode: string): Promise<void> {
  const code = normalizeRoomCode(roomCode);

  if (!isFirebaseConfigured()) {
    writeLocalRoom(code, null);
    return;
  }

  const db = getDb();
  await deleteDoc(doc(db, 'rooms', code));
}
