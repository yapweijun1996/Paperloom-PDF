/**
 * ICC LUT transforms — lut8, lut16, mft2 with trilinear CLUT interpolation.
 * ISO 15076-1 / ICC.1:2010.
 */

import type { ICCProfile } from './icc-profile';
import { getICCTag, parseICCProfile } from './icc-profile';

export type ICCLutType = 'lut8' | 'lut16' | 'mft1' | 'mft2' | 'unknown';

export interface ICCLutInfo {
  type: ICCLutType;
  inputChannels: number;
  outputChannels: number;
  gridPoints: number[];
}

export interface Mft2Table {
  info: ICCLutInfo;
  inputCurves: number[][];
  outputCurves: number[][];
  clut: Uint16Array;
  clutOffset: number;
}

function readTagType(tag: Uint8Array): ICCLutType {
  if (tag.length < 8) return 'unknown';
  const sig = String.fromCharCode(tag[4], tag[5], tag[6], tag[7]);
  switch (sig) {
    case 'mft1': return 'mft1';
    case 'mft2': return 'mft2';
    default:
      if (sig === 'lut8') return 'lut8';
      if (sig === 'lut16') return 'lut16';
      return 'unknown';
  }
}

function readU16BE(tag: Uint8Array, offset: number): number {
  return (tag[offset] << 8) | tag[offset + 1];
}

/** Parse LUT metadata from an A2B* or B2A* tag. */
export function parseICCLutTag(tag: Uint8Array): ICCLutInfo | null {
  if (tag.length < 20) return null;

  const type = readTagType(tag);
  const inputChannels = tag[8];
  const outputChannels = tag[9];
  const gridPoints: number[] = [];

  for (let i = 0; i < inputChannels; i++) {
    gridPoints.push(tag[10 + i] ?? 2);
  }

  return { type, inputChannels, outputChannels, gridPoints };
}

