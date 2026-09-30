/**
 * Réception et activation atomique des manifests (PLY-007, PROTO-013), comme le Player
 * natif : le manifest courant ne change qu’à la première image du candidat, après
 * vérification complète de ses ressources. Une préparation incomplète laisse le dernier
 * manifest valide et remonte sa cause.
 */
import {
  evaluateManifestCandidate,
  verifyManifest,
  type ManifestPayload,
  type TrustStore,
} from '@pixlova/contracts';
import { AssetError, type AssetCache, type AssetRef } from './assets.js';
import type { Cloud } from './cloud.js';
import { HostError, type PlayerHost } from './host.js';
import { instant, state, type DisplayState } from './state.js';

/** Délai de confirmation de la première image [à valider], comme le natif. */
export const ACTIVATION_TIMEOUT_MS = 30_000;
const RETRY_BASE_MS = 10_000;
const RETRY_MAX_MS = 10 * 60_000;

export type Outcome =
  | { kind: 'idle' }
  | { kind: 'applied'; manifestId: string }
  | { kind: 'waiting'; reason: string }
  | { kind: 'retrying'; code: string }
  | { kind: 'failed'; code: string };

interface Verified {
  manifest: ManifestPayload;
  hash: string;
}

function assetsOf(manifest: ManifestPayload): AssetRef[] {
  return manifest.assets.map((a) => ({
    id: a.id,
    sha256: a.sha256,
    size_bytes: a.size_bytes,
    mime_type: a.mime_type,
  }));
}

export class WebPipeline {
  private retry: {
    manifestId: string;
    attempts: number;
    nextAt: number;
    reported: string | null;
  } | null = null;

  constructor(
    private readonly cloud: Cloud,
    private readonly assets: AssetCache,
    private readonly trust: TrustStore,
    private readonly host: PlayerHost,
    private readonly now: () => number = Date.now,
  ) {}

  private verify(raw: string): Verified | { code: string } {
    const result = verifyManifest(raw, this.trust);
    return result.ok
      ? { manifest: result.manifest, hash: result.manifestHash }
      : { code: result.code };
  }

  private async load(id: string): Promise<Verified | null> {
    const stored = await state.manifest(id);
    if (!stored) return null;
    const verified = this.verify(stored.envelope);
    return 'manifest' in verified && verified.manifest.manifest_id === id ? verified : null;
  }

  /** Épinglage : courant, précédent, candidat (jamais évincés). */
  async pinned(): Promise<Set<string>> {
    const display = await state.display();
    const pinned = new Set<string>();
    for (const id of [
      display?.current,
      display?.previous,
      display?.staging,
      display?.intent?.new,
    ]) {
      if (!id) continue;
      const loaded = await this.load(id);
      for (const asset of loaded?.manifest.assets ?? []) pinned.add(asset.sha256);
    }
    return pinned;
  }

  /** Étapes 1-2 : réception, vérification, acceptation, staging. */
  async fetchCandidate(
    organizationId: string,
    playerId: string,
    display: DisplayState,
  ): Promise<void> {
    const fetched = await this.cloud.manifest(display.display_id, display.highest_hash);
    if (fetched.kind !== 'envelope') return;
    const verified = this.verify(fetched.raw);
    if (!('manifest' in verified)) {
      await state.saveDisplay({ ...display, last_error: verified.code });
      return;
    }
    const { manifest, hash } = verified;
    const decision = evaluateManifestCandidate(
      manifest,
      hash,
      {
        organization_id: organizationId,
        player_id: playerId,
        displays: new Map([
          [
            display.display_id,
            {
              assignment_generation: display.assignment_generation,
              highest_version: display.highest_version,
              highest_version_hash: display.highest_hash,
            },
          ],
        ]),
      },
      instant(this.now()),
    );
    if (decision.decision === 'duplicate') return;
    if (decision.decision === 'reject') {
      if (decision.code === 'VERSION_REPLAYED') return;
      await state.saveDisplay({ ...display, last_error: decision.code });
      await state.push({
        manifest_id: manifest.manifest_id,
        state: 'failed',
        error_code: decision.code,
        detail: null,
      });
      return;
    }
    await state.saveManifest({
      manifest_id: manifest.manifest_id,
      display_id: manifest.display_id,
      version: manifest.version,
      manifest_hash: hash,
      envelope: fetched.raw,
    });
    await state.saveDisplay({
      ...display,
      staging: manifest.manifest_id,
      highest_version: manifest.version,
      highest_hash: hash,
      last_error: null,
    });
    await state.push({
      manifest_id: manifest.manifest_id,
      state: 'downloading',
      error_code: null,
      detail: null,
    });
    this.retry = null;
  }

