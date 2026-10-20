/** Small in-process LRU with optional per-entry expiry. */
export class MemoryLru<V> {
  private readonly map = new Map<string, { value: V; expiresAt: number }>();
  private readonly max: number;
  private readonly now: () => number;

  constructor(max: number, now: () => number = Date.now) {
    this.max = max;
    this.now = now;
  }

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: string, value: V, ttlMs = Number.POSITIVE_INFINITY): void {
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}
