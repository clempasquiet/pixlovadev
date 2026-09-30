/**
 * Compilation pure d’un snapshot en payload de manifest (PROTO-018, ADR-011). Aucune base,
 * aucune horloge implicite : l’instant de compilation et la fenêtre sont des paramètres.
 */
import {
  canonicalSha256,
  formatInstant,
  MANIFEST_SCHEMA_VERSION,
  type ContentRef,
  type ManifestAsset,
  type ManifestContent,
  type ManifestPayload,
  type TimelineEntry,
} from '@pixlova/contracts';
import { arbitrate, toTimeline } from '../arbitrate.js';
import { expandSources, InvalidRuleError } from '../occurrences.js';
import { targetsDisplay } from '../targets.js';
import type { Occurrence, ProgramSource, Segment } from '../types.js';
import { ContentResolver, VIDEO_PROFILE } from './catalog.js';
import type { CompileIssue, DisplaySnapshot, ExplanationEntry, ProgramEntry } from './types.js';

export const DAY_MS = 86_400_000;
/** Horizon de compilation [à valider] (PLN-011). */
export const DEFAULT_HORIZON_MS = 7 * DAY_MS;
/** Seuil de renouvellement de l’horizon [à valider]. */
export const RENEWAL_THRESHOLD_MS = 5 * DAY_MS;
export const MAX_TIMELINE_ENTRIES = 20_000;
export const MAX_CONTENTS = 5_000;
export const MAX_EXPLANATION_ENTRIES = 2_000;

export interface PreparedSnapshot {
  snapshot: DisplaySnapshot;
  programs: ProgramEntry[];
  /** Empreinte des entrées utiles, hors fenêtre temporelle (idempotence). */
  inputHash: string;
}

function contentKey(ref: ContentRef): string {
  return `${ref.type}:${ref.id}`;
}

function programContents(program: ProgramEntry): ContentRef[] {
  const document = program.document;
  if (document.kind === 'schedule') {
    return [
      ...document.rules.map((rule) => rule.content),
      ...document.exceptions.flatMap((exception) => (exception.content ? [exception.content] : [])),
    ];
  }
  return document.content ? [document.content] : [];
}

/** Programmes visant le Display et empreinte de toutes les données atteignables. */
export function prepareSnapshot(snapshot: DisplaySnapshot): PreparedSnapshot {
  const facts = {
    id: snapshot.display_id,
    site_id: snapshot.display.site_id,
    group_ids: snapshot.display.group_ids,
  };
  const programs = snapshot.programs
    .filter((program) => targetsDisplay(program.document.targets, facts, program.site_id))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  // Fermeture des contenus atteignables, pour une empreinte limitée à ce qui compte.
  const reached = new Set<string>();
  const stack: ContentRef[] = programs.flatMap(programContents);
  if (snapshot.display.fallback) stack.push(snapshot.display.fallback);
  while (stack.length > 0) {
    const ref = stack.pop()!;
    const key = contentKey(ref);
    if (reached.has(key)) continue;
    reached.add(key);
    if (ref.type === 'playlist') {
      for (const item of snapshot.playlists[ref.id]?.document.items ?? []) stack.push(item.content);
    } else if (ref.type === 'composition') {
      for (const element of snapshot.compositions[ref.id]?.document.elements ?? []) {
        if ((element.type === 'image' || element.type === 'video') && element.props.media_id) {
          stack.push({ type: 'media', id: element.props.media_id });
        }
        if (element.type === 'playlist_zone' && element.props.playlist_id) {
          stack.push({ type: 'playlist', id: element.props.playlist_id });
        }
      }
    }
  }
  const pick = <T>(type: ContentRef['type'], record: Record<string, T>, map: (v: T) => unknown) =>
    [...reached]
      .filter((key) => key.startsWith(`${type}:`))
      .map((key) => key.slice(type.length + 1))
      .sort()
      .map((id) => [id, record[id] === undefined ? null : map(record[id])]);
  const capabilities = snapshot.assignment?.capabilities ?? null;
  const input = {
    display: snapshot.display,
    assignment: snapshot.assignment && {
      player_id: snapshot.assignment.player_id,
      generation: snapshot.assignment.generation,
      capabilities: capabilities && {
        manifest_schemas: capabilities.manifest_schemas,
        render_schemas: capabilities.render_schemas,
        image_types: capabilities.image_types,
        video_profiles: capabilities.video_profiles,
        max_canvas: capabilities.max_canvas,
        max_concurrent_videos: capabilities.max_concurrent_videos,
        storage_quota_bytes: capabilities.storage_quota_bytes,
      },
    },
    programs: programs.map((program) => [program.id, program.version_id]),
    playlists: pick('playlist', snapshot.playlists, (p) => p.version_id),
    compositions: pick('composition', snapshot.compositions, (c) => c.version_id),
    media: pick('media', snapshot.media, (m) => [m.playback, m.original]),
  };
  return { snapshot, programs, inputHash: canonicalSha256(input) };
}

