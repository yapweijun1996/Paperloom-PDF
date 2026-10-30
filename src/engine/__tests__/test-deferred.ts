/** A test synchronization primitive available on all supported Node versions. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}
