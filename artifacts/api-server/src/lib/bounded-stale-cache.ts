interface CacheEntry<T> {
  value?: T;
  weight: number;
  freshUntil: number;
  staleUntil: number;
  inFlight?: Promise<T>;
}

export interface BoundedStaleCacheOptions {
  maxEntries: number;
  /** Approximate retained bytes. Entries over this budget are not retained. */
  maxWeight?: number;
  estimateWeight?: (value: unknown) => number;
  freshMs: number;
  staleMs: number;
  now?: () => number;
}

export type BoundedStaleCacheStatus =
  | "hit"
  | "stale"
  | "in-flight"
  | "miss";

/**
 * Conservative graph-size estimate for enforcing process-cache budgets. It
 * observes only types, collection sizes and string lengths; no values leave
 * the process or enter logs.
 */
export function estimateRetainedBytes(value: unknown): number {
  const seen = new WeakSet<object>();
  const pending: unknown[] = [value];
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || current === undefined) continue;
    if (typeof current === "string") {
      bytes += 16 + current.length * 2;
      continue;
    }
    if (typeof current === "number" || typeof current === "bigint") {
      bytes += 16;
      continue;
    }
    if (typeof current === "boolean") {
      bytes += 8;
      continue;
    }
    if ((typeof current !== "object" && typeof current !== "function") ||
        seen.has(current)) continue;
    seen.add(current);
    bytes += 64;
    if (current instanceof Map) {
      bytes += current.size * 48;
      for (const [key, item] of current) pending.push(key, item);
    } else if (current instanceof Set) {
      bytes += current.size * 32;
      for (const item of current) pending.push(item);
    } else if (Array.isArray(current)) {
      bytes += current.length * 8;
      for (const item of current) pending.push(item);
    } else if (!(current instanceof Date)) {
      const entries = Object.entries(current);
      bytes += entries.length * 24;
      for (const [key, item] of entries) pending.push(key, item);
    }
  }
  return bytes;
}

export class TaskSchedulerBusyError extends Error {
  readonly status = 503;

  constructor() {
    super("Reporting capacity is temporarily busy; retry shortly");
    this.name = "TaskSchedulerBusyError";
  }
}

interface ScheduledTask<T> {
  operation: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/** Bounds both active heavyweight work and closures waiting to start it. */
export class BoundedTaskScheduler {
  private active = 0;
  private readonly queue: ScheduledTask<unknown>[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 ||
        !Number.isInteger(maxQueued) || maxQueued < 0) {
      throw new Error("BoundedTaskScheduler requires valid concurrency limits");
    }
  }

  schedule<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active < this.maxConcurrent) {
      return this.start(operation);
    }
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(new TaskSchedulerBusyError());
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        operation,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
  }

  private start<T>(operation: () => Promise<T>): Promise<T> {
    this.active += 1;
    const result = Promise.resolve().then(operation);
    void result.finally(() => {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) this.start(next.operation).then(next.resolve, next.reject);
    }).catch(() => {
      // The caller observes the original result; consume the finally chain.
    });
    return result;
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.length;
  }
}

/**
 * Process-local, bounded LRU cache. Cold misses are single-flight; expired
 * authorized successes remain available while one same-key refresh runs.
 */
export class BoundedStaleCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly now: () => number;
  private retainedWeight = 0;

  constructor(private readonly options: BoundedStaleCacheOptions) {
    if (options.maxEntries < 1 || options.freshMs < 0 || options.staleMs < 0) {
      throw new Error("BoundedStaleCache requires positive capacity and non-negative TTLs");
    }
    if (options.maxWeight !== undefined &&
        (!Number.isFinite(options.maxWeight) || options.maxWeight < 1)) {
      throw new Error("BoundedStaleCache requires a positive finite weight budget");
    }
    this.now = options.now ?? Date.now;
  }

  private touch(key: string, entry: CacheEntry<T>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.retainedWeight -= entry.weight;
    this.entries.delete(key);
  }

  private pruneExpired(at = this.now()): void {
    for (const [key, entry] of this.entries) {
      if (!entry.inFlight && entry.value !== undefined && at >= entry.staleUntil) {
        this.delete(key);
      }
    }
  }

  private storeValue(entry: CacheEntry<T>, value: T, storedAt: number): void {
    this.retainedWeight -= entry.weight;
    entry.value = value;
    entry.weight = Math.max(
      0,
      Math.ceil(this.options.estimateWeight?.(value) ?? 1),
    );
    this.retainedWeight += entry.weight;
    entry.freshUntil = storedAt + this.options.freshMs;
    entry.staleUntil = entry.freshUntil + this.options.staleMs;
  }

  private trim(): void {
    this.pruneExpired();
    while (
      this.entries.size > this.options.maxEntries ||
      (this.options.maxWeight !== undefined &&
        this.retainedWeight > this.options.maxWeight)
    ) {
      const overWeight = this.options.maxWeight !== undefined &&
        this.retainedWeight > this.options.maxWeight;
      const oldest = [...this.entries].find(([, entry]) =>
        !entry.inFlight && (!overWeight || entry.weight > 0))?.[0];
      if (oldest === undefined) return;
      this.delete(oldest);
    }
  }

  get size(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  get weight(): number {
    this.pruneExpired();
    return this.retainedWeight;
  }

  status(key: string): BoundedStaleCacheStatus {
    const at = this.now();
    this.pruneExpired(at);
    const current = this.entries.get(key);
    if (current?.value !== undefined && at < current.freshUntil) return "hit";
    if (current?.value !== undefined && at < current.staleUntil) return "stale";
    if (current?.inFlight) return "in-flight";
    return "miss";
  }

  getOrLoad(
    key: string,
    load: () => Promise<T>,
    options: {
      refreshStale?: boolean;
      onStale?: (staleValue: T) => T;
      onRefreshError?: (staleValue: T, error: unknown) => T;
    } = {},
  ): Promise<T> {
    const at = this.now();
    this.pruneExpired(at);
    const current = this.entries.get(key);
    if (current?.value !== undefined && at < current.freshUntil) {
      this.touch(key, current);
      return Promise.resolve(current.value);
    }
    if (current?.inFlight && current.value === undefined) return current.inFlight;
    if (current?.value !== undefined && at < current.staleUntil) {
      this.touch(key, current);
      if (!current.inFlight && options.refreshStale !== false) {
        const staleValue = current.value;
        const refresh = load().then((value) => {
          if (this.entries.get(key)?.inFlight === refresh) {
            const storedAt = this.now();
            this.storeValue(current, value, storedAt);
            current.inFlight = undefined;
            this.touch(key, current);
            this.trim();
          }
          return value;
        }, (error) => {
          if (this.entries.get(key)?.inFlight === refresh) {
            current.inFlight = undefined;
            if (options.onRefreshError) {
              current.value = options.onRefreshError(staleValue, error);
            }
          }
          return current.value ?? staleValue;
        });
        current.inFlight = refresh;
      }
      return Promise.resolve(options.onStale
        ? options.onStale(current.value)
        : current.value);
    }

    const entry: CacheEntry<T> = {
      weight: 0,
      freshUntil: 0,
      staleUntil: 0,
    };
    const inFlight = load().then((value) => {
      if (this.entries.get(key) === entry) {
        const storedAt = this.now();
        this.storeValue(entry, value, storedAt);
        entry.inFlight = undefined;
        this.touch(key, entry);
        this.trim();
      }
      return value;
    }, (error) => {
      if (this.entries.get(key) === entry) this.delete(key);
      throw error;
    });
    entry.inFlight = inFlight;
    this.entries.set(key, entry);
    this.trim();
    return inFlight;
  }
}