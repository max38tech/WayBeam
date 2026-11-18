import {
  addHostCandidate,
  addViewerCandidate,
  createRoom,
  deleteRoom,
  getRoom,
  normalizeRoomCode,
  requestViewerReconnect,
  subscribeToRoom,
  updateControlState,
  writeAnswer,
  writeOffer,
  writeTurnIceServers,
} from './firebase';
import type {
  ConnectionMode,
  ControlPacket,
  IceCandidatePayload,
  IceServerConfig,
  LocalAgentStatus,
  QualityPreset,
  RoomDocument,
  TelemetryData,
} from './types';

const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

export const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

const TURN_FALLBACK_TIMEOUT_MS = 4500;
const TELEMETRY_INTERVAL_MS = 1000;
const AGENT_RECONNECT_DELAY_MS = 2500;
const TURN_REQUEST_TIMEOUT_MS = 6000;

export interface LocalAgentClientOptions {
  url?: string;
  token?: string;
  onStatusChange?: (status: LocalAgentStatus) => void;
}

export class LocalAgentClient {
  private url: string;
  private token: string;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private statusListeners = new Set<(status: LocalAgentStatus) => void>();
  private pendingTurnResolvers: Array<{
    resolve: (servers: IceServerConfig[]) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  private status: LocalAgentStatus = {
    connected: false,
    controlEnabled: false,
    uinputReady: false,
  };

  constructor(options: LocalAgentClientOptions = {}) {
    this.url =
      options.url?.trim() ||
      env.VITE_WAYBEAM_AGENT_URL?.trim() ||
      'ws://127.0.0.1:8765';
    this.token =
      options.token?.trim() ??
      env.VITE_WAYBEAM_LOCAL_TOKEN?.trim() ??
      '';
    if (options.onStatusChange) {
      this.statusListeners.add(options.onStatusChange);
    }
  }

  getStatus(): LocalAgentStatus {
    return { ...this.status };
  }

  onStatus(listener: (status: LocalAgentStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private updateStatus(next: Partial<LocalAgentStatus>): void {
    this.status = { ...this.status, ...next };
    const snapshot = this.getStatus();
    for (const listener of this.statusListeners) {
      listener(snapshot);
    }
  }

  connect(): void {
    if (this.destroyed) return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    let targetUrl = this.url;
    if (this.token) {
      const separator = targetUrl.includes('?') ? '&' : '?';
      targetUrl = `${targetUrl}${separator}token=${encodeURIComponent(this.token)}`;
    }

    try {
      const ws = new WebSocket(targetUrl);
      this.ws = ws;

      ws.onopen = () => {
        if (this.token) {
          this.sendRaw({ type: 'auth', token: this.token });
        }
        this.updateStatus({ connected: true, error: undefined });
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (msg.type === 'status') {
            this.updateStatus({
              connected: true,
              controlEnabled: Boolean(msg.controlEnabled),
              uinputReady: Boolean(msg.uinputReady),
              error: typeof msg.error === 'string' ? msg.error : undefined,
            });
          } else if (msg.type === 'turn_credentials') {
            const servers = Array.isArray(msg.iceServers)
              ? (msg.iceServers as IceServerConfig[])
              : [];
            const pending = this.pendingTurnResolvers.splice(0);
            for (const p of pending) {
              clearTimeout(p.timer);
              p.resolve(servers);
            }
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onerror = () => {
        this.updateStatus({
          connected: false,
          error: 'Local agent WebSocket error',
        });
      };

      ws.onclose = () => {
        this.ws = null;
        this.updateStatus({
          connected: false,
          controlEnabled: false,
        });
        if (!this.destroyed) {
          this.scheduleReconnect();
        }
      };
    } catch (err) {
      this.updateStatus({
        connected: false,
        error: err instanceof Error ? err.message : 'Failed to connect to local agent',
      });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, AGENT_RECONNECT_DELAY_MS);
  }

  private sendRaw(payload: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  setControl(enabled: boolean): void {
    this.sendRaw({ type: 'set_control', enabled });
  }

  killSwitch(): void {
    this.sendRaw({ type: 'kill_switch' });
  }

  sendInput(packet: ControlPacket): void {
    this.sendRaw({ type: 'input', event: packet });
  }

  requestTurnCredentials(): Promise<IceServerConfig[]> {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        resolve([]);
        return;
      }

      const timer = setTimeout(() => {
        const idx = this.pendingTurnResolvers.findIndex((p) => p.timer === timer);
        if (idx >= 0) {
          this.pendingTurnResolvers.splice(idx, 1);
        }
        resolve([]);
      }, TURN_REQUEST_TIMEOUT_MS);

      this.pendingTurnResolvers.push({ resolve, reject: () => resolve([]), timer });
      const sent = this.sendRaw({ type: 'get_turn_credentials' });
      if (!sent) {
        clearTimeout(timer);
        this.pendingTurnResolvers.pop();
        resolve([]);
      }
    });
  }

  disconnect(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const p of this.pendingTurnResolvers.splice(0)) {
      clearTimeout(p.timer);
      p.resolve([]);
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
    this.updateStatus({ connected: false, controlEnabled: false });
  }
}

export interface WebRTCManagerOptions {
  role: 'host' | 'viewer';
  roomCode: string;
  localAgent?: LocalAgentClient;
  onRemoteStream?: (stream: MediaStream) => void;
  onTelemetry?: (telemetry: TelemetryData) => void;
  onControlPacket?: (packet: ControlPacket) => void;
  onRoomUpdate?: (room: RoomDocument | null) => void;
  onError?: (err: string) => void;
}

const INPUT_PACKET_TYPES = new Set<ControlPacket['t']>([
  'move',
  'mousedown',
  'mouseup',
  'wheel',
  'keydown',
  'keyup',
  'release_all',
]);

export class WebRTCManager {
  private role: 'host' | 'viewer';
  private roomCode: string;
  private localAgent?: LocalAgentClient;
  private onRemoteStream?: (stream: MediaStream) => void;
  private onTelemetry?: (telemetry: TelemetryData) => void;
  private onControlPacket?: (packet: ControlPacket) => void;
  private onRoomUpdate?: (room: RoomDocument | null) => void;
  private onError?: (err: string) => void;

  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private unsubscribeRoom: (() => void) | null = null;
  private telemetryTimer: ReturnType<typeof setInterval> | null = null;
  private turnFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  private destroyed = false;
  private turnFallbackTriggered = false;
  private turnServersApplied = false;
  private controlGranted = false;
  private currentPreset: QualityPreset = 'balanced';

  private lastOfferUpdatedAt = 0;
  private lastAnswerUpdatedAt = 0;
  private processedRemoteCandidates = 0;
  private pendingRemoteCandidates: IceCandidatePayload[] = [];
  private makingOffer = false;
  private updateQueue: Promise<void> = Promise.resolve();
  private viewerSessionId: string;
  private activeViewerSessionId: string | null = null;

  private prevBytes = 0;
  private prevBytesTimestamp = 0;

  constructor(options: WebRTCManagerOptions) {
    this.role = options.role;
    this.roomCode = normalizeRoomCode(options.roomCode);
    this.localAgent = options.localAgent;
    this.onRemoteStream = options.onRemoteStream;
    this.onTelemetry = options.onTelemetry;
    this.onControlPacket = options.onControlPacket;
    this.onRoomUpdate = options.onRoomUpdate;
    this.onError = options.onError;
    this.viewerSessionId =
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  private enqueueRoomUpdate(fn: () => Promise<void>): void {
    this.updateQueue = this.updateQueue
      .then(async () => {
        if (this.destroyed) return;
        await fn();
      })
      .catch((err) => {
        if (!this.destroyed) {
          this.onError?.(err instanceof Error ? err.message : String(err));
        }
      });
  }

  private createPeerConnection(): RTCPeerConnection | null {
    if (this.destroyed) return null;

    const pc = new RTCPeerConnection({
      iceServers: DEFAULT_STUN_SERVERS,
      iceTransportPolicy: 'all',
    });

    if (this.destroyed) {
      try {
        pc.close();
      } catch {
        // Ignore close errors
      }
      return null;
    }

    pc.onicecandidate = (event) => {
      if (!event.candidate || this.destroyed) return;
      const init = event.candidate.toJSON();
      if (this.role === 'host') {
        void addHostCandidate(this.roomCode, init).catch((err) => {
          this.onError?.(`Failed to send host ICE candidate: ${String(err)}`);
        });
      } else {
        void addViewerCandidate(this.roomCode, init).catch((err) => {
          this.onError?.(`Failed to send viewer ICE candidate: ${String(err)}`);
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (this.destroyed) return;
      const state = pc.iceConnectionState;
      if (state === 'connected' || state === 'completed') {
        this.clearTurnFallbackTimer();
      } else if (state === 'checking') {
        if (this.role === 'host' && !this.turnFallbackTriggered && !this.turnFallbackTimer) {
          this.startTurnFallbackTimer();
        }
      } else if (state === 'failed' || state === 'disconnected') {
        if (this.role === 'host' && !this.turnFallbackTriggered) {
          void this.triggerTurnFallback();
        }
      }
      void this.emitTelemetry();
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        this.clearTurnFallbackTimer();
      } else if (state === 'failed' || state === 'disconnected') {
        if (this.role === 'host' && !this.turnFallbackTriggered) {
          void this.triggerTurnFallback();
        }
      }
      void this.emitTelemetry();
    };

    if (this.role === 'viewer') {
      pc.ontrack = (event) => {
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        this.onRemoteStream?.(stream);
      };

      pc.ondatachannel = (event) => {
        if (event.channel.label === 'waybeam-control') {
          this.attachDataChannel(event.channel);
        }
      };
    }

    this.pc = pc;
    this.startTelemetryPolling();
    return pc;
  }

  private attachDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel;
    channel.onmessage = (event) => {
      try {
        const packet = JSON.parse(String(event.data)) as ControlPacket;
        if (this.role === 'host') {
          if (this.controlGranted && INPUT_PACKET_TYPES.has(packet.t)) {
            this.localAgent?.sendInput(packet);
          }
          if (packet.t === 'request_control') {
            void updateControlState(this.roomCode, { controlRequested: true });
          } else if (packet.t === 'release_control') {
            this.controlGranted = false;
            this.localAgent?.setControl(false);
            void updateControlState(this.roomCode, {
              controlGranted: false,
              controlRequested: false,
            });
          }
        }
        this.onControlPacket?.(packet);
      } catch {
        // Ignore malformed control packet
      }
    };
  }

  async startHost(stream: MediaStream, preset: QualityPreset = 'balanced'): Promise<void> {
    if (this.destroyed) return;
    this.currentPreset = preset;
    await createRoom(this.roomCode, preset);
    if (this.destroyed) return;

    const pc = this.createPeerConnection();
    if (!pc || this.destroyed) return;
    const channel = pc.createDataChannel('waybeam-control', { ordered: true });
    this.attachDataChannel(channel);

    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }

    await this.applyQualityPreset(preset);
    if (this.destroyed) return;

    this.makingOffer = true;
    try {
      const offer = await pc.createOffer();
      if (this.destroyed) return;
      await pc.setLocalDescription(offer);
      if (this.destroyed) return;
      this.lastOfferUpdatedAt = Date.now();
      await writeOffer(this.roomCode, offer);
      if (this.destroyed) return;
    } finally {
      this.makingOffer = false;
    }

    this.unsubscribeRoom = subscribeToRoom(
      this.roomCode,
      (room) => {
        if (this.destroyed) return;
        this.onRoomUpdate?.(room);
        if (!room) return;
        this.enqueueRoomUpdate(() => this.handleHostRoomUpdate(room));
      },
      (err) => {
        if (!this.destroyed) {
          this.onError?.(err.message);
        }
      },
    );
  }

  private async renegotiateOffer(newViewerSessionId?: string): Promise<void> {
    if (this.destroyed || this.makingOffer || this.role !== 'host') return;
    const pc = this.pc;
    if (!pc) return;

    if (newViewerSessionId) {
      this.activeViewerSessionId = newViewerSessionId;
    }
    this.makingOffer = true;
    try {
      const offer = await pc.createOffer({ iceRestart: true });
      if (this.destroyed) return;
      await pc.setLocalDescription(offer);
      if (this.destroyed) return;
      this.lastOfferUpdatedAt = Date.now();
      this.processedRemoteCandidates = 0;
      this.pendingRemoteCandidates = [];
      await writeOffer(this.roomCode, offer);
      if (this.destroyed) return;
    } finally {
      this.makingOffer = false;
    }
  }

  private async handleHostRoomUpdate(room: RoomDocument): Promise<void> {
    if (this.destroyed) return;
    const pc = this.pc;
    if (!pc) return;

    if (room.controlGranted !== this.controlGranted) {
      this.controlGranted = room.controlGranted;
      this.localAgent?.setControl(room.controlGranted);
    }

    if (
      room.viewerSessionId &&
      this.activeViewerSessionId !== null &&
      room.viewerSessionId !== this.activeViewerSessionId &&
      !this.makingOffer
    ) {
      await this.renegotiateOffer(room.viewerSessionId);
      return;
    }

    if (room.answer && room.answer.updatedAt > this.lastAnswerUpdatedAt) {
      if (pc.signalingState !== 'have-local-offer') {
        if (
          room.viewerSessionId &&
          room.viewerSessionId !== this.activeViewerSessionId &&
          !this.makingOffer
        ) {
          await this.renegotiateOffer(room.viewerSessionId);
        }
        return;
      }

      this.lastAnswerUpdatedAt = room.answer.updatedAt;
      if (room.viewerSessionId) {
        this.activeViewerSessionId = room.viewerSessionId;
      }
      try {
        await pc.setRemoteDescription(
          new RTCSessionDescription({ type: room.answer.type, sdp: room.answer.sdp }),
        );
        if (this.destroyed) return;
        await this.flushPendingCandidates();
        if (this.destroyed) return;
        this.startTurnFallbackTimer();
      } catch (err) {
        if (!this.destroyed) {
          this.onError?.(`Failed to apply viewer answer: ${String(err)}`);
        }
      }
    }

    if (this.destroyed) return;
    if (room.viewerCandidates.length < this.processedRemoteCandidates) {
      this.processedRemoteCandidates = 0;
    }
    if (room.viewerCandidates.length > this.processedRemoteCandidates) {
      const fresh = room.viewerCandidates.slice(this.processedRemoteCandidates);
      this.processedRemoteCandidates = room.viewerCandidates.length;
      await this.addRemoteCandidates(fresh);
      if (this.destroyed) return;
    }
  }

  async startViewer(): Promise<void> {
    if (this.destroyed) return;
    const existing = await getRoom(this.roomCode);
    if (this.destroyed) return;
    if (!existing) {
      throw new Error(`Room ${this.roomCode} not found`);
    }

    if (existing.answer !== null) {
      this.lastOfferUpdatedAt = existing.offer?.updatedAt ?? 0;
      await requestViewerReconnect(this.roomCode, this.viewerSessionId);
      if (this.destroyed) return;
    }

    const pc = this.createPeerConnection();
    if (!pc || this.destroyed) return;

    this.unsubscribeRoom = subscribeToRoom(
      this.roomCode,
      (room) => {
        if (this.destroyed) return;
        this.onRoomUpdate?.(room);
        if (!room) return;
        this.enqueueRoomUpdate(() => this.handleViewerRoomUpdate(room));
      },
      (err) => {
        if (!this.destroyed) {
          this.onError?.(err.message);
        }
      },
    );
  }

  private async handleViewerRoomUpdate(room: RoomDocument): Promise<void> {
    if (this.destroyed) return;
    const pc = this.pc;
    if (!pc) return;

    this.controlGranted = room.controlGranted;

    if (room.turnIceServers && room.turnIceServers.length > 0 && !this.turnServersApplied) {
      this.turnServersApplied = true;
      try {
        pc.setConfiguration({
          iceServers: [...DEFAULT_STUN_SERVERS, ...room.turnIceServers],
          iceTransportPolicy: 'all',
        });
      } catch (err) {
        this.onError?.(`Failed to apply TURN configuration: ${String(err)}`);
      }
    }

    if (room.offer && room.offer.updatedAt > this.lastOfferUpdatedAt) {
      this.lastOfferUpdatedAt = room.offer.updatedAt;
      try {
        await pc.setRemoteDescription(
          new RTCSessionDescription({ type: room.offer.type, sdp: room.offer.sdp }),
        );
        if (this.destroyed) return;
        await this.flushPendingCandidates();
        if (this.destroyed) return;
        const answer = await pc.createAnswer();
        if (this.destroyed) return;
        await pc.setLocalDescription(answer);
        if (this.destroyed) return;
        await writeAnswer(this.roomCode, answer, this.viewerSessionId);
        if (this.destroyed) return;
      } catch (err) {
        if (!this.destroyed) {
          this.onError?.(`Failed to process host offer: ${String(err)}`);
        }
      }
    }

    if (this.destroyed) return;
    if (room.hostCandidates.length > this.processedRemoteCandidates) {
      const fresh = room.hostCandidates.slice(this.processedRemoteCandidates);
      this.processedRemoteCandidates = room.hostCandidates.length;
      await this.addRemoteCandidates(fresh);
      if (this.destroyed) return;
    }
  }

  private async addRemoteCandidates(candidates: IceCandidatePayload[]): Promise<void> {
    const pc = this.pc;
    if (!pc) return;

    if (!pc.remoteDescription) {
      this.pendingRemoteCandidates.push(...candidates);
      return;
    }

    for (const c of candidates) {
      if (!c.candidate) continue;
      try {
        await pc.addIceCandidate(new RTCIceCandidate(c));
      } catch {
        // Ignore stale or incompatible candidate
      }
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    if (this.pendingRemoteCandidates.length === 0) return;
    const queued = this.pendingRemoteCandidates.splice(0);
    await this.addRemoteCandidates(queued);
  }

  private startTurnFallbackTimer(): void {
    this.clearTurnFallbackTimer();
    if (this.turnFallbackTriggered || this.role !== 'host') return;
    this.turnFallbackTimer = setTimeout(() => {
      this.turnFallbackTimer = null;
      const state = this.pc?.iceConnectionState;
      if (state !== 'connected' && state !== 'completed') {
        void this.triggerTurnFallback();
      }
    }, TURN_FALLBACK_TIMEOUT_MS);
  }

  private clearTurnFallbackTimer(): void {
    if (this.turnFallbackTimer) {
      clearTimeout(this.turnFallbackTimer);
      this.turnFallbackTimer = null;
    }
  }

  async triggerTurnFallback(): Promise<void> {
    if (this.destroyed || this.turnFallbackTriggered || this.role !== 'host') return;
    const pc = this.pc;
    if (!pc || this.makingOffer) return;

    this.turnFallbackTriggered = true;
    this.clearTurnFallbackTimer();

    try {
      const turnServers = this.localAgent
        ? await this.localAgent.requestTurnCredentials()
        : [];
      if (this.destroyed || turnServers.length === 0) return;

      await writeTurnIceServers(this.roomCode, turnServers);
      if (this.destroyed) return;
      pc.setConfiguration({
        iceServers: [...DEFAULT_STUN_SERVERS, ...turnServers],
        iceTransportPolicy: 'all',
      });

      this.makingOffer = true;
      try {
        const offer = await pc.createOffer({ iceRestart: true });
        if (this.destroyed) return;
        await pc.setLocalDescription(offer);
        if (this.destroyed) return;
        this.lastOfferUpdatedAt = Date.now();
        this.processedRemoteCandidates = 0;
        this.pendingRemoteCandidates = [];
        await writeOffer(this.roomCode, offer);
        if (this.destroyed) return;
      } finally {
        this.makingOffer = false;
      }
    } catch (err) {
      if (!this.destroyed) {
        this.onError?.(`TURN fallback failed: ${String(err)}`);
      }
    }
  }

  async applyQualityPreset(preset: QualityPreset): Promise<void> {
    this.currentPreset = preset;
    const pc = this.pc;
    if (!pc) return;

    const presetMap: Record<
      QualityPreset,
      {
        degradationPreference: RTCDegradationPreference;
        maxBitrate: number;
        maxFramerate: number;
      }
    > = {
      sharp: {
        degradationPreference: 'maintain-resolution',
        maxBitrate: 8_000_000,
        maxFramerate: 60,
      },
      balanced: {
        degradationPreference: 'balanced',
        maxBitrate: 4_500_000,
        maxFramerate: 60,
      },
      low: {
        degradationPreference: 'maintain-framerate',
        maxBitrate: 1_500_000,
        maxFramerate: 30,
      },
    };

    const config = presetMap[preset];
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      try {
        await sender.track.applyConstraints({
          frameRate: { ideal: config.maxFramerate, max: config.maxFramerate },
        });
      } catch {
        // Ignore unsupported track constraints
      }
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.degradationPreference = config.degradationPreference;
        params.encodings[0].maxBitrate = config.maxBitrate;
        params.encodings[0].maxFramerate = config.maxFramerate;
        await sender.setParameters(params);
      } catch {
        // Ignore unsupported RTCRtpSender parameters
      }
    }
  }

  async replaceStream(stream: MediaStream): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    const newVideoTrack = stream.getVideoTracks()[0];
    if (!newVideoTrack) return;

    const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video');
    if (videoSender) {
      await videoSender.replaceTrack(newVideoTrack);
    } else {
      pc.addTrack(newVideoTrack, stream);
    }
    await this.applyQualityPreset(this.currentPreset);
  }

  async setControlGranted(enabled: boolean): Promise<void> {
    this.controlGranted = enabled;
    this.localAgent?.setControl(enabled);
    if (!enabled) {
      this.localAgent?.sendInput({ t: 'release_all' });
    }
    await updateControlState(this.roomCode, {
      controlGranted: enabled,
      controlRequested: false,
    });
    this.sendControlPacket({ t: 'control_state', enabled });
  }

  async requestControl(): Promise<void> {
    await updateControlState(this.roomCode, { controlRequested: true });
    this.sendControlPacket({ t: 'request_control' });
  }

  async releaseControl(): Promise<void> {
    this.sendControlPacket({ t: 'release_all' });
    this.sendControlPacket({ t: 'release_control' });
    await updateControlState(this.roomCode, {
      controlGranted: false,
      controlRequested: false,
    });
  }

  sendClipboard(text: string): void {
    this.sendControlPacket({ t: 'clipboard', text });
  }

  sendControlPacket(packet: ControlPacket): boolean {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      return false;
    }
    try {
      this.dataChannel.send(JSON.stringify(packet));
      return true;
    } catch {
      return false;
    }
  }

  private startTelemetryPolling(): void {
    if (this.telemetryTimer) {
      clearInterval(this.telemetryTimer);
    }
    this.telemetryTimer = setInterval(() => {
      void this.emitTelemetry();
    }, TELEMETRY_INTERVAL_MS);
  }

  private async emitTelemetry(): Promise<void> {
    if (this.destroyed || !this.pc || !this.onTelemetry) return;

    const pc = this.pc;
    const iceState = pc.iceConnectionState;
    let connectionMode: ConnectionMode = 'Connecting';
    if (iceState === 'closed' || iceState === 'failed' || iceState === 'disconnected') {
      connectionMode = 'Disconnected';
    }

    let latencyMs: number | null = null;
    let fps: number | null = null;
    let resolution: string | null = null;
    let bitrateKbps: number | null = null;

    try {
      const stats = await pc.getStats();
      const candidates = new Map<string, Record<string, unknown>>();
      let activePair: Record<string, unknown> | null = null;
      let selectedPairId: string | null = null;

      stats.forEach((report) => {
        const rec = report as unknown as Record<string, unknown>;
        if (report.type === 'transport' && typeof rec.selectedCandidatePairId === 'string') {
          selectedPairId = rec.selectedCandidatePairId;
        }
        if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
          candidates.set(report.id, rec);
        }
        if (report.type === 'candidate-pair') {
          if (rec.nominated === true && rec.state === 'succeeded') {
            activePair = rec;
          } else if (!activePair && rec.state === 'succeeded') {
            activePair = rec;
          }
        }
      });

      if (selectedPairId) {
        const selected = stats.get(selectedPairId) as unknown as Record<string, unknown> | undefined;
        if (selected) activePair = selected;
      }

      if (activePair) {
        const pair = activePair as Record<string, unknown>;
        const localCand =
          typeof pair.localCandidateId === 'string'
            ? candidates.get(pair.localCandidateId)
            : undefined;
        const remoteCand =
          typeof pair.remoteCandidateId === 'string'
            ? candidates.get(pair.remoteCandidateId)
            : undefined;

        const isRelay =
          localCand?.candidateType === 'relay' || remoteCand?.candidateType === 'relay';
        if (iceState === 'connected' || iceState === 'completed') {
          connectionMode = isRelay ? 'Relayed (Cloudflare TURN)' : 'P2P Direct (STUN)';
        }

        if (typeof pair.currentRoundTripTime === 'number') {
          latencyMs = Math.round(pair.currentRoundTripTime * 1000);
        }
      }

      const targetType = this.role === 'host' ? 'outbound-rtp' : 'inbound-rtp';
      stats.forEach((report) => {
        if (report.type !== targetType) return;
        const rec = report as unknown as Record<string, unknown>;
        if (rec.kind !== 'video') return;

        if (typeof rec.framesPerSecond === 'number') {
          fps = Math.round(rec.framesPerSecond);
        }
        if (typeof rec.frameWidth === 'number' && typeof rec.frameHeight === 'number') {
          resolution = `${rec.frameWidth}x${rec.frameHeight}`;
        }

        const bytesField = this.role === 'host' ? 'bytesSent' : 'bytesReceived';
        const totalBytes = rec[bytesField];
        if (typeof totalBytes === 'number') {
          if (this.prevBytesTimestamp > 0 && report.timestamp > this.prevBytesTimestamp) {
            const deltaBytes = Math.max(0, totalBytes - this.prevBytes);
            const deltaMs = report.timestamp - this.prevBytesTimestamp;
            bitrateKbps = Math.round((deltaBytes * 8) / deltaMs);
          }
          this.prevBytes = totalBytes;
          this.prevBytesTimestamp = report.timestamp;
        }
      });
    } catch {
      // Ignore transient getStats failures
    }

    const viewerConnected = iceState === 'connected' || iceState === 'completed';

    this.onTelemetry({
      connectionMode,
      iceState,
      latencyMs,
      fps,
      resolution,
      bitrateKbps,
      viewerConnected,
    });
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    this.clearTurnFallbackTimer();
    if (this.telemetryTimer) {
      clearInterval(this.telemetryTimer);
      this.telemetryTimer = null;
    }
    if (this.unsubscribeRoom) {
      this.unsubscribeRoom();
      this.unsubscribeRoom = null;
    }
    if (this.role === 'host') {
      this.localAgent?.setControl(false);
      this.localAgent?.sendInput({ t: 'release_all' });
      try {
        await deleteRoom(this.roomCode);
      } catch {
        // Ignore cleanup errors
      }
    }
    if (this.dataChannel) {
      try {
        this.dataChannel.close();
      } catch {
        // Ignore close errors
      }
      this.dataChannel = null;
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        // Ignore close errors
      }
      this.pc = null;
    }
  }
}
