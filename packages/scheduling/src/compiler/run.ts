/**
 * Compilation d’un Display avec la base (DATA-010, ADR-011) : snapshot cohérent, empreinte
 * d’entrée, préflight, puis allocation de version, signature et enregistrement sous verrou
 * du Display si la révision compilée est encore la révision désirée.
 */
import { randomUUID } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  decodeBase64url,
  MANIFEST_ENVELOPE_TYPE,
  signEnvelope,
  verifyManifest,
} from '@pixlova/contracts';
import { enqueueJob, schema, withTenant, type Database, type Transaction } from '@pixlova/db';
import {
  assemblePayload,
  buildDraft,
  preflight,
  prepareSnapshot,
  RENEWAL_THRESHOLD_MS,
  type ManifestDraft,
} from './build.js';
import { loadSnapshot } from './snapshot.js';
import type { CompileIssue, ExplanationEntry } from './types.js';

export const COMPILE_DISPLAY = 'compile_display';

export interface ManifestSigner {
  kid: string;
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

const KID = /^[a-z0-9][a-z0-9-]{2,63}$/;

/** Clé Ed25519 du compilateur depuis sa graine (32 octets, base64url). */
export function manifestSignerFromSeed(kid: string, seed: string): ManifestSigner {
  if (!KID.test(kid)) throw new Error('Identifiant de clé de manifest invalide.');
  const secretKey = decodeBase64url(seed);
  if (!secretKey || secretKey.length !== 32)
    throw new Error('La graine de signature doit faire 32 octets.');
  return { kid, secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

/**
 * Incrémente la révision désirée des Displays concernés et enfile leur compilation, dans la
 * transaction de la décision métier (outbox). `'all'` : tous les Displays du tenant.
 */
export async function requestRecompile(
  tx: Transaction,
  organizationId: string,
  displays: readonly string[] | 'all',
  reason: string,
): Promise<number> {
  if (displays !== 'all' && displays.length === 0) return 0;
  const bumped = await tx
    .update(schema.displays)
    .set({ configRevision: sql`${schema.displays.configRevision} + 1` })
    .where(
      and(
        eq(schema.displays.organizationId, organizationId),
        isNull(schema.displays.deletedAt),
        ...(displays === 'all' ? [] : [inArray(schema.displays.id, [...displays])]),
      ),
    )
    .returning({ id: schema.displays.id, revision: schema.displays.configRevision });
  for (const display of bumped) {
    await enqueueJob(tx, {
      organizationId,
      kind: COMPILE_DISPLAY,
      dedupeKey: `${display.id}:${display.revision.toString()}`,
      payload: {
        display_id: display.id,
        config_revision: display.revision.toString(),
        reason: reason.slice(0, 64),
      },
    });
  }
  return bumped.length;
}

export type CompileOutcome =
  | { status: 'missing' | 'stale' }
  | { status: 'unassigned' | 'unchanged' | 'superseded'; compilationId: string }
  | { status: 'rejected'; compilationId: string; issues: CompileIssue[] }
  | { status: 'published'; compilationId: string; manifestId: string; version: string };

export interface CompileOptions {
  db: Database;
  organizationId: string;
  displayId: string;
  /** Révision de la tâche ; une révision désirée plus récente rend la tâche caduque. */
  configRevision?: string;
  signer: ManifestSigner;
  now: Date;
  horizonMs?: number;
  /** Tests : exécuté entre la préparation et la validation sous verrou (révision concurrente). */
  beforeCommit?: () => Promise<void>;
}

async function record(
  tx: Transaction,
  values: {
    organizationId: string;
    displayId: string;
    configRevision: string;
    status: 'published' | 'unchanged' | 'superseded' | 'rejected' | 'unassigned';
    inputHash?: string | null;
    manifestId?: string | null;
    issues?: CompileIssue[];
    explanation?: ExplanationEntry[] | null;
    draft?: ManifestDraft;
  },
): Promise<string> {
  const [row] = await tx
    .insert(schema.displayCompilations)
    .values({
      organizationId: values.organizationId,
      displayId: values.displayId,
      configRevision: BigInt(values.configRevision),
      status: values.status,
      inputHash: values.inputHash ?? null,
      manifestId: values.manifestId ?? null,
      issues: values.issues ?? [],
      explanation: values.explanation ?? null,
      windowFrom: values.draft ? new Date(values.draft.generatedAt) : null,
      windowUntil: values.draft ? new Date(values.draft.scheduleUntil) : null,
    })
    .returning({ id: schema.displayCompilations.id });
  return row!.id;
}

class RejectedError extends Error {
  constructor(readonly issues: CompileIssue[]) {
    super('Manifest refusé au préflight.');
  }
}

export async function compileDisplay(options: CompileOptions): Promise<CompileOutcome> {
  const { db, organizationId, displayId, now, signer } = options;
  const snapshot = await withTenant(db, organizationId, (tx) => loadSnapshot(tx, displayId, now), {
    isolationLevel: 'repeatable read',
  });
  if (!snapshot) return { status: 'missing' };
  if (options.configRevision !== undefined && snapshot.config_revision !== options.configRevision) {
    return { status: 'stale' };
  }
  const base = { organizationId, displayId, configRevision: snapshot.config_revision };
  if (!snapshot.assignment) {
    const compilationId = await withTenant(db, organizationId, (tx) =>
      record(tx, { ...base, status: 'unassigned' }),
    );
    return { status: 'unassigned', compilationId };
  }
  const assignment = snapshot.assignment;
  const prepared = prepareSnapshot(snapshot);

  const latestManifest = (tx: Transaction) =>
    tx
      .select({
        inputHash: schema.manifests.inputHash,
        assignmentGeneration: schema.manifests.assignmentGeneration,
        scheduleUntil: schema.manifests.scheduleUntil,
      })
      .from(schema.manifests)
      .where(eq(schema.manifests.displayId, displayId))
      .orderBy(desc(schema.manifests.version))
      .limit(1)
      .then((rows) => rows[0]);
  const isCurrent = (latest: Awaited<ReturnType<typeof latestManifest>>) =>
    !!latest &&
    latest.inputHash === prepared.inputHash &&
    latest.assignmentGeneration.toString() === assignment.generation &&
    latest.scheduleUntil.getTime() - now.getTime() >= RENEWAL_THRESHOLD_MS;

  // Publication idempotente : mêmes entrées, même affectation, horizon suffisant.
  const current = await withTenant(db, organizationId, latestManifest);
  if (isCurrent(current)) {
    const compilationId = await withTenant(db, organizationId, (tx) =>
      record(tx, { ...base, status: 'unchanged', inputHash: prepared.inputHash }),
    );
    return { status: 'unchanged', compilationId };
  }

  const draft = buildDraft(prepared, {
    now,
    ...(options.horizonMs ? { horizonMs: options.horizonMs } : {}),
  });
  const issues = [...draft.issues, ...preflight(prepared, draft)];
  const rejected = async (list: CompileIssue[]): Promise<CompileOutcome> => {
    const compilationId = await withTenant(db, organizationId, (tx) =>
      record(tx, {
        ...base,
        status: 'rejected',
        inputHash: prepared.inputHash,
        issues: list,
        explanation: draft.explanation,
        draft,
      }),
    );
    return { status: 'rejected', compilationId, issues: list };
  };
  if (issues.some((issue) => issue.severity === 'error')) return rejected(issues);

  await options.beforeCommit?.();
  try {
    return await withTenant(db, organizationId, async (tx) => {
      const [display] = await tx
        .select({
          configRevision: schema.displays.configRevision,
          manifestVersion: schema.displays.manifestVersion,
        })
        .from(schema.displays)
        .where(eq(schema.displays.id, displayId))
        .for('update');
      if (!display || display.configRevision.toString() !== snapshot.config_revision) {
        // Une révision plus récente est désirée : sa tâche produira le manifest.
        const compilationId = await record(tx, {
          ...base,
          status: 'superseded',
          inputHash: prepared.inputHash,
        });
        return { status: 'superseded', compilationId };
      }
      if (isCurrent(await latestManifest(tx))) {
        const compilationId = await record(tx, {
          ...base,
          status: 'unchanged',
          inputHash: prepared.inputHash,
        });
        return { status: 'unchanged', compilationId };
      }
      const version = display.manifestVersion + 1n;
      const manifestId = randomUUID();
      const payload = assemblePayload(prepared, draft, {
        manifestId,
        version: version.toString(),
      });
      const envelope = signEnvelope(MANIFEST_ENVELOPE_TYPE, signer.kid, payload, signer.secretKey);
      const raw = JSON.stringify(envelope);
      // Préflight 3 et 4 : schéma, cohérence et signature vérifiés comme un Player.
      const verified = verifyManifest(raw, new Map([[signer.kid, signer.publicKey]]));
      if (!verified.ok) {
        throw new RejectedError([
          {
            severity: 'error',
            code:
              verified.code === 'SIGNATURE_INVALID' ? 'SIGNATURE_CHECK_FAILED' : 'MANIFEST_INVALID',
            ref: verified.reason ?? null,
            message: verified.detail.slice(0, 500),
          },
        ]);
      }
      await tx
        .update(schema.displays)
        .set({ manifestVersion: version })
        .where(eq(schema.displays.id, displayId));
      await tx.insert(schema.manifests).values({
        id: manifestId,
        organizationId,
        displayId,
        playerId: assignment.player_id,
        version,
        assignmentGeneration: BigInt(assignment.generation),
        configRevision: BigInt(snapshot.config_revision),
        schemaVersion: payload.schema_version,
        payloadHash: verified.manifestHash,
        inputHash: prepared.inputHash,
        keyId: signer.kid,
        envelope: raw,
        generatedAt: new Date(draft.generatedAt),
        validFrom: new Date(draft.generatedAt),
        scheduleUntil: new Date(draft.scheduleUntil),
      });
      if (payload.assets.length > 0) {
        await tx
          .insert(schema.manifestAssets)
          .values(
            payload.assets.map((asset) => ({ organizationId, manifestId, mediaAssetId: asset.id })),
          );
      }
      await tx
        .update(schema.manifestDeliveries)
        .set({ state: 'superseded', updatedAt: now })
        .where(
          and(
            eq(schema.manifestDeliveries.displayId, displayId),
            inArray(schema.manifestDeliveries.state, [
              'desired',
              'received',
              'downloading',
              'ready',
            ]),
          ),
        );
      await tx.insert(schema.manifestDeliveries).values({
        organizationId,
        manifestId,
        displayId,
        playerId: assignment.player_id,
        assignmentGeneration: BigInt(assignment.generation),
      });
      await tx.insert(schema.outboxEvents).values({
        organizationId,
        aggregateType: 'display',
        aggregateId: displayId,
        eventType: 'manifest.desired',
        payload: {
          manifest_id: manifestId,
          version: version.toString(),
          player_id: assignment.player_id,
        },
      });
      const compilationId = await record(tx, {
        ...base,
        status: 'published',
        inputHash: prepared.inputHash,
        manifestId,
        issues,
        explanation: draft.explanation,
        draft,
      });
      return { status: 'published', compilationId, manifestId, version: version.toString() };
    });
  } catch (error) {
    if (error instanceof RejectedError) return rejected([...issues, ...error.issues]);
    throw error;
  }
}

/**
 * Displays affectés dont l’horizon désiré s’épuise (PLN-011) ou qui n’ont encore aucun
 * manifest, sans compilation active ni refus récent pour leur révision. Rôle système.
 */
export async function scheduleRenewals(system: Database, now: Date): Promise<number> {
  const threshold = new Date(now.getTime() + RENEWAL_THRESHOLD_MS);
  const recent = new Date(now.getTime() - 60 * 60_000);
  const candidates = await system.execute<{
    id: string;
    organization_id: string;
    config_revision: string;
  }>(sql`
    select d.id, d.organization_id, d.config_revision::text as config_revision
    from displays d
    join display_assignments a on a.display_id = d.id and a.ended_at is null
    left join lateral (
      select m.schedule_until from manifests m where m.display_id = d.id
      order by m.version desc limit 1
    ) latest on true
    where d.deleted_at is null
      and (latest.schedule_until is null or latest.schedule_until < ${threshold})
      and not exists (
        select 1 from display_compilations c
        where c.display_id = d.id and c.config_revision = d.config_revision
          and c.status in ('rejected', 'unassigned') and c.created_at > ${recent}
      )
    limit 500`);
  let count = 0;
  for (const row of candidates.rows) {
    const job = await enqueueJob(system, {
      organizationId: row.organization_id,
      kind: COMPILE_DISPLAY,
      dedupeKey: `${row.id}:${row.config_revision}`,
      payload: { display_id: row.id, config_revision: row.config_revision, reason: 'renewal' },
    });
    if (job.created) count += 1;
  }
  return count;
}
