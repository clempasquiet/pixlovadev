import { and, desc, eq } from 'drizzle-orm';
import { compareReleaseVersions, parseReleaseVersion } from '@pixlova/contracts';
import { schema, type Database, type Transaction } from '@pixlova/db';

/** Version du protocole Player servie par cette API (PROTO-*, ADR-012). */
export const PLAYER_PROTOCOL_VERSION = 1;

/** Plateformes servies par le registre (NAT-013). */
export const RELEASE_OS = ['linux', 'windows'] as const;
export const RELEASE_ARCHITECTURES = ['x86_64', 'aarch64'] as const;
export type ReleaseOs = (typeof RELEASE_OS)[number];
export type ReleaseArchitecture = (typeof RELEASE_ARCHITECTURES)[number];

export interface DistributedRelease {
  id: string;
  version: string;
  envelope: string;
  sha256: string;
  sizeBytes: number;
  artifactKey: string;
}

/** Plateforme d’un Player natif connue du registre, sinon `null` (Player Web, autre OS). */
export function releasePlatform(player: {
  type: string;
  os: string | null;
  architecture: string | null;
}): { os: ReleaseOs; architecture: ReleaseArchitecture } | null {
  if (player.type !== 'native') return null;
  const os = RELEASE_OS.find((value) => value === player.os);
  const architecture = RELEASE_ARCHITECTURES.find((value) => value === player.architecture);
  return os && architecture ? { os, architecture } : null;
}

/**
 * Release souhaitée d’une plateforme (PLY-005, ADR-019) : la publiée la plus récente.
 * Les brouillons et les releases bloquées ne sont jamais distribués.
 */
export async function desiredRelease(
  db: Database | Transaction,
  platform: { os: ReleaseOs; architecture: ReleaseArchitecture },
): Promise<DistributedRelease | null> {
  const t = schema.playerReleases;
  const [row] = await db
    .select({
      id: t.id,
      version: t.version,
      envelope: t.envelope,
      sha256: t.sha256,
      sizeBytes: t.sizeBytes,
      artifactKey: t.artifactKey,
    })
    .from(t)
    .where(
      and(
        eq(t.os, platform.os),
        eq(t.architecture, platform.architecture),
        eq(t.status, 'published'),
      ),
    )
    .orderBy(desc(t.versionMajor), desc(t.versionMinor), desc(t.versionPatch))
    .limit(1);
  if (!row?.artifactKey) return null;
  return { ...row, artifactKey: row.artifactKey };
}

/** La version donnée est-elle une release bloquée de cette plateforme ? */
export async function isBlockedVersion(
  db: Database | Transaction,
  platform: { os: ReleaseOs; architecture: ReleaseArchitecture },
  version: string,
): Promise<boolean> {
  const t = schema.playerReleases;
  const [row] = await db
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        eq(t.os, platform.os),
        eq(t.architecture, platform.architecture),
        eq(t.version, version),
        eq(t.status, 'blocked'),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Vrai si `candidate` est une version SemVer strictement postérieure à `current`. */
export function isNewerVersion(candidate: string, current: string | null): boolean {
  if (!current || !parseReleaseVersion(current)) return true;
  return compareReleaseVersions(candidate, current) > 0;
}
