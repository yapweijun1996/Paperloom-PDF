/**
 * PDF Stream Filters — Decompression and decoding
 *
 * Implements the standard PDF stream filters:
 *   - FlateDecode (zlib/deflate via browser DecompressionStream API)
 *   - ASCIIHexDecode
 *   - ASCII85Decode
 *   - LZWDecode
 *   - RunLengthDecode
 *   - Predictor support (PNG predictors for FlateDecode/LZW)
 *
 * Uses the browser's native DecompressionStream for Flate — zero dependencies,
 * native C++ performance, and spec-compliant.
 */

import { PDFDict } from '../types';

// ─── Filter application ────────────────────────────────────────────────────

/**
 * Apply a chain of filters to decompress/decode stream data.
 * Filters are applied in order (first filter in the array is applied first).
 */
export async function applyFilters(
  data: Uint8Array,
  filterNames: string[],
  decodeParams: (PDFDict | null)[],
): Promise<Uint8Array> {
  let result = data;

  for (let i = 0; i < filterNames.length; i++) {
    const filterName = filterNames[i];
    const params = decodeParams[i] ?? null;

    switch (filterName) {
      case 'FlateDecode':
      case 'Fl':
        result = await flateDecode(result);
        result = applyPredictor(result, params);
        break;
      case 'ASCIIHexDecode':
      case 'AHx':
        result = asciiHexDecode(result);
        break;
      case 'ASCII85Decode':
      case 'A85':
        result = ascii85Decode(result);
        break;
      case 'LZWDecode':
      case 'LZW':
        result = lzwDecode(result, params);
        result = applyPredictor(result, params);
        break;
      case 'RunLengthDecode':
      case 'RL':
        result = runLengthDecode(result);
        break;
      case 'DCTDecode':
      case 'DCT':
        // JPEG — raw bytes are passed through; browser decodes via <img> or ImageBitmap
        break;
      case 'JPXDecode':
        // JPEG2000 — same as DCT, pass through
        break;
      case 'CCITTFaxDecode':
      case 'CCF':
        // CCITT fax — used in old scanned documents, complex to implement
        // For now pass through; will be handled by the image decoder
        break;
      case 'Crypt':
        // Encryption filter — skip for now (handled at document level)
        break;
      default:
        console.warn(`[PDF Filter] Unknown filter: ${filterName}, passing through`);
    }
  }

  return result;
}

// ─── FlateDecode (zlib inflate) ─────────────────────────────────────────────

/**
 * Decompress FlateDecode (zlib/deflate) data using the browser's native
 * DecompressionStream API. Falls back to a manual inflate if unavailable.
 */
async function flateDecode(data: Uint8Array): Promise<Uint8Array> {
  // Try browser's native DecompressionStream (available in all modern browsers)
  if (typeof DecompressionStream !== 'undefined') {
    try {
      return await nativeInflate(data, 'deflate');
    } catch {
      // Some PDFs use raw deflate without zlib header
      try {
        return await nativeInflate(data, 'raw');
      } catch {
        // Fall through to manual implementation
      }
    }
  }

  // Fallback: manual inflate implementation
  return manualInflate(data);
}

/**
 * Use the browser's native DecompressionStream API
 */
async function nativeInflate(
  data: Uint8Array,
  format: 'deflate' | 'raw',
): Promise<Uint8Array> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ds = new DecompressionStream(format as any);
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  // Write compressed data
  writer.write(data as unknown as BufferSource).catch(() => {});
  writer.close().catch(() => {});

  // Read decompressed chunks
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }

  // Concatenate chunks
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Manual inflate implementation for environments without DecompressionStream.
 * Implements RFC 1951 DEFLATE decompression.
 *
 * This is a complete, standalone implementation — no external dependencies.
 */
