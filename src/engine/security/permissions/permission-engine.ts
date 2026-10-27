/**
 * Permission Engine — parse, serialize, enforce (Phase 5).
 */

import type {
  EncryptionRevision,
  IPermissionEngine,
  PdfPermissions,
  RestrictedOperation,
} from '../types';
import {
  allowsOperation,
  assertAllowed,
  mergePermissions,
  parsePermissions,
  serializePermissions,
} from './permission-bits';
import type { EncryptDictionary } from '../types';
import { PDFNumber } from '../../types';

export class PermissionEngine implements IPermissionEngine {
  parse(P: number, revision: EncryptionRevision = 3): PdfPermissions {
    return parsePermissions(P, revision);
  }

  serialize(perms: PdfPermissions, revision: EncryptionRevision = 3): number {
    return serializePermissions(perms, revision);
  }

  allows(perms: PdfPermissions, op: RestrictedOperation): boolean {
    return allowsOperation(perms, op);
  }

  assertAllowed(perms: PdfPermissions, op: RestrictedOperation): void {
    assertAllowed(perms, op);
  }

  fromEncryptDict(enc: EncryptDictionary): PdfPermissions {
    return parsePermissions(enc.P, enc.revision);
  }

  /** Update /P on an existing Encrypt dictionary. */
  applyToEncryptDict(enc: EncryptDictionary, perms: PdfPermissions): number {
    const P = serializePermissions(perms, enc.revision);
    enc.P = P;
    enc.dict.set('P', new PDFNumber(P));
    return P;
  }

  merge(partial?: Partial<PdfPermissions>): PdfPermissions {
    return mergePermissions(partial);
  }

  /** Owner role bypasses all restrictions. */
  effectivePermissions(
    perms: PdfPermissions,
    isOwner: boolean,
  ): PdfPermissions {
    if (isOwner) {
      return mergePermissions({
        print: true,
        modify: true,
        copy: true,
        annotate: true,
        fillForms: true,
        accessibility: true,
        assemble: true,
        printHighQuality: true,
      });
    }
    return perms;
  }
}

export const permissionEngine = new PermissionEngine();
