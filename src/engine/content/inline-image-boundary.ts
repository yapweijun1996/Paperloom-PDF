import { PDFArray, PDFDict, PDFName } from '../types';
import { zlibEncodedLength } from '../parser/filters';

/** A false EI match can turn compressed bytes into page drawing instructions. */
export class InlineImageBoundaryError extends Error {
  constructor(reason: string) {
    super(`Cannot safely determine inline image boundary: ${reason}`);
    this.name = 'InlineImageBoundaryError';
  }
}

function jpegLength(data: Uint8Array): number {
  if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error('invalid JPEG start');
  let pos = 2, inScan = false, sawScan = false;
  while (pos < data.length) {
    if (inScan) while (pos < data.length && data[pos] !== 0xff) pos++;
    if (data[pos++] !== 0xff) throw new Error('invalid JPEG marker');
    while (data[pos] === 0xff) pos++;
    if (pos >= data.length) throw new Error('truncated JPEG marker');
    const marker = data[pos++];
    if (inScan && (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7))) continue;
    inScan = false;
    if (marker === 0xd9) {
      if (!sawScan) throw new Error('JPEG has no scan');
      return pos;
    }
    if (marker === 0x01) continue;
    if (marker === 0xd8 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) throw new Error('unexpected JPEG marker');
    if (pos + 2 > data.length) throw new Error('truncated JPEG segment');
    const len = data[pos] * 256 + data[pos + 1];
    if (len < 2 || len > data.length - pos) throw new Error('invalid JPEG segment length');
    pos += len;
    if (marker === 0xda) { inScan = true; sawScan = true; }
  }
  throw new Error('JPEG is missing EOI');
}

function runLength(data: Uint8Array): number {
  let pos = 0;
  while (pos < data.length) {
    const command = data[pos++];
    if (command === 128) return pos;
    const payload = command < 128 ? command + 1 : 1;
    if (payload > data.length - pos) throw new Error('truncated RunLength data');
    pos += payload;
  }
  throw new Error('RunLength data is missing EOD');
}

/** Return the exact encoded data length, or refuse unknown/ambiguous filters. */
export function inlineEncodedLength(dict: PDFDict, bytes: Uint8Array): number {
  const raw = dict.get('Filter');
  const first = raw instanceof PDFArray ? raw.get(0) : raw;
  if (!(first instanceof PDFName)) throw new InlineImageBoundaryError('missing or indirect first filter');
  try {
    switch (first.name) {
      case 'FlateDecode': case 'Fl': return zlibEncodedLength(bytes);
      case 'DCTDecode': case 'DCT': return jpegLength(bytes);
      case 'ASCII85Decode': case 'A85':
        for (let i = 0; i + 1 < bytes.length; i++) if (bytes[i] === 0x7e && bytes[i + 1] === 0x3e) return i + 2;
        throw new Error('ASCII85 data is missing EOD');
      case 'ASCIIHexDecode': case 'AHx': {
        const end = bytes.indexOf(0x3e);
        if (end >= 0) return end + 1;
        throw new Error('ASCIIHex data is missing EOD');
      }
      case 'RunLengthDecode': case 'RL': return runLength(bytes);
      default: throw new Error(`unsupported filter ${first.name}`);
    }
  } catch (error) {
    throw new InlineImageBoundaryError(error instanceof Error ? error.message : 'invalid data');
  }
}
