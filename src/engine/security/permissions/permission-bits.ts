/**
 * PDF permission bit flags (ISO 32000 Table 22).
 */

import type { EncryptionRevision, PdfPermissions, RestrictedOperation } from '../types';
import { DEFAULT_PERMISSIONS } from '../types';

/** Bit positions (1-based in spec → 0-based shifts: bit n means 1 << (n-1)). */
const BITS = {
  print: 3,           // bit 3
  modify: 4,          // bit 4
  copy: 5,            // bit 5
  annotate: 6,        // bit 6
  fillForms: 9,       // bit 9
  accessibility: 10,  // bit 10
  assemble: 11,       // bit 11
  printHighQuality: 12, // bit 12
} as const;

function bitMask(bit: number): number {
  return 1 << (bit - 1);
}

/**
 * Parse /P integer into structured permissions.
 * Bits 1–2 must be 0; bits 7–8 and 13–32 must be 1 (reserved).
 */
export function parsePermissions(P: number, _revision: EncryptionRevision = 3): PdfPermissions {
  return {
    print: (P & bitMask(BITS.print)) !== 0,
    modify: (P & bitMask(BITS.modify)) !== 0,
    copy: (P & bitMask(BITS.copy)) !== 0,
    annotate: (P & bitMask(BITS.annotate)) !== 0,
    fillForms: (P & bitMask(BITS.fillForms)) !== 0,
    accessibility: (P & bitMask(BITS.accessibility)) !== 0,
    assemble: (P & bitMask(BITS.assemble)) !== 0,
    printHighQuality: (P & bitMask(BITS.printHighQuality)) !== 0,
  };
}

/**
 * Serialize permissions to a signed 32-bit /P value.
 */
export function serializePermissions(
  perms: PdfPermissions,
  revision: EncryptionRevision = 3,
): number {
  // Start with reserved bits set: bits 7,8 and 13–32 = 1; bits 1–2 = 0
  // 0xFFFFF0C0 has bits 7-8 and 13-32 set… Let's compute carefully.
  // Bits numbered from 1 (LSB = bit 1).
  // Reserved-as-1: 7, 8, 13..32
  let P = 0;
  for (let bit = 7; bit <= 8; bit++) P |= bitMask(bit);
  for (let bit = 13; bit <= 32; bit++) P |= bitMask(bit);

  if (perms.print) P |= bitMask(BITS.print);
  if (perms.modify) P |= bitMask(BITS.modify);
  if (perms.copy) P |= bitMask(BITS.copy);
  if (perms.annotate) P |= bitMask(BITS.annotate);

  // R3+ extra bits
  if (revision >= 3) {
    if (perms.fillForms) P |= bitMask(BITS.fillForms);
    if (perms.accessibility) P |= bitMask(BITS.accessibility);
    if (perms.assemble) P |= bitMask(BITS.assemble);
    if (perms.printHighQuality) P |= bitMask(BITS.printHighQuality);
  }

  // Force to signed 32-bit
  return P | 0;
}

export function mergePermissions(partial?: Partial<PdfPermissions>): PdfPermissions {
  return { ...DEFAULT_PERMISSIONS, ...partial };
}

export function allowsOperation(perms: PdfPermissions, op: RestrictedOperation): boolean {
  switch (op) {
    case 'print':
      return perms.print;
    case 'printHighQuality':
      return perms.print && perms.printHighQuality;
    case 'modify':
      return perms.modify;
    case 'copy':
    case 'extract':
      return perms.copy;
    case 'annotate':
      return perms.annotate;
    case 'fillForms':
      return perms.fillForms || perms.modify || perms.annotate;
    case 'accessibility':
      return perms.accessibility || perms.copy;
    case 'assemble':
      return perms.assemble || perms.modify;
    default:
      return false;
  }
}

export function assertAllowed(perms: PdfPermissions, op: RestrictedOperation): void {
  if (!allowsOperation(perms, op)) {
    throw new Error(`PDF security restriction: operation "${op}" is not permitted`);
  }
}
