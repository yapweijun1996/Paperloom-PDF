/**
 * AI document layer types — chunking, embedding blocks, semantic search index.
 */

/** Source provenance for a text chunk. */
export interface ChunkSource {
  documentId: string;
  pageIndex: number;
  blockId?: string;
  /** PDF user-space bbox when available. */
  bbox?: { x: number; y: number; width: number; height: number };
}

/** Document chunk sized for embedding models. */
export interface DocumentChunk {
  id: string;
  text: string;
  tokenEstimate: number;
  source: ChunkSource;
  /** Heading context prepended for embedding quality. */
  headingContext: string | null;
  /** Zero-based index in document chunk sequence. */
  sequenceIndex: number;
}

/** Block prepared for external embedding API (OpenAI, etc.). */
export interface EmbeddingBlock {
  id: string;
  /** Text fed to embedding model (may include metadata prefix). */
  input: string;
  chunk: DocumentChunk;
  /** Optional precomputed embedding vector. */
  vector?: Float32Array;
}

/** Indexed document term for TF-IDF search. */
export interface IndexTerm {
  term: string;
  documentFrequency: number;
}

/** In-memory semantic search index (TF-IDF + cosine similarity). */
export interface SemanticSearchIndex {
  documentId: string;
  chunks: DocumentChunk[];
  /** term → global document frequency */
  vocabulary: Map<string, number>;
  /** chunkId → sparse term frequency map */
  tfMaps: Map<string, Map<string, number>>;
  /** chunkId → L2-normalized TF-IDF vector (dense array aligned to vocabArray) */
  vectors: Map<string, Float32Array>;
  /** Stable term ordering for vector indices */
  vocabArray: string[];
  createdAt: number;
}

export interface ChunkingOptions {
  /** Target max tokens per chunk (word-based estimate). */
  maxTokens: number;
  /** Overlap tokens carried to next chunk for context continuity. */
  overlapTokens: number;
  /** Minimum chunk length to emit. */
  minTokens: number;
  /** Include heading path in chunk prefix. */
  includeHeadingContext: boolean;
}

export const DEFAULT_CHUNKING_OPTIONS: ChunkingOptions = {
  maxTokens: 512,
  overlapTokens: 64,
  minTokens: 32,
  includeHeadingContext: true,
};

export interface SearchOptions {
  topK: number;
  /** Minimum cosine similarity threshold 0–1. */
  minScore: number;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  topK: 5,
  minScore: 0.05,
};

export interface SearchHit {
  chunk: DocumentChunk;
  score: number;
  rank: number;
}

/** Input paragraph for chunking pipeline. */
export interface ChunkInputParagraph {
  text: string;
  pageIndex: number;
  blockId?: string;
  heading?: string;
  bbox?: { x: number; y: number; width: number; height: number };
}

export interface ChunkDocumentInput {
  documentId: string;
  paragraphs: ChunkInputParagraph[];
}
