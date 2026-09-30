import Type, { type Static } from 'typebox';
import {
  Instant,
  Orientation,
  PixelSize,
  Sha256Hex,
  Strict,
  Timezone,
  Uuid,
  VersionString,
} from './common.js';
import { PlayerCapabilities } from './capabilities.js';

/**
 * Contrats de l’API Player `/player/v1` (PROTO-001 à PROTO-004, SEC-005 à SEC-007).
 * Le Player génère une paire Ed25519 ; la clé privée ne quitte jamais l’appareil.
 */

/** Clé publique Ed25519 brute (32 octets) en base64url sans remplissage. */
export const PublicKeyB64u = Type.String({ pattern: '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$' });
/** Signature Ed25519 (64 octets) en base64url sans remplissage. */
export const SignatureB64uStrict = Type.String({ pattern: '^[A-Za-z0-9_-]{85}[AQgw]$' });
/** Secret opaque de 256 bits en base64url (suivi d’appairage, jeton d’accès). */
export const OpaqueSecret = Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' });
/** Code lisible `XXXX-XXXX`, alphabet sans caractères ambigus (0/O, 1/I/L). */
export const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const PairingCode = Type.String({ pattern: '^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$' });

export const OutputReport = Type.Object(
  {
    output_key: Type.String({ minLength: 1, maxLength: 128 }),
    connector_type: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
    width: Type.Union([PixelSize, Type.Null()]),
    height: Type.Union([PixelSize, Type.Null()]),
    refresh_hz: Type.Union([Type.Number({ minimum: 1, maximum: 1000 }), Type.Null()]),
    /** `null` : la plateforme ne permet pas de le savoir (DSP-005). */
    connected: Type.Union([Type.Boolean(), Type.Null()]),
  },
  Strict,
);
export type OutputReport = Static<typeof OutputReport>;

export const PlayerRegisterRequest = Type.Object(
  {
    installation_id: Uuid,
    public_key: PublicKeyB64u,
    capabilities: PlayerCapabilities,
    outputs: Type.Array(OutputReport, { minItems: 1, maxItems: 16 }),
    /** Empreinte pseudonymisée de la machine (SHA-256) ; indice de rapprochement, jamais une preuve. */
    machine_fingerprint: Type.Union([Sha256Hex, Type.Null()]),
  },
  Strict,
);
export type PlayerRegisterRequest = Static<typeof PlayerRegisterRequest>;

export const PlayerRegisterResponse = Type.Object(
  {
    registration_id: Uuid,
    pairing_code: PairingCode,
    expires_at: Instant,
    /** Secret de suivi : seul le Player qui l’a reçu peut récupérer l’association. */
    poll_secret: OpaqueSecret,
    poll_interval_s: Type.Integer({ minimum: 1, maximum: 60 }),
  },
  Strict,
);
export type PlayerRegisterResponse = Static<typeof PlayerRegisterResponse>;

export const PlayerPairRequest = Type.Object(
  { registration_id: Uuid, poll_secret: OpaqueSecret },
  Strict,
);
export type PlayerPairRequest = Static<typeof PlayerPairRequest>;

export const PlayerPairResponse = Type.Union([
  Type.Object({ status: Type.Literal('pending'), expires_at: Instant }, Strict),
  Type.Object({ status: Type.Literal('paired'), player_id: Uuid, organization_id: Uuid }, Strict),
]);
export type PlayerPairResponse = Static<typeof PlayerPairResponse>;

export const PLAYER_AUTH_TYPE = 'PIXLOVA_PLAYER_AUTH_V1';
export const PLAYER_AUTH_AUDIENCE = 'pixlova-player-api';

/** Challenge à usage unique signé par la clé de l’appareil (PROTO-002). */
export const PlayerAuthChallenge = Type.Object(
  {
    type: Type.Literal(PLAYER_AUTH_TYPE),
    audience: Type.Literal(PLAYER_AUTH_AUDIENCE),
    challenge_id: Uuid,
    nonce: OpaqueSecret,
    player_id: Uuid,
    installation_id: Uuid,
    issued_at: Instant,
    expires_at: Instant,
  },
  Strict,
);
export type PlayerAuthChallenge = Static<typeof PlayerAuthChallenge>;

export const PlayerChallengeRequest = Type.Object({ player_id: Uuid }, Strict);
export const PlayerChallengeResponse = Type.Object({ challenge: PlayerAuthChallenge }, Strict);
export const PlayerTokenRequest = Type.Object(
  { challenge_id: Uuid, signature: SignatureB64uStrict },
  Strict,
);
export type PlayerTokenRequest = Static<typeof PlayerTokenRequest>;
export const PlayerTokenResponse = Type.Object(
  {
    access_token: OpaqueSecret,
    token_type: Type.Literal('Bearer'),
    expires_at: Instant,
    credential_generation: VersionString,
  },
  Strict,
);
export type PlayerTokenResponse = Static<typeof PlayerTokenResponse>;

/** Affectations autorisées pour ce Player (GET /player/v1/config). */
export const PlayerConfig = Type.Object(
  {
    player_id: Uuid,
    organization_id: Uuid,
    heartbeat_interval_s: Type.Integer({ minimum: 5, maximum: 600 }),
    presence_timeout_s: Type.Integer({ minimum: 10, maximum: 3600 }),
    assignments: Type.Array(
      Type.Object(
        {
          display_id: Uuid,
          assignment_generation: VersionString,
          output_key: Type.String({ minLength: 1, maxLength: 128 }),
          display: Type.Object(
            {
              name: Type.String({ maxLength: 120 }),
              width: PixelSize,
              height: PixelSize,
              orientation: Orientation,
              timezone: Timezone,
            },
            Strict,
          ),
        },
        Strict,
      ),
      { maxItems: 16 },
    ),
  },
  Strict,
);
export type PlayerConfig = Static<typeof PlayerConfig>;

export const OutputsReportRequest = Type.Object(
  { outputs: Type.Array(OutputReport, { minItems: 1, maxItems: 16 }) },
  Strict,
);

export const HeartbeatResponse = Type.Object(
  {
    server_time: Instant,
    /** Displays annoncés avec une affectation qui n’est plus la courante : rafraîchir /config. */
    stale_displays: Type.Array(Uuid, { maxItems: 16 }),
  },
  Strict,
);
export type HeartbeatResponse = Static<typeof HeartbeatResponse>;
