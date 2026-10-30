import type { PDFDocumentData } from '../types';
import { saveQuick } from '../writer/save-pipeline';
import { createSignatureFieldAtPoint, detectSignatureFieldsOnPage } from '../signatures/fields/signature-field';
import { installSignatureBase, prepareSignatureSource, signDocumentCryptographic, type CryptoSignOptions, type SignPipelineResult } from '../signatures/crypto/signing-pipeline';
import { SessionDocumentEditor } from './document-edit';

/** Sign the caller-owned document as one graph-and-byte history boundary. */
export async function signDocumentTransaction(
  doc: PDFDocumentData,
  input: {
    pageIndex: number;
    selectedFieldId: string | null;
    point: { x: number; y: number };
    privateKey: CryptoKey;
    signOptions: CryptoSignOptions;
    isCurrent: () => boolean;
  },
): Promise<{ editor: SessionDocumentEditor; result: SignPipelineResult; pageIndex: number }> {
  if (!input.isCurrent()) throw new Error('The document was replaced before signing.');
  if (doc.decryptedFromEncrypted || doc.xref.trailerDict.getRef('Encrypt')) {
    throw new Error('Digital signing of encrypted documents is not supported.');
  }
  const editor = new SessionDocumentEditor();
  const signed: { result?: SignPipelineResult; pageIndex?: number } = {};
  await editor.edit(doc, 'digital-sign', async staged => {
    // The revision being signed must include edits already present in the graph.
    await prepareSignatureSource(staged);
    await installSignatureBase(staged, await saveQuick(staged));
    const fields = detectSignatureFieldsOnPage(staged, input.pageIndex);
    let field = fields.find(item => item.id === input.selectedFieldId) ?? fields.find(item => !item.signed);
    if (!field) {
      const created = createSignatureFieldAtPoint(staged, input.pageIndex, input.point.x, input.point.y, {
        withPlaceholderAppearance: true,
      });
      field = detectSignatureFieldsOnPage(staged, input.pageIndex).find(item => item.id === created.id);
    }
    if (!field) throw new Error('No valid signature field available for digital signing.');
    if (field.signed) throw new Error('This field is already signed.');
    signed.pageIndex = field.pageIndex;
    signed.result = await signDocumentCryptographic(staged, field.ref, input.privateKey, input.signOptions);
  }, { includeRawBytes: true, isCurrent: input.isCurrent });
  if (!signed.result || signed.pageIndex === undefined) throw new Error('Signing did not produce a revision.');
  return { editor, result: signed.result, pageIndex: signed.pageIndex };
}
