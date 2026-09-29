import type { Redis } from 'ioredis';

/**
 * Limitation de débit par fenêtre fixe (SEC-002). Les seuils sont fixés par configuration.
 * En production, l’implémentation Redis partage les compteurs entre instances ; la
 * version mémoire sert aux tests et au développement mono-processus.
 */
export interface RateLimiter {
  /** Consomme une unité ; retourne le délai d’attente en secondes si la limite est atteinte. */
  hit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<{ allowed: boolean; retryAfter: number }>;
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async hit(key: string, limit: number, windowSeconds: number) {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowSeconds * 1000 };
      this.buckets.set(key, bucket);
    }
    bucket.count++;
    const allowed = bucket.count <= limit;
    return { allowed, retryAfter: allowed ? 0 : Math.ceil((bucket.resetAt - now) / 1000) };
  }
}

export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redis: Redis) {}

  async hit(key: string, limit: number, windowSeconds: number) {
    const redisKey = `pixlova:rl:${key}`;
    const results = await this.redis
      .multi()
      .incr(redisKey)
      .expire(redisKey, windowSeconds, 'NX')
      .ttl(redisKey)
      .exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    const ttl = Number(results?.[2]?.[1] ?? windowSeconds);
    const allowed = count <= limit;
    return { allowed, retryAfter: allowed ? 0 : Math.max(1, ttl) };
  }
}
