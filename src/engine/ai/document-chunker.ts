/**
 * Document chunking, embedding-ready blocks, and TF-IDF semantic search index.
 *
 * Pure TypeScript — no external embedding APIs. Vectors are built locally
 * for keyword-semantic retrieval until external embeddings are wired.
 */

import type {
  ChunkDocumentInput,
  ChunkingOptions,
  DocumentChunk,
  EmbeddingBlock,
  SearchHit,
  SearchOptions,
  SemanticSearchIndex,
} from './types';
import { DEFAULT_CHUNKING_OPTIONS, DEFAULT_SEARCH_OPTIONS } from './types';

// ─── Token estimation ────────────────────────────────────────────────────────

/** Rough token count ≈ words × 1.3 (English prose heuristic). */
export function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return Math.max(1, Math.ceil(words.length * 1.3));
}

function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

// ─── Chunking ────────────────────────────────────────────────────────────────

let chunkIdCounter = 0;

/**
 * Split document paragraphs into embedding-sized chunks with overlap.
 */
export function chunkDocument(
  input: ChunkDocumentInput,
  options: Partial<ChunkingOptions> = {},
): DocumentChunk[] {
  const opts = { ...DEFAULT_CHUNKING_OPTIONS, ...options };
  const chunks: DocumentChunk[] = [];
  let sequenceIndex = 0;
  let currentHeading: string | null = null;

  let buffer = '';
  let bufferTokens = 0;
  let bufferSource = input.paragraphs[0]
    ? {
        pageIndex: input.paragraphs[0].pageIndex,
        blockId: input.paragraphs[0].blockId,
        bbox: input.paragraphs[0].bbox,
      }
    : { pageIndex: 0 };

  function flushBuffer(): void {
    const trimmed = buffer.trim();
    if (!trimmed || bufferTokens < opts.minTokens) return;

    const prefix = opts.includeHeadingContext && currentHeading
      ? `[${currentHeading}]\n`
      : '';

    chunks.push({
      id: `chunk_${++chunkIdCounter}`,
      text: trimmed,
      tokenEstimate: estimateTokens(trimmed),
      source: {
        documentId: input.documentId,
        pageIndex: bufferSource.pageIndex,
        blockId: bufferSource.blockId,
        bbox: bufferSource.bbox,
      },
      headingContext: currentHeading,
      sequenceIndex: sequenceIndex++,
    });

    if (opts.overlapTokens > 0) {
      const words = trimmed.split(/\s+/);
      const overlapWords = Math.ceil(opts.overlapTokens / 1.3);
      buffer = words.slice(-overlapWords).join(' ');
      bufferTokens = estimateTokens(buffer);
    } else {
      buffer = '';
      bufferTokens = 0;
    }
  }

  for (const para of input.paragraphs) {
    if (para.heading) currentHeading = para.heading;

    const sentences = splitIntoSentences(para.text);
    for (const sentence of sentences) {
      const st = estimateTokens(sentence);
      if (bufferTokens + st > opts.maxTokens && buffer.length > 0) {
        flushBuffer();
      }
      if (buffer.length === 0) {
        bufferSource = {
          pageIndex: para.pageIndex,
          blockId: para.blockId,
          bbox: para.bbox,
        };
      }
      buffer += (buffer.length ? ' ' : '') + sentence;
      bufferTokens = estimateTokens(buffer);
    }
  }

  flushBuffer();
  return chunks;
}

/**
 * Wrap chunks as embedding API input blocks with optional context prefix.
 */
export function toEmbeddingBlocks(chunks: DocumentChunk[]): EmbeddingBlock[] {
  return chunks.map(chunk => {
    const prefix = chunk.headingContext ? `Section: ${chunk.headingContext}\n\n` : '';
    return {
      id: chunk.id,
      input: prefix + chunk.text,
      chunk,
    };
  });
}

// ─── TF-IDF index ────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'this', 'that', 'it', 'as', 'not', 'no', 'yes', 'can', 'will', 'has', 'have',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

function buildTf(text: string): Map<string, number> {
  const tf = new Map<string, number>();
  const tokens = tokenize(text);
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  const max = Math.max(1, ...Array.from(tf.values()));
  for (const [t, c] of tf.entries()) {
    tf.set(t, c / max);
  }
  return tf;
}

/**
 * Build in-memory semantic search index from document chunks.
 */
export function buildSemanticSearchIndex(
  documentId: string,
  chunks: DocumentChunk[],
): SemanticSearchIndex {
  const vocabulary = new Map<string, number>();
  const tfMaps = new Map<string, Map<string, number>>();

  for (const chunk of chunks) {
    const tf = buildTf(chunk.text);
    tfMaps.set(chunk.id, tf);
    for (const term of tf.keys()) {
      vocabulary.set(term, (vocabulary.get(term) ?? 0) + 1);
    }
  }

  const N = chunks.length;
  const vocabArray = Array.from(vocabulary.keys()).sort();
  const vocabIndex = new Map(vocabArray.map((t, i) => [t, i] as const));
  const vectors = new Map<string, Float32Array>();

  for (const chunk of chunks) {
    const tf = tfMaps.get(chunk.id)!;
    const vec = new Float32Array(vocabArray.length);
    for (const [term, freq] of tf.entries()) {
      const df = vocabulary.get(term)!;
      const idf = Math.log((N + 1) / (df + 1)) + 1;
      const idx = vocabIndex.get(term)!;
      vec[idx] = freq * idf;
    }
    normalizeVector(vec);
    vectors.set(chunk.id, vec);
  }

  const indexTerms = new Map<string, number>();
  for (const [term, df] of vocabulary.entries()) indexTerms.set(term, df);

  return {
    documentId,
    chunks,
    vocabulary: indexTerms,
    tfMaps,
    vectors,
    vocabArray,
    createdAt: Date.now(),
  };
}

function normalizeVector(v: Float32Array): void {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i]! /= norm;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i]! * b[i]!;
  return dot;
}

function queryVector(query: string, index: SemanticSearchIndex): Float32Array {
  const tf = buildTf(query);
  const N = index.chunks.length;
  const vec = new Float32Array(index.vocabArray.length);
  for (const [term, freq] of tf.entries()) {
    const df = index.vocabulary.get(term);
    if (df === undefined) continue;
    const idf = Math.log((N + 1) / (df + 1)) + 1;
    const idx = index.vocabArray.indexOf(term);
    if (idx >= 0) vec[idx] = freq * idf;
  }
  normalizeVector(vec);
  return vec;
}

/**
 * Search index with cosine similarity over TF-IDF vectors.
 */
export function searchSemanticIndex(
  index: SemanticSearchIndex,
  query: string,
  options: Partial<SearchOptions> = {},
): SearchHit[] {
  const opts = { ...DEFAULT_SEARCH_OPTIONS, ...options };
  const qVec = queryVector(query, index);
  const scored: SearchHit[] = [];

  for (const chunk of index.chunks) {
    const vec = index.vectors.get(chunk.id);
    if (!vec) continue;
    const score = cosineSimilarity(qVec, vec);
    if (score >= opts.minScore) {
      scored.push({ chunk, score, rank: 0 });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, opts.topK).map((hit, i) => ({ ...hit, rank: i + 1 }));
}

/** End-to-end: chunk document + build index. */
export function indexDocument(
  input: ChunkDocumentInput,
  chunkOpts?: Partial<ChunkingOptions>,
): SemanticSearchIndex {
  const chunks = chunkDocument(input, chunkOpts);
  return buildSemanticSearchIndex(input.documentId, chunks);
}

export function resetChunkIdCounter(): void {
  chunkIdCounter = 0;
}
