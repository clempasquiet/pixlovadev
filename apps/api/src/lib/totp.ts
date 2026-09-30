import { createHmac, randomBytes } from 'node:crypto';

/** TOTP RFC 6238 (SHA-1, 6 chiffres, pas de 30 s), compatible avec les applications usuelles. */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Tolérance d’un pas avant et après pour la dérive d’horloge. */
export const TOTP_WINDOW = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('Secret base32 invalide.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return code.toString().padStart(TOTP_DIGITS, '0');
}

export function currentStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/**
 * Retourne le pas accepté, ou `null`. Un pas inférieur ou égal à `lastUsedStep` est
 * refusé : un code déjà utilisé ne peut pas être rejoué.
 */
export function verifyTotp(
  secret: string,
  code: string,
  nowMs: number,
  lastUsedStep: number | null,
): number | null {
  if (!/^[0-9]{6}$/.test(code)) return null;
  const now = currentStep(nowMs);
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta++) {
    const step = now + delta;
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    if (totpAt(secret, step) === code) return step;
  }
  return null;
}

export function otpauthUri(secret: string, account: string): string {
  const label = encodeURIComponent(`pixlova:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=pixlova&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}
