export type ConnectionMode =
  | 'Connecting'
  | 'P2P Direct (STUN)'
  | 'Relayed (Cloudflare TURN)'
  | 'Disconnected';

export type QualityPreset = 'sharp' | 'balanced' | 'low';

export interface TelemetryData {
  connectionMode: ConnectionMode;
  iceState: RTCIceConnectionState | 'new';
  latencyMs: number | null;
  fps: number | null;
  resolution: string | null;
  bitrateKbps: number | null;
  viewerConnected: boolean;
}

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface SessionDescriptionPayload {
  type: 'offer' | 'answer';
  sdp: string;
  updatedAt: number;
}

export interface IceCandidatePayload {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string | null;
}

export interface RoomDocument {
  roomCode: string;
  offer: SessionDescriptionPayload | null;
  answer: SessionDescriptionPayload | null;
  hostCandidates: IceCandidatePayload[];
  viewerCandidates: IceCandidatePayload[];
  turnIceServers: IceServerConfig[] | null;
  controlGranted: boolean;
  controlRequested: boolean;
  qualityPreset: QualityPreset;
  createdAt: number;
  updatedAt: number;
}

export type ControlPacket =
  | { t: 'move'; x: number; y: number }
  | { t: 'mousedown'; button: 0 | 1 | 2; x: number; y: number }
  | { t: 'mouseup'; button: 0 | 1 | 2; x: number; y: number }
  | { t: 'wheel'; dx: number; dy: number }
  | { t: 'keydown'; code: string; key?: string }
  | { t: 'keyup'; code: string; key?: string }
  | { t: 'request_control' }
  | { t: 'release_control' }
  | { t: 'control_state'; enabled: boolean }
  | { t: 'clipboard'; text: string }
  | { t: 'release_all' };

export interface LocalAgentStatus {
  connected: boolean;
  controlEnabled: boolean;
  uinputReady: boolean;
  error?: string;
}
