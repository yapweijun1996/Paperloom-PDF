import type { EncryptOptions } from '../types';

/** Require a caller-supplied owner secret before creating any encryption state. */
export function validateEncryptionPasswords(options: EncryptOptions): void {
  if (typeof options.ownerPassword !== 'string' || options.ownerPassword.length === 0) {
    throw new Error('An owner password is required to encrypt the document.');
  }
  if (options.userPassword !== undefined && typeof options.userPassword !== 'string') {
    throw new Error('The user password must be a string.');
  }
}
