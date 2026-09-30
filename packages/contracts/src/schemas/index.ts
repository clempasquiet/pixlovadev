export * from './common.js';
export * from './errors.js';
export * from './tenant.js';
export * from './display.js';
export * from './capabilities.js';
export * from './composition.js';
export * from './manifest.js';
export * from './command.js';
export * from './ws.js';
export * from './events.js';

import { PlayerCapabilities } from './capabilities.js';
import { CommandPayload, CommandResult, SignedCommand } from './command.js';
import { Composition } from './composition.js';
import { Display, DisplayAssignment } from './display.js';
import { ErrorEnvelope } from './errors.js';
import { PlayerEventBatch } from './events.js';
import { ManifestPayload, SignedManifest } from './manifest.js';
import { Organization } from './tenant.js';
import { HeartbeatPayload, WsMessage } from './ws.js';

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
  'manifest-payload.json': root('manifest-payload.json', ManifestPayload),
  'manifest.json': root('manifest.json', SignedManifest),
  'command.json': root('command.json', SignedCommand),
  'command-payload.json': root('command-payload.json', CommandPayload),
  'command-result.json': root('command-result.json', CommandResult),
  'heartbeat.json': root('heartbeat.json', HeartbeatPayload),
  'ws-message.json': root('ws-message.json', WsMessage),
  'player-event-batch.json': root('player-event-batch.json', PlayerEventBatch),
} as const;
export type RootSchemaName = keyof typeof ROOT_SCHEMAS;
