/**
 * Photographie cohérente des données publiées utiles à un Display (PROTO-018 étape 1).
 * Chargée en base par `loadSnapshot`, compilée par des fonctions pures.
 */
import type {
  CompositionDocument,
  ContentRef,
  PlayerCapabilities,
  PlaylistDocument,
  ProgramDocument,
} from '@pixlova/contracts';

export interface AssetEntry {
  id: string;
  variant: 'playback' | 'original';
  mime_type: string;
  size_bytes: number;
  sha256: string;
  duration_ms: number | null;
}

/** Média prêt et hors corbeille ; un média indisponible est absent du snapshot. */
export interface MediaEntry {
  id: string;
  type: 'image' | 'video';
  duration_ms: number | null;
  playback: AssetEntry | null;
  original: AssetEntry | null;
}

export interface CompositionEntry {
  id: string;
  version_id: string;
  version: number;
  document: CompositionDocument;
}

export interface PlaylistEntry {
  id: string;
  version_id: string;
  version: number;
  document: PlaylistDocument;
}

export interface ProgramEntry {
  id: string;
  kind: 'schedule' | 'campaign' | 'override';
  site_id: string | null;
  version: number;
  version_id: string;
  document: ProgramDocument;
}

export interface DisplaySnapshot {
  organization_id: string;
  display_id: string;
  config_revision: string;
  display: {
    width: number;
    height: number;
    orientation: 0 | 90 | 180 | 270;
    /** Fuseau effectif : Display, sinon site, sinon organisation. */
    timezone: string;
    site_id: string;
    group_ids: string[];
    fallback: ContentRef | null;
  };
  /** `null` : Display non affecté, rien à distribuer. */
  assignment: {
    player_id: string;
    generation: string;
    capabilities: PlayerCapabilities | null;
  } | null;
  /** Programmes publiés, non annulés et non terminés de l’organisation. */
  programs: ProgramEntry[];
  playlists: Record<string, PlaylistEntry>;
  compositions: Record<string, CompositionEntry>;
  media: Record<string, MediaEntry>;
}

export type CompileIssueCode =
  | 'CAPABILITIES_UNKNOWN'
  | 'UNSUPPORTED_SCHEMA'
  | 'UNSUPPORTED_IMAGE_TYPE'
  | 'UNSUPPORTED_VIDEO_PROFILE'
  | 'CANVAS_TOO_LARGE'
  | 'TOO_MANY_VIDEOS'
  | 'CACHE_TOO_SMALL'
  | 'CONTENT_CYCLE'
  | 'DEPTH_EXCEEDED'
  | 'CONTENT_UNAVAILABLE'
  | 'DURATION_MISSING'
  | 'INVALID_RULE'
  | 'HORIZON_TRUNCATED'
  | 'MANIFEST_INVALID'
  | 'SIGNATURE_CHECK_FAILED';

export interface CompileIssue {
  severity: 'error' | 'warning';
  code: CompileIssueCode;
  ref: string | null;
  message: string;
}

/** Explication compacte d’un intervalle (PLN-005, PROD-003). */
export interface ExplanationEntry {
  starts_at: string;
  ends_at: string;
  winner: {
    kind: 'schedule' | 'campaign' | 'override' | 'emergency';
    program_id: string;
    rule_id: string;
    priority: number;
    version: number;
    content: ContentRef;
    content_ref: string;
    exception_id: string | null;
    occurrence: { starts_at: string; ends_at: string };
    local: { date: string; start_time: string; end_time: string; timezone: string } | null;
  } | null;
  masked: {
    kind: 'schedule' | 'campaign' | 'override' | 'emergency';
    program_id: string;
    rule_id: string;
    priority: number;
    reason: 'lower_priority' | 'older_start' | 'identifier_order' | 'content_unavailable';
  }[];
}
