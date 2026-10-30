/**
 * Security Inspector — Phase 13 (Acrobat-style report).
 */

import { PDFArray, PDFDict, PDFRef, type PDFDocumentData, type PDFObject } from '../../types';
import type {
  ISecurityInspector,
  SecurityInspectionReport,
} from '../types';
import { getEncryptDictFromTrailer } from '../encryption/encrypt-dict';
import { detectAlgorithm } from '../encryption/standard-handler';
import { permissionEngine } from '../permissions/permission-engine';
import { metadataEngine } from '../metadata/metadata-engine';
import { embeddedFileSecurityEngine } from '../embedded-files/embedded-file-engine';
import { assertJavaScriptRemovalSupported, javaScriptSecurityEngine } from '../javascript/javascript-engine';
import { integrityScanner } from '../integrity/integrity-scanner';
import { publicKeyEncryptionEngine } from '../public-key/public-key-engine';

export interface FullSecurityReport extends SecurityInspectionReport {
  handler: 'None' | 'Standard' | 'PublicKey' | 'Unknown';
  metadata: { hasInfo: boolean; hasXmp: boolean; infoKeys: string[] };
  embeddedFiles: { count: number; names: string[]; complete: boolean };
  javascript: { present: boolean; actionCount: number; warnings: string[]; complete: boolean };
  integrity: { ok: boolean; issueCount: number; brokenRefs: number };
  redactionMarks: number;
  redactionMarksComplete: boolean;
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
    let attachments: ReturnType<typeof embeddedFileSecurityEngine.listAttachments> = [];
    let attachmentsComplete = true;
    try {
      attachments = embeddedFileSecurityEngine.listAttachments(doc);
    } catch {
      attachmentsComplete = false;
    }
    const js = javaScriptSecurityEngine.analyze(doc);
    let javascriptLimitation = '';
    try {
      assertJavaScriptRemovalSupported(doc);
    } catch (error) {
      javascriptLimitation = error instanceof Error ? error.message : 'Interactive form inspection is incomplete.';
    }
    const integrity = integrityScanner.inspect(doc);

    let redactionMarks = 0;
    let redactionMarksComplete = true;
    const resolve = (value: PDFObject): PDFObject | undefined => {
      const seen = new Set<string>();
      while (value instanceof PDFRef) {
        const key = value.toKey();
        if (seen.has(key)) return undefined;
        seen.add(key);
        const next = doc.objects.get(key);
        if (!next) return undefined;
        value = next;
      }
      return value;
    };
    for (const page of doc.pages) {
      const annots = page.dict.get('Annots');
      if (!annots) continue;
      const resolved = resolve(annots);
      if (!(resolved instanceof PDFArray)) { redactionMarksComplete = false; continue; }
      for (const item of resolved.items) {
        const annot = resolve(item);
        if (!(annot instanceof PDFDict) || !annot.getName('Subtype')) { redactionMarksComplete = false; continue; }
        if (annot.getName('Subtype') === 'Redact') redactionMarks++;
      }
    }

    const recommendations: string[] = [];
    if (!encrypted) {
      recommendations.push('Encrypt the document with AES-256 for confidentiality.');
    }
    if (js.hasJavaScript) {
      recommendations.push('Remove JavaScript actions before distributing externally.');
    }
    recommendations.push('JavaScript inspection covers known action locations only; it cannot rule out all scripts.');
    if (javascriptLimitation) {
      recommendations.push('JavaScript inspection is incomplete for this interactive form. Review it with a tool that supports XFA and malformed forms.');
    }
    if (attachments.length > 0) {
      recommendations.push(`Review ${attachments.length} embedded attachment(s) for malware risk.`);
    }
    if (!attachmentsComplete) recommendations.push('Attachment inspection is incomplete; unresolved document references require review.');
    if (meta.hasInfo || meta.hasXmp) {
      recommendations.push('Strip metadata if the document will leave your organization.');
    }
    if (!integrity.ok) {
      recommendations.push('Repair integrity issues before signing or archiving.');
    }
    if (redactionMarks > 0) {
      recommendations.push(`${redactionMarks} redaction mark(s) are not applied. Complex redaction is unavailable; only isolated full pages and simple graphics are supported. Do not distribute marked content as redacted.`);
    }
    if (!redactionMarksComplete) {
      recommendations.push('Redaction marks could not be fully inspected. Do not distribute this document as redacted.');
    }
    const algorithm = enc ? detectAlgorithm(enc) : undefined;
    const permissions = enc ? permissionEngine.fromEncryptDict(enc) : undefined;

    // Score 0–100
    let score = 40;
    if (encrypted) score += 25;
    if (algorithm === 'AES-256') score += 15;
    else if (algorithm === 'AES-128') score += 10;
    if (attachmentsComplete && attachments.length === 0) score += 5;
    if (integrity.ok) score += 5;
    score = Math.min(score, 60);

    const posture = encrypted
      ? `${handler} encryption (${algorithm ?? 'unknown'}); score ${score}/100`
      : `Unencrypted document; score ${score}/100`;
    const summary = `${posture}; JavaScript inspection incomplete`;

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
        complete: attachmentsComplete,
      },
      javascript: {
        present: js.hasJavaScript,
        actionCount: js.actions.length,
        warnings: [
          ...js.warnings,
          'JavaScript inspection covers known action locations only.',
          ...(javascriptLimitation ? [javascriptLimitation] : []),
        ],
        complete: false,
      },
      integrity: {
        ok: integrity.ok,
        issueCount: integrity.issues.length,
        brokenRefs: integrity.brokenRefs,
      },
      redactionMarks,
      redactionMarksComplete,
      score,
    };
  }
}

export const securityInspector = new SecurityInspector();
