/**
 * Phase 11 — RFC 3161 timestamp request / response (TimeStampReq / TimeStampResp).
 */

import { derLength, derSequence, derInteger, derObjectIdentifier, derOctetString } from '../crypto/cms-builder';
import { hashBytes, hashAlgorithmOID, type HashAlgorithm } from '../crypto/hash-engine';
import { parseDERNode, nodeOID } from '../crypto/signature-verify';
import type { ASN1Node } from '../crypto/types';

/** Default public TSA (fallback list — may be unavailable). */
export const DEFAULT_TSA_URLS = [
  'https://freetsa.org/tsr',
  'https://timestamp.digicert.com',
] as const;

export interface TimestampRequestOptions {
  /** Data to timestamp (typically CMS signatureValue / encryptedDigest). */
  data: Uint8Array;
  hashAlgorithm?: HashAlgorithm;
  /** Request TSA certificates in response. */
  certReq?: boolean;
  nonce?: Uint8Array;
  tsaUrl?: string;
  /** Extra TSA URLs to try on failure. */
  fallbackUrls?: string[];
  /** Fetch timeout ms. */
  timeoutMs?: number;
}

export interface TimestampToken {
  /** Full TimeStampToken (ContentInfo) DER. */
  der: Uint8Array;
  genTime: string | null;
  serialNumberHex: string | null;
  tsaUrl: string;
}

export interface TimestampResult {
  ok: boolean;
  token: TimestampToken | null;
  error?: string;
  /** True when TSA was skipped / unreachable and caller should continue without TST. */
  fallback: boolean;
}

function derBoolean(v: boolean): number[] {
  return [0x01, 0x01, v ? 0xff : 0x00];
}

function buildMessageImprint(hash: Uint8Array, hashAlgorithm: HashAlgorithm): number[] {
  const oid = hashAlgorithmOID(hashAlgorithm);
  const algId = derSequence([...derObjectIdentifier(oid), 0x05, 0x00]);
  return derSequence([...algId, ...derOctetString(hash)]);
}

/**
 * Build a TimeStampReq DER (RFC 3161).
 */
export function buildTimestampRequest(
  messageHash: Uint8Array,
  options: {
    hashAlgorithm?: HashAlgorithm;
    certReq?: boolean;
    nonce?: Uint8Array;
  } = {},
): Uint8Array {
  const hashAlgorithm = options.hashAlgorithm ?? 'sha256';
  const body: number[] = [
    ...derInteger(1),
    ...buildMessageImprint(messageHash, hashAlgorithm),
  ];
  if (options.nonce && options.nonce.length > 0) {
    body.push(...derInteger(options.nonce));
  }
  if (options.certReq !== false) {
    body.push(...derBoolean(true));
  }
  return new Uint8Array(derSequence(body));
}

function findUtcTime(node: ASN1Node): string | null {
  if (node.tag === 0x17 || node.tag === 0x18) {
    try {
      return new TextDecoder().decode(node.content);
    } catch {
      return null;
    }
  }
  if (node.children) {
    for (const c of node.children) {
      const t = findUtcTime(c);
      if (t) return t;
    }
  }
  return null;
}

