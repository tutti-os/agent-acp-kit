export function createDetectionCache<TValue>() {
  const cache = new Map<string, TValue>();

  return {
    clear() {
      cache.clear();
    },
    get(key: string): TValue | undefined {
      return cache.get(key);
    },
    set(key: string, value: TValue) {
      cache.set(key, value);
    },
  };
}