function toSources(programs: readonly ProgramEntry[]): ProgramSource[] {
  const sources: ProgramSource[] = [];
  for (const program of programs) {
    const document = program.document;
    if (document.kind === 'schedule') {
      sources.push({
        kind: 'schedule',
        program_id: program.id,
        version: program.version,
        timezone: document.timezone,
        rules: document.rules,
        exceptions: document.exceptions,
      });
    } else if (document.content && document.starts_at && document.ends_at) {
      sources.push({
        kind:
          document.kind === 'override' && document.priority === 100 ? 'emergency' : document.kind,
        program_id: program.id,
        version: program.version,
        priority: document.priority,
        starts_at: Date.parse(document.starts_at),
        ends_at: Date.parse(document.ends_at),
        content: document.content,
      });
    }
  }
  return sources;
}

/** Explication compacte : segments contigus de même décision fusionnés. */
export function explain(segments: readonly Segment[]): ExplanationEntry[] {
  const entries: ExplanationEntry[] = [];
  let signature = '';
  for (const segment of segments) {
    const winner = segment.winner;
    const masked = segment.masked.map(({ occurrence, reason }) => ({
      kind: occurrence.kind,
      program_id: occurrence.program_id,
      rule_id: occurrence.rule_id,
      priority: occurrence.priority,
      reason,
    }));
    const next = JSON.stringify([
      winner && [winner.occurrence.rule_id, winner.occurrence.start, winner.variant],
      masked,
    ]);
    const previous = entries.at(-1);
    if (
      previous &&
      next === signature &&
      previous.ends_at === formatInstant(new Date(segment.start))
    ) {
      previous.ends_at = formatInstant(new Date(segment.end));
      continue;
    }
    signature = next;
    entries.push({
      starts_at: formatInstant(new Date(segment.start)),
      ends_at: formatInstant(new Date(segment.end)),
      winner: winner && {
        kind: winner.occurrence.kind,
        program_id: winner.occurrence.program_id,
        rule_id: winner.occurrence.rule_id,
        priority: winner.occurrence.priority,
        version: winner.occurrence.version,
        content: winner.occurrence.content,
        content_ref: winner.variant!,
        exception_id: winner.occurrence.exception_id,
        occurrence: {
          starts_at: formatInstant(new Date(winner.occurrence.start)),
          ends_at: formatInstant(new Date(winner.occurrence.end)),
        },
        local: winner.occurrence.local,
      },
      masked,
    });
  }
  return entries;
}

export interface EvaluatedProgram {
  segments: Segment[];
  resolver: ContentResolver;
  issues: CompileIssue[];
}

