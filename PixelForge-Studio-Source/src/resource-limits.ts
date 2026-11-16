export const MAX_DOCUMENT_DIMENSION = 8192;
export const MAX_DOCUMENT_PIXELS = 16_777_216;
export const MAX_PROJECT_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_PROJECT_MANIFEST_BYTES = 32 * 1024 * 1024;
export const MAX_PROJECT_ASSET_BYTES = MAX_PROJECT_FILE_BYTES - MAX_PROJECT_MANIFEST_BYTES - 12;
export const MAX_PROJECT_DECODED_PIXELS = 64_000_000;
export const MAX_IMPORT_IMAGE_BYTES = 100 * 1024 * 1024;
export const MAX_IMAGE_HEADER_BYTES = 2 * 1024 * 1024;
export const MAX_SELECTION_TILES_PER_DOCUMENT = 4096;
export const MAX_HISTORY_BYTES_PER_DOCUMENT = 128 * 1024 * 1024;
export const MAX_MASK_ALPHA_CACHE_BYTES = 32 * 1024 * 1024;
export const MAX_COMPOSITE_CACHE_BYTES = 64 * 1024 * 1024;
export const MAX_CACHED_SURFACE_BYTES = 16 * 1024 * 1024;

export type ImageDimensions = { width: number; height: number };

export function rgbaByteLength(width: number, height: number): number {
  assertCanvasDimensions(width, height);
  const pixels = width * height;
  const bytes = pixels * 4;
  if (!Number.isSafeInteger(bytes)) throw new RangeError('The requested image buffer is too large.');
  return bytes;
}

export function assertRgbaBufferLength(byteLength: number): void {
  const maximumBytes = MAX_DOCUMENT_PIXELS * 4;
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > maximumBytes || byteLength % 4 !== 0) {
    throw new RangeError('The RGBA buffer size is invalid or exceeds the document pixel limit.');
  }
}

export function assertCanvasDimensions(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new RangeError('Canvas dimensions must be positive safe integers.');
  }
  if (width > MAX_DOCUMENT_DIMENSION || height > MAX_DOCUMENT_DIMENSION) {
    throw new RangeError(`Canvas dimensions cannot exceed ${MAX_DOCUMENT_DIMENSION.toLocaleString()} pixels per side.`);
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > MAX_DOCUMENT_PIXELS) {
    throw new RangeError(`Canvas area cannot exceed ${MAX_DOCUMENT_PIXELS.toLocaleString()} pixels.`);
  }
  return pixels;
}

function isBytes(bytes: Uint8Array, offset: number, values: number[]): boolean {
  return values.every((value, index) => bytes[offset + index] === value);
}

function readUInt24LE(view: DataView, offset: number): number {
  return view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
}

export function readPngDimensions(bytes: Uint8Array): ImageDimensions {
  if (bytes.byteLength < 24 || !isBytes(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10]) || !isBytes(bytes, 12, [73, 72, 68, 82])) {
    throw new Error('The PNG image header is invalid or incomplete.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

export function readImageDimensions(bytes: Uint8Array): ImageDimensions {
  if (bytes.byteLength >= 24 && isBytes(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10])) {
    return readPngDimensions(bytes);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength >= 10 && (isBytes(bytes, 0, [71, 73, 70, 56, 55, 97]) || isBytes(bytes, 0, [71, 73, 70, 56, 57, 97]))) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }

  if (bytes.byteLength >= 26 && isBytes(bytes, 0, [66, 77])) {
    const headerSize = view.getUint32(14, true);
    if (headerSize === 12) return { width: view.getUint16(18, true), height: view.getUint16(20, true) };
    if (headerSize >= 40) {
      return { width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) };
    }
    throw new Error('The bitmap image header is unsupported or malformed.');
  }

  if (bytes.byteLength >= 30 && isBytes(bytes, 0, [82, 73, 70, 70]) && isBytes(bytes, 8, [87, 69, 66, 80])) {
    if (isBytes(bytes, 12, [86, 80, 56, 88])) {
      return { width: readUInt24LE(view, 24) + 1, height: readUInt24LE(view, 27) + 1 };
    }
    if (isBytes(bytes, 12, [86, 80, 56, 76]) && bytes[20] === 47) {
      const b1 = view.getUint8(21), b2 = view.getUint8(22), b3 = view.getUint8(23), b4 = view.getUint8(24);
      return {
        width: 1 + (((b2 & 0x3f) << 8) | b1),
        height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
      };
    }
    if (isBytes(bytes, 12, [86, 80, 56, 32]) && isBytes(bytes, 23, [157, 1, 42])) {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
    throw new Error('The WebP image header is unsupported or malformed.');
  }

  if (bytes.byteLength >= 4 && isBytes(bytes, 0, [255, 216])) {
    let offset = 2;
    while (offset + 4 <= bytes.byteLength) {
      if (bytes[offset] !== 255) { offset++; continue; }
      while (offset < bytes.byteLength && bytes[offset] === 255) offset++;
      if (offset >= bytes.byteLength) break;
      const marker = bytes[offset++];
      if (marker === 0 || marker === 1 || (marker >= 208 && marker <= 217)) continue;
      if (offset + 2 > bytes.byteLength) break;
      const length = view.getUint16(offset, false);
      if (length < 2) throw new Error('The JPEG image header is malformed.');
      const isStartOfFrame = (marker >= 192 && marker <= 195) || (marker >= 197 && marker <= 199)
        || (marker >= 201 && marker <= 203) || (marker >= 205 && marker <= 207);
      if (isStartOfFrame) {
        if (length < 7 || offset + 7 > bytes.byteLength) throw new Error('The JPEG image dimensions are incomplete.');
        return { height: view.getUint16(offset + 3, false), width: view.getUint16(offset + 5, false) };
      }
      offset += length;
    }
    throw new Error('The JPEG image dimensions are missing or exceed the supported header size.');
  }

  throw new Error('The image format is unsupported or its dimensions could not be verified.');
}

export async function inspectImageBlob(blob: Blob): Promise<ImageDimensions> {
  if (!blob.size || blob.size > MAX_IMPORT_IMAGE_BYTES) {
    throw new Error(`Images must be ${Math.round(MAX_IMPORT_IMAGE_BYTES / 1024 / 1024)} MB or smaller.`);
  }
  const header = new Uint8Array(await blob.slice(0, MAX_IMAGE_HEADER_BYTES).arrayBuffer());
  const dimensions = readImageDimensions(header);
  assertCanvasDimensions(dimensions.width, dimensions.height);
  return dimensions;
}
