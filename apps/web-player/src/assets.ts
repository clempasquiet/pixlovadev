/**
 * Cache d’assets vérifiés (ADR-013, PLY-007) : Cache API, clé = SHA-256. Un asset n’est
 * déclaré présent dans IndexedDB qu’après contrôle de sa taille et de son empreinte ; un
 * contenu faux est supprimé et jamais présenté. La lecture reçoit des URL `blob:`.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Cloud } from './cloud.js';
import { idb } from './db.js';
import { planEviction, usableBytes, type BlobEntry } from './storage-policy.js';

const CACHE_NAME = 'pixlova-assets-v1';

export interface AssetRef {
  id: string;
  sha256: string;
  size_bytes: number;
  mime_type: string;
}

export class AssetError extends Error {
  constructor(
    readonly code: string,
    detail: string,
    readonly transient: boolean,
  ) {
    super(detail);
  }
}

const cacheKey = (sha: string) => new URL(`./__pixlova_asset__/${sha}`, location.href).toString();

function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'QuotaExceededError';
}

export class AssetCache {
  private readonly verified = new Set<string>();
  private readonly urls = new Map<string, string>();

  private cache(): Promise<Cache> {
    return caches.open(CACHE_NAME);
  }

  async entries(): Promise<BlobEntry[]> {
    return idb.all<BlobEntry>('assets');
  }

  private async known(asset: AssetRef): Promise<boolean> {
    const entry = await idb.get<BlobEntry>('assets', asset.sha256);
    return entry?.size === asset.size_bytes;
  }

  async missingBytes(assets: readonly AssetRef[]): Promise<number> {
    let total = 0;
    const seen = new Set<string>();
    for (const asset of assets) {
      if (seen.has(asset.sha256)) continue;
      seen.add(asset.sha256);
      if (!(await this.known(asset))) total += asset.size_bytes;
    }
    return total;
  }

  /** Libère de la place sans jamais toucher aux assets épinglés. */
  async ensureSpace(needed: number, pinned: ReadonlySet<string>): Promise<void> {
    if (needed === 0) return;
    const estimate = await navigator.storage?.estimate?.().catch(() => null);
    const plan = planEviction(await this.entries(), pinned, needed, usableBytes(estimate ?? null));
    for (const sha of plan.evict) await this.remove(sha);
    if (!plan.enough) {
      throw new AssetError('STORAGE_QUOTA_EXCEEDED', `${needed} octets requis`, true);
    }
  }

  async remove(sha: string): Promise<void> {
    await idb.delete('assets', sha);
    await (await this.cache()).delete(cacheKey(sha));
    this.verified.delete(sha);
    const url = this.urls.get(sha);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(sha);
  }

  async touch(assets: readonly AssetRef[]): Promise<void> {
    const now = Date.now();
    for (const asset of assets) {
      const entry = await idb.get<BlobEntry>('assets', asset.sha256);
      if (entry) await idb.put('assets', { ...entry, lastUsed: now }, asset.sha256);
    }
  }

  /** Télécharge un asset du manifest s’il manque ; le manifest signé fait foi. */
  async fetch(cloud: Cloud, manifestId: string, asset: AssetRef): Promise<void> {
    if (await this.known(asset)) return;
    const described = await cloud.assetUrl(asset.id, manifestId);
    if (described.sha256 !== asset.sha256 || described.size_bytes !== asset.size_bytes) {
      throw new AssetError('ASSET_MISMATCH', asset.id, false);
    }
    const address = cloud.absoluteUrl(described.url);
    if (!address) throw new AssetError('ASSET_DOWNLOAD_FAILED', 'URL invalide', true);
    let response: Response;
    try {
      response = await fetch(address, { credentials: 'omit', cache: 'no-store' });
    } catch (error) {
      throw new AssetError('ASSET_DOWNLOAD_FAILED', String(error), true);
    }
    if (!response.ok || !response.body) {
      throw new AssetError('ASSET_DOWNLOAD_FAILED', `HTTP ${response.status}`, true);
    }
    const [toHash, toStore] = response.body.tee();
    const hashing = (async () => {
      const hasher = sha256.create();
      const reader = toHash.getReader();
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > asset.size_bytes) {
          await reader.cancel();
          break;
        }
        hasher.update(value);
      }
      return { size, digest: bytesToHex(hasher.digest()) };
    })();
    const cache = await this.cache();
    const key = cacheKey(asset.sha256);
    try {
      await cache.put(key, new Response(toStore, { headers: { 'content-type': asset.mime_type } }));
    } catch (error) {
      await hashing.catch(() => undefined);
      await cache.delete(key);
      if (isQuotaError(error)) {
        throw new AssetError('STORAGE_QUOTA_EXCEEDED', 'quota du navigateur atteint', true);
      }
      throw new AssetError('ASSET_DOWNLOAD_FAILED', String(error), true);
    }
    const { size, digest } = await hashing;
    if (size !== asset.size_bytes || digest !== asset.sha256) {
      await cache.delete(key);
      throw new AssetError('CHECKSUM_MISMATCH', asset.id, true);
    }
    await idb.put('assets', { sha256: asset.sha256, size, lastUsed: Date.now() }, asset.sha256);
    this.verified.add(asset.sha256);
  }

  /** Recontrôle complet avant la première présentation de la session. */
  async verify(asset: AssetRef): Promise<boolean> {
    if (this.verified.has(asset.sha256)) return true;
    const response = await (await this.cache()).match(cacheKey(asset.sha256));
    let ok = false;
    if (response?.body) {
      // Lecture en flux : une vidéo n’est jamais chargée entière en mémoire.
      const hasher = sha256.create();
      const reader = response.body.getReader();
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        hasher.update(value);
      }
      ok = size === asset.size_bytes && bytesToHex(hasher.digest()) === asset.sha256;
    }
    if (ok) this.verified.add(asset.sha256);
    else await this.remove(asset.sha256);
    return ok;
  }

  /** URL locale d’un asset vérifié, pour la lecture. */
  async objectUrl(sha: string): Promise<string | null> {
    const existing = this.urls.get(sha);
    if (existing) return existing;
    const response = await (await this.cache()).match(cacheKey(sha));
    if (!response) return null;
    const url = URL.createObjectURL(await response.blob());
    this.urls.set(sha, url);
    return url;
  }

  urlFor(sha: string): string {
    return this.urls.get(sha) ?? 'about:blank';
  }

  /** Libère les URL des assets qui ne sont plus utiles à l’écran. */
  releaseExcept(keep: ReadonlySet<string>): void {
    for (const [sha, url] of this.urls) {
      if (!keep.has(sha)) {
        URL.revokeObjectURL(url);
        this.urls.delete(sha);
      }
    }
  }
}