function manualInflate(data: Uint8Array): Uint8Array {
  let pos = 0;
  let bitBuf = 0;
  let bitCount = 0;

  // Check for zlib header (CMF + FLG)
  if (data.length >= 2) {
    const cmf = data[0];
    const flg = data[1];
    const cm = cmf & 0x0f;
    if (cm === 8 && (cmf * 256 + flg) % 31 === 0) {
      pos = 2; // Skip zlib header
      // If FDICT flag is set, skip 4-byte dictionary ID
      if (flg & 0x20) pos += 4;
    }
  }

  const output: number[] = [];

  function readBits(n: number): number {
    while (bitCount < n) {
      if (pos >= data.length) throw new Error('Unexpected end of deflate data');
      bitBuf |= data[pos++] << bitCount;
      bitCount += 8;
    }
    const val = bitBuf & ((1 << n) - 1);
    bitBuf >>= n;
    bitCount -= n;
    return val;
  }

  function readByte(): number {
    // Flush bit buffer to byte boundary
    bitBuf = 0;
    bitCount = 0;
    if (pos >= data.length) throw new Error('Unexpected end of deflate data');
    return data[pos++];
  }

  // Fixed Huffman code lengths (RFC 1951 section 3.2.6)
  function buildFixedLitLenTree(): HuffmanTree {
    const lengths = new Uint8Array(288);
    for (let i = 0; i <= 143; i++) lengths[i] = 8;
    for (let i = 144; i <= 255; i++) lengths[i] = 9;
    for (let i = 256; i <= 279; i++) lengths[i] = 7;
    for (let i = 280; i <= 287; i++) lengths[i] = 8;
    return buildHuffmanTree(lengths);
  }

  function buildFixedDistTree(): HuffmanTree {
    const lengths = new Uint8Array(30);
    lengths.fill(5);
    return buildHuffmanTree(lengths);
  }

  // Extra bits tables for length and distance codes
  const lengthBase = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
    35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
  ];
  const lengthExtra = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
    3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
  ];
  const distBase = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
    257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
  ];
  const distExtra = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
    7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
  ];

  function decodeSymbol(tree: HuffmanTree): number {
    let node = tree.root;
    while (node.left || node.right) {
      const bit = readBits(1);
      node = bit ? node.right! : node.left!;
      if (!node) throw new Error('Invalid Huffman code');
    }
    return node.symbol!;
  }

  let finalBlock = false;

  while (!finalBlock) {
    finalBlock = readBits(1) === 1;
    const blockType = readBits(2);

    if (blockType === 0) {
      // ── Stored (no compression) ──
      // Align to byte boundary
      bitBuf = 0;
      bitCount = 0;
      const len = data[pos] | (data[pos + 1] << 8);
      pos += 2;
      // Skip NLEN (one's complement of LEN)
      pos += 2;
      for (let i = 0; i < len; i++) {
        output.push(data[pos++]);
      }
    } else if (blockType === 1) {
      // ── Fixed Huffman codes ──
      const litLenTree = buildFixedLitLenTree();
      const distTree = buildFixedDistTree();
      inflateBlock(litLenTree, distTree);
    } else if (blockType === 2) {
      // ── Dynamic Huffman codes ──
      const hlit = readBits(5) + 257;
      const hdist = readBits(5) + 1;
      const hclen = readBits(4) + 4;

      // Read code length code lengths
      const codeLenOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
      const codeLenLengths = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) {
        codeLenLengths[codeLenOrder[i]] = readBits(3);
      }
      const codeLenTree = buildHuffmanTree(codeLenLengths);

      // Read literal/length and distance code lengths
      const lengths = new Uint8Array(hlit + hdist);
      let idx = 0;
      while (idx < hlit + hdist) {
        const sym = decodeSymbol(codeLenTree);
        if (sym < 16) {
          lengths[idx++] = sym;
        } else if (sym === 16) {
          const repeat = readBits(2) + 3;
          const prev = idx > 0 ? lengths[idx - 1] : 0;
          for (let i = 0; i < repeat; i++) lengths[idx++] = prev;
        } else if (sym === 17) {
          const repeat = readBits(3) + 3;
          for (let i = 0; i < repeat; i++) lengths[idx++] = 0;
        } else if (sym === 18) {
          const repeat = readBits(7) + 11;
          for (let i = 0; i < repeat; i++) lengths[idx++] = 0;
        }
      }

      const litLenLengths = lengths.slice(0, hlit);
      const distLengths = lengths.slice(hlit, hlit + hdist);
      const litLenTree = buildHuffmanTree(litLenLengths);
      const distTree = buildHuffmanTree(distLengths);
      inflateBlock(litLenTree, distTree);
    } else {
      throw new Error(`Invalid deflate block type: ${blockType}`);
    }
  }

  function inflateBlock(litLenTree: HuffmanTree, distTree: HuffmanTree) {
    while (true) {
      const sym = decodeSymbol(litLenTree);
      if (sym < 256) {
        output.push(sym);
      } else if (sym === 256) {
        break; // End of block
      } else {
        // Length-distance pair
        const lenIdx = sym - 257;
        const length = lengthBase[lenIdx] + readBits(lengthExtra[lenIdx]);

        const distSym = decodeSymbol(distTree);
        const distance = distBase[distSym] + readBits(distExtra[distSym]);

        // Copy from output buffer
        const srcStart = output.length - distance;
        for (let i = 0; i < length; i++) {
          output.push(output[srcStart + i]);
        }
      }
    }
  }

  return new Uint8Array(output);
}

