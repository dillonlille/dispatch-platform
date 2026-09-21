type Snapshot = { data?: unknown; generation: number };
type Entry = { snapshot: Snapshot; expires: number; bytes: number };
type Request = { controller: AbortController; promise: Promise<unknown> };

/** An in-memory LRU. The byte budget measures serialized payloads, not JavaScript heap size. */
export class ResponseCache {
  private entries = new Map<string, Entry>();
  private requests = new Map<string, Request>();
  private listeners = new Map<string, Set<() => void>>();
  private versions = new Map<string, string>();
  private bytes = 0;
  private empty: Snapshot = { generation: 0 };
  session = 0;
  generation = 0;

  constructor(readonly limits: { entries: number; bytes: number; freshMs: number }) {}

  peek(key: string): Snapshot {
    return this.entries.get(key)?.snapshot ?? this.empty;
  }

  subscribe(key: string, listener: () => void) {
    const listeners = this.listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(key);
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
    const generation = this.generation;
    const promise = Promise.resolve()
      .then(() => load(controller.signal))
      .then((data) => {
        if (!controller.signal.aborted && generation === this.generation) this.save(key, data);
        return data;
      })
      .finally(() => {
        if (this.requests.get(key)?.controller === controller) this.requests.delete(key);
      });
    this.requests.set(key, { controller, promise });
    return promise;
  }

  /** Latest and explicitly dated URLs can refer to the same collected timecard. */
  alias(source: string, target: string) {
    const entry = this.entries.get(source);
    if (entry && source !== target) this.save(target, entry.snapshot.data, entry.expires);
  }

  private save(key: string, data: unknown, expires = Date.now() + this.limits.freshMs) {
    const bytes = JSON.stringify(data).length * 2;
    this.remove(key);
    // A large response can still be displayed by its caller; do not retain it for navigation.
    if (bytes <= this.limits.bytes) {
      this.entries.set(key, {
        snapshot: { data, generation: this.generation },
        expires,
        bytes,
      });
      this.bytes += bytes;
      while (this.entries.size > this.limits.entries || this.bytes > this.limits.bytes) {
        const oldest = this.entries.keys().next().value!;
        this.remove(oldest);
        this.notify(oldest);
      }
    }
    this.notify(key);
  }

  private remove(key: string) {
    this.bytes -= this.entries.get(key)?.bytes ?? 0;
    this.entries.delete(key);
  }

  /** Keep same-record data visible while active views fetch the new revision. */
  invalidate() {
    this.generation++;
    this.empty = { generation: this.generation };
    for (const request of this.requests.values()) request.controller.abort();
    this.requests.clear();
    for (const entry of this.entries.values()) {
      entry.expires = 0;
      entry.snapshot = { ...entry.snapshot, generation: this.generation };
    }
    for (const key of this.listeners.keys()) this.notify(key);
  }

  observeVersion(key: string, version: string) {
    const previous = this.versions.get(key);
    this.versions.set(key, version);
    if (previous !== undefined && previous !== version) this.invalidate();
  }

  /** Authorization changes discard values as well as pending requests. */
  clear() {
    this.session++;
    this.entries.clear();
    this.versions.clear();
    this.bytes = 0;
    this.invalidate();
  }
}
