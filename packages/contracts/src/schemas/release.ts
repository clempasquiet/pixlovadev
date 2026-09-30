import Type, { type Static } from 'typebox';
import { Instant, Sha256Hex, SizeBytes, Strict, Uuid } from './common.js';

/**
 * Métadonnées signées d’une release du Player natif (PLY-005, NAT-013, SEC-011),
 * enveloppe `SIGNAGE_RELEASE_V1`. Elles sont vérifiées avant tout téléchargement ou
 * extraction ; la clé de release est distincte des clés de manifest et d’appareil.
 */
export const RELEASE_ENVELOPE_TYPE = 'SIGNAGE_RELEASE_V1';
export const RELEASE_SCHEMA_VERSION = 1;

const ProtocolVersion = Type.Integer({ minimum: 1, maximum: 1000 });

export const ReleasePayload = Type.Object(
  {
    schema_version: Type.Literal(RELEASE_SCHEMA_VERSION),
    release_id: Uuid,
    /** Version SemVer sans métadonnées de build. */
    version: Type.String({
      pattern: '^(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})$',
    }),
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
