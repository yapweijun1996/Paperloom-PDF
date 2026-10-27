/**
 * ICC Profile Parser — Phase 3
 *
 * Parses ICC v2/v4 profile headers and tag table for color management.
 * ISO 15076-1 / ICC.1:2010.
 */

export interface ICCHeader {
  profileSize: number;
  cmmType: string;
  version: string;
  deviceClass: string;
  colorSpace: string;
  pcs: string;
  renderingIntent: number;
  illuminant: [number, number, number];
  profileCreator: string;
}

export interface ICCTag {
  signature: string;
  offset: number;
  size: number;
}

export interface ICCProfile {
  header: ICCHeader;
  tags: ICCTag[];
  data: Uint8Array;
}

function readTag(data: Uint8Array, offset: number): string {
  if (offset + 4 > data.length) return '';
  return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

function readU32BE(data: Uint8Array, offset: number): number {
  return (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
}

function readS15Fixed16(data: Uint8Array, offset: number): number {
  const raw = readU32BE(data, offset);
  return raw / 65536;
}

/** Parse ICC profile binary from an ICCBased stream. */
export function parseICCProfile(data: Uint8Array): ICCProfile | null {
  if (data.length < 128) return null;

  const profileSize = readU32BE(data, 0);
  if (profileSize > data.length) return null;

  const major = data[8];
  const minor = data[9] >> 4;
  const micro = data[9] & 0x0f;

  const header: ICCHeader = {
    profileSize,
    cmmType: readTag(data, 4),
    version: `${major}.${minor}.${micro}`,
    deviceClass: readTag(data, 12),
    colorSpace: readTag(data, 16),
    pcs: readTag(data, 20),
    renderingIntent: readU32BE(data, 64),
    illuminant: [
      readS15Fixed16(data, 68),
      readS15Fixed16(data, 72),
      readS15Fixed16(data, 76),
    ],
    profileCreator: readTag(data, 80),
  };

  const tagCount = readU32BE(data, 128);
  const tags: ICCTag[] = [];
  let tagOffset = 132;

  for (let i = 0; i < tagCount && tagOffset + 12 <= data.length; i++) {
    tags.push({
      signature: readTag(data, tagOffset),
      offset: readU32BE(data, tagOffset + 4),
      size: readU32BE(data, tagOffset + 8),
    });
    tagOffset += 12;
  }

  return { header, tags, data };
}

/** Extract a tag's raw bytes. */
export function getICCTag(profile: ICCProfile, signature: string): Uint8Array | null {
  const tag = profile.tags.find(t => t.signature === signature);
  if (!tag || tag.offset + tag.size > profile.data.length) return null;
  return profile.data.slice(tag.offset, tag.offset + tag.size);
}

/** Map ICC color space signature to component count. */
export function iccColorSpaceComponents(space: string): number {
  switch (space) {
    case 'GRAY': return 1;
    case 'RGB ': case 'RGB': return 3;
    case 'CMYK': return 4;
    case 'Lab ': case 'Lab': return 3;
    default: return 3;
  }
}
