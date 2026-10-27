/**
 * Password Engine — authenticate, create keys, cache (Phase 3).
 */

import type {
  EncryptDictionary,
  EncryptOptions,
  FileIdPair,
  IPasswordEngine,
  PasswordAuthResult,
  PdfPermissions,
} from '../types';
import { mergePermissions } from '../permissions/permission-bits';
import {
  authenticateOwnerR2R4,
  authenticateOwnerR5R6,
  authenticateUserR2R4,
  authenticateUserR5R6,
  createEncryptionR2R4,
  createEncryptionR6,
  detectAlgorithm,
} from '../encryption/standard-handler';
import { parseEncryptDict, bytesToPdfHex } from '../encryption/encrypt-dict';
import {
  PDFBoolean,
  PDFDict,
  PDFName,
  PDFNumber,
} from '../../types';

interface CacheEntry {
  fileKey: Uint8Array;
  role: 'user' | 'owner';
  fingerprint: string;
}

function fingerprint(enc: EncryptDictionary, fileId: FileIdPair): string {
  const u = enc.U.subarray(0, 16);
  let s = `${enc.revision}:${fileId.permanent[0]}:`;
  for (let i = 0; i < u.length; i++) s += u[i].toString(16);
  return s;
}

export class PasswordEngine implements IPasswordEngine {
  private cache = new Map<string, CacheEntry>();

  async authenticate(
    enc: EncryptDictionary,
    fileId: FileIdPair,
    password: string,
  ): Promise<PasswordAuthResult> {
    const fp = fingerprint(enc, fileId);
    const cached = this.cache.get(fp + ':' + password);
    if (cached) {
      return { ok: true, role: cached.role, fileKey: cached.fileKey };
    }

    if (enc.filter !== 'Standard') {
      return {
        ok: false,
        role: 'none',
        fileKey: null,
        error: `Unsupported security handler: ${enc.filter}`,
      };
    }

    // Try empty password first when password is empty string is intentional
    if (enc.revision >= 5) {
      // Owner first (full access), then user
      const ownerKey = await authenticateOwnerR5R6(password, enc);
      if (ownerKey) {
        this.cache.set(fp + ':' + password, { fileKey: ownerKey, role: 'owner', fingerprint: fp });
        return { ok: true, role: 'owner', fileKey: ownerKey };
      }
      const userKey = await authenticateUserR5R6(password, enc);
      if (userKey) {
        this.cache.set(fp + ':' + password, { fileKey: userKey, role: 'user', fingerprint: fp });
        return { ok: true, role: 'user', fileKey: userKey };
      }
    } else {
      const ownerKey = authenticateOwnerR2R4(password, enc, fileId);
      if (ownerKey) {
        this.cache.set(fp + ':' + password, { fileKey: ownerKey, role: 'owner', fingerprint: fp });
        return { ok: true, role: 'owner', fileKey: ownerKey };
      }
      const userKey = authenticateUserR2R4(password, enc, fileId);
      if (userKey) {
        this.cache.set(fp + ':' + password, { fileKey: userKey, role: 'user', fingerprint: fp });
        return { ok: true, role: 'user', fileKey: userKey };
      }
    }

    return {
      ok: false,
      role: 'none',
      fileKey: null,
      error: 'Incorrect password',
    };
  }

  async createEncryptionKeys(
    options: EncryptOptions,
    fileId: FileIdPair,
  ): Promise<{ encrypt: EncryptDictionary; fileKey: Uint8Array }> {
    const algorithm = options.algorithm ?? 'AES-256';
    const userPassword = options.userPassword ?? '';
    const ownerPassword = options.ownerPassword ?? userPassword;
    const permissions: PdfPermissions = mergePermissions(options.permissions);
    const encryptMetadata = options.encryptMetadata ?? true;

    if (algorithm === 'AES-256') {
      const mat = await createEncryptionR6(userPassword, ownerPassword, permissions, encryptMetadata);
      const dict = new PDFDict();
      const cf = new PDFDict();
      const stdCF = new PDFDict();
      stdCF.set('CFM', new PDFName('AESV3'));
      stdCF.set('Length', new PDFNumber(32));
      cf.set('StdCF', stdCF);
      dict.set('Filter', new PDFName('Standard'));
      dict.set('V', new PDFNumber(5));
      dict.set('R', new PDFNumber(6));
      dict.set('Length', new PDFNumber(256));
      dict.set('O', bytesToPdfHex(mat.O));
      dict.set('U', bytesToPdfHex(mat.U));
      dict.set('OE', bytesToPdfHex(mat.OE));
      dict.set('UE', bytesToPdfHex(mat.UE));
      dict.set('Perms', bytesToPdfHex(mat.Perms));
      dict.set('P', new PDFNumber(mat.P));
      dict.set('EncryptMetadata', new PDFBoolean(encryptMetadata));
      dict.set('CF', cf);
      dict.set('StmF', new PDFName('StdCF'));
      dict.set('StrF', new PDFName('StdCF'));
      return { encrypt: parseEncryptDict(dict), fileKey: mat.fileKey };
    }

    const mat = createEncryptionR2R4(
      userPassword,
      ownerPassword,
      permissions,
      algorithm,
      fileId,
      encryptMetadata,
    );
    const dict = new PDFDict();
    dict.set('Filter', new PDFName('Standard'));
    dict.set('V', new PDFNumber(mat.version));
    dict.set('R', new PDFNumber(mat.revision));
    dict.set('Length', new PDFNumber(mat.length));
    dict.set('O', bytesToPdfHex(mat.O));
    dict.set('U', bytesToPdfHex(mat.U));
    dict.set('P', new PDFNumber(mat.P));
    if (algorithm === 'AES-128') {
      dict.set('EncryptMetadata', new PDFBoolean(encryptMetadata));
      const cf = new PDFDict();
      const stdCF = new PDFDict();
      stdCF.set('CFM', new PDFName('AESV2'));
      stdCF.set('Length', new PDFNumber(16));
      cf.set('StdCF', stdCF);
      dict.set('CF', cf);
      dict.set('StmF', new PDFName('StdCF'));
      dict.set('StrF', new PDFName('StdCF'));
    }
    return { encrypt: parseEncryptDict(dict), fileKey: mat.fileKey };
  }

  clearCache(): void {
    this.cache.clear();
  }

  /** Validate password strength (optional helper for UI). */
  validatePassword(password: string): { ok: boolean; warnings: string[] } {
    const warnings: string[] = [];
    if (password.length === 0) warnings.push('Empty password — document opens without a prompt for user access if empty user password is set');
    if (password.length > 0 && password.length < 6) warnings.push('Password is short; prefer 8+ characters');
    if (password.length > 127) warnings.push('Password truncated to 127 UTF-8 bytes for AES-256');
    return { ok: true, warnings };
  }
}

export const passwordEngine = new PasswordEngine();
