// src/lib/free-cache.ts
// Simple in-memory TTL cache — no Redis needed for free tier traffic

export class TTLCache {
  private store = new Map<string, { value: any; expiresAt: number }>();

  constructor(private defaultTTL = 30_000) {}

  get(key: string): any | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: any, ttl?: number): any {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttl || this.defaultTTL),
    });
    return value;
  }

  async getOrFetch(key: string, fetchFn: () => Promise<any>, ttl?: number): Promise<any> {
    const cached = this.get(key);
    if (cached !== null) return cached;
    const value = await fetchFn();
    return this.set(key, value, ttl);
  }
}

// Singleton caches with different TTLs
export const gasCache     = new TTLCache(15_000);   // 15s — gas changes fast
export const priceCache   = new TTLCache(60_000);   // 60s — spot prices
export const chainCache   = new TTLCache(30_000);   // 30s — block heights
export const resolveCache = new TTLCache(300_000);  // 5min — ENS names rarely change
export const agentCache   = new TTLCache(300_000);  // 5min — registry data
