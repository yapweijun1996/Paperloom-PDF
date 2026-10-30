import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF, getPageContentBytes } from '../parser/parser';
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRef, PDFStream, PDFString } from '../types';
import { updatePageContent } from '../editor/stream-compiler';
import { serializeDocument } from '../writer/serializer';
import { redactionEngine } from '../security/redaction/redaction-engine';

async function fixture() {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]).drawText('seed');
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}

describe('redaction diagnostic verification', () => {
  it('inspects deeply nested and cyclic direct objects without losing matches', async () => {
    const doc = await fixture();
    const root = new PDFDict(), tail = new PDFDict([['Secret', new PDFString('DEEP_PRIVATE_MARKER')]]);
    let cursor = root;
    for (let i = 0; i < 14_000; i++) {
      const next = new PDFDict();
      cursor.set('Child', new PDFArray([next]));
      cursor = next;
    }
    cursor.set('Tail', tail);
    tail.set('Cycle', root);
    doc.catalog.set('Private', root);
    const result = redactionEngine.verifyRedaction(doc, ['DEEP_PRIVATE_MARKER']);
    expect(result).toMatchObject({ ok: false, complete: false, found: ['DEEP_PRIVATE_MARKER'] });
  });

  it('finds hex text and text split across TJ operands after save and reopen', async () => {
    const doc = await fixture();
    const bytes = new TextEncoder().encode('BT <534543524554> Tj [(PRI) -10 <56415445>] TJ ET');
    await updatePageContent(doc.pages[0].contentRefs, bytes, doc.objects);
    const reopened = await parsePDF(await serializeDocument(doc));
    expect(new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects))).toContain('<534543524554>');
    expect(redactionEngine.verifyRedaction(reopened, ['SECRET', 'PRIVATE'])).toMatchObject({
      ok: false, complete: false, found: expect.arrayContaining(['SECRET', 'PRIVATE']),
    });
  });

  it('finds nested PDF strings, UTF-16 hex strings, and decoded form stream text', async () => {
    const doc = await fixture();
    const nested = new PDFDict([
      ['Child', new PDFArray([new PDFString('NESTED'), new PDFHexString('feff0057004900440045')])],
    ]);
    const form = new PDFStream(new PDFDict([['Subtype', new PDFName('Form')]]),
      new TextEncoder().encode('BT <464F524D534543524554> Tj ET'));
    const formRef = new PDFRef(999, 0);
    doc.objects.set(formRef.toKey(), form);
    nested.set('Form', formRef);
    doc.catalog.set('CustomNested', nested);
    const result = redactionEngine.verifyRedaction(await parsePDF(await serializeDocument(doc)), ['NESTED', 'WIDE', 'FORMSECRET']);
    expect(result.found).toEqual(expect.arrayContaining(['NESTED', 'WIDE', 'FORMSECRET']));
    expect(result.ok).toBe(false);
  });

  it('never claims clean when no literal match was found', async () => {
    const result = redactionEngine.verifyRedaction(await fixture(), ['NOT-REPRESENTED-AS-LITERAL']);
    expect(result).toMatchObject({ ok: false, complete: false, found: [] });
    expect(result.limitations.join(' ')).toMatch(/font encodings.*images.*embedded files/i);
  });
});
