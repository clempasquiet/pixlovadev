import { parseInstantMicros } from './instant.js';
import {
  MANIFEST_ENVELOPE_TYPE,
  MANIFEST_SCHEMA_VERSION,
  type ManifestContent,
  type ManifestPayload,
  type SourceType,
} from './schemas/index.js';
import { verifyEnvelope, type EnvelopeErrorCode, type TrustStore } from './signature.js';
import { describeErrors, validator } from './validate.js';

/** Bandes de priorité partagées par le compilateur, la preview et les Players (PLN-008). */
export const PRIORITY_BANDS: Record<SourceType, readonly [number, number]> = {
  schedule: [0, 19],
  campaign: [20, 79],
  override: [80, 99],
  emergency: [100, 100],
};

export type ManifestSemanticReason =
  | 'WINDOW_INVALID'
  | 'DUPLICATE_ASSET_ID'
  | 'DUPLICATE_CONTENT_ID'
  | 'DUPLICATE_ELEMENT_ID'
  | 'UNKNOWN_ASSET'
  | 'ASSET_KIND_MISMATCH'
  | 'UNKNOWN_CONTENT'
  | 'INVALID_REFERENCE'
  | 'VIDEO_RANGE_INVALID'
  | 'CONTENT_CYCLE'
  | 'TIMELINE_INTERVAL_INVALID'
  | 'TIMELINE_OVERLAP'
  | 'PRIORITY_OUT_OF_BAND';

export type ManifestVerificationCode =
  EnvelopeErrorCode | 'UNSUPPORTED_SCHEMA' | 'SCHEMA_INVALID' | 'SEMANTIC_INVALID';

export type ManifestVerification =
  | { ok: true; manifest: ManifestPayload; manifestHash: string; kid: string }
  | { ok: false; code: ManifestVerificationCode; reason?: ManifestSemanticReason; detail: string };

class SemanticError extends Error {
  constructor(
    readonly reason: ManifestSemanticReason,
    detail: string,
  ) {
    super(detail);
  }
}

function micros(value: string): number {
  const parsed = parseInstantMicros(value);
  if (parsed === null) throw new SemanticError('WINDOW_INVALID', `instant invalide ${value}`);
  return parsed;
}

function mimeFamily(mime: string): string {
  return mime.slice(0, mime.indexOf('/'));
}

/**
 * Contrôles de cohérence non exprimables en JSON Schema, appliqués dans un ordre fixe
 * (le premier échec est rapporté) et identiques dans la crate Rust.
 */
