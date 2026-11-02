/** Joins static class strings, skipping falsy entries. No merging: callers append, never override, variant classes. */
export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}