function findIntegerHex(node: ASN1Node, depth = 0): string | null {
  if (depth > 8) return null;
  if (node.tag === 0x02) {
    return Array.from(node.content)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  if (node.children) {
    for (const c of node.children) {
      const v = findIntegerHex(c, depth + 1);
      if (v) return v;
    }
  }
  return null;
}

/**
 * Parse TimeStampResp → extract TimeStampToken ContentInfo.
 */
export function parseTimestampResponse(data: Uint8Array): {
  status: number;
  token: Uint8Array | null;
  genTime: string | null;
  serialNumberHex: string | null;
  statusString?: string;
} {
  let root: ASN1Node;
  try {
    root = parseDERNode(data, 0);
  } catch (e) {
    return {
      status: 2,
      token: null,
      genTime: null,
      serialNumberHex: null,
      statusString: `Invalid TimeStampResp: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const ch = root.children ?? [];
  // PKIStatusInfo
  const statusInfo = ch[0];
  const status = statusInfo?.children?.[0]?.content?.[0] ?? 2;
  if (status !== 0 && status !== 1) {
    let statusString = `PKIStatus=${status}`;
    const statusStringNode = statusInfo?.children?.[1];
    if (statusStringNode?.children?.[0]?.content) {
      try {
        statusString = new TextDecoder().decode(statusStringNode.children[0].content);
      } catch {
        // ignore
      }
    }
    return { status, token: null, genTime: null, serialNumberHex: null, statusString };
  }

  const tokenNode = ch[1];
  if (!tokenNode) {
    return { status, token: null, genTime: null, serialNumberHex: null };
  }

  // Re-slice full ContentInfo TLV from original
  let token: Uint8Array;
  if (tokenNode.offset != null && tokenNode.length != null) {
    token = data.subarray(tokenNode.offset, tokenNode.offset + tokenNode.length);
  } else {
    // reconstruct SEQUENCE
    const inner = tokenNode.content;
    const len = inner.length;
    token = new Uint8Array(4 + len);
    token[0] = 0x30;
    if (len < 0x80) {
      token = new Uint8Array(2 + len);
      token[0] = 0x30;
      token[1] = len;
      token.set(inner, 2);
    } else {
      token[0] = 0x30;
      token[1] = 0x82;
      token[2] = (len >> 8) & 0xff;
      token[3] = len & 0xff;
      token.set(inner, 4);
    }
  }

  const genTime = findUtcTime(tokenNode);
  const serialNumberHex = findIntegerHex(tokenNode);
  return { status, token, genTime, serialNumberHex };
}

async function postTimestamp(
  url: string,
  body: Uint8Array,
  timeoutMs: number,
): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/timestamp-query',
        Accept: 'application/timestamp-reply',
      },
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`TSA HTTP ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Request an RFC 3161 timestamp. Falls back gracefully when TSA is unavailable.
 */
export async function requestTimestamp(
  options: TimestampRequestOptions,
): Promise<TimestampResult> {
  const hashAlgorithm = options.hashAlgorithm ?? 'sha256';
  const hash = await hashBytes(options.data, hashAlgorithm);
  const req = buildTimestampRequest(hash, {
    hashAlgorithm,
    certReq: options.certReq !== false,
    nonce: options.nonce,
  });

  const urls = [
    options.tsaUrl,
    ...(options.fallbackUrls ?? []),
    ...DEFAULT_TSA_URLS,
  ].filter((u): u is string => !!u);

  const unique = [...new Set(urls)];
  const timeoutMs = options.timeoutMs ?? 8000;
  const errors: string[] = [];

  for (const url of unique) {
    try {
      const resp = await postTimestamp(url, req, timeoutMs);
      const parsed = parseTimestampResponse(resp);
      if (!parsed.token) {
        errors.push(`${url}: ${parsed.statusString ?? `status ${parsed.status}`}`);
        continue;
      }
      return {
        ok: true,
        token: {
          der: parsed.token,
          genTime: parsed.genTime,
          serialNumberHex: parsed.serialNumberHex,
          tsaUrl: url,
        },
        fallback: false,
      };
    } catch (e) {
      errors.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    ok: false,
    token: null,
    fallback: true,
    error: `TSA unavailable — continuing without timestamp. ${errors.join('; ')}`,
  };
}

/** Detect whether CMS contains a signature timestamp token attribute. */
export function cmsHasTimestampToken(cmsDer: Uint8Array): boolean {
  try {
    const root = parseDERNode(cmsDer, 0);
    const walk = (n: ASN1Node): boolean => {
      const oid = nodeOID(n);
      if (oid === '1.2.840.113549.1.9.16.2.14') return true;
      if (n.children) {
        for (const c of n.children) {
          if (walk(c)) return true;
        }
      }
      return false;
    };
    return walk(root);
  } catch {
    return false;
  }
}
