/**
 * Recipient manager for public-key (Adobe.PubSec) encryption — Phase 6.
 */

import type { RecipientCert, RecipientInfo } from '../types';
import { describeCmsRecipient } from './cms-enveloped';

export class RecipientManager {
  private recipients: Array<RecipientCert & { id: string }> = [];

  add(cert: RecipientCert): string {
    const id = `rcpt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.recipients.push({ ...cert, id });
    return id;
  }

  addMany(certs: RecipientCert[]): string[] {
    return certs.map((c) => this.add(c));
  }

  remove(id: string): boolean {
    const before = this.recipients.length;
    this.recipients = this.recipients.filter((r) => r.id !== id);
    return this.recipients.length < before;
  }

  clear(): void {
    this.recipients = [];
  }

  list(): Array<RecipientCert & { id: string; label: string }> {
    return this.recipients.map((r) => ({
      ...r,
      label: r.label ?? `Recipient (${r.certificateDer.length} bytes)`,
    }));
  }

  getAll(): RecipientCert[] {
    return this.recipients.map(({ certificateDer, label }) => ({ certificateDer, label }));
  }

  count(): number {
    return this.recipients.length;
  }
}

export function recipientInfoFromCms(
  index: number,
  cmsBytes: Uint8Array,
  label?: string,
): RecipientInfo {
  const desc = describeCmsRecipient(cmsBytes);
  return {
    index,
    label: label ?? desc.serialNumberHex ?? `Recipient ${index + 1}`,
    serialNumberHex: desc.serialNumberHex,
    cmsBytesLength: cmsBytes.length,
  };
}