export function checkManifestSemantics(manifest: ManifestPayload): void {
  const generated = micros(manifest.generated_at);
  const validFrom = micros(manifest.valid_from);
  const activateBefore = micros(manifest.activate_before);
  const until = micros(manifest.schedule_until);
  if (!(validFrom < until && validFrom <= activateBefore && activateBefore <= until)) {
    throw new SemanticError('WINDOW_INVALID', 'fenêtre valid_from/activate_before/schedule_until');
  }
  if (generated > activateBefore) {
    throw new SemanticError('WINDOW_INVALID', 'generated_at postérieur à activate_before');
  }

  const assets = new Map<string, string>();
  for (const asset of manifest.assets) {
    if (assets.has(asset.id)) throw new SemanticError('DUPLICATE_ASSET_ID', asset.id);
    assets.set(asset.id, mimeFamily(asset.mime_type));
  }
  const contents = new Map<string, ManifestContent>();
  for (const content of manifest.contents) {
    if (contents.has(content.id)) throw new SemanticError('DUPLICATE_CONTENT_ID', content.id);
    contents.set(content.id, content);
  }

  const requireAsset = (id: string, family: 'image' | 'video') => {
    const actual = assets.get(id);
    if (actual === undefined) throw new SemanticError('UNKNOWN_ASSET', id);
    if (actual !== family) throw new SemanticError('ASSET_KIND_MISMATCH', id);
  };
  const requireContent = (ref: string, allowed: ManifestContent['type'][]) => {
    const target = contents.get(ref);
    if (!target) throw new SemanticError('UNKNOWN_CONTENT', ref);
    if (!allowed.includes(target.type)) throw new SemanticError('INVALID_REFERENCE', ref);
  };

  const edges = new Map<string, string[]>();
  for (const content of manifest.contents) {
    const children: string[] = [];
    if (content.type === 'media') {
      requireAsset(content.asset_id, content.media_kind);
    } else if (content.type === 'playlist') {
      for (const item of content.items) {
        requireContent(item.content_ref, ['media', 'composition']);
        children.push(item.content_ref);
      }
    } else {
      const ids = new Set<string>();
      for (const element of content.document.elements) {
        if (ids.has(element.id)) throw new SemanticError('DUPLICATE_ELEMENT_ID', element.id);
        ids.add(element.id);
        switch (element.type) {
          case 'image':
            requireAsset(element.props.asset_id, 'image');
            break;
          case 'video': {
            requireAsset(element.props.asset_id, 'video');
            const { start_ms: start = 0, end_ms: end } = element.props;
            if (end !== undefined && end <= start) {
              throw new SemanticError('VIDEO_RANGE_INVALID', element.id);
            }
            break;
          }
          case 'media_zone':
            requireContent(element.props.content_ref, ['media']);
            children.push(element.props.content_ref);
            break;
          case 'playlist_zone':
            requireContent(element.props.content_ref, ['playlist']);
            children.push(element.props.content_ref);
            break;
          default:
            break;
        }
      }
    }
    edges.set(content.id, children);
  }

  // Détection de cycle (CMP-005, PROTO-016) : parcours en profondeur itératif.
  const state = new Map<string, 'visiting' | 'done'>();
  for (const root of manifest.contents) {
    if (state.get(root.id) === 'done') continue;
    const stack: [string, number][] = [[root.id, 0]];
    state.set(root.id, 'visiting');
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const children = edges.get(frame[0]) ?? [];
      if (frame[1] < children.length) {
        const child = children[frame[1]++]!;
        const childState = state.get(child);
        if (childState === 'visiting') throw new SemanticError('CONTENT_CYCLE', child);
        if (childState === undefined) {
          state.set(child, 'visiting');
          stack.push([child, 0]);
        }
      } else {
        state.set(frame[0], 'done');
        stack.pop();
      }
    }
  }

  let previousEnd = validFrom;
  manifest.timeline.forEach((entry, index) => {
    const start = micros(entry.starts_at);
    const end = micros(entry.ends_at);
    if (!(start < end) || start < validFrom || end > until) {
      throw new SemanticError('TIMELINE_INTERVAL_INVALID', `timeline[${index}]`);
    }
    if (start < previousEnd) throw new SemanticError('TIMELINE_OVERLAP', `timeline[${index}]`);
    previousEnd = end;
    if (!contents.has(entry.content_ref)) {
      throw new SemanticError('UNKNOWN_CONTENT', entry.content_ref);
    }
    const [min, max] = PRIORITY_BANDS[entry.source.type];
    if (entry.source.priority < min || entry.source.priority > max) {
      throw new SemanticError('PRIORITY_OUT_OF_BAND', `timeline[${index}]`);
    }
  });

  if (manifest.fallback.content_ref !== null && !contents.has(manifest.fallback.content_ref)) {
    throw new SemanticError('UNKNOWN_CONTENT', manifest.fallback.content_ref);
  }
}

