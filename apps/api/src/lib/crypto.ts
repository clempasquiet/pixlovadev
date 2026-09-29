import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** Jeton opaque de 256 bits, encodé en base64url (sessions, liens email, invitations). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Empreinte stockée à la place d’un jeton : une fuite de la base ne donne aucun jeton utilisable. */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Chiffrement applicatif AES-256-GCM des données sensibles au repos (secrets TOTP,
 * contenu des emails en attente). Format : `v1.<kid>.<iv>.<tag>.<chiffré>` en base64url.
 * Plusieurs clés peuvent coexister pour la rotation ; la première chiffre.
 */
export class DataCipher {
  private readonly keys: Map<string, Buffer>;
  private readonly current: string;

  constructor(keys: readonly { kid: string; key: Buffer }[]) {
    if (keys.length === 0) throw new Error('Au moins une clé de chiffrement est requise.');
    for (const { kid, key } of keys) {
      if (key.length !== 32) throw new Error(`La clé ${kid} doit faire 32 octets.`);
      if (!/^[a-z0-9-]{1,32}$/.test(kid)) throw new Error(`Identifiant de clé invalide : ${kid}`);
    }
    this.keys = new Map(keys.map(({ kid, key }) => [kid, key]));
    this.current = keys[0]!.kid;
  }

  /** `PIXLOVA_DATA_KEYS=kid1:base64,kid2:base64` (la première chiffre). */
  static fromEnv(value: string | undefined): DataCipher {
    if (!value) throw new Error('PIXLOVA_DATA_KEYS est requis.');
    return new DataCipher(
      value.split(',').map((entry) => {
        const [kid, key] = entry.split(':');
        return { kid: kid ?? '', key: Buffer.from(key ?? '', 'base64') };
      }),
    );
  }

  encrypt(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.current)!, iv);
    // Le contexte (usage) est authentifié : un chiffré ne peut pas être réutilisé ailleurs.
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', this.current, iv, cipher.getAuthTag(), data]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
      .join('.');
  }

  decrypt(payload: string, context: string): string {
    const [version, kid, iv, tag, data] = payload.split('.');
    const key = kid ? this.keys.get(kid) : undefined;
    if (version !== 'v1' || !key || !iv || !tag || data === undefined) {
      throw new Error('Données chiffrées invalides ou clé inconnue.');
    }
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
