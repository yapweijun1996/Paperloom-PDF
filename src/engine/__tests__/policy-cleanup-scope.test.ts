import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { PDFArray, PDFDict, PDFName, PDFString } from '../types';
import { SecurityPolicyEngine } from '../security/policy/policy-engine';
import { serializeDocument } from '../writer/serializer';

describe('security policy cleanup scope', () => {
  it('removes JavaScript without changing optional layers or alternate images', async () => {
    const input = await PDFDocument.create();
    input.addPage([200, 200]);
    const doc = await parsePDF(await input.save({ useObjectStreams: false }));
    doc.catalog.set('OpenAction', new PDFDict([['S', new PDFName('JavaScript')], ['JS', new PDFString('alert(1)')]]));
    doc.catalog.set('OCProperties', new PDFDict([['OCGs', new PDFArray([])]]));
    doc.pages[0].resources.set('Alternates', new PDFArray([]));
    await new SecurityPolicyEngine().applyPolicy(doc, 'Internal Use');
    expect(doc.catalog.has('OpenAction')).toBe(false);
    const reopened = await parsePDF(await serializeDocument(doc));
    expect(reopened.catalog.has('OCProperties')).toBe(true);
    expect(reopened.pages[0].resources.has('Alternates')).toBe(true);
  });
});