// ─── Huffman tree ───────────────────────────────────────────────────────────

interface HuffmanNode {
  left?: HuffmanNode;
  right?: HuffmanNode;
  symbol?: number;
}

interface HuffmanTree {
  root: HuffmanNode;
}

function buildHuffmanTree(codeLengths: Uint8Array): HuffmanTree {
  let maxBits = 1;
  for (let i = 0; i < codeLengths.length; i++) {
    if (codeLengths[i] > maxBits) maxBits = codeLengths[i];
  }
  const blCount = new Uint16Array(maxBits + 1);
  for (let i = 0; i < codeLengths.length; i++) {
    const len = codeLengths[i];
    if (len > 0) blCount[len]++;
  }

  const nextCode = new Uint16Array(maxBits + 1);
  let code = 0;
  for (let bits = 1; bits <= maxBits; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }

  const root: HuffmanNode = {};
  for (let i = 0; i < codeLengths.length; i++) {
    const len = codeLengths[i];
    if (len === 0) continue;
    const c = nextCode[len]++;
    let node = root;
    for (let bit = len - 1; bit >= 0; bit--) {
      const b = (c >> bit) & 1;
      if (b === 0) {
        if (!node.left) node.left = {};
        node = node.left;
      } else {
        if (!node.right) node.right = {};
        node = node.right;
      }
    }
    node.symbol = i;
  }

  return { root };
}

// ─── Predictor support ──────────────────────────────────────────────────────

/**
 * Apply PNG/TIFF predictor to decompressed data.
 * Commonly used with FlateDecode and LZWDecode.
 */
function applyPredictor(data: Uint8Array, params: PDFDict | null): Uint8Array {
  if (!params) return data;

  const predictor = params.getNumber('Predictor') ?? 1;
  if (predictor === 1) return data; // No prediction

  const columns = params.getNumber('Columns') ?? 1;
  const colors = params.getNumber('Colors') ?? 1;
  const bitsPerComponent = params.getNumber('BitsPerComponent') ?? 8;

  if (predictor === 2) {
    // TIFF Predictor 2 — horizontal differencing
    return tiffPredictor2(data, columns, colors, bitsPerComponent);
  }

  if (predictor >= 10 && predictor <= 15) {
    // PNG predictors (10=None, 11=Sub, 12=Up, 13=Average, 14=Paeth, 15=Optimum)
    return pngPredictor(data, columns, colors, bitsPerComponent);
  }

  return data;
}

function tiffPredictor2(
  data: Uint8Array,
  columns: number,
  colors: number,
  bpc: number,
): Uint8Array {
  if (bpc !== 8) return data; // Only 8-bit supported for now

  const bytesPerRow = columns * colors;
  const rows = Math.floor(data.length / bytesPerRow);
  const result = new Uint8Array(data.length);

  for (let row = 0; row < rows; row++) {
    const offset = row * bytesPerRow;
    for (let col = 0; col < bytesPerRow; col++) {
      if (col < colors) {
        result[offset + col] = data[offset + col];
      } else {
        result[offset + col] = (data[offset + col] + result[offset + col - colors]) & 0xff;
      }
    }
  }

  return result;
}

