import { normalizeUrl } from "../../convex/lib/domain";
import type { PageRecord } from "./content";
import { buildCacheKey } from "./content";

export interface PageCacheEntry {
  page: PageRecord;
  content_hash: string;
  cached_at: number;
  extractor_version: string;
}

export interface CacheStats {
  hits: number;
  misses: number;
  stored: number;
  invalidated: number;
}

const DEFAULT_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export class PageCache {
  private store: Map<string, PageCacheEntry>;
  private hits = 0;
  private misses = 0;
  private stored = 0;
  private invalidated = 0;
  private freshnessMs: number;

  constructor(freshnessMs: number = DEFAULT_FRESHNESS_MS) {
    this.store = new Map();
    this.freshnessMs = freshnessMs;
  }

  buildKey(url: string, extractorVersion: string): string {
    return buildCacheKey(url, extractorVersion);
  }

  computeContentHash(html: string): string {
    let hash = 0;
    for (let i = 0; i < html.length; i++) {
      const char = html.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  async get(url: string, extractorVersion: string): Promise<PageRecord | null> {
    const key = this.buildKey(url, extractorVersion);
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    const now = Date.now();
    if (now - entry.cached_at > this.freshnessMs) {
      this.store.delete(key);
      this.invalidated++;
      this.misses++;
      return null;
    }

    if (entry.extractor_version !== extractorVersion) {
      this.store.delete(key);
      this.invalidated++;
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.page;
  }

  async set(
    url: string,
    extractorVersion: string,
    html: string,
    page: PageRecord,
  ): Promise<void> {
    const key = this.buildKey(url, extractorVersion);
    const content_hash = this.computeContentHash(html);
    this.store.set(key, {
      page,
      content_hash,
      cached_at: Date.now(),
      extractor_version: extractorVersion,
    });
    this.stored++;
  }

  invalidate(): number {
    const now = Date.now();
    let count = 0;
    for (const [key, entry] of this.store.entries()) {
      if (now - entry.cached_at > this.freshnessMs) {
        this.store.delete(key);
        count++;
      }
    }
    this.invalidated += count;
    return count;
  }

  invalidateVersion(extractorVersion: string): number {
    let count = 0;
    for (const [key, entry] of this.store.entries()) {
      if (entry.extractor_version !== extractorVersion) {
        this.store.delete(key);
        count++;
      }
    }
    this.invalidated += count;
    return count;
  }

  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
    this.stored = 0;
    this.invalidated = 0;
  }

  stats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      stored: this.stored,
      invalidated: this.invalidated,
    };
  }

  hitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }
}
