import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { securityInspector } from '../security/inspector/security-inspector';
import { PDFArray, PDFDict, PDFName, PDFRef, PDFString } from '../types';

async function fixture() {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}

describe('security inspection limitations', () => {
  it('does not treat a clear action scan as proof of JavaScript absence', async () => {
    const doc = await fixture();
    const report = await securityInspector.inspectFull(doc);
    expect(report.javascript.present).toBe(false);
    expect(report.javascript.complete).toBe(false);
    expect(report.recommendations.join(' ')).toMatch(/known action locations only/i);
    expect(report.summary).toMatch(/JavaScript inspection incomplete/i);
    expect(report.score).toBeLessThanOrEqual(60);
    expect(report.recommendations.join(' ')).not.toMatch(/posture looks solid/i);
  });

  it.each(['xfa', 'unresolved', 'cyclic'] as const)('surfaces incomplete interactive form inspection for %s', async (kind) => {
    const doc = await fixture();
    if (kind === 'xfa') doc.catalog.set('AcroForm', new PDFDict([['XFA', new PDFString('<script>secret</script>')]]));
    if (kind === 'unresolved') doc.catalog.set('AcroForm', new PDFRef(9991, 0));
    if (kind === 'cyclic') {
      const ref = new PDFRef(9992, 0);
      doc.objects.set(ref.toKey(), ref);
      doc.catalog.set('AcroForm', ref);
    }
    const report = await securityInspector.inspectFull(doc);
    expect(report.javascript.complete).toBe(false);
    expect(report.javascript.warnings.join(' ')).toMatch(/XFA|interactive form/i);
    expect(report.recommendations.join(' ')).toMatch(/inspection is incomplete/i);
    expect(report.score).toBeLessThanOrEqual(60);
    expect((await securityInspector.inspect(doc)).summary).toMatch(/inspection incomplete/i);
  });

  it('warns that pending redaction marks cannot be applied securely', async () => {
    const doc = await fixture();
    const arrayRef = new PDFRef(9993, 0);
    doc.objects.set(arrayRef.toKey(), new PDFArray([new PDFDict([['Subtype', new PDFName('Redact')]])]));
    doc.pages[0].dict.set('Annots', arrayRef);
    const report = await securityInspector.inspectFull(doc);
    expect(report.redactionMarks).toBe(1);
    expect(report.redactionMarksComplete).toBe(true);
    expect(report.recommendations.join(' ')).toMatch(/redaction.*unavailable/i);
    expect(report.recommendations.join(' ')).not.toMatch(/Apply .* securely/i);
  });

  it('reports incomplete annotation inspection without claiming no marks', async () => {
    const doc = await fixture();
    doc.pages[0].dict.set('Annots', new PDFRef(9994, 0));
    const report = await securityInspector.inspectFull(doc);
    expect(report.redactionMarksComplete).toBe(false);
    expect(report.recommendations.join(' ')).toMatch(/Redaction marks could not be fully inspected/i);
  });
});
