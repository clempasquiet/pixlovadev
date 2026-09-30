import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import {
  encodeBase64url,
  evaluateManifestCandidate,
  MANIFEST_ENVELOPE_TYPE,
  parseInstantMicros,
  signEnvelope,
  verifyManifest,
  type CompositionDocument,
  type PlayerCapabilities,
  type ProgramDocument,
} from '@pixlova/contracts';
import { selectAt } from '@pixlova/render-engine';
import {
  assemblePayload,
  buildDraft,
  manifestSignerFromSeed,
  preflight,
  prepareSnapshot,
  type DisplaySnapshot,
  type ProgramEntry,
} from '../src/compiler/index.js';

const ORG = '10000000-0000-4000-8000-000000000001';
const DISPLAY = '20000000-0000-4000-8000-000000000001';
const PLAYER = '30000000-0000-4000-8000-000000000001';
const SITE = '40000000-0000-4000-8000-000000000001';
const OTHER_SITE = '40000000-0000-4000-8000-000000000002';
const GROUP = '50000000-0000-4000-8000-000000000001';
const IMAGE = '60000000-0000-4000-8000-000000000001';
const VIDEO = '60000000-0000-4000-8000-000000000002';
const WEBP = '60000000-0000-4000-8000-000000000003';
const PLAYLIST = '70000000-0000-4000-8000-000000000001';
const LOOP = '70000000-0000-4000-8000-000000000002';
const COMPOSITION = '80000000-0000-4000-8000-000000000001';
const SCHEDULE = '90000000-0000-4000-8000-000000000001';
const CAMPAIGN = '90000000-0000-4000-8000-000000000002';
const OVERRIDE = '90000000-0000-4000-8000-000000000003';
const RULE = '91000000-0000-4000-8000-000000000001';
const ITEM = (n: number) => `a0000000-0000-4000-8000-00000000000${n}`;

const NOW = new Date('2026-10-05T08:00:00Z');

function capabilities(overrides: Partial<PlayerCapabilities> = {}): PlayerCapabilities {
  return {
    player_type: 'native',
    app_version: '0.1.0',
    os: { family: 'linux', version: '24.04' },
    architecture: 'x86_64',
    protocol_versions: [1],
    manifest_schemas: [1],
    render_schemas: [1],
    renderer: { engine: 'webkitgtk', version: '2.52' },
    image_types: ['image/png', 'image/jpeg'],
    video_profiles: ['mp4-h264-aac'],
    max_canvas: { width: 3840, height: 2160 },
    max_concurrent_videos: 2,
    multi_output: 'supported',
    screenshot: 'supported',
    volume_control: 'supported',
    reboot_host: 'unsupported',
    persistent_storage: 'granted',
    storage_quota_bytes: null,
    ...overrides,
  };
}

const asset = (
  id: string,
  variant: 'playback' | 'original',
  mime: string,
  duration: number | null,
) => ({
  id: id.replace(/^6/, 'b'),
  variant,
  mime_type: mime,
  size_bytes: 1000,
  sha256: 'a'.repeat(64),
  duration_ms: duration,
});

const composition = (zonePlaylist: string): CompositionDocument => ({
  schema_version: 1,
  canvas: { width: 1920, height: 1080, background: '#000000' },
  elements: [
    {
      id: 'fond',
      type: 'image',
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
      rotation: 0,
      z_index: 1,
      opacity: 1,
      visible: true,
      locked: false,
      props: { media_id: IMAGE, fit: 'cover' },
    },
    {
      id: 'zone',
      type: 'playlist_zone',
      x: 100,
      y: 100,
      width: 800,
      height: 450,
      rotation: 0,
      z_index: 2,
      opacity: 1,
      visible: true,
      locked: false,
      props: { playlist_id: zonePlaylist },
    },
  ],
  settings: { duration_ms: 20_000, audio_policy: 'muted' },
});

const targets = { include: [{ type: 'organization' as const }], exclude: [] };

function program(
  id: string,
  kind: ProgramEntry['kind'],
  document: ProgramDocument,
  siteId: string | null = null,
): ProgramEntry {
  return { id, kind, site_id: siteId, version: 1, version_id: id.replace(/^9/, 'c'), document };
}