/** Arbitrage sur une fenêtre quelconque : compilation et simulation partagent ce chemin. */
export function evaluate(
  prepared: PreparedSnapshot,
  from: number,
  until: number,
): EvaluatedProgram {
  const { snapshot } = prepared;
  const resolver = new ContentResolver(snapshot, snapshot.assignment?.capabilities ?? null);
  const issues: CompileIssue[] = [];
  let occurrences: Occurrence[];
  try {
    occurrences = expandSources(
      toSources(prepared.programs),
      snapshot.display.timezone,
      from,
      until,
    );
  } catch (error) {
    if (!(error instanceof InvalidRuleError)) throw error;
    issues.push({
      severity: 'error',
      code: 'INVALID_RULE',
      ref: error.ruleId,
      message: error.message,
    });
    occurrences = [];
  }
  const segments = arbitrate(occurrences, resolver, from, until);
  return { segments, resolver, issues };
}

export interface ManifestDraft {
  inputHash: string;
  generatedAt: number;
  scheduleUntil: number;
  timeline: TimelineEntry[];
  contents: ManifestContent[];
  assets: ManifestAsset[];
  fallback: ManifestPayload['fallback'];
  requiredCapabilities: ManifestPayload['required_capabilities'];
  explanation: ExplanationEntry[];
  issues: CompileIssue[];
}

export function buildDraft(
  prepared: PreparedSnapshot,
  options: { now: Date; horizonMs?: number },
): ManifestDraft {
  const generatedAt = Math.floor(options.now.getTime() / 1000) * 1000;
  let scheduleUntil = generatedAt + (options.horizonMs ?? DEFAULT_HORIZON_MS);
  const { segments, resolver, issues } = evaluate(prepared, generatedAt, scheduleUntil);
  let slots = toTimeline(segments);
  if (slots.length > MAX_TIMELINE_ENTRIES) {
    scheduleUntil = slots[MAX_TIMELINE_ENTRIES - 1]!.end;
    slots = slots.slice(0, MAX_TIMELINE_ENTRIES);
    issues.push({
      severity: 'warning',
      code: 'HORIZON_TRUNCATED',
      ref: null,
      message: `Horizon réduit au ${formatInstant(new Date(scheduleUntil))} (limite de ${MAX_TIMELINE_ENTRIES} intervalles).`,
    });
  }
  const fallbackRef = prepared.snapshot.display.fallback
    ? resolver.fallback(prepared.snapshot.display.fallback, generatedAt)
    : null;
  const roots = [...new Set(slots.map((slot) => slot.variant))];
  if (fallbackRef) roots.push(fallbackRef);
  const { contents, assets } = resolver.reachable(roots);
  issues.push(...resolver.issueList());
  const timeline: TimelineEntry[] = slots.map((slot) => ({
    starts_at: formatInstant(new Date(slot.start)),
    ends_at: formatInstant(new Date(slot.end)),
    content_ref: slot.variant,
    source: {
      type: slot.kind,
      id: slot.program_id,
      priority: slot.priority,
      revision: String(slot.version),
    },
  }));
  const imageTypes = [
    ...new Set(assets.filter((a) => a.mime_type.startsWith('image/')).map((a) => a.mime_type)),
  ].sort();
  const hasVideo = assets.some((a) => a.mime_type.startsWith('video/'));
  return {
    inputHash: prepared.inputHash,
    generatedAt,
    scheduleUntil,
    timeline,
    contents,
    assets,
    fallback: {
      content_ref: fallbackRef,
      after_schedule: fallbackRef ? 'play_fallback' : 'standby_screen',
    },
    requiredCapabilities: {
      render_schema: 1,
      image_types: imageTypes,
      video_profiles: hasVideo ? [VIDEO_PROFILE] : [],
    },
    explanation: explain(segments).slice(0, MAX_EXPLANATION_ENTRIES),
    issues,
  };
}

