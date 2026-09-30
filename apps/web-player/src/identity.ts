/**
 * Identité de l’installation navigateur (WEBPLY-001, PROTO-002) : UUID et paire Ed25519
 * créés à la première ouverture. Avec WebCrypto Ed25519, la clé privée est non
 * extractible : IndexedDB conserve l’objet `CryptoKey`, jamais ses octets. Sinon, repli
 * sur une graine conservée par la page (protection moindre, affichée dans l’état).
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { encodeBase64url } from '@pixlova/contracts';
import { idb } from './db.js';

export type KeyProtection = 'webcrypto-non-extractible' | 'logicielle';

interface StoredIdentity {
  installation_id: string;
  public_key: string;
  protection: KeyProtection;
  private_key?: CryptoKey;
  seed?: Uint8Array;
}

export interface Identity {
  installationId: string;
  publicKey: string;
  protection: KeyProtection;
  sign(bytes: Uint8Array): Promise<string>;
}

async function createWebCrypto(): Promise<StoredIdentity | null> {
  try {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    return {
      installation_id: crypto.randomUUID(),
      public_key: encodeBase64url(raw),
      protection: 'webcrypto-non-extractible',
      private_key: pair.privateKey,
    };
  } catch {
    return null;
  }
}

function createSoftware(): StoredIdentity {
  const seed = ed25519.utils.randomSecretKey();
  return {
    installation_id: crypto.randomUUID(),
    public_key: encodeBase64url(ed25519.getPublicKey(seed)),
    protection: 'logicielle',
    seed,
  };
}

function toIdentity(stored: StoredIdentity): Identity {
  return {
    installationId: stored.installation_id,
    publicKey: stored.public_key,
    protection: stored.protection,
    async sign(bytes) {
      if (stored.private_key) {
        const signature = await crypto.subtle.sign(
          'Ed25519',
          stored.private_key,
          new Uint8Array(bytes),
        );
        return encodeBase64url(new Uint8Array(signature));
      }
      return encodeBase64url(ed25519.sign(bytes, stored.seed!));
    },
  };
}

export async function loadOrCreateIdentity(): Promise<Identity> {
  const existing = await idb.get<StoredIdentity>('kv', 'identity');
  if (existing) return toIdentity(existing);
  const created = (await createWebCrypto()) ?? createSoftware();
  await idb.put('kv', created, 'identity');
  return toIdentity(created);
}