function snapshot(overrides: Partial<DisplaySnapshot> = {}): DisplaySnapshot {
  return {
    organization_id: ORG,
    display_id: DISPLAY,
    config_revision: '3',
    display: {
      width: 1920,
      height: 1080,
      orientation: 0,
      timezone: 'Europe/Paris',
      site_id: SITE,
      group_ids: [GROUP],
      fallback: { type: 'playlist', id: LOOP },
    },
    assignment: { player_id: PLAYER, generation: '2', capabilities: capabilities() },
    programs: [
      program(SCHEDULE, 'schedule', {
        schema_version: 1,
        kind: 'schedule',
        timezone: null,
        targets,
        rules: [
          {
            id: RULE,
            content: { type: 'composition', id: COMPOSITION },
            priority: 10,
            weekdays: [1, 2, 3, 4, 5, 6, 7],
            start_time: '09:00',
            end_time: '18:00',
            start_date: null,
            end_date: null,
          },
        ],
        exceptions: [],
      }),
      program(CAMPAIGN, 'campaign', {
        schema_version: 1,
        kind: 'campaign',
        content: { type: 'playlist', id: PLAYLIST },
        starts_at: '2026-10-06T08:00:00Z',
        ends_at: '2026-10-06T10:00:00Z',
        priority: 50,
        targets: { include: [{ type: 'group', id: GROUP }], exclude: [] },
      }),
      // Hors périmètre : site différent du Display, ignoré.
      program(
        OVERRIDE,
        'override',
        {
          schema_version: 1,
          kind: 'override',
          content: { type: 'media', id: IMAGE },
          starts_at: '2026-10-05T08:00:00Z',
          ends_at: '2026-10-05T09:00:00Z',
          priority: 90,
          targets,
        },
        OTHER_SITE,
      ),
    ],
    playlists: {
      [PLAYLIST]: {
        id: PLAYLIST,
        version_id: 'd0000000-0000-4000-8000-000000000001',
        version: 2,
        document: {
          schema_version: 1,
          transition: 'fade',
          items: [
            {
              id: ITEM(1),
              content: { type: 'media', id: VIDEO },
              duration_ms: null,
              enabled: true,
              valid_from: null,
              valid_until: '2026-10-06T09:00:00Z',
            },
            {
              id: ITEM(2),
              content: { type: 'media', id: IMAGE },
              duration_ms: 8000,
              enabled: true,
              valid_from: null,
              valid_until: null,
            },
            {
              id: ITEM(3),
              content: { type: 'media', id: IMAGE },
              duration_ms: 5000,
              enabled: false,
              valid_from: null,
              valid_until: null,
            },
          ],
        },
      },
      [LOOP]: {
        id: LOOP,
        version_id: 'd0000000-0000-4000-8000-000000000002',
        version: 1,
        document: {
          schema_version: 1,
          transition: 'cut',
          items: [
            {
              id: ITEM(4),
              content: { type: 'media', id: IMAGE },
              duration_ms: 10000,
              enabled: true,
              valid_from: null,
              valid_until: null,
            },
            {
              id: ITEM(5),
              content: { type: 'media', id: VIDEO },
              duration_ms: 12000,
              enabled: true,
              valid_from: null,
              valid_until: '2026-12-31T23:00:00Z',
            },
          ],
        },
      },
    },
    compositions: {
      [COMPOSITION]: {
        id: COMPOSITION,
        version_id: 'e0000000-0000-4000-8000-000000000001',
        version: 4,
        document: composition(LOOP),
      },
    },
    media: {
      [IMAGE]: {
        id: IMAGE,
        type: 'image',
        duration_ms: null,
        playback: asset(IMAGE, 'playback', 'image/png', null),
        original: null,
      },
      [VIDEO]: {
        id: VIDEO,
        type: 'video',
        duration_ms: 30_000,
        playback: asset(VIDEO, 'playback', 'video/mp4', 30_000),
        original: null,
      },
      [WEBP]: {
        id: WEBP,
        type: 'image',
        duration_ms: null,
        playback: asset(WEBP, 'playback', 'image/webp', null),
        original: asset(WEBP.replace(/3$/, '4'), 'original', 'image/webp', null),
      },
    },
    ...overrides,
  };
}

const seed = encodeBase64url(ed25519.utils.randomSecretKey());
const signer = manifestSignerFromSeed('manifest-key-test', seed);

function compile(snap: DisplaySnapshot) {
  const prepared = prepareSnapshot(snap);
  const draft = buildDraft(prepared, { now: NOW });
  const payload = assemblePayload(prepared, draft, {
    manifestId: 'f0000000-0000-4000-8000-000000000001',
    version: '7',
  });
  const raw = JSON.stringify(
    signEnvelope(MANIFEST_ENVELOPE_TYPE, signer.kid, payload, signer.secretKey),
  );
  return { prepared, draft, payload, raw };
}