/** Contrôles des capacités et ressources avant distribution (ADR-011, préflight 1 et 2). */
export function preflight(prepared: PreparedSnapshot, draft: ManifestDraft): CompileIssue[] {
  const issues: CompileIssue[] = [];
  const capabilities = prepared.snapshot.assignment?.capabilities ?? null;
  const display = prepared.snapshot.display;
  if (!capabilities) {
    return [
      {
        severity: 'error',
        code: 'CAPABILITIES_UNKNOWN',
        ref: null,
        message: 'Capacités du Player inconnues : aucune variante ne peut être choisie.',
      },
    ];
  }
  if (
    !capabilities.manifest_schemas.includes(MANIFEST_SCHEMA_VERSION) ||
    !capabilities.render_schemas.includes(draft.requiredCapabilities.render_schema)
  ) {
    issues.push({
      severity: 'error',
      code: 'UNSUPPORTED_SCHEMA',
      ref: null,
      message: `Le Player ne reconnaît pas le manifest v${MANIFEST_SCHEMA_VERSION} ou le rendu v${draft.requiredCapabilities.render_schema}.`,
    });
  }
  const canvas = capabilities.max_canvas;
  if (canvas) {
    const tooLarge = (w: number, h: number) =>
      Math.max(w, h) > Math.max(canvas.width, canvas.height) ||
      Math.min(w, h) > Math.min(canvas.width, canvas.height);
    const compositions = draft.contents.filter((c) => c.type === 'composition');
    if (
      tooLarge(display.width, display.height) ||
      compositions.some((c) => tooLarge(c.document.canvas.width, c.document.canvas.height))
    ) {
      issues.push({
        severity: 'error',
        code: 'CANVAS_TOO_LARGE',
        ref: null,
        message: `Dimensions supérieures au maximum qualifié du Player (${canvas.width}×${canvas.height}).`,
      });
    }
  }
  if (capabilities.max_concurrent_videos !== null) {
    for (const content of draft.contents) {
      if (content.type !== 'composition') continue;
      const videos = content.document.elements.filter((e) => e.type === 'video' && e.visible);
      if (videos.length > capabilities.max_concurrent_videos) {
        issues.push({
          severity: 'error',
          code: 'TOO_MANY_VIDEOS',
          ref: content.composition_version_id,
          message: `${videos.length} vidéos simultanées ; le Player en annonce ${capabilities.max_concurrent_videos}.`,
        });
      }
    }
  }
  const total = draft.assets.reduce((sum, asset) => sum + asset.size_bytes, 0);
  if (capabilities.storage_quota_bytes !== null && total > capabilities.storage_quota_bytes) {
    issues.push({
      severity: 'error',
      code: 'CACHE_TOO_SMALL',
      ref: null,
      message: `Les ressources (${total} octets) dépassent le stockage annoncé (${capabilities.storage_quota_bytes} octets).`,
    });
  }
  if (draft.contents.length > MAX_CONTENTS) {
    issues.push({
      severity: 'error',
      code: 'MANIFEST_INVALID',
      ref: null,
      message: `Plus de ${MAX_CONTENTS} contenus distincts.`,
    });
  }
  return issues;
}

/** Payload complet, une fois version et identifiant alloués sous verrou. */
export function assemblePayload(
  prepared: PreparedSnapshot,
  draft: ManifestDraft,
  ids: { manifestId: string; version: string },
): ManifestPayload {
  const { snapshot } = prepared;
  const assignment = snapshot.assignment!;
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    manifest_id: ids.manifestId,
    organization_id: snapshot.organization_id,
    display_id: snapshot.display_id,
    player_id: assignment.player_id,
    version: ids.version,
    assignment_generation: assignment.generation,
    config_revision: snapshot.config_revision,
    generated_at: formatInstant(new Date(draft.generatedAt)),
    valid_from: formatInstant(new Date(draft.generatedAt)),
    activate_before: formatInstant(new Date(draft.scheduleUntil)),
    schedule_until: formatInstant(new Date(draft.scheduleUntil)),
    display: {
      width: snapshot.display.width,
      height: snapshot.display.height,
      orientation: snapshot.display.orientation,
      fit: 'contain',
      timezone: snapshot.display.timezone,
    },
    required_capabilities: draft.requiredCapabilities,
    assets: draft.assets,
    contents: draft.contents,
    timeline: draft.timeline,
    fallback: draft.fallback,
  };
}
