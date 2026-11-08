type Entry = { promise: Promise<unknown>; expires: number };

// Display reads share in-flight requests and a short cache. Payment validation and
// transaction submission deliberately do not use this cache.
export class RpcReadCache {
  private entries = new Map<string, Entry>();
  private queue: Promise<unknown> = Promise.resolve();
  private nextStart = 0;

  constructor(
    private options: {
      intervalMs?: number;
      maxEntries?: number;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {}

  private now = () => this.options.now?.() ?? Date.now();
  private sleep = (ms: number) =>
    this.options.sleep?.(ms) ?? new Promise<void>((resolve) => setTimeout(resolve, ms));

  read<T>(
    key: string,
    load: () => Promise<T>,
    ttl: number | ((value: T) => number) = 5000,
  ): Promise<T> {
    const cached = this.entries.get(key);
    if (cached && cached.expires > this.now()) return cached.promise as Promise<T>;
    this.entries.delete(key);
    if (this.entries.size >= (this.options.maxEntries ?? 512)) {
      const evictable = [...this.entries].find(([, entry]) => entry.expires !== Infinity);
      if (!evictable) return Promise.reject(new Error('Chain reads are busy. Please try again.'));
      this.entries.delete(evictable[0]);
    }
    const entry: Entry = { expires: Infinity, promise: Promise.resolve() };
    const start = this.queue.then(async () => {
      const wait = this.nextStart - this.now();
      if (wait > 0) await this.sleep(wait);
      this.nextStart = this.now() + (this.options.intervalMs ?? 500);
    });
    // Reserve start times without waiting for a slow RPC response to finish.
    this.queue = start.catch(() => {});
    entry.promise = start.then(load).then(
      (value) => {
        entry.expires = this.now() + (typeof ttl === 'function' ? ttl(value) : ttl);
        return value;
      },
      (error) => {
        this.entries.delete(key);
        throw error;
      },
    );
    this.entries.set(key, entry);
    return entry.promise as Promise<T>;
  }
}
