export * from './common.js';
export * from './errors.js';
export * from './tenant.js';
export * from './display.js';
export * from './capabilities.js';
export * from './composition.js';
export * from './composition-document.js';
export * from './manifest.js';
export * from './command.js';
export * from './ws.js';
export * from './events.js';
export * from './player-api.js';
export * from './programming.js';
export * from './release.js';
export * from './billing.js';

import { BillingCatalog, CatalogFile, PlanEntitlements } from './billing.js';
import { PlayerCapabilities } from './capabilities.js';
import { CommandPayload, CommandResult, SignedCommand } from './command.js';
import { Composition } from './composition.js';
import { CompositionDocument, CompositionTemplate } from './composition-document.js';
import { Display, DisplayAssignment } from './display.js';
import { ErrorEnvelope } from './errors.js';
import { PlayerEventBatch } from './events.js';
import { ManifestPayload, SignedManifest } from './manifest.js';
import { Organization } from './tenant.js';
import { PlaylistDocument, ProgramDocument } from './programming.js';
import { ReleasePayload } from './release.js';
import {
  AssetUrlResponse,
  CommandAckRequest,
  PlayerCommandsResponse,
  PlayerEventsAck,
  ScreenshotUploadRequest,
  ScreenshotUploadResponse,
  HeartbeatResponse,
  ManifestStatusRequest,
  OutputsReportRequest,
  PlayerAuthChallenge,
  PlayerChallengeRequest,
  PlayerChallengeResponse,
  PlayerConfig,
  PlayerPairRequest,
  PlayerPairResponse,
  PlayerRegisterRequest,
  PlayerRegisterResponse,
  PlayerTokenRequest,
  PlayerTokenResponse,
} from './player-api.js';
import { HeartbeatPayload, StatusPayload, WsMessage } from './ws.js';

import { SCHEMA_BASE_URI } from './common.js';

/**
 * Seules les versions racines portent un `$id` : les sous-schémas réutilisés
 * (par exemple une affectation dans un Display) restent anonymes.
 */
function root<T extends object>(name: string, schema: T): T & { $id: string } {
  return { ...schema, $id: `${SCHEMA_BASE_URI}${name}` };
}

/** Schémas racines publiés en JSON dans `schemas/` (nom de fichier → schéma). */
export const ROOT_SCHEMAS = {
  'error.json': root('error.json', ErrorEnvelope),
  'organization.json': root('organization.json', Organization),
  'display.json': root('display.json', Display),
  'display-assignment.json': root('display-assignment.json', DisplayAssignment),
  'player-capabilities.json': root('player-capabilities.json', PlayerCapabilities),
  'composition.json': root('composition.json', Composition),
  'composition-document.json': root('composition-document.json', CompositionDocument),
  'composition-template.json': root('composition-template.json', CompositionTemplate),
  'manifest-payload.json': root('manifest-payload.json', ManifestPayload),
  'manifest.json': root('manifest.json', SignedManifest),
  'command.json': root('command.json', SignedCommand),
  'command-payload.json': root('command-payload.json', CommandPayload),
  'command-result.json': root('command-result.json', CommandResult),
  'heartbeat.json': root('heartbeat.json', HeartbeatPayload),
  'ws-message.json': root('ws-message.json', WsMessage),
  'player-event-batch.json': root('player-event-batch.json', PlayerEventBatch),
  'player-register-request.json': root('player-register-request.json', PlayerRegisterRequest),
  'player-register-response.json': root('player-register-response.json', PlayerRegisterResponse),
  'player-pair-request.json': root('player-pair-request.json', PlayerPairRequest),
  'player-pair-response.json': root('player-pair-response.json', PlayerPairResponse),
  'player-auth-challenge.json': root('player-auth-challenge.json', PlayerAuthChallenge),
  'player-challenge-request.json': root('player-challenge-request.json', PlayerChallengeRequest),
  'player-challenge-response.json': root('player-challenge-response.json', PlayerChallengeResponse),
  'player-token-request.json': root('player-token-request.json', PlayerTokenRequest),
  'player-token-response.json': root('player-token-response.json', PlayerTokenResponse),
  'player-config.json': root('player-config.json', PlayerConfig),
  'player-outputs-report.json': root('player-outputs-report.json', OutputsReportRequest),
  'heartbeat-response.json': root('heartbeat-response.json', HeartbeatResponse),
  'playlist-document.json': root('playlist-document.json', PlaylistDocument),
  'program-document.json': root('program-document.json', ProgramDocument),
  'manifest-status-request.json': root('manifest-status-request.json', ManifestStatusRequest),
  'asset-url-response.json': root('asset-url-response.json', AssetUrlResponse),
  'release-payload.json': root('release-payload.json', ReleasePayload),
  'player-status.json': root('player-status.json', StatusPayload),
  'player-events-ack.json': root('player-events-ack.json', PlayerEventsAck),
  'player-commands-response.json': root('player-commands-response.json', PlayerCommandsResponse),
  'command-ack-request.json': root('command-ack-request.json', CommandAckRequest),
  'screenshot-upload-request.json': root('screenshot-upload-request.json', ScreenshotUploadRequest),
  'screenshot-upload-response.json': root(
    'screenshot-upload-response.json',
    ScreenshotUploadResponse,
  ),
  'plan-entitlements.json': root('plan-entitlements.json', PlanEntitlements),
  'billing-catalog.json': root('billing-catalog.json', BillingCatalog),
  'billing-catalog-file.json': root('billing-catalog-file.json', CatalogFile),
} as const;
export type RootSchemaName = keyof typeof ROOT_SCHEMAS;