/** Vérification complète d’un manifest reçu : enveloppe, schéma puis cohérence. */
export function verifyManifest(
  raw: string,
  trust: TrustStore,
  maxBytes?: number,
): ManifestVerification {
  const envelope = verifyEnvelope(raw, MANIFEST_ENVELOPE_TYPE, trust, maxBytes);
  if (!envelope.ok) return envelope;
  const { payload } = envelope.envelope;
  if (payload.schema_version !== MANIFEST_SCHEMA_VERSION) {
    return { ok: false, code: 'UNSUPPORTED_SCHEMA', detail: 'schema_version non supportée' };
  }
  const validate = validator('manifest-payload.json');
  if (!validate(payload)) {
    return { ok: false, code: 'SCHEMA_INVALID', detail: describeErrors(validate.errors) };
  }
  const manifest = payload as unknown as ManifestPayload;
  try {
    checkManifestSemantics(manifest);
  } catch (error) {
    if (error instanceof SemanticError) {
      return { ok: false, code: 'SEMANTIC_INVALID', reason: error.reason, detail: error.message };
    }
    throw error;
  }
  return {
    ok: true,
    manifest,
    manifestHash: envelope.envelope.payloadHash,
    kid: envelope.envelope.protected.kid,
  };
}

/** État local d’un Player pour un Display affecté (NAT-007). */
export interface LocalDisplayState {
  assignment_generation: string;
  /** Plus haute version acceptée et son empreinte ; `null` avant le premier manifest. */
  highest_version: string | null;
  highest_version_hash: string | null;
}

export interface LocalAssociation {
  organization_id: string;
  player_id: string;
  displays: ReadonlyMap<string, LocalDisplayState>;
}

export type ManifestRejection =
  | 'WRONG_ORGANIZATION'
  | 'WRONG_PLAYER'
  | 'WRONG_DISPLAY'
  | 'STALE_ASSIGNMENT'
  | 'ASSIGNMENT_AHEAD'
  | 'VERSION_REPLAYED'
  | 'VERSION_CONFLICT'
  | 'ACTIVATION_WINDOW_EXPIRED';

export type ManifestDecision =
  | { decision: 'accept'; activate_not_before: string }
  | { decision: 'duplicate' }
  | { decision: 'reject'; code: ManifestRejection };

function compareVersions(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Décide si un manifest vérifié peut être préparé (PROTO-013, NAT-008 étape 1).
 * Une retransmission identique est sans effet ; une ancienne version ou une même
 * version au contenu différent est refusée ; une ancienne affectation ne redevient
 * jamais légitime.
 */
export function evaluateManifestCandidate(
  manifest: ManifestPayload,
  manifestHash: string,
  local: LocalAssociation,
  now: string,
): ManifestDecision {
  if (manifest.organization_id !== local.organization_id) {
    return { decision: 'reject', code: 'WRONG_ORGANIZATION' };
  }
  if (manifest.player_id !== local.player_id) return { decision: 'reject', code: 'WRONG_PLAYER' };
  const display = local.displays.get(manifest.display_id);
  if (!display) return { decision: 'reject', code: 'WRONG_DISPLAY' };
  const generation = compareVersions(manifest.assignment_generation, display.assignment_generation);
  if (generation < 0) return { decision: 'reject', code: 'STALE_ASSIGNMENT' };
  if (generation > 0) return { decision: 'reject', code: 'ASSIGNMENT_AHEAD' };
  if (display.highest_version !== null) {
    const order = compareVersions(manifest.version, display.highest_version);
    if (order < 0) return { decision: 'reject', code: 'VERSION_REPLAYED' };
    if (order === 0) {
      return manifestHash === display.highest_version_hash
        ? { decision: 'duplicate' }
        : { decision: 'reject', code: 'VERSION_CONFLICT' };
    }
  }
  const nowMicros = parseInstantMicros(now);
  if (nowMicros === null) throw new Error(`Instant courant invalide : ${now}`);
  if (nowMicros >= parseInstantMicros(manifest.activate_before)!) {
    return { decision: 'reject', code: 'ACTIVATION_WINDOW_EXPIRED' };
  }
  return { decision: 'accept', activate_not_before: manifest.valid_from };
}
