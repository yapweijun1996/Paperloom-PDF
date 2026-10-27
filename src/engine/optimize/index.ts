/**
 * PDF optimization — reachability analysis, stream dedup, garbage collection.
 */

export {
  buildObjectGraph,
  computeReachability,
  rootsFromTrailer,
  deduplicateStreams,
  applyRefMap,
  garbageCollect,
} from './garbage-collect';

export type {
  ObjectGraphEdge,
  ObjectGraph,
  ReachabilityResult,
  StreamDuplicateGroup,
  DeduplicateResult,
  GarbageCollectResult,
  OptimizeOptions,
} from './types';

export { DEFAULT_OPTIMIZE_OPTIONS, fnv1aHex } from './types';

export { compressDocumentImages } from './image-compress';
export type { ImageCompressOptions, ImageCompressResult } from './image-compress';

export { recompressStreams } from './stream-recompress';
export type { RecompressResult } from './stream-recompress';

export { subsetFonts } from './font-subsetter';
export type { FontSubsetResult } from './font-subsetter';

export { packIntoObjectStreams, buildXRefStream } from './object-streams';
export type { ObjectStreamPack } from './object-streams';
