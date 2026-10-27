/**
 * Bloom Engine — public API
 *
 * PDF → Word-like document model → edit/reflow → compile clean PDF text.
 */

export type {
  BloomRun,
  BloomBlockKind,
  BloomAlign,
  BloomBox,
  BloomLineBox,
  BloomBlock,
  BloomFrame,
  BloomPage,
  BloomDocument,
  BloomCaret,
  BloomSelection,
} from './types';

export { blockPlainText } from './types';

export {
  ingestPage,
  ingestDocument,
  resetBloomIds,
} from './ingest';
export type { IngestPageOptions } from './ingest';

export {
  layoutPage,
  layoutBlock,
  measureWithRuns,
  sliceRunsForRange,
} from './layout';

export {
  insertTextAtCaret,
  deleteTextAtCaret,
  replaceRange,
  replaceBlockText,
  setBlockText,
  hitTestBloomPage,
  findNearestBlock,
  caretPdfPosition,
} from './edit';

export {
  renderBloomPage,
  maskBloomTextRegions,
  paintBloomOverPdf,
  maskBloomBlocks,
  renderBloomBlocks,
  paintBloomBlocksOverPdf,
} from './render';
export type { BloomRenderOptions } from './render';

export {
  compilePage,
  compilePageAndClearDirty,
  compileBlocks,
  compileBlocksAndClearDirty,
  stripOwnedTextOps,
  collectOwnedIndices,
} from './compile';
export type { CompilePageResult } from './compile';
