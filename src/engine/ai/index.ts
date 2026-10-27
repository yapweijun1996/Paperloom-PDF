/**
 * AI document layer — chunking, embedding blocks, semantic search index, compare.
 */

export {
  estimateTokens,
  chunkDocument,
  toEmbeddingBlocks,
  buildSemanticSearchIndex,
  searchSemanticIndex,
  indexDocument,
  resetChunkIdCounter,
} from './document-chunker';

export {
  comparePageText,
  compareDocuments,
  extractPagePlainText,
} from './compare';
export type { TextDiff, DocumentCompareResult } from './compare';

export type {
  ChunkSource,
  DocumentChunk,
  EmbeddingBlock,
  IndexTerm,
  SemanticSearchIndex,
  ChunkingOptions,
  SearchOptions,
  SearchHit,
  ChunkInputParagraph,
  ChunkDocumentInput,
} from './types';

export { DEFAULT_CHUNKING_OPTIONS, DEFAULT_SEARCH_OPTIONS } from './types';