const micros = (text: string) => parseInstantMicros(text)!;

describe('compilateur de manifests', () => {
  it('produit un manifest signé, valide et accepté par un Player de la bonne affectation', () => {
    const { draft, raw } = compile(snapshot());
    expect(draft.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const verified = verifyManifest(raw, new Map([[signer.kid, signer.publicKey]]));
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    const local = {
      organization_id: ORG,
      player_id: PLAYER,
      displays: new Map([
        [DISPLAY, { assignment_generation: '2', highest_version: '6', highest_version_hash: 'x' }],
      ]),
    };
    expect(
      evaluateManifestCandidate(verified.manifest, verified.manifestHash, local, NOW.toISOString()),
    ).toEqual({ decision: 'accept', activate_not_before: '2026-10-05T08:00:00Z' });
    const stale = {
      ...local,
      displays: new Map([
        [
          DISPLAY,
          { assignment_generation: '3', highest_version: null, highest_version_hash: null },
        ],
      ]),
    };
    expect(
      evaluateManifestCandidate(verified.manifest, verified.manifestHash, stale, NOW.toISOString()),
    ).toEqual({ decision: 'reject', code: 'STALE_ASSIGNMENT' });
  });

  it('respecte ciblage, fuseau, priorités et validités ; le Player sélectionne le bon contenu', () => {
    const { payload } = compile(snapshot());
    expect(payload.schedule_until).toBe('2026-10-12T08:00:00Z');
    // L’override d’un autre site n’apparaît pas.
    expect(payload.timeline.some((e) => e.source.id === OVERRIDE)).toBe(false);
    const at = (iso: string) => selectAt(payload, micros(iso));
    // 09:00–18:00 Europe/Paris = 07:00–16:00 UTC en octobre (CEST).
    const morning = at('2026-10-06T07:30:00Z');
    expect(morning.kind).toBe('timeline');
    if (morning.kind === 'timeline') expect(morning.entry.source.id).toBe(SCHEDULE);
    expect(at('2026-10-06T06:59:59Z').kind).toBe('fallback');
    // Campagne : vidéo + image jusqu’à 09:00Z, puis image seule (nouvelle entrée).
    const early = at('2026-10-06T08:30:00Z');
    const late = at('2026-10-06T09:30:00Z');
    expect(early.kind === 'timeline' && early.entry.source.type).toBe('campaign');
    expect(late.kind === 'timeline' && late.entry.source.type).toBe('campaign');
    if (early.kind !== 'timeline' || late.kind !== 'timeline') return;
    const content = (ref: string) => payload.contents.find((c) => c.id === ref)!;
    const earlyPlaylist = content(early.contentRef);
    const latePlaylist = content(late.contentRef);
    expect(
      earlyPlaylist.type === 'playlist' && earlyPlaylist.items.map((i) => i.duration_ms),
    ).toEqual([30_000, 8000]);
    expect(
      latePlaylist.type === 'playlist' && latePlaylist.items.map((i) => i.duration_ms),
    ).toEqual([8000]);
    // Après l’horizon : fallback permanent (sans l’élément à fin de validité).
    const after = at('2026-10-20T12:00:00Z');
    expect(after.kind).toBe('fallback');
    const fallback = content(payload.fallback.content_ref!);
    expect(fallback.type === 'playlist' && fallback.items).toHaveLength(1);
    expect(payload.fallback.after_schedule).toBe('play_fallback');
  });

  it('résout la zone playlist de la composition et déclare assets et capacités requis', () => {
    const { payload } = compile(snapshot());
    const compositionContent = payload.contents.find((c) => c.type === 'composition')!;
    expect(
      compositionContent.type === 'composition' && compositionContent.composition_version_id,
    ).toBe('e0000000-0000-4000-8000-000000000001');
    const zone =
      compositionContent.type === 'composition' &&
      compositionContent.document.elements.find((e) => e.type === 'playlist_zone');
    expect(
      zone &&
        zone.type === 'playlist_zone' &&
        payload.contents.some((c) => c.id === zone.props.content_ref),
    ).toBe(true);
    expect(payload.assets.map((a) => a.mime_type).sort()).toEqual(['image/png', 'video/mp4']);
    expect(payload.required_capabilities).toEqual({
      render_schema: 1,
      image_types: ['image/png'],
      video_profiles: ['mp4-h264-aac'],
    });
  });

  it('est déterministe : même snapshot, même payload et même empreinte d’entrée', () => {
    const a = compile(snapshot());
    const b = compile(snapshot({ programs: [...snapshot().programs].reverse() }));
    expect(b.prepared.inputHash).toBe(a.prepared.inputHash);
    expect(b.payload).toEqual(a.payload);
    // Une donnée hors périmètre du Display ne change pas l’empreinte.
    const unrelated = snapshot();
    unrelated.media[WEBP] = { ...unrelated.media[WEBP]!, duration_ms: 1 };
    expect(prepareSnapshot(unrelated).inputHash).toBe(a.prepared.inputHash);
    const changed = snapshot();
    changed.playlists[PLAYLIST] = {
      ...changed.playlists[PLAYLIST]!,
      version_id: 'd0000000-0000-4000-8000-000000000009',
    };
    expect(prepareSnapshot(changed).inputHash).not.toBe(a.prepared.inputHash);
  });

  it('explique chaque intervalle : source, priorité, règles masquées', () => {
    const { draft } = compile(snapshot());
    const campaign = draft.explanation.find((e) => e.winner?.program_id === CAMPAIGN)!;
    expect(campaign.winner).toMatchObject({ kind: 'campaign', priority: 50 });
    expect(campaign.masked).toEqual([
      {
        kind: 'schedule',
        program_id: SCHEDULE,
        rule_id: RULE,
        priority: 10,
        reason: 'lower_priority',
      },
    ]);
    const schedule = draft.explanation.find((e) => e.winner?.program_id === SCHEDULE)!;
    expect(schedule.winner?.local).toEqual({
      date: '2026-10-05',
      start_time: '09:00',
      end_time: '18:00',
      timezone: 'Europe/Paris',
    });
  });

  it('préflight : capacités, types d’images, canvas, vidéos et cache contrôlés', () => {
    const check = (caps: PlayerCapabilities | null, extra: Partial<DisplaySnapshot> = {}) => {
      const snap = snapshot({
        assignment: { player_id: PLAYER, generation: '2', capabilities: caps },
        ...extra,
      });
      const prepared = prepareSnapshot(snap);
      const draft = buildDraft(prepared, { now: NOW });
      return [...draft.issues, ...preflight(prepared, draft)]
        .filter((i) => i.severity === 'error')
        .map((i) => i.code);
    };
    expect(check(capabilities())).toEqual([]);
    expect(check(null)).toContain('CAPABILITIES_UNKNOWN');
    expect(check(capabilities({ manifest_schemas: [2] }))).toContain('UNSUPPORTED_SCHEMA');
    expect(check(capabilities({ image_types: ['image/jpeg'] }))).toContain(
      'UNSUPPORTED_IMAGE_TYPE',
    );
    expect(check(capabilities({ video_profiles: [] }))).toContain('UNSUPPORTED_VIDEO_PROFILE');
    expect(check(capabilities({ max_canvas: { width: 1280, height: 720 } }))).toContain(
      'CANVAS_TOO_LARGE',
    );
    expect(check(capabilities({ storage_quota_bytes: 10 }))).toContain('CACHE_TOO_SMALL');
    // Image WebP : variante lisible choisie, sinon refus.
    const webp = snapshot();
    webp.display.fallback = { type: 'media', id: WEBP };
    expect(
      check(capabilities({ image_types: ['image/png', 'image/webp'] }), { display: webp.display }),
    ).toEqual([]);
  });

  it('détecte un cycle playlist → composition → playlist', () => {
    const snap = snapshot();
    snap.playlists[LOOP]!.document.items.push({
      id: ITEM(6),
      content: { type: 'composition', id: COMPOSITION },
      duration_ms: 10_000,
      enabled: true,
      valid_from: null,
      valid_until: null,
    });
    const prepared = prepareSnapshot(snap);
    const draft = buildDraft(prepared, { now: NOW });
    expect(draft.issues.map((i) => i.code)).toContain('CONTENT_CYCLE');
  });

  it('sans programme ni fallback : timeline vide et écran d’attente', () => {
    const { payload } = compile(
      snapshot({ programs: [], display: { ...snapshot().display, fallback: null } }),
    );
    expect(payload.timeline).toEqual([]);
    expect(payload.fallback).toEqual({ content_ref: null, after_schedule: 'standby_screen' });
    expect(selectAt(payload, micros('2026-10-05T10:00:00Z')).kind).toBe('standby');
  });
});
