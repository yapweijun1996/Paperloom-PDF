/**
 * Encryption Engine — parse, object keys, encrypt/decrypt bytes (Phases 2 & 4).
 */

import type { PDFDict, PDFObject } from '../../types';
import type {
  EncryptionAlgorithm,
  EncryptDictionary,
  IEncryptionEngine,
} from '../types';
import { parseEncryptDict } from './encrypt-dict';
import { detectAlgorithm } from './standard-handler';
import {
  computeObjectKey,
  decryptBytes,
  encryptBytes,
} from './object-cipher';

export class EncryptionEngine implements IEncryptionEngine {
  parseEncryptDict(
    dict: PDFDict,
    resolve?: (obj: PDFObject) => PDFObject,
  ): EncryptDictionary {
    return parseEncryptDict(dict, resolve);
  }

  detectAlgorithm(enc: EncryptDictionary): EncryptionAlgorithm {
    return detectAlgorithm(enc);
  }

  computeObjectKey(
    fileKey: Uint8Array,
    objNum: number,
    genNum: number,
    algorithm: EncryptionAlgorithm,
  ): Uint8Array {
    return computeObjectKey(fileKey, objNum, genNum, algorithm);
  }

  decryptBytes(
    data: Uint8Array,
    key: Uint8Array,
    algorithm: EncryptionAlgorithm,
  ): Promise<Uint8Array> {
    return decryptBytes(data, key, algorithm);
  }

  encryptBytes(
    data: Uint8Array,
    key: Uint8Array,
    algorithm: EncryptionAlgorithm,
  ): Promise<Uint8Array> {
    return encryptBytes(data, key, algorithm);
  }
}

export const encryptionEngine = new EncryptionEngine();