function pngPredictor(
  data: Uint8Array,
  columns: number,
  colors: number,
  bpc: number,
): Uint8Array {
  const bytesPerPixel = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowBytes = Math.ceil((columns * colors * bpc) / 8);
  // Each row in PNG-predicted data has a 1-byte filter type prefix
  const srcRowBytes = rowBytes + 1;
  const rows = Math.floor(data.length / srcRowBytes);

  const result = new Uint8Array(rows * rowBytes);
  const prevRow = new Uint8Array(rowBytes); // Previous row (starts as zeros)

  for (let row = 0; row < rows; row++) {
    const srcOffset = row * srcRowBytes;
    const dstOffset = row * rowBytes;
    const filterType = data[srcOffset];

    for (let col = 0; col < rowBytes; col++) {
      const raw = data[srcOffset + 1 + col];
      const a = col >= bytesPerPixel ? result[dstOffset + col - bytesPerPixel] : 0; // left
      const b = prevRow[col]; // above
      const c = col >= bytesPerPixel ? prevRow[col - bytesPerPixel] : 0; // upper-left

      let decoded: number;
      switch (filterType) {
        case 0: // None
          decoded = raw;
          break;
        case 1: // Sub
          decoded = (raw + a) & 0xff;
          break;
        case 2: // Up
          decoded = (raw + b) & 0xff;
          break;
        case 3: // Average
          decoded = (raw + Math.floor((a + b) / 2)) & 0xff;
          break;
        case 4: // Paeth
          decoded = (raw + paethPredictor(a, b, c)) & 0xff;
          break;
        default:
          decoded = raw;
      }

      result[dstOffset + col] = decoded;
    }

    // Copy current row to prevRow for next iteration
    prevRow.set(result.subarray(dstOffset, dstOffset + rowBytes));
  }

  return result;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// ─── ASCIIHexDecode ─────────────────────────────────────────────────────────

function asciiHexDecode(data: Uint8Array): Uint8Array {
  const output: number[] = [];
  let hex = '';

  for (let i = 0; i < data.length; i++) {
    const ch = data[i];

    // End-of-data marker
    if (ch === 0x3e) break; // '>'

    // Skip whitespace
    if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d || ch === 0x0c || ch === 0x00) {
      continue;
    }

    hex += String.fromCharCode(ch);
    if (hex.length === 2) {
      output.push(parseInt(hex, 16));
      hex = '';
    }
  }

  // If odd number of hex digits, pad last nibble with 0
  if (hex.length === 1) {
    output.push(parseInt(hex + '0', 16));
  }

  return new Uint8Array(output);
}

// ─── ASCII85Decode (Base85) ─────────────────────────────────────────────────

function ascii85Decode(data: Uint8Array): Uint8Array {
  const output: number[] = [];
  let i = 0;

  // Skip "<~" prefix if present
  if (data[0] === 0x3c && data[1] === 0x7e) i = 2;

  while (i < data.length) {
    const ch = data[i];

    // End-of-data: "~>"
    if (ch === 0x7e && i + 1 < data.length && data[i + 1] === 0x3e) break;

    // Skip whitespace
    if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d || ch === 0x0c) {
      i++;
      continue;
    }

    // 'z' is special shorthand for four zero bytes
    if (ch === 0x7a) {
      output.push(0, 0, 0, 0);
      i++;
      continue;
    }

    // Collect up to 5 base-85 digits
    const group: number[] = [];
    while (group.length < 5 && i < data.length) {
      const c = data[i];
      if (c === 0x7e) break; // EOD
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c) {
        i++;
        continue;
      }
      group.push(c - 33); // '!' = 0 in base-85
      i++;
    }

    if (group.length === 0) break;

    // Pad incomplete group with 'u' (84)
    const padded = [...group];
    while (padded.length < 5) padded.push(84);

    // Decode 5 base-85 digits to 4 bytes
    let value = 0;
    for (let j = 0; j < 5; j++) {
      value = value * 85 + padded[j];
    }

    // Output bytes (big-endian)
    const numBytes = group.length - 1; // 2 digits → 1 byte, 3 → 2, 4 → 3, 5 → 4
    if (numBytes >= 1) output.push((value >> 24) & 0xff);
    if (numBytes >= 2) output.push((value >> 16) & 0xff);
    if (numBytes >= 3) output.push((value >> 8) & 0xff);
    if (numBytes >= 4) output.push(value & 0xff);
  }

  return new Uint8Array(output);
}

