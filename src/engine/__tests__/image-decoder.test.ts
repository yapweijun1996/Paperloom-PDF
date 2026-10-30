import { describe, expect, it, vi } from 'vitest';
import { decodeImage, type DecodedImage } from '../render/image-decoder';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFObject } from '../types';
import { tinyJPEG } from './audit-p1-fixtures';

function image(width: number, height: number, bpc: number, bytes: number[], colorSpace = 'DeviceGray'): PDFStream {
  return new PDFStream(new PDFDict([
    ['Width', new PDFNumber(width)],
    ['Height', new PDFNumber(height)],
    ['BitsPerComponent', new PDFNumber(bpc)],
    ['ColorSpace', new PDFName(colorSpace)],
  ]), new Uint8Array(bytes));
}

describe('image allocation limits', () => {
  it.each([
    [100_000, 100_000],
    [32_768, 1],
    [10_000, 3_201],
    [1.5, 1],
    [Number.POSITIVE_INFINITY, 1],
  ])('rejects unsafe dimensions %s × %s before allocating pixels', async (width, height) => {
    const realArray = Uint8ClampedArray;
    const guarded = new Proxy(realArray, {
      construct(target, args, newTarget) {
        if (typeof args[0] === 'number' && args[0] > 1024) throw new Error('unsafe pixel allocation attempted');
        return Reflect.construct(target, args, newTarget);
      },
    });
    vi.stubGlobal('Uint8ClampedArray', guarded);
    try {
      await expect(decodeImage(image(width, height, 8, [0]), new Map())).rejects.toThrow(/image.*(dimension|limit)/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects a malicious soft-mask dimension instead of sampling it', async () => {
    const base = image(1, 1, 8, [127]);
    base.dict.set('SMask', new PDFRef(2, 0));
    await expect(decodeImage(base, new Map([['2_0', image(1, 33_000, 8, [255])]])))
      .rejects.toThrow(/image.*(dimension|limit)/i);
  });

  it('checks decoded JPEG bitmap dimensions before creating an offscreen canvas', async () => {
    const close = vi.fn();
    const canvas = vi.fn();
    const base = image(1, 1, 8, [0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0xff, 0xd9]);
    base.dict.set('Filter', new PDFName('DCTDecode'));
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 50_000, height: 50_000, close }));
    vi.stubGlobal('OffscreenCanvas', canvas);
    try {
      await expect(decodeImage(base, new Map())).rejects.toThrow(/image.*(dimension|limit)/i);
      expect(canvas).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])(
    'rejects oversized JPEG SOF marker %s before browser decoding', async marker => {
      const base = image(1, 1, 8, [0xff, 0xd8, 0xff, marker, 0, 11, 8, 0x80, 0, 0, 1, 1, 1, 0x11, 0, 0xff, 0xd9]);
      base.dict.set('Filter', new PDFName('DCTDecode'));
      const browserDecode = vi.fn();
      vi.stubGlobal('createImageBitmap', browserDecode);
      try {
        await expect(decodeImage(base, new Map())).rejects.toThrow(/image.*(dimension|limit)/i);
        expect(browserDecode).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it.each([
    { bytes: [0xff, 0xd8, 0xff, 0xc0] }, // no length
    { bytes: [0xff, 0xd8, 0xff, 0xc0, 0, 2, 0xff, 0xd9] }, // undersized SOF
    { bytes: [0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1] }, // truncated segment
    { bytes: [0xff, 0xd8, 0xff, 0xda, 0, 6, 1, 1, 0, 0, 0xff, 0xd9] }, // scan without SOF
    { bytes: [0xff, 0xd8, 0xff, 0xde, 0, 2, 0xff, 0xd9] }, // unsupported hierarchy
    { bytes: [0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 0, 0, 1, 1, 1, 0x11, 0, 0xff, 0xd9] }, // DNL-dependent height
    { bytes: [0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0] }, // missing scan and EOI
    { bytes: [0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0xf1, 0, 0xff, 0xd9] }, // unsafe sampling factor
  ])('rejects malformed or unsupported JPEG headers before browser decoding', async ({ bytes }) => {
    const base = image(1, 1, 8, bytes);
    base.dict.set('Filter', new PDFName('DCTDecode'));
    const browserDecode = vi.fn();
    vi.stubGlobal('createImageBitmap', browserDecode);
    try {
      await expect(decodeImage(base, new Map())).rejects.toThrow(/jpeg|image.*dimension/i);
      expect(browserDecode).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { name: 'baseline', data: () => tinyJPEG(), dimension: 1 },
    { name: 'progressive', data: () => Uint8Array.from(atob('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wgARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUAQEAAAAAAAAAAAAAAAAAAAAF/9oADAMBAAIQAxAAAAG6BQn/xAAWEAEBAQAAAAAAAAAAAAAAAAADBQH/2gAIAQEAAQUCmiezv//EABcRAAMBAAAAAAAAAAAAAAAAAAABAzL/2gAIAQMBAT8Brtn/xAAXEQADAQAAAAAAAAAAAAAAAAAAAQMy/9oACAECAQE/AaaZ/8QAGhABAAIDAQAAAAAAAAAAAAAAAQIDAARBYf/aAAgBAQAGPwLVWuCtUeeZ/8QAFhABAQEAAAAAAAAAAAAAAAAAAREA/9oACAEBAAE/IUzAqmrO/9oADAMBAAIAAwAAABD3/8QAFxEAAwEAAAAAAAAAAAAAAAAAAAGhsf/aAAgBAwEBPxC96f/EABcRAAMBAAAAAAAAAAAAAAAAAAABobH/2gAIAQIBAT8Qren/xAAWEAEBAQAAAAAAAAAAAAAAAAABACH/2gAIAQEAAT8QTWV8hFVNW//Z'), c => c.charCodeAt(0)), dimension: 2 },
  ])('accepts a normal $name JPEG through the browser decoder', async ({ data, dimension }) => {
    const bytes = data();
    const base = new PDFStream(image(dimension, dimension, 8, []).dict, bytes);
    base.dict.set('Filter', new PDFName('DCTDecode'));
    const close = vi.fn();
    const decode = vi.fn().mockResolvedValue({ width: dimension, height: dimension, close });
    vi.stubGlobal('createImageBitmap', decode);
    vi.stubGlobal('OffscreenCanvas', class {
      getContext() { return { drawImage: () => {}, getImageData: () => ({ data: new Uint8ClampedArray(dimension * dimension * 4) }) }; }
    });
    try {
      expect((await decodeImage(base, new Map()))?.width).toBe(dimension);
      expect(decode).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

async function decoded(base: PDFStream, mask?: PDFStream): Promise<DecodedImage> {
  const objects = new Map<string, PDFObject>();
  if (mask) {
    const ref = new PDFRef(2, 0);
    base.dict.set('SMask', ref);
    objects.set(ref.toKey(), mask);
  }
  const result = await decodeImage(base, objects);
  expect(result).not.toBeNull();
  return result!;
}

function alpha(result: DecodedImage): number[] {
  return Array.from(result.data.filter((_, i) => i % 4 === 3));
}

const basePaths = [
  { name: 'gray', colorSpace: 'DeviceGray', bpc: 8, bytes: [123, 123, 123, 123] },
  { name: 'RGB', colorSpace: 'DeviceRGB', bpc: 8, bytes: [123, 45, 67, 123, 45, 67, 123, 45, 67, 123, 45, 67] },
  { name: 'CMYK', colorSpace: 'DeviceCMYK', bpc: 8, bytes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: 'generic', colorSpace: 'DeviceGray', bpc: 4, bytes: [0x77, 0x77] },
];

describe('image soft masks', () => {
  it('unpacks a 10x3 one-bit mask with byte-padded rows into exact RGBA', async () => {
    // Padding bits are deliberately set; they must not become the next row's samples.
    const mask = image(10, 3, 1, [0xaa, 0xbf, 0x55, 0x7f, 0xff, 0xff]);
    const result = await decoded(image(10, 3, 8, new Array(30).fill(123)), mask);
    const expectedAlpha = [
      255, 0, 255, 0, 255, 0, 255, 0, 255, 0,
      0, 255, 0, 255, 0, 255, 0, 255, 0, 255,
      255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    ];
    expect(result.width).toBe(10);
    expect(result.height).toBe(3);
    expect(Array.from(result.data)).toEqual(expectedAlpha.flatMap(a => [123, 123, 123, a]));
  });

  it.each(basePaths)('applies packed masks on the $name base decode path', async ({ colorSpace, bpc, bytes }) => {
    const result = await decoded(image(4, 1, bpc, bytes, colorSpace), image(4, 1, 1, [0xa0]));
    expect(alpha(result)).toEqual([255, 0, 255, 0]);
  });

  it('preserves eight-bit mask alpha values', async () => {
    const result = await decoded(image(4, 1, 8, [123, 123, 123, 123]), image(4, 1, 8, [0, 64, 128, 255]));
    expect(alpha(result)).toEqual([0, 64, 128, 255]);
  });

  it('inverts alpha with the mask Decode array', async () => {
    const mask = image(3, 1, 8, [0, 64, 255]);
    mask.dict.set('Decode', new PDFArray([new PDFNumber(1), new PDFNumber(0)]));
    expect(alpha(await decoded(image(3, 1, 8, [123, 123, 123]), mask))).toEqual([255, 191, 0]);
  });

  it('maps Decode endpoints and clamps alpha to the byte range', async () => {
    const mask = image(3, 1, 8, [0, 128, 255]);
    mask.dict.set('Decode', new PDFArray([new PDFNumber(-1), new PDFNumber(2)]));
    expect(alpha(await decoded(image(3, 1, 8, [123, 123, 123]), mask))).toEqual([0, 129, 255]);
  });

  it('aligns a 2x2 mask over a 4x4 base using nearest neighbours', async () => {
    const result = await decoded(image(4, 4, 8, new Array(16).fill(123)), image(2, 2, 8, [0, 85, 170, 255]));
    expect(alpha(result)).toEqual([
      0, 0, 85, 85,
      0, 0, 85, 85,
      170, 170, 255, 255,
      170, 170, 255, 255,
    ]);
  });

  it('scales four-bit mask samples and skips row padding', async () => {
    const result = await decoded(image(3, 2, 8, new Array(6).fill(123)), image(3, 2, 4, [0x08, 0xff, 0xf4, 0x0f]));
    expect(alpha(result)).toEqual([0, 136, 255, 255, 68, 0]);
  });

  it('scales two-bit mask samples and skips row padding', async () => {
    const result = await decoded(image(3, 2, 8, new Array(6).fill(123)), image(3, 2, 2, [0x1b, 0xe7]));
    expect(alpha(result)).toEqual([0, 85, 170, 255, 170, 85]);
  });

  it('reads sixteen-bit mask samples most-significant byte first', async () => {
    const result = await decoded(image(3, 1, 8, [123, 123, 123]), image(3, 1, 16, [0, 0, 0x80, 0, 0xff, 0xff]));
    expect(alpha(result)).toEqual([0, 128, 255]);
  });

  it.each(basePaths)('leaves a $name base without a mask fully opaque', async ({ colorSpace, bpc, bytes }) => {
    expect(alpha(await decoded(image(4, 1, bpc, bytes, colorSpace)))).toEqual([255, 255, 255, 255]);
  });
});

describe('image soft-mask Matte correction', () => {
  function matteMask(samples: number[], matte: number[]): PDFStream {
    const mask = image(samples.length, 1, 8, samples);
    mask.dict.set('Matte', new PDFArray(matte.map(value => new PDFNumber(value))));
    return mask;
  }

  it('preserves RGB samples when Matte is absent', async () => {
    const result = await decoded(
      image(2, 1, 8, [64, 96, 128, 20, 40, 60], 'DeviceRGB'),
      image(2, 1, 8, [128, 0]),
    );
    expect(Array.from(result.data)).toEqual([64, 96, 128, 128, 20, 40, 60, 0]);
  });

  it('leaves fully opaque samples unchanged with Matte', async () => {
    const result = await decoded(
      image(1, 1, 8, [64, 96, 128], 'DeviceRGB'),
      matteMask([255], [1, 0.5, 0]),
    );
    expect(Array.from(result.data)).toEqual([64, 96, 128, 255]);
  });

  it('recovers exact RGB bytes from partial alpha and a coloured matte', async () => {
    const result = await decoded(
      image(1, 1, 8, [64, 96, 128], 'DeviceRGB'),
      matteMask([128], [0, 64 / 255, 128 / 255]),
    );
    expect(Array.from(result.data)).toEqual([128, 128, 128, 128]);
  });

  it('removes a white matte and clamps recovered components', async () => {
    const result = await decoded(
      image(2, 1, 8, [191, 191, 191, 0, 255, 128], 'DeviceRGB'),
      matteMask([128, 64], [1, 1, 1]),
    );
    expect(Array.from(result.data)).toEqual([128, 128, 128, 128, 0, 255, 0, 64]);
  });

  it('clamps components recovered above one with a black matte', async () => {
    const result = await decoded(
      image(1, 1, 8, [255, 128, 64], 'DeviceRGB'),
      matteMask([64], [0, 0, 0]),
    );
    expect(Array.from(result.data)).toEqual([255, 255, 255, 64]);
  });

  it('leaves zero-alpha pixels transparent without dividing by zero', async () => {
    const result = await decoded(
      image(1, 1, 8, [12, 34, 56], 'DeviceRGB'),
      matteMask([0], [1, 0.5, 0]),
    );
    expect(Array.from(result.data)).toEqual([12, 34, 56, 0]);
  });

  it.each([[], [0], [0, 0], [0, 0, 0, 0]].map(matte => ({ matte })))('ignores a mismatched Matte array $matte', async ({ matte }) => {
    const result = await decoded(
      image(1, 1, 8, [64, 96, 128], 'DeviceRGB'),
      matteMask([128], matte),
    );
    expect(Array.from(result.data)).toEqual([64, 96, 128, 128]);
  });

  it('ignores nonnumeric Matte components', async () => {
    const mask = matteMask([128], [0, 0, 0]);
    mask.dict.set('Matte', new PDFArray([new PDFNumber(0), new PDFName('Invalid'), new PDFNumber(0)]));
    expect(Array.from((await decoded(image(1, 1, 8, [64, 96, 128], 'DeviceRGB'), mask)).data))
      .toEqual([64, 96, 128, 128]);
  });

  it.each([
    { colorSpace: 'DeviceGray', bytes: [64], matte: [0], expected: [64, 64, 64, 128] },
    { colorSpace: 'DeviceCMYK', bytes: [0, 0, 0, 0], matte: [0, 0, 0, 0], expected: [255, 255, 255, 128] },
  ])('ignores Matte for $colorSpace without dropping alpha', async ({ colorSpace, bytes, matte, expected }) => {
    expect(Array.from((await decoded(image(1, 1, 8, bytes, colorSpace), matteMask([128], matte))).data))
      .toEqual(expected);
  });

  it('ignores Matte for an Indexed image even when the palette is RGB', async () => {
    const base = image(1, 1, 8, [0]);
    base.dict.set('ColorSpace', new PDFArray([
      new PDFName('Indexed'), new PDFName('DeviceRGB'), new PDFNumber(0),
      new PDFStream(new PDFDict(), new Uint8Array([64, 96, 128])),
    ]));
    expect(Array.from((await decoded(base, matteMask([128], [0]))).data))
      .toEqual([64, 96, 128, 128]);
  });

  it('uses mapped mask alpha before unblending and resizes the same mask sample', async () => {
    const mask = matteMask([127], [0, 64 / 255, 128 / 255]);
    mask.dict.set('Decode', new PDFArray([new PDFNumber(1), new PDFNumber(0)]));
    const result = await decoded(image(2, 1, 8, [64, 96, 128, 64, 96, 128], 'DeviceRGB'), mask);
    expect(Array.from(result.data)).toEqual([128, 128, 128, 128, 128, 128, 128, 128]);
  });

  it('uses sixteen-bit alpha precision before quantizing the output alpha byte', async () => {
    const mask = image(1, 1, 16, [0x7f, 0xff]);
    mask.dict.set('Matte', new PDFArray([0, 64 / 255, 128 / 255].map(value => new PDFNumber(value))));
    expect(Array.from((await decoded(image(1, 1, 8, [64, 96, 128], 'DeviceRGB'), mask)).data))
      .toEqual([128, 128, 128, 127]);
  });

  it('resolves indirect Matte and RGB colour-space objects', async () => {
    const base = image(1, 1, 8, [64, 96, 128], 'DeviceRGB');
    const mask = matteMask([128], [0, 64 / 255, 128 / 255]);
    const matteRef = new PDFRef(3, 0);
    const colorRef = new PDFRef(4, 0);
    const objects = new Map<string, PDFObject>([
      [matteRef.toKey(), mask.dict.get('Matte')!],
      [colorRef.toKey(), new PDFName('DeviceRGB')],
    ]);
    mask.dict.set('Matte', matteRef);
    base.dict.set('ColorSpace', colorRef);
    base.dict.set('SMask', mask);
    expect(Array.from((await decodeImage(base, objects))!.data)).toEqual([128, 128, 128, 128]);
  });
});

describe('unsupported compressed images', () => {
  it.each(['CCITTFaxDecode', 'CCF', 'JBIG2Decode', 'JPXDecode', 'UnknownCodec'])('rejects %s before interpreting encoded bytes as pixels', async filter => {
    const source = image(2, 1, 8, [0x9a, 0xbc, 0xde]);
    source.dict.set('Filter', new PDFName(filter));
    await expect(decodeImage(source, new Map())).rejects.toThrow(`Unsupported PDF image filter: ${filter}`);
    expect([...source.rawBytes]).toEqual([0x9a, 0xbc, 0xde]);
  });

  it('does not treat missing decoded bytes as uncompressed pixels', async () => {
    const source = image(1, 1, 8, [0x78, 0x9c]);
    source.dict.set('Filter', new PDFName('FlateDecode'));
    await expect(decodeImage(source, new Map())).rejects.toThrow(/undecoded filter/);
  });

  it('rejects indirect filters and encoded soft masks that are not decoded', async () => {
    const source = image(1, 1, 8, [100]);
    source.dict.set('Filter', new PDFRef(8, 0));
    await expect(decodeImage(source, new Map([['8_0', new PDFName('JPXDecode')]]))).rejects.toThrow(/indirect filter/);
    source.dict.delete('Filter');
    const mask = image(1, 1, 8, [23]);
    mask.dict.set('Filter', new PDFName('JBIG2Decode'));
    source.dict.set('SMask', new PDFRef(9, 0));
    await expect(decodeImage(source, new Map([['9_0', mask]]))).rejects.toThrow(/JBIG2Decode/);
  });
});
