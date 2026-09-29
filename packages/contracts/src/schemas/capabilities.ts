import Type, { type Static } from 'typebox';
import { MimeType, PixelSize, SizeBytes, Strict, Support } from './common.js';

/**
 * Capacités déclarées par un Player (PROTO-017). Elles guident le choix des variantes
 * et l’UX ; elles ne constituent ni une autorisation, ni une preuve matérielle.
 */
export const PlayerCapabilities = Type.Object(
  {
    player_type: Type.Union([Type.Literal('native'), Type.Literal('web')]),
    app_version: Type.String({ pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+([-+][0-9A-Za-z.-]{1,64})?$' }),
    os: Type.Object(
      {
        family: Type.Union([
          Type.Literal('linux'),
          Type.Literal('windows'),
          Type.Literal('macos'),
          Type.Literal('android'),
          Type.Literal('other'),
          Type.Literal('unknown'),
        ]),
        version: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
      },
      Strict,
    ),
    architecture: Type.Union([
      Type.Literal('x86_64'),
      Type.Literal('aarch64'),
      Type.Literal('other'),
      Type.Literal('unknown'),
    ]),
    protocol_versions: Type.Array(Type.Integer({ minimum: 1, maximum: 1000 }), {
      minItems: 1,
      maxItems: 8,
    }),
    manifest_schemas: Type.Array(Type.Integer({ minimum: 1, maximum: 1000 }), {
      minItems: 1,
      maxItems: 8,
    }),
    render_schemas: Type.Array(Type.Integer({ minimum: 1, maximum: 1000 }), {
      minItems: 1,
      maxItems: 8,
    }),
    renderer: Type.Object(
      {
        engine: Type.String({ minLength: 1, maxLength: 64 }),
        version: Type.String({ minLength: 1, maxLength: 64 }),
      },
      Strict,
    ),
    image_types: Type.Array(MimeType, { maxItems: 32 }),
    /** Profils vidéo qualifiés, par exemple `mp4-h264-aac`. */
    video_profiles: Type.Array(Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,63}$' }), {
      maxItems: 32,
    }),
    max_canvas: Type.Union([
      Type.Object({ width: PixelSize, height: PixelSize }, Strict),
      Type.Null(),
    ]),
    max_concurrent_videos: Type.Union([Type.Integer({ minimum: 0, maximum: 64 }), Type.Null()]),
    multi_output: Support,
    screenshot: Support,
    volume_control: Support,
    reboot_host: Support,
    persistent_storage: Type.Union([
      Type.Literal('granted'),
      Type.Literal('denied'),
      Type.Literal('unsupported'),
      Type.Literal('unknown'),
    ]),
    storage_quota_bytes: Type.Union([SizeBytes, Type.Null()]),
  },
  { ...Strict, title: 'PlayerCapabilities' },
);
export type PlayerCapabilities = Static<typeof PlayerCapabilities>;
