/**
 * Pure TypeScript MD5 (RFC 1321) for PDF Standard Security Handler R2–R4.
 */

function leftRotate(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function toWords(bytes: Uint8Array): number[] {
  const bitLen = bytes.length * 8;
  const withPad = bytes.length + 1;
  const total = ((withPad + 7) >> 6 << 4) + 16; // words including length
  // Simpler: pad to 56 mod 64, then +8
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  // length in bits as 64-bit LE
  view.setUint32(paddedLen - 8, bitLen >>> 0, true);
  view.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000), true);

  const words: number[] = [];
  for (let i = 0; i < paddedLen; i += 4) {
    words.push(view.getUint32(i, true));
  }
  return words;
}

export function md5(data: Uint8Array): Uint8Array {
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;

  const words = toWords(data);
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  }

  for (let offset = 0; offset < words.length; offset += 16) {
    let a = h0, b = h1, c = h2, d = h3;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const temp = d;
      d = c;
      c = b;
      const sum = (a + f + K[i] + words[offset + g]) >>> 0;
      b = (b + leftRotate(sum, s[i])) >>> 0;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  view.setUint32(0, h0, true);
  view.setUint32(4, h1, true);
  view.setUint32(8, h2, true);
  view.setUint32(12, h3, true);
  return out;
}
