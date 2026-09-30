import Type, { type Static } from 'typebox';
import {
  Code,
  Detail,
  Instant,
  LocalId,
  PixelSize,
  Sha256Hex,
  SizeBytes,
  Strict,
  Uuid,
  VersionString,
} from './common.js';
import { PlayerCapabilities } from './capabilities.js';
import { CommandResult, SignedCommand } from './command.js';
import { SourceType } from './manifest.js';

export const WS_PROTOCOL_VERSION = 1;

const Nullable = <T extends Type.TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const RendererState = Type.Union([
  Type.Literal('ok'),
  Type.Literal('starting'),
  Type.Literal('degraded'),
  Type.Literal('error'),
  Type.Literal('stopped'),
  Type.Literal('unknown'),
]);

export const PlaybackState = Type.Union([
  Type.Literal('playing'),
  Type.Literal('fallback'),
  Type.Literal('standby'),
  Type.Literal('error'),
  Type.Literal('unknown'),
]);

const DisplayApplied = Type.Object(
  {
    display_id: Uuid,
    assignment_generation: VersionString,
    manifest_applied_version: Nullable(VersionString),
  },
  Strict,
);

/** Corps du heartbeat, identique en WSS et en repli `POST /player/v1/heartbeat` (SUP-002). */
export const HeartbeatPayload = Type.Object(
  {
    uptime_seconds: Type.Integer({ minimum: 0, maximum: 9_007_199_254_740_991 }),
    renderer: RendererState,
    displays: Type.Array(
      Type.Object(
        {
          display_id: Uuid,
          assignment_generation: VersionString,
          manifest_applied_version: Nullable(VersionString),
          playback: PlaybackState,
        },
        Strict,
      ),
      { maxItems: 16 },
    ),
  },
  { ...Strict, title: 'HeartbeatPayload' },
);
export type HeartbeatPayload = Static<typeof HeartbeatPayload>;

/** Mesures : `null` signifie « non disponible », jamais zéro (OBS-003). */
const StatusPayload = Type.Object(
  {
    metrics: Type.Object(
      {
        cpu_percent: Nullable(Type.Number({ minimum: 0, maximum: 100 })),
        memory_used_bytes: Nullable(SizeBytes),
        memory_total_bytes: Nullable(SizeBytes),
        disk_free_bytes: Nullable(SizeBytes),
        disk_total_bytes: Nullable(SizeBytes),
        temperature_c: Nullable(Type.Number({ minimum: -50, maximum: 150 })),
      },
      Strict,
    ),
    cache: Nullable(Type.Object({ required_bytes: SizeBytes, ready_bytes: SizeBytes }, Strict)),
    outputs: Type.Array(
      Type.Object(
        {
          output_key: Type.String({ minLength: 1, maxLength: 128 }),
          /** `null` : la plateforme ne permet pas de le savoir (DSP-005). */
          connected: Nullable(Type.Boolean()),
          width: Nullable(PixelSize),
          height: Nullable(PixelSize),
          refresh_hz: Nullable(Type.Number({ minimum: 1, maximum: 1000 })),
        },
        Strict,
      ),
      { maxItems: 16 },
    ),
  },
  Strict,
);

const ManifestRef = { display_id: Uuid, manifest_id: Uuid, version: VersionString };
const Failure = { reason: Code, detail: Nullable(Detail) };

