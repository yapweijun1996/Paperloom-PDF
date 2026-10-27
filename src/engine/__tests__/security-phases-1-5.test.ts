/**
 * Security Engine — Phases 1–5 unit tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocumentData,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
} from '../types';
import {
  securityEngine,
  passwordEngine,
  permissionEngine,
  md5,
  rc4,
  padPassword,
  PASSWORD_PADDING,
  parsePermissions,
  serializePermissions,
  allowsOperation,
  computeObjectKey,
  encryptBytes,
  decryptBytes,
  createEncryptionR2R4,
  createEncryptionR6,
  authenticateUserR2R4,
  authenticateOwnerR2R4,
  authenticateUserR5R6,
  detectAlgorithm,
  parseEncryptDict,
  ensureFileId,
  bytesEqual,
  stringToPdfBytes,
  DEFAULT_PERMISSIONS,
} from '../security';
import { serializeDocument } from '../writer/serializer';
import { parsePDF } from '../parser/parser';

function makeMinimalDoc(content = 'BT /F1 12 Tf 100 700 Td (Hello) Tj ET'): PDFDocumentData {
  const objects = new Map<string, import('../types').PDFObject>();
  const catalogRef = new PDFRef(1, 0);
  const pagesRef = new PDFRef(2, 0);
  const pageRef = new PDFRef(3, 0);
  const contentRef = new PDFRef(4, 0);

  const catalog = new PDFDict();
  catalog.set('Type', new PDFName('Catalog'));
  catalog.set('Pages', pagesRef);
  objects.set(catalogRef.toKey(), catalog);

  const pages = new PDFDict();
  pages.set('Type', new PDFName('Pages'));
  pages.set('Kids', new PDFArray([pageRef]));
  pages.set('Count', new PDFNumber(1));
  objects.set(pagesRef.toKey(), pages);

  const contentBytes = stringToPdfBytes(content);
  const contentStream = new PDFStream(new PDFDict([
    ['Length', new PDFNumber(contentBytes.length)],
  ]), contentBytes, contentBytes);
  objects.set(contentRef.toKey(), contentStream);

  const page = new PDFDict();
  page.set('Type', new PDFName('Page'));
  page.set('Parent', pagesRef);
  page.set('MediaBox', new PDFArray([
    new PDFNumber(0), new PDFNumber(0), new PDFNumber(612), new PDFNumber(792),
  ]));
  page.set('Contents', contentRef);
  page.set('Resources', new PDFDict());
  objects.set(pageRef.toKey(), page);

  const trailerDict = new PDFDict();
  trailerDict.set('Size', new PDFNumber(5));
  trailerDict.set('Root', catalogRef);

  return {
    version: '1.7',
    catalog,
    objects,
    pages: [{
      index: 0,
      ref: pageRef,
      dict: page,
      mediaBox: { x: 0, y: 0, width: 612, height: 792 },
      cropBox: { x: 0, y: 0, width: 612, height: 792 },
      rotate: 0,
      contentRefs: [contentRef],
      resources: new PDFDict(),
    }],
    xref: {
      entries: new Map([
        ['1_0', { objNum: 1, genNum: 0, offset: 0, type: 'n' as const }],
        ['2_0', { objNum: 2, genNum: 0, offset: 0, type: 'n' as const }],
        ['3_0', { objNum: 3, genNum: 0, offset: 0, type: 'n' as const }],
        ['4_0', { objNum: 4, genNum: 0, offset: 0, type: 'n' as const }],
      ]),
      trailerDict,
    },
    info: {},
    rawBytes: new Uint8Array(0),
  };
}

describe('Phase 1 — Security Engine foundation', () => {
  it('exposes all required modules', () => {
    expect(securityEngine.encryption).toBeDefined();
    expect(securityEngine.password).toBeDefined();
    expect(securityEngine.permissions).toBeDefined();
    expect(securityEngine.publicKey).toBeDefined();
    expect(securityEngine.metadata).toBeDefined();
    expect(securityEngine.embeddedFiles).toBeDefined();
    expect(securityEngine.javascript).toBeDefined();
    expect(securityEngine.redaction).toBeDefined();
    expect(securityEngine.sanitization).toBeDefined();
    expect(securityEngine.integrity).toBeDefined();
    expect(securityEngine.optimizer).toBeDefined();
    expect(securityEngine.policy).toBeDefined();
    expect(securityEngine.inspector).toBeDefined();
  });

  it('lists security policies', () => {
    const policies = securityEngine.policy.listPolicies();
    expect(policies).toContain('Confidential');
    expect(policies).toContain('No Print');
  });

  it('inspector reports unencrypted docs', async () => {
    const doc = makeMinimalDoc();
    const report = await securityEngine.inspector.inspect(doc);
    expect(report.encrypted).toBe(false);
  });
});

describe('Phase 1 — crypto primitives', () => {
  it('md5 matches known vector', () => {
    // MD5("") = d41d8cd98f00b204e9800998ecf8427e
    const h = md5(new Uint8Array(0));
    expect(Array.from(h).map((b) => b.toString(16).padStart(2, '0')).join('')).toBe(
      'd41d8cd98f00b204e9800998ecf8427e',
    );
  });

  it('md5("abc") known vector', () => {
    const h = md5(stringToPdfBytes('abc'));
    expect(Array.from(h).map((b) => b.toString(16).padStart(2, '0')).join('')).toBe(
      '900150983cd24fb0d6963f7d28e17f72',
    );
  });

  it('rc4 roundtrips', () => {
    const key = stringToPdfBytes('Secret');
    const plain = stringToPdfBytes('Attack at dawn');
    const cipher = rc4(key, plain);
    expect(bytesEqual(rc4(key, cipher), plain)).toBe(true);
  });

  it('pads passwords to 32 bytes', () => {
    const p = padPassword('user');
    expect(p.length).toBe(32);
    expect(p[0]).toBe('u'.charCodeAt(0));
    expect(bytesEqual(p.subarray(4), PASSWORD_PADDING.subarray(0, 28))).toBe(true);
  });
});

describe('Phase 5 — Permission Engine', () => {
  it('serializes and parses permission bits', () => {
    const perms = {
      ...DEFAULT_PERMISSIONS,
      print: true,
      modify: false,
      copy: false,
      annotate: true,
      fillForms: true,
      accessibility: true,
      assemble: false,
      printHighQuality: false,
    };
    const P = serializePermissions(perms, 3);
    const parsed = parsePermissions(P, 3);
    expect(parsed.print).toBe(true);
    expect(parsed.modify).toBe(false);
    expect(parsed.copy).toBe(false);
    expect(parsed.annotate).toBe(true);
    expect(parsed.assemble).toBe(false);
  });

  it('enforces restricted operations', () => {
    const perms = permissionEngine.merge({ copy: false, print: true });
    expect(allowsOperation(perms, 'print')).toBe(true);
    expect(allowsOperation(perms, 'copy')).toBe(false);
    expect(() => permissionEngine.assertAllowed(perms, 'copy')).toThrow(/copy/);
  });

  it('owner bypasses restrictions', () => {
    const restricted = permissionEngine.merge({ print: false, copy: false });
    const effective = permissionEngine.effectivePermissions(restricted, true);
    expect(effective.print).toBe(true);
    expect(effective.copy).toBe(true);
  });
});

describe('Phase 2/3 — R2–R4 password + encryption keys', () => {
  beforeEach(() => {
    passwordEngine.clearCache();
  });

  it('creates and authenticates RC4-128 user password', () => {
    const fileId = {
      permanent: new Uint8Array(16).fill(0xab),
      changing: new Uint8Array(16).fill(0xab),
    };
    const mat = createEncryptionR2R4('secret', 'owner', DEFAULT_PERMISSIONS, 'RC4-128', fileId);
    expect(mat.O.length).toBe(32);
    expect(mat.U.length).toBe(32);
    expect(mat.fileKey.length).toBe(16);

    const enc = parseEncryptDict(
      (() => {
        const d = new PDFDict();
        d.set('Filter', new PDFName('Standard'));
        d.set('V', new PDFNumber(mat.version));
        d.set('R', new PDFNumber(mat.revision));
        d.set('Length', new PDFNumber(mat.length));
        d.set('O', new PDFString(Array.from(mat.O).map((b) => String.fromCharCode(b)).join('')));
        d.set('U', new PDFString(Array.from(mat.U).map((b) => String.fromCharCode(b)).join('')));
        d.set('P', new PDFNumber(mat.P));
        return d;
      })(),
    );

    const userKey = authenticateUserR2R4('secret', enc, fileId);
    expect(userKey).not.toBeNull();
    expect(bytesEqual(userKey!, mat.fileKey)).toBe(true);

    const bad = authenticateUserR2R4('wrong', enc, fileId);
    expect(bad).toBeNull();

    const ownerKey = authenticateOwnerR2R4('owner', enc, fileId);
    expect(ownerKey).not.toBeNull();
  });

  it('object key + RC4 encrypt/decrypt roundtrip', async () => {
    const fileKey = new Uint8Array(16).fill(0x42);
    const objKey = computeObjectKey(fileKey, 7, 0, 'RC4-128');
    expect(objKey.length).toBeLessThanOrEqual(16);
    const plain = stringToPdfBytes('stream data here');
    const cipher = await encryptBytes(plain, objKey, 'RC4-128');
    const back = await decryptBytes(cipher, objKey, 'RC4-128');
    expect(bytesEqual(back, plain)).toBe(true);
  });
});

describe('Phase 3/4 — AES-256 R6 encrypt document roundtrip', () => {
  beforeEach(() => {
    passwordEngine.clearCache();
  });

  it('creates R6 material and authenticates user password', async () => {
    const mat = await createEncryptionR6('hunter2', 'owner-pass', DEFAULT_PERMISSIONS, true);
    expect(mat.O.length).toBe(48);
    expect(mat.U.length).toBe(48);
    expect(mat.OE.length).toBe(32);
    expect(mat.UE.length).toBe(32);
    expect(mat.fileKey.length).toBe(32);

    const d = new PDFDict();
    const cf = new PDFDict();
    const stdCF = new PDFDict();
    stdCF.set('CFM', new PDFName('AESV3'));
    cf.set('StdCF', stdCF);
    d.set('Filter', new PDFName('Standard'));
    d.set('V', new PDFNumber(5));
    d.set('R', new PDFNumber(6));
    d.set('Length', new PDFNumber(256));
    d.set('O', new PDFString(Array.from(mat.O).map((b) => String.fromCharCode(b)).join('')));
    d.set('U', new PDFString(Array.from(mat.U).map((b) => String.fromCharCode(b)).join('')));
    d.set('OE', new PDFString(Array.from(mat.OE).map((b) => String.fromCharCode(b)).join('')));
    d.set('UE', new PDFString(Array.from(mat.UE).map((b) => String.fromCharCode(b)).join('')));
    d.set('Perms', new PDFString(Array.from(mat.Perms).map((b) => String.fromCharCode(b)).join('')));
    d.set('P', new PDFNumber(mat.P));
    d.set('CF', cf);
    d.set('StmF', new PDFName('StdCF'));
    d.set('StrF', new PDFName('StdCF'));

    const enc = parseEncryptDict(d);
    expect(detectAlgorithm(enc)).toBe('AES-256');

    const key = await authenticateUserR5R6('hunter2', enc);
    expect(key).not.toBeNull();
    expect(bytesEqual(key!, mat.fileKey)).toBe(true);

    const bad = await authenticateUserR5R6('nope', enc);
    expect(bad).toBeNull();
  });

  it('encrypts a document, serializes, reparses, and opens with password', async () => {
    const doc = makeMinimalDoc('BT (SecretContent) Tj ET');
    ensureFileId(doc.xref.trailerDict);

    await securityEngine.encrypt(doc, {
      userPassword: 'test-pass',
      ownerPassword: 'owner-pass',
      algorithm: 'AES-256',
      permissions: { copy: false, print: true },
    });

    expect(securityEngine.isEncrypted(doc)).toBe(true);

    const bytes = await serializeDocument(doc);
    expect(bytes.length).toBeGreaterThan(100);

    const reparsed = await parsePDF(bytes);
    expect(securityEngine.isEncrypted(reparsed)).toBe(true);

    await expect(securityEngine.open(reparsed, 'wrong')).rejects.toThrow(/password/i);

    const opened = await securityEngine.open(reparsed, 'test-pass');
    expect(opened.role).toBe('user');
    expect(opened.permissions.copy).toBe(false);
    expect(opened.permissions.print).toBe(true);

    const stream = opened.doc.objects.get('4_0');
    expect(stream).toBeInstanceOf(PDFStream);
    const text = new TextDecoder().decode((stream as PDFStream).getBytes());
    expect(text).toContain('SecretContent');
  }, 30000);

  it('opens with owner password and grants full permissions', async () => {
    const doc = makeMinimalDoc();
    await securityEngine.encrypt(doc, {
      userPassword: 'user',
      ownerPassword: 'owner',
      algorithm: 'AES-128',
      permissions: { print: false, copy: false, modify: false },
    });

    const bytes = await serializeDocument(doc);
    const reparsed = await parsePDF(bytes);
    const opened = await securityEngine.open(reparsed, 'owner');
    expect(opened.role).toBe('owner');
    expect(opened.permissions.print).toBe(true);
    expect(opened.permissions.copy).toBe(true);
  }, 30000);
});

describe('Phase 2 — AES-128 object cipher', () => {
  it('AES-128 CBC roundtrip with IV prefix', async () => {
    const key = computeObjectKey(new Uint8Array(16).fill(1), 1, 0, 'AES-128');
    const plain = stringToPdfBytes('Hello AES PDF encryption!');
    const cipher = await encryptBytes(plain, key, 'AES-128');
    expect(cipher.length).toBeGreaterThan(plain.length); // IV + padding
    const back = await decryptBytes(cipher, key, 'AES-128');
    expect(bytesEqual(back, plain)).toBe(true);
  });
});
