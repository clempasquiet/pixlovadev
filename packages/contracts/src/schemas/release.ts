import Type, { type Static } from 'typebox';
import { Code, Detail, Instant, Sha256Hex, SizeBytes, Strict, Uuid } from './common.js';

/**
 * Métadonnées signées d’une release du Player natif (PLY-005, NAT-013, SEC-011),
 * enveloppe `SIGNAGE_RELEASE_V1`. Elles sont vérifiées avant tout téléchargement ou
 * extraction ; la clé de release est distincte des clés de manifest et d’appareil.
 */
export const RELEASE_ENVELOPE_TYPE = 'SIGNAGE_RELEASE_V1';
export const RELEASE_SCHEMA_VERSION = 1;

/** Version SemVer `a.b.c` d’une release (sans métadonnées de build). */
export const ReleaseVersion = Type.String({
  pattern: '^(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})$',
});

const ProtocolVersion = Type.Integer({ minimum: 1, maximum: 1000 });

export const ReleasePayload = Type.Object(
  {
    schema_version: Type.Literal(RELEASE_SCHEMA_VERSION),
    release_id: Uuid,
    /** Version SemVer sans métadonnées de build. */
    version: ReleaseVersion,
    os: Type.Union([Type.Literal('linux'), Type.Literal('windows')]),
    arch: Type.Union([Type.Literal('x86_64'), Type.Literal('aarch64')]),
    /** Archive tar du paquet : empreinte et taille exactes. */
    package: Type.Object({ sha256: Sha256Hex, size_bytes: SizeBytes }, Strict),
    /** Versions du protocole Player (API et manifests) prises en charge. */
    protocol_min: ProtocolVersion,
    protocol_max: ProtocolVersion,
    /** Version de schéma SQLite atteinte par cette release. */
    sqlite_schema: Type.Integer({ minimum: 1, maximum: 100000 }),
    /** Niveau de lecture SQLite de cette release (compatibilité du retour arrière). */
    sqlite_reader_level: Type.Integer({ minimum: 1, maximum: 100000 }),
    renderer_build: Type.String({ pattern: '^[0-9A-Za-z.+-]{1,64}$' }),
    published_at: Instant,
  },
  { ...Strict, title: 'ReleasePayload' },
);
export type ReleasePayload = Static<typeof ReleasePayload>;

/** Taille maximale d’une enveloppe de release (métadonnées seules, NAT-013). */
export const MAX_RELEASE_ENVELOPE_BYTES = 64 * 1024;

/**
 * `GET /player/v1/releases/desired?current_version=a.b.c` (PLY-005, ADR-019). Le cloud
 * indique la release publiée la plus récente pour la plateforme du Player, avec une URL
 * signée de son paquet, et demande un retour arrière si la version en service a été
 * bloquée. Le Player vérifie la signature avant tout téléchargement : cette réponse
 * n’est jamais une autorisation d’installer.
 */
export const DesiredReleaseResponse = Type.Object(
  {
    /** Enveloppe `SIGNAGE_RELEASE_V1` textuelle, telle que signée ; `null` si aucune. */
    release: Type.Union([
      Type.String({ minLength: 2, maxLength: MAX_RELEASE_ENVELOPE_BYTES }),
      Type.Null(),
    ]),
    package: Type.Union([
      Type.Object(
        {
          url: Type.String({ minLength: 1, maxLength: 4096 }),
          expires_at: Instant,
          size_bytes: SizeBytes,
          sha256: Sha256Hex,
        },
        Strict,
      ),
      Type.Null(),
    ]),
    /** La version en service a été bloquée par la plateforme : revenir à la précédente. */
    rollback: Type.Boolean(),
  },
  { ...Strict, title: 'DesiredReleaseResponse' },
);
export type DesiredReleaseResponse = Static<typeof DesiredReleaseResponse>;

/** États d’une mise à jour déclarés par le Player natif (PLY-005). */
export const UPDATE_STATES = ['installed', 'promoted', 'rolled_back', 'failed'] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];

/** `POST /player/v1/updates/:release_id/status` : dernier état connu localement. */
export const UpdateStatusRequest = Type.Object(
  {
    version: ReleaseVersion,
    state: Type.Union([
      Type.Literal('installed'),
      Type.Literal('promoted'),
      Type.Literal('rolled_back'),
      Type.Literal('failed'),
    ]),
    code: Type.Union([Code, Type.Null()]),
    detail: Type.Union([Detail, Type.Null()]),
    observed_at: Instant,
  },
  { ...Strict, title: 'UpdateStatusRequest' },
);
export type UpdateStatusRequest = Static<typeof UpdateStatusRequest>;