const PAYLOADS = {
  // Player → Cloud
  HELLO: Type.Object(
    {
      protocol_version: Type.Integer({ minimum: 1, maximum: 1000 }),
      installation_id: Uuid,
      boot_id: Uuid,
      capabilities: PlayerCapabilities,
      displays: Type.Array(DisplayApplied, { maxItems: 16 }),
      pending_events: Type.Integer({ minimum: 0, maximum: 9_007_199_254_740_991 }),
      local_time: Instant,
    },
    Strict,
  ),
  HEARTBEAT: HeartbeatPayload,
  STATUS: StatusPayload,
  MANIFEST_RECEIVED: Type.Object(ManifestRef, Strict),
  MANIFEST_READY: Type.Object(ManifestRef, Strict),
  MANIFEST_APPLIED: Type.Object(ManifestRef, Strict),
  MANIFEST_FAILED: Type.Object({ ...ManifestRef, ...Failure }, Strict),
  ASSET_DOWNLOAD_STARTED: Type.Object({ manifest_id: Uuid, asset_id: Uuid }, Strict),
  ASSET_DOWNLOAD_COMPLETED: Type.Object({ manifest_id: Uuid, asset_id: Uuid }, Strict),
  ASSET_DOWNLOAD_FAILED: Type.Object({ manifest_id: Uuid, asset_id: Uuid, ...Failure }, Strict),
  PLAYBACK_STARTED: Type.Object(
    { display_id: Uuid, content_ref: LocalId, source_type: Nullable(SourceType) },
    Strict,
  ),
  PLAYBACK_ERROR: Type.Object(
    { display_id: Uuid, content_ref: Nullable(LocalId), ...Failure },
    Strict,
  ),
  DISPLAY_CONNECTED: Type.Object(
    { output_key: Type.String({ minLength: 1, maxLength: 128 }) },
    Strict,
  ),
  DISPLAY_DISCONNECTED: Type.Object(
    { output_key: Type.String({ minLength: 1, maxLength: 128 }) },
    Strict,
  ),
  COMMAND_ACK: Type.Object({ command_id: Uuid }, Strict),
  COMMAND_RESULT: CommandResult,
  PONG: Type.Object({}, Strict),
  // Cloud → Player
  WELCOME: Type.Object(
    {
      session_id: Uuid,
      server_time: Instant,
      heartbeat_interval_s: Type.Integer({ minimum: 5, maximum: 600 }),
      presence_timeout_s: Type.Integer({ minimum: 10, maximum: 3600 }),
      supported_protocol_versions: Type.Array(Type.Integer({ minimum: 1, maximum: 1000 }), {
        minItems: 1,
        maxItems: 8,
      }),
      config_revision: VersionString,
    },
    Strict,
  ),
  CONFIG_CHANGED: Type.Object({ config_revision: VersionString }, Strict),
  MANIFEST_AVAILABLE: Type.Object({ ...ManifestRef, manifest_hash: Sha256Hex }, Strict),
  COMMAND: Type.Object({ command: SignedCommand }, Strict),
  UPDATE_AVAILABLE: Type.Object(
    { release_id: Uuid, version: Type.String({ maxLength: 64 }) },
    Strict,
  ),
  UPDATE_REQUIRED: Type.Object(
    { release_id: Uuid, version: Type.String({ maxLength: 64 }) },
    Strict,
  ),
  PING: Type.Object({}, Strict),
  ERROR: Type.Object({ code: Code, message: Detail }, Strict),
} as const;

export type WsMessageType = keyof typeof PAYLOADS;
export const PLAYER_TO_CLOUD: readonly WsMessageType[] = [
  'HELLO',
  'HEARTBEAT',
  'STATUS',
  'MANIFEST_RECEIVED',
  'MANIFEST_READY',
  'MANIFEST_APPLIED',
  'MANIFEST_FAILED',
  'ASSET_DOWNLOAD_STARTED',
  'ASSET_DOWNLOAD_COMPLETED',
  'ASSET_DOWNLOAD_FAILED',
  'PLAYBACK_STARTED',
  'PLAYBACK_ERROR',
  'DISPLAY_CONNECTED',
  'DISPLAY_DISCONNECTED',
  'COMMAND_ACK',
  'COMMAND_RESULT',
  'PONG',
];
export const CLOUD_TO_PLAYER: readonly WsMessageType[] = [
  'WELCOME',
  'CONFIG_CHANGED',
  'MANIFEST_AVAILABLE',
  'COMMAND',
  'UPDATE_AVAILABLE',
  'UPDATE_REQUIRED',
  'PING',
  'ERROR',
];

function message<K extends WsMessageType>(kind: K) {
  return Type.Object(
    {
      type: Type.Literal(kind),
      version: Type.Literal(WS_PROTOCOL_VERSION),
      id: Uuid,
      timestamp: Instant,
      correlation_id: Type.Optional(Uuid),
      payload: PAYLOADS[kind],
    },
    Strict,
  );
}

/** Enveloppe WebSocket (PROTO-005) : un schéma par type de message. */
export const WsMessage = Type.Union(
  (Object.keys(PAYLOADS) as WsMessageType[]).map((kind) => message(kind)),
  { title: 'WsMessage' },
);

type Payloads = typeof PAYLOADS;
export type WsMessage = {
  [K in WsMessageType]: {
    type: K;
    version: typeof WS_PROTOCOL_VERSION;
    id: string;
    timestamp: string;
    correlation_id?: string;
    payload: Static<Payloads[K]>;
  };
}[WsMessageType];
