/**
 * Phase 11 — Timestamp token helpers / re-exports.
 */

export {
  buildTimestampRequest,
  parseTimestampResponse,
  requestTimestamp,
  cmsHasTimestampToken,
  DEFAULT_TSA_URLS,
} from './timestamp-client';
export type {
  TimestampRequestOptions,
  TimestampToken,
  TimestampResult,
} from './timestamp-client';