// ─── LZWDecode ──────────────────────────────────────────────────────────────

function lzwDecode(data: Uint8Array, params: PDFDict | null): Uint8Array {
  const earlyChange = params?.getNumber('EarlyChange') ?? 1;
  const output: number[] = [];

  let bitPos = 0;
  let codeSize = 9;
  const clearCode = 256;
  const eodCode = 257;

  function readCode(): number {
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      const byteIdx = Math.floor(bitPos / 8);
      const bitIdx = 7 - (bitPos % 8); // MSB first
      if (byteIdx < data.length) {
        code |= ((data[byteIdx] >> bitIdx) & 1) << (codeSize - 1 - i);
      }
      bitPos++;
    }
    return code;
  }

  // Initialize table
  let table: Uint8Array[] = [];
  function resetTable() {
    table = [];
    for (let i = 0; i < 256; i++) table.push(new Uint8Array([i]));
    table.push(new Uint8Array(0)); // 256 = clear
    table.push(new Uint8Array(0)); // 257 = EOD
    codeSize = 9;
  }

  resetTable();
  let prevEntry: Uint8Array | null = null;

  while (bitPos < data.length * 8) {
    const code = readCode();

    if (code === eodCode) break;

    if (code === clearCode) {
      resetTable();
      prevEntry = null;
      continue;
    }

    let entry: Uint8Array;
    if (code < table.length) {
      entry = table[code];
    } else if (code === table.length && prevEntry) {
      // Special case: code not yet in table
      entry = new Uint8Array(prevEntry.length + 1);
      entry.set(prevEntry);
      entry[prevEntry.length] = prevEntry[0];
    } else {
      // Invalid code — break to avoid infinite loop
      break;
    }

    for (let i = 0; i < entry.length; i++) output.push(entry[i]);

    if (prevEntry) {
      const newEntry = new Uint8Array(prevEntry.length + 1);
      newEntry.set(prevEntry);
      newEntry[prevEntry.length] = entry[0];
      table.push(newEntry);

      // Increase code size when table grows past threshold
      const threshold = (1 << codeSize) - earlyChange;
      if (table.length > threshold && codeSize < 12) {
        codeSize++;
      }
    }

    prevEntry = entry;
  }

  return new Uint8Array(output);
}

// ─── RunLengthDecode ────────────────────────────────────────────────────────

function runLengthDecode(data: Uint8Array): Uint8Array {
  const output: number[] = [];
  let i = 0;

  while (i < data.length) {
    const length = data[i++];

    if (length === 128) break; // EOD marker

    if (length < 128) {
      // Copy next (length + 1) bytes literally
      const count = length + 1;
      for (let j = 0; j < count && i < data.length; j++) {
        output.push(data[i++]);
      }
    } else {
      // Repeat next byte (257 - length) times
      const count = 257 - length;
      if (i < data.length) {
        const byte = data[i++];
        for (let j = 0; j < count; j++) {
          output.push(byte);
        }
      }
    }
  }

  return new Uint8Array(output);
}

// ─── Compression (for writing) ──────────────────────────────────────────────

/**
 * Compress data using FlateDecode via browser's native CompressionStream.
 * Used when writing modified streams back to PDF.
 */
export async function flateEncode(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('deflate');
    const writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();

    writer.write(data as unknown as BufferSource).catch(() => {});
    writer.close().catch(() => {});

    const chunks: Uint8Array[] = [];
    let totalLength = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLength += value.length;
    }

    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  }

  // If CompressionStream is not available, return uncompressed
  // (the writer will omit the FlateDecode filter)
  return data;
}
