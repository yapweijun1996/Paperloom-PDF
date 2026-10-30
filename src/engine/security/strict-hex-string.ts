export interface HexInspectionBudget { characters: number; bytes: number }

/** Bound and validate PDF hex syntax without allocating a decoded copy. */
export function isStrictHexString(hex: string): boolean {
  return hex.length <= 262_144 && /^[0-9A-Fa-f\x00\x09\x0a\x0c\x0d\x20]*$/.test(hex);
}

/** Decode a PDF hex-string body only when every character has valid syntax. */
export function decodeStrictHexString(hex: string, budget?: HexInspectionBudget): Uint8Array | undefined {
  if (budget && budget.characters + hex.length > 262_144) return undefined;
  if (!isStrictHexString(hex)) return undefined;
  let digits = 0;
  for (let i = 0; i < hex.length; i++) if (/[0-9A-Fa-f]/.test(hex[i])) digits++;
  const length = Math.ceil(digits / 2);
  if (budget && budget.bytes + length > 131_072) return undefined;
  if (budget) { budget.characters += hex.length; budget.bytes += length; }
  const bytes = new Uint8Array(length);
  let high = -1, index = 0;
  for (let i = 0; i < hex.length; i++) {
    const code = hex.charCodeAt(i);
    const nibble = code >= 48 && code <= 57 ? code - 48
      : code >= 65 && code <= 70 ? code - 55 : code >= 97 && code <= 102 ? code - 87 : -1;
    if (nibble < 0) continue;
    if (high < 0) high = nibble;
    else { bytes[index++] = (high << 4) | nibble; high = -1; }
  }
  if (high >= 0) bytes[index] = high << 4;
  return bytes;
}
