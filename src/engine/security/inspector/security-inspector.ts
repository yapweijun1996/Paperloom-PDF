/**
 * Security Inspector — Phase 13 (Acrobat-style report).
 */

import type { PDFDocumentData } from '../../types';
import type {
  ISecurityInspector,
  SecurityInspectionReport,
} from '../types';
import { getEncryptDictFromTrailer } from '../encryption/encrypt-dict';
import { detectAlgorithm } from '../encryption/standard-handler';
import { permissionEngine } from '../permissions/permission-engine';
import { metadataEngine } from '../metadata/metadata-engine';
import { embeddedFileSecurityEngine } from '../embedded-files/embedded-file-engine';
import { javaScriptSecurityEngine } from '../javascript/javascript-engine';
import { integrityScanner } from '../integrity/integrity-scanner';
import { publicKeyEncryptionEngine } from '../public-key/public-key-engine';

export interface FullSecurityReport extends SecurityInspectionReport {
  handler: 'None' | 'Standard' | 'PublicKey' | 'Unknown';
  metadata: { hasInfo: boolean; hasXmp: boolean; infoKeys: string[] };
  embeddedFiles: { count: number; names: string[] };
  javascript: { present: boolean; actionCount: number; warnings: string[] };
  integrity: { ok: boolean; issueCount: number; brokenRefs: number };
  redactionMarks: number;
  score: number;
}

export class SecurityInspector implements ISecurityInspector {
  async inspect(doc: PDFDocumentData): Promise<SecurityInspectionReport> {
    const full = await this.inspectFull(doc);
    return {
      encrypted: full.encrypted,
      algorithm: full.algorithm,
      revision: full.revision,
      permissions: full.permissions,
      hasUserPassword: full.hasUserPassword,
      hasOwnerPassword: full.hasOwnerPassword,
      encryptMetadata: full.encryptMetadata,
      recommendations: full.recommendations,
      summary: full.summary,
    };
  }

  async inspectFull(doc: PDFDocumentData): Promise<FullSecurityReport> {
    const enc = getEncryptDictFromTrailer(doc.xref.trailerDict, doc.objects);
    const encrypted = !!enc;
    const isPub = enc ? publicKeyEncryptionEngine.isPublicKeyHandler(enc) : false;
    const handler: FullSecurityReport['handler'] = !enc
      ? 'None'
      : isPub
        ? 'PublicKey'
        : enc.filter === 'Standard'
          ? 'Standard'
          : 'Unknown';

    const meta = metadataEngine.validateMetadata(doc);
    const attachments = embeddedFileSecurityEngine.listAttachments(doc);
    const js = javaScriptSecurityEngine.analyze(doc);
    const integrity = integrityScanner.inspect(doc);

    let redactionMarks = 0;
    for (const page of doc.pages) {
      const annots = page.dict.getArray('Annots');
      if (!annots) continue;
      for (let i = 0; i < annots.length; i++) {
        const ref = annots.get(i);
        if (!ref || !('toKey' in ref)) continue;
        const obj = doc.objects.get((ref as { toKey(): string }).toKey());
        if (obj && 'getName' in obj && (obj as { getName(k: string): string | undefined }).getName('Subtype') === 'Redact') {
          redactionMarks++;
        }
      }
    }

    const recommendations: string[] = [];
    if (!encrypted) {
      recommendations.push('Encrypt the document with AES-256 for confidentiality.');
    }
    if (js.hasJavaScript) {
      recommendations.push('Remove JavaScript actions before distributing externally.');
    }
    if (attachments.length > 0) {
      recommendations.push(`Review ${attachments.length} embedded attachment(s) for malware risk.`);
    }
    if (meta.hasInfo || meta.hasXmp) {
      recommendations.push('Strip metadata if the document will leave your organization.');
    }
    if (!integrity.ok) {
      recommendations.push('Repair integrity issues before signing or archiving.');
    }
    if (redactionMarks > 0) {
      recommendations.push(`Apply ${redactionMarks} pending redaction mark(s) securely.`);
    }
    if (recommendations.length === 0) {
      recommendations.push('Security posture looks solid for typical internal use.');
    }

    const algorithm = enc ? detectAlgorithm(enc) : undefined;
    const permissions = enc ? permissionEngine.fromEncryptDict(enc) : undefined;

    // Score 0–100
    let score = 40;
    if (encrypted) score += 25;
    if (algorithm === 'AES-256') score += 15;
    else if (algorithm === 'AES-128') score += 10;
    if (!js.hasJavaScript) score += 10;
    if (attachments.length === 0) score += 5;
    if (integrity.ok) score += 5;
    if (score > 100) score = 100;

    const summary = encrypted
      ? `${handler} encryption (${algorithm ?? 'unknown'}); score ${score}/100`
      : `Unencrypted document; score ${score}/100`;

    return {
      encrypted,
      algorithm,
      revision: enc?.revision,
      permissions,
      hasUserPassword: encrypted && handler === 'Standard',
      hasOwnerPassword: encrypted && handler === 'Standard',
      encryptMetadata: enc?.encryptMetadata,
      recommendations,
      summary,
      handler,
      metadata: {
        hasInfo: meta.hasInfo,
        hasXmp: meta.hasXmp,
        infoKeys: meta.infoKeys,
      },
      embeddedFiles: {
        count: attachments.length,
        names: attachments.map((a) => a.name),
      },
      javascript: {
        present: js.hasJavaScript,
        actionCount: js.actions.length,
        warnings: js.warnings,
      },
      integrity: {
        ok: integrity.ok,
        issueCount: integrity.issues.length,
        brokenRefs: integrity.brokenRefs,
      },
      redactionMarks,
      score,
    };
  }
}

export const securityInspector = new SecurityInspector();