/** Parse mft2 tag into curves + 16-bit CLUT. */
export function parseMft2Table(tag: Uint8Array): Mft2Table | null {
  const info = parseICCLutTag(tag);
  if (!info || info.type !== 'mft2') return null;

  const { inputChannels, outputChannels, gridPoints } = info;
  let pos = 10 + inputChannels + 1; // skip reserved byte after grid points
  if (pos % 2 !== 0) pos += 1;

  const inputCurves: number[][] = [];
  for (let i = 0; i < inputChannels; i++) {
    if (pos + 2 > tag.length) return null;
    const count = readU16BE(tag, pos);
    pos += 2;
    const curve: number[] = [];
    for (let c = 0; c < count; c++) {
      curve.push(readU16BE(tag, pos) / 65535);
      pos += 2;
    }
    inputCurves.push(curve);
  }

  const outputCurves: number[][] = [];
  for (let i = 0; i < outputChannels; i++) {
    if (pos + 2 > tag.length) return null;
    const count = readU16BE(tag, pos);
    pos += 2;
    const curve: number[] = [];
    for (let c = 0; c < count; c++) {
      curve.push(readU16BE(tag, pos) / 65535);
      pos += 2;
    }
    outputCurves.push(curve);
  }

  const clutCells = gridPoints.reduce((a, g) => a * g, 1);
  const clutLen = clutCells * outputChannels;
  const clut = new Uint16Array(clutLen);
  for (let i = 0; i < clutLen && pos + 2 <= tag.length; i++) {
    clut[i] = readU16BE(tag, pos);
    pos += 2;
  }

  return { info, inputCurves, outputCurves, clut, clutOffset: pos };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function linearizeSRGB(c: number): number {
  const x = clamp01(c);
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function delinearizeSRGB(c: number): number {
  const x = clamp01(c);
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

function applyCurve(value: number, curve: number[]): number {
  if (curve.length < 2) return clamp01(value);
  const t = clamp01(value) * (curve.length - 1);
  const lo = Math.floor(t);
  const hi = Math.min(curve.length - 1, lo + 1);
  const f = t - lo;
  return curve[lo] * (1 - f) + curve[hi] * f;
}

function clutIndex(gridPoints: number[], indices: number[]): number {
  let idx = 0;
  let stride = 1;
  for (let i = gridPoints.length - 1; i >= 0; i--) {
    idx += indices[i] * stride;
    stride *= gridPoints[i];
  }
  return idx;
}

/** Trilinear interpolation for 3-input CLUT; falls back to nearest for other dimensions. */
function sampleMft2Clut(
  table: Mft2Table,
  input: number[],
): number[] {
  const { info, clut } = table;
  const { gridPoints, outputChannels } = info;
  const nIn = info.inputChannels;

  const mapped = input.map((v, i) => applyCurve(v, table.inputCurves[i] ?? []));

  if (nIn === 3 && gridPoints.length >= 3) {
    const gx = gridPoints[0] - 1;
    const gy = gridPoints[1] - 1;
    const gz = gridPoints[2] - 1;

    const tx = clamp01(mapped[0]) * gx;
    const ty = clamp01(mapped[1]) * gy;
    const tz = clamp01(mapped[2]) * gz;

    const x0 = Math.floor(tx);
    const y0 = Math.floor(ty);
    const z0 = Math.floor(tz);
    const x1 = Math.min(gx, x0 + 1);
    const y1 = Math.min(gy, y0 + 1);
    const z1 = Math.min(gz, z0 + 1);
    const fx = tx - x0;
    const fy = ty - y0;
    const fz = tz - z0;

    const corners = [
      [x0, y0, z0], [x1, y0, z0], [x0, y1, z0], [x1, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x0, y1, z1], [x1, y1, z1],
    ];
    const weights = [
      (1 - fx) * (1 - fy) * (1 - fz),
      fx * (1 - fy) * (1 - fz),
      (1 - fx) * fy * (1 - fz),
      fx * fy * (1 - fz),
      (1 - fx) * (1 - fy) * fz,
      fx * (1 - fy) * fz,
      (1 - fx) * fy * fz,
      fx * fy * fz,
    ];

    const out = new Array(outputChannels).fill(0);
    for (let c = 0; c < corners.length; c++) {
      const idx = clutIndex(gridPoints, corners[c]);
      for (let ch = 0; ch < outputChannels; ch++) {
        out[ch] += (clut[idx * outputChannels + ch] / 65535) * weights[c];
      }
    }

    return out.map((v, i) => applyCurve(v, table.outputCurves[i] ?? []));
  }

  const indices = mapped.map((v, i) =>
    Math.round(clamp01(v) * (gridPoints[i] - 1)),
  );
  const idx = clutIndex(gridPoints, indices);
  const out: number[] = [];
  for (let ch = 0; ch < outputChannels; ch++) {
    const raw = clut[idx * outputChannels + ch] / 65535;
    out.push(applyCurve(raw, table.outputCurves[ch] ?? []));
  }
  return out;
}

function transformWithTag(
  tag: Uint8Array,
  components: number[],
): number[] | null {
  const info = parseICCLutTag(tag);
  if (!info) return null;

  if (info.type === 'lut8' && info.inputChannels === components.length) {
    return sampleLut8(tag, info, components);
  }

  if (info.type === 'mft2' && info.inputChannels === components.length) {
    const table = parseMft2Table(tag);
    if (table) return sampleMft2Clut(table, components);
  }

  return null;
}

/**
 * Transform device color components to PCS using A2B tag.
 */
export function transformDeviceToPCS(
  profile: ICCProfile,
  components: number[],
): number[] {
  const a2b = getICCTag(profile, 'A2B0')
    ?? getICCTag(profile, 'A2B1')
    ?? getICCTag(profile, 'A2B2');

  if (a2b) {
    const out = transformWithTag(a2b, components);
    if (out) return out;
  }

  if (components.length >= 3) {
    return [
      linearizeSRGB(components[0]),
      linearizeSRGB(components[1]),
      linearizeSRGB(components[2]),
    ];
  }
  const g = linearizeSRGB(components[0] ?? 0);
  return [g, g, g];
}

/**
 * Transform PCS components to device color using B2A tag.
 */
export function transformPCSToDevice(
  profile: ICCProfile,
  pcs: number[],
  channelCount: number,
): number[] {
  const b2a = getICCTag(profile, 'B2A0')
    ?? getICCTag(profile, 'B2A1')
    ?? getICCTag(profile, 'B2A2');

  if (b2a) {
    const out = transformWithTag(b2a, pcs);
    if (out) return out.slice(0, channelCount);
  }

  if (channelCount >= 3) {
    return [
      delinearizeSRGB(pcs[0] ?? 0),
      delinearizeSRGB(pcs[1] ?? 0),
      delinearizeSRGB(pcs[2] ?? 0),
    ];
  }
  return [delinearizeSRGB(pcs[0] ?? 0)];
}

/** Sample a lut8 CLUT with linear interpolation per channel. */
function sampleLut8(
  tag: Uint8Array,
  info: ICCLutInfo,
  input: number[],
): number[] | null {
  const { inputChannels, outputChannels, gridPoints } = info;
  if (input.length < inputChannels) return null;

  const headerSize = 10 + inputChannels;
  const clutCells = gridPoints.reduce((a, g) => a * g, 1);
  if (tag.length < headerSize + clutCells * outputChannels) return null;

  const frac = input.map((v, i) => clamp01(v) * (gridPoints[i] - 1));
  const lo = frac.map(f => Math.floor(f));
  const hi = frac.map((f, i) => Math.min(gridPoints[i] - 1, Math.floor(f) + 1));
  const t = frac.map((f, i) => f - lo[i]);

  const out = new Array(outputChannels).fill(0);
  const corners = 1 << inputChannels;

  for (let mask = 0; mask < corners; mask++) {
    const idxParts: number[] = [];
    let weight = 1;
    for (let ch = 0; ch < inputChannels; ch++) {
      const useHi = (mask >> ch) & 1;
      idxParts.push(useHi ? hi[ch] : lo[ch]);
      weight *= useHi ? t[ch] : 1 - t[ch];
    }
    const base = headerSize + clutIndex(gridPoints, idxParts) * outputChannels;
    for (let c = 0; c < outputChannels; c++) {
      out[c] += (tag[base + c] / 255) * weight;
    }
  }

  return out;
}

/** Build ICCBased color transform from profile stream bytes. */
export function iccBasedToRGB(
  profileBytes: Uint8Array,
  n: number,
): ((components: number[]) => [number, number, number]) | null {
  const profile = parseICCProfile(profileBytes);
  if (!profile) return null;

  return (components: number[]) => {
    const pcs = transformDeviceToPCS(profile, components.slice(0, n));
    if (pcs.length >= 3) {
      return [
        clamp01(pcs[0]),
        clamp01(pcs[1]),
        clamp01(pcs[2]),
      ];
    }
    const g = clamp01(pcs[0]);
    return [g, g, g];
  };
}
