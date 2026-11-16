import { assertRgbaBufferLength, rgbaByteLength } from './resource-limits';

export type MaskPoint = { x: number; y: number };
export type MaskGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
};
export type MaskBounds = { x: number; y: number; width: number; height: number };
export type MaskBrushStyle = { color: '#ffffff'; opacityMultiplier: number; erase: boolean };

export function maskBrushStyle(color: string): MaskBrushStyle {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return { color: '#ffffff', opacityMultiplier: 1, erase: false };
  const hex = match[1], red = parseInt(hex.slice(0, 2), 16) / 255, green = parseInt(hex.slice(2, 4), 16) / 255, blue = parseInt(hex.slice(4, 6), 16) / 255;
  const luminance = Math.max(0, Math.min(1, .2126 * red + .7152 * green + .0722 * blue));
  return { color: '#ffffff', opacityMultiplier: luminance, erase: luminance === 0 };
}

export function whiteMaskPixels(width: number, height: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(rgbaByteLength(width, height));
  pixels.fill(255);
  return pixels;
}

export function selectionMaskPixels(
  width: number,
  height: number,
  bounds: MaskBounds | null,
  alphaAt: (x: number, y: number) => number,
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(rgbaByteLength(width, height));
  if (!bounds) return pixels;
  const left = Math.max(0, bounds.x), top = Math.max(0, bounds.y);
  const right = Math.min(width, bounds.x + bounds.width), bottom = Math.min(height, bounds.y + bounds.height);
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const index = (y * width + x) * 4;
    pixels[index] = pixels[index + 1] = pixels[index + 2] = 255;
    pixels[index + 3] = Math.max(0, Math.min(255, Math.round(alphaAt(x, y))));
  }
  return pixels;
}

export function normalizeLegacyMaskPixels(pixels: Uint8ClampedArray): Uint8ClampedArray {
  assertRgbaBufferLength(pixels.length);
  const normalized = new Uint8ClampedArray(pixels.length);
  for (let index = 0; index < pixels.length; index += 4) {
    const luminance = Math.round(pixels[index] * .2126 + pixels[index + 1] * .7152 + pixels[index + 2] * .0722);
    normalized[index] = normalized[index + 1] = normalized[index + 2] = 255;
    normalized[index + 3] = Math.round(luminance * pixels[index + 3] / 255);
  }
  return normalized;
}

export function invertMaskPixels(pixels: Uint8ClampedArray): Uint8ClampedArray {
  assertRgbaBufferLength(pixels.length);
  const inverted = new Uint8ClampedArray(pixels.length);
  for (let index = 0; index < pixels.length; index += 4) {
    inverted[index] = inverted[index + 1] = inverted[index + 2] = 255;
    inverted[index + 3] = 255 - pixels[index + 3];
  }
  return inverted;
}

export function documentToMaskPoint(point: MaskPoint, geometry: MaskGeometry): MaskPoint {
  const angle = -(geometry.rotation ?? 0) * Math.PI / 180;
  const centerX = geometry.x + geometry.width / 2, centerY = geometry.y + geometry.height / 2;
  const dx = point.x - centerX, dy = point.y - centerY;
  let localX = dx * Math.cos(angle) - dy * Math.sin(angle);
  let localY = dx * Math.sin(angle) + dy * Math.cos(angle);
  if (geometry.flipX) localX = -localX;
  if (geometry.flipY) localY = -localY;
  return { x: localX + geometry.width / 2, y: localY + geometry.height / 2 };
}

export function maskToDocumentPoint(point: MaskPoint, geometry: MaskGeometry): MaskPoint {
  let localX = point.x - geometry.width / 2, localY = point.y - geometry.height / 2;
  if (geometry.flipX) localX = -localX;
  if (geometry.flipY) localY = -localY;
  const angle = (geometry.rotation ?? 0) * Math.PI / 180;
  return {
    x: geometry.x + geometry.width / 2 + localX * Math.cos(angle) - localY * Math.sin(angle),
    y: geometry.y + geometry.height / 2 + localX * Math.sin(angle) + localY * Math.cos(angle),
  };
}