  /** Étapes 3 à 9 ; sans effet sur l’écran tant que la première image n’est pas confirmée. */
  async advance(): Promise<Outcome> {
    const display = await state.display();
    const candidate = display?.staging;
    if (!display || !candidate) return { kind: 'idle' };
    if (this.retry?.manifestId === candidate && this.retry.nextAt > this.now()) {
      return { kind: 'waiting', reason: 'retry' };
    }
    const verified = await this.load(candidate);
    if (!verified) {
      await state.saveDisplay({ ...display, staging: null, last_error: 'MANIFEST_INVALID' });
      return { kind: 'failed', code: 'MANIFEST_INVALID' };
    }
    try {
      return await this.prepareAndActivate(display, verified.manifest);
    } catch (error) {
      const code =
        error instanceof AssetError || error instanceof HostError
          ? error.code
          : 'PREPARATION_FAILED';
      const detail = error instanceof Error ? error.message : String(error);
      const transient =
        (error instanceof AssetError && error.transient) ||
        (error instanceof HostError && code === 'ACTIVATION_INTERRUPTED');
      const latest = (await state.display())!;
      if (transient) {
        const attempts = this.retry?.manifestId === candidate ? this.retry.attempts + 1 : 1;
        const report = this.retry?.manifestId !== candidate || this.retry.reported !== code;
        this.retry = {
          manifestId: candidate,
          attempts,
          nextAt: this.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts, 10)),
          reported: code,
        };
        await state.saveDisplay({ ...latest, intent: null, last_error: code });
        if (report)
          await state.push({ manifest_id: candidate, state: 'failed', error_code: code, detail });
        return { kind: 'retrying', code };
      }
      this.retry = null;
      await state.saveDisplay({ ...latest, staging: null, intent: null, last_error: code });
      await state.push({ manifest_id: candidate, state: 'failed', error_code: code, detail });
      // Le candidat a pu être affiché sans confirmation : retour au manifest courant.
      if (this.host.player.activeManifestId !== latest.current) await this.restoreCurrent();
      return { kind: 'failed', code };
    }
  }

  private async prepareAndActivate(
    display: DisplayState,
    manifest: ManifestPayload,
  ): Promise<Outcome> {
    const now = this.now();
    if (now >= Date.parse(manifest.activate_before)) {
      throw new HostError('ACTIVATION_WINDOW_EXPIRED', 'fenêtre d’activation dépassée');
    }
    const assets = assetsOf(manifest);
    await this.assets.ensureSpace(await this.assets.missingBytes(assets), await this.pinned());
    for (const asset of assets) await this.assets.fetch(this.cloud, manifest.manifest_id, asset);
    for (const asset of assets) {
      if (!(await this.assets.verify(asset))) {
        throw new AssetError('CHECKSUM_MISMATCH', `asset ${asset.id} altéré`, true);
      }
    }
    if (now < Date.parse(manifest.valid_from)) return { kind: 'waiting', reason: 'valid_from' };
    await this.present(manifest);
    await state.push({
      manifest_id: manifest.manifest_id,
      state: 'ready',
      error_code: null,
      detail: null,
    });
    await state.saveDisplay({
      ...display,
      intent: { old: display.current, new: manifest.manifest_id },
    });
    await this.host.activate(manifest.manifest_id, ACTIVATION_TIMEOUT_MS);
    const latest = (await state.display())!;
    const previous =
      latest.current && latest.current !== manifest.manifest_id ? latest.current : latest.previous;
    await state.saveDisplay({
      ...latest,
      previous,
      current: manifest.manifest_id,
      staging: latest.staging === manifest.manifest_id ? null : latest.staging,
      intent: null,
      last_error: null,
    });
    await state.push({
      manifest_id: manifest.manifest_id,
      state: 'applied',
      error_code: null,
      detail: null,
    });
    await this.assets.touch(assets);
    await state.pruneManifests(
      new Set([manifest.manifest_id, previous].filter((v): v is string => !!v)),
    );
    this.assets.releaseExcept(new Set(assets.map((a) => a.sha256)));
    return { kind: 'applied', manifestId: manifest.manifest_id };
  }

  /** URL locales puis préparation par la lecture (décodage, polices). */
  private async present(manifest: ManifestPayload): Promise<void> {
    const map: Record<string, string> = {};
    for (const asset of manifest.assets) {
      const url = await this.assets.objectUrl(asset.sha256);
      if (!url) throw new AssetError('ASSET_MISSING', asset.id, true);
      map[asset.id] = asset.sha256;
    }
    await this.host.prepare(manifest.manifest_id, manifest, map);
  }

  /** Au démarrage : une intention ouverte est une activation interrompue ; on la reprend. */
  async recover(): Promise<void> {
    const display = await state.display();
    if (!display?.intent) return;
    await state.saveDisplay({ ...display, intent: null, last_error: 'ACTIVATION_INTERRUPTED' });
    await state.push({
      manifest_id: display.intent.new,
      state: 'failed',
      error_code: 'ACTIVATION_INTERRUPTED',
      detail: 'page fermée ou rechargée pendant l’activation',
    });
  }

  /** Remet à l’écran le manifest courant (ou précédent) depuis le stockage local. */
  async restoreCurrent(): Promise<boolean> {
    const display = await state.display();
    for (const id of [display?.current, display?.previous]) {
      if (!id) continue;
      const verified = await this.load(id);
      if (!verified) continue;
      const assets = assetsOf(verified.manifest);
      let complete = true;
      for (const asset of assets) complete &&= await this.assets.verify(asset);
      if (!complete) continue;
      try {
        await this.present(verified.manifest);
        await this.host.activate(id, ACTIVATION_TIMEOUT_MS);
        return true;
      } catch {
        // essai du précédent
      }
    }
    return false;
  }
}
