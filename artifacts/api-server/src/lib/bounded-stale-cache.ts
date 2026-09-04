interface CacheEntry<T> {
  value?: T;
  freshUntil: number;
  staleUntil: number;
  inFlight?: Promise<T>;
}

export interface BoundedStaleCacheOptions {
  maxEntries: number;
  freshMs: number;
  staleMs: number;
  now?: () => number;
}

/**
 * Process-local, bounded LRU cache. Cold misses are single-flight; expired
 * authorized successes remain available while one same-key refresh runs.
 */
export class BoundedStaleCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly now: () => number;

  constructor(private readonly options: BoundedStaleCacheOptions) {
    if (options.maxEntries < 1 || options.freshMs < 0 || options.staleMs < 0) {
      throw new Error("BoundedStaleCache requires positive capacity and non-negative TTLs");
    }
    this.now = options.now ?? Date.now;
  }

  private touch(key: string, entry: CacheEntry<T>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private trim(): void {
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  getOrLoad(key: string, load: () => Promise<T>): Promise<T> {
    const at = this.now();
    const current = this.entries.get(key);
    if (current?.value !== undefined && at < current.freshUntil) {
      this.touch(key, current);
      return Promise.resolve(current.value);
    }
    if (current?.inFlight && current.value === undefined) return current.inFlight;
    if (current?.value !== undefined && at < current.staleUntil) {
      this.touch(key, current);
      if (!current.inFlight) {
        const staleValue = current.value;
        const refresh = load().then((value) => {
          if (this.entries.get(key)?.inFlight === refresh) {
            const storedAt = this.now();
            this.entries.set(key, {
              value,
              freshUntil: storedAt + this.options.freshMs,
              staleUntil: storedAt + this.options.freshMs + this.options.staleMs,
            });
            this.trim();
          }
          return value;
        }, () => {
          if (this.entries.get(key)?.inFlight === refresh) {
            current.inFlight = undefined;
          }
          return staleValue;
        });
        current.inFlight = refresh;
      }
      return Promise.resolve(current.value);
    }

    const entry: CacheEntry<T> = {
      freshUntil: 0,
      staleUntil: 0,
    };
    const inFlight = load().then((value) => {
      if (this.entries.get(key) === entry) {
        const storedAt = this.now();
        entry.value = value;
        entry.inFlight = undefined;
        entry.freshUntil = storedAt + this.options.freshMs;
        entry.staleUntil = entry.freshUntil + this.options.staleMs;
        this.touch(key, entry);
        this.trim();
      }
      return value;
    }, (error) => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    });
    entry.inFlight = inFlight;
    this.entries.set(key, entry);
    this.trim();
    return inFlight;
  }
}