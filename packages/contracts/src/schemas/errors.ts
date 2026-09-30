import Type, { type Static } from 'typebox';
import { Code, Strict, Uuid } from './common.js';

/** Codes métier minimum (API-006). La liste peut s’étendre ; un client traite un code inconnu comme non récupérable. */
export const ERROR_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'RESOURCE_NOT_FOUND',
  'VALIDATION_ERROR',
  'RATE_LIMITED',
  'DISPLAY_LIMIT_REACHED',
  'PLAYER_NOT_PAIRED',
  'PLAYER_REVOKED',
  'PAIRING_EXPIRED',
  'PAIRING_ALREADY_USED',
  'ASSIGNMENT_CONFLICT',
  'STALE_ASSIGNMENT',
  'ASSET_NOT_READY',
  'STORAGE_QUOTA_EXCEEDED',
  'MANIFEST_NOT_FOUND',
  'MANIFEST_INVALID',
  'UNSUPPORTED_SCHEMA',
  'CAPABILITY_UNSUPPORTED',
  'COMMAND_EXPIRED',
  'BILLING_PENDING',
  'REVISION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorEnvelope = Type.Object(
  {
    error: Type.Object(
      {
        code: Code,
        message: Type.String({ maxLength: 1000 }),
        request_id: Uuid,
        retryable: Type.Boolean(),
        details: Type.Optional(Type.Object({}, { maxProperties: 32 })),
      },
      Strict,
    ),
  },
  { ...Strict, title: 'ErrorEnvelope' },
);
export type ErrorEnvelope = Static<typeof ErrorEnvelope>;
