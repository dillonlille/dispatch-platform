type Snapshot = { data?: unknown; generation: number };
type Entry = { snapshot: Snapshot; expires: number; bytes: number; json: string };
type Request = { controller: AbortController; promise: Promise<unknown> };
export type CacheFilter = (key: string) => boolean;

/** Bounded session memory. Its byte budget estimates payloads plus comparison strings, not heap size. */
export class ResponseCache {
  private entries = new Map<string, Entry>();
  private requests = new Map<string, Request>();
  private listeners = new Map<string, Set<() => void>>();
  private versions = new Map<string, string>();
  private emptyEntries = new Map<string, Snapshot>();
  private bytes = 0;
  private empty: Snapshot = { generation: 0 };
  session = 0;
  generation = 0;

  constructor(readonly limits: { entries: number; bytes: number; freshMs: number }) {}

  peek(key: string): Snapshot {
    return this.entries.get(key)?.snapshot ?? this.emptyEntries.get(key) ?? this.empty;
  }

  subscribe(key: string, listener: () => void) {
    const listeners = this.listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        this.listeners.delete(key);
        this.emptyEntries.delete(key);
      }
    };
  }

  private notify(key: string) {
    this.listeners.get(key)?.forEach((listener) => listener());
  }

  read<T>(key: string, load: (signal: AbortSignal) => Promise<T>, force = false): Promise<T> {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      if (!force && entry.expires > Date.now()) return Promise.resolve(entry.snapshot.data as T);
    }
    const pending = this.requests.get(key);
    if (pending) return pending.promise as Promise<T>;
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => load(controller.signal))
      .then((data) => {
        // Scoped invalidation aborts only affected requests. Other responses remain valid.
        if (!controller.signal.aborted) return this.save(key, data);
        return data;
      })
      .finally(() => {
        if (this.requests.get(key)?.controller === controller) this.requests.delete(key);
      });
    this.requests.set(key, { controller, promise });
    return promise;
  }

  /** Also used for authoritative mutation acknowledgements and live snapshots. */
  put<T>(key: string, data: T): T {
    return this.save(key, data);
  }

  alias(source: string, target: string) {
    const entry = this.entries.get(source);
    if (entry && source !== target) this.save(target, entry.snapshot.data, entry.expires);
  }

  private save<T>(key: string, data: T, expires = Date.now() + this.limits.freshMs): T {
    const json = JSON.stringify(data);
    const previous = this.entries.get(key);
    if (previous?.json === json) {
      previous.expires = expires;
      return previous.snapshot.data as T;
    }
    const generation = this.peek(key).generation;
    const bytes = json.length * 4;
    this.remove(key);
    if (bytes <= this.limits.bytes) {
      this.entries.set(key, { snapshot: { data, generation }, expires, bytes, json });
      this.bytes += bytes;
      while (this.entries.size > this.limits.entries || this.bytes > this.limits.bytes) {
        const oldest = this.entries.keys().next().value!;
        this.remove(oldest);
        this.notify(oldest);
      }
    }
    this.notify(key);
    return data;
  }

  private remove(key: string) {
    this.bytes -= this.entries.get(key)?.bytes ?? 0;
    this.entries.delete(key);
  }

  /** Retain known data; only affected subscribers revalidate or cancel pending reads. */
  invalidate(matches?: CacheFilter) {
    this.generation++;
    if (!matches) {
      this.empty = { generation: this.generation };
      this.emptyEntries.clear();
    }
    const keys = new Set([
      ...this.entries.keys(),
      ...this.requests.keys(),
      ...this.listeners.keys(),
    ]);
    for (const key of keys) {
      if (matches && !matches(key)) continue;
      this.requests.get(key)?.controller.abort();
      this.requests.delete(key);
      const entry = this.entries.get(key);
      if (entry) {
        entry.expires = 0;
        entry.snapshot = { ...entry.snapshot, generation: this.generation };
      } else if (matches && this.listeners.has(key)) {
        this.emptyEntries.set(key, { generation: this.generation });
      }
      this.notify(key);
    }
  }

  observeVersion(key: string, version: string, matches?: CacheFilter) {
    const previous = this.versions.get(key);
    this.versions.set(key, version);
    if (previous !== undefined && previous !== version) this.invalidate(matches);
  }

  clear() {
    this.session++;
    this.entries.clear();
    this.emptyEntries.clear();
    this.versions.clear();
    this.bytes = 0;
    this.invalidate();
  }
}
