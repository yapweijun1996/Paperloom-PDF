/** A timestamp failure does not undo a successfully committed signature. */
export function timestampFallbackMessage(timestampError: unknown): string | null {
  return timestampError ? 'The document was signed, but the timestamp request or validation failed. No timestamp was embedded.' : null;
}
