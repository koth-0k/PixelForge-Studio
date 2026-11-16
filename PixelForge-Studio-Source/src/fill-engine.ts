import { assertCanvasDimensions, rgbaByteLength } from './resource-limits';

export type GradientKind = 'linear' | 'radial';
export type FillBlendMode = 'source-over' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'color-dodge' | 'soft-light';
export type GradientStop = { position: number; color: string; opacity: number };
export type GradientOptions = {
  kind: GradientKind;
  start: { x: number; y: number };
  end: { x: number; y: number };
  stops: GradientStop[];
  opacity: number;
  blend: FillBlendMode;
  originX?: number;
  originY?: number;
  coverageAt?: (x: number, y: number) => number;
  targetMask?: boolean;
};
export type FloodFillOptions = {
  x: number;
  y: number;
  tolerance: number;
  contiguous: boolean;
  antiAlias: boolean;
};
export type FloodFillResult = { width: number; height: number; coverage: Uint8Array; bounds: { x: number; y: number; width: number; height: number } | null; count: number };

const MAX_GRADIENT_STOPS = 16;
const ANTIALIAS_BAND = 32;
const QUEUE_CHUNK_SIZE = 65_536;

function assertOpacity(opacity: number): void {
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 100) throw new RangeError('Fill opacity must be between 0 and 100.');
}

function assertBlendMode(blend: string): asserts blend is FillBlendMode {
  if (!['source-over', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'soft-light'].includes(blend)) {
    throw new Error(`Unsupported fill blend mode: ${blend}.`);
  }
}

export function validateGradientStops(value: unknown): GradientStop[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_GRADIENT_STOPS) {
    throw new Error(`A gradient must contain between 2 and ${MAX_GRADIENT_STOPS} colour stops.`);
  }
  const stops = value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`Gradient stop ${index + 1} is invalid.`);
    const stop = item as Record<string, unknown>;
    if (typeof stop.position !== 'number' || !Number.isFinite(stop.position) || stop.position < 0 || stop.position > 1) {
      throw new Error(`Gradient stop ${index + 1} has an invalid position.`);
    }
    if (typeof stop.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(stop.color)) {
      throw new Error(`Gradient stop ${index + 1} must use a six-digit RGB colour.`);
    }
    if (typeof stop.opacity !== 'number' || !Number.isFinite(stop.opacity) || stop.opacity < 0 || stop.opacity > 100) {
      throw new Error(`Gradient stop ${index + 1} has an invalid opacity.`);
    }
    return { position: stop.position, color: stop.color, opacity: stop.opacity };
  });
  return stops.sort((a, b) => a.position - b.position);
}

function colorChannels(color: string): [number, number, number] {
  const value = Number.parseInt(color.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function interpolate(stops: GradientStop[], amount: number): { color: [number, number, number]; opacity: number } {
  if (amount <= stops[0].position) return { color: colorChannels(stops[0].color), opacity: stops[0].opacity };
  const last = stops[stops.length - 1];
  if (amount >= last.position) return { color: colorChannels(last.color), opacity: last.opacity };
  let upperIndex = 1;
  while (upperIndex < stops.length - 1 && stops[upperIndex].position < amount) upperIndex++;
  const lower = stops[upperIndex - 1], upper = stops[upperIndex];
  const span = upper.position - lower.position;
  const t = span <= 0 ? 1 : (amount - lower.position) / span;
  const a = colorChannels(lower.color), b = colorChannels(upper.color);
  return {
    color: [0, 1, 2].map(channel => a[channel] + (b[channel] - a[channel]) * t) as [number, number, number],
    opacity: lower.opacity + (upper.opacity - lower.opacity) * t,
  };
}

function blendChannel(backdrop: number, source: number, mode: FillBlendMode): number {
  if (mode === 'multiply') return backdrop * source / 255;
  if (mode === 'screen') return 255 - (255 - backdrop) * (255 - source) / 255;
  if (mode === 'overlay') return backdrop < 128 ? 2 * backdrop * source / 255 : 255 - 2 * (255 - backdrop) * (255 - source) / 255;
  if (mode === 'darken') return Math.min(backdrop, source);
  if (mode === 'lighten') return Math.max(backdrop, source);
  if (mode === 'color-dodge') return source >= 255 ? 255 : Math.min(255, backdrop * 255 / (255 - source));
  if (mode === 'soft-light') {
    const b = backdrop / 255, s = source / 255;
    const curve = b <= .25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
    return 255 * (s <= .5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (curve - b));
  }
  return source;
}

function compositePixel(
  pixels: Uint8ClampedArray,
  index: number,
  color: [number, number, number],
  sourceOpacity: number,
  blend: FillBlendMode,
  coverage: number,
): void {
  const sourceAlpha = sourceOpacity * Math.max(0, Math.min(1, coverage / 255));
  if (sourceAlpha <= 0) return;
  const destinationAlpha = pixels[index + 3] / 255;
  const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  for (let channel = 0; channel < 3; channel++) {
    const backdrop = pixels[index + channel], source = color[channel];
    const mixed = blendChannel(backdrop, source, blend);
    const premultiplied = (1 - sourceAlpha) * destinationAlpha * backdrop
      + (1 - destinationAlpha) * sourceAlpha * source
      + destinationAlpha * sourceAlpha * mixed;
    pixels[index + channel] = outputAlpha ? premultiplied / outputAlpha : 0;
  }
  pixels[index + 3] = outputAlpha * 255;
}

function maskTargetAlpha(color: [number, number, number], stopOpacity: number): number {
  return (color[0] * .2126 + color[1] * .7152 + color[2] * .0722) * stopOpacity / 100;
}

function compositeMaskPixel(pixels: Uint8ClampedArray, index: number, targetAlpha: number, opacity: number, coverage: number): void {
  const amount = opacity / 100 * Math.max(0, Math.min(1, coverage / 255));
  if (!amount) return;
  pixels[index] = pixels[index + 1] = pixels[index + 2] = 255;
  pixels[index + 3] += (targetAlpha - pixels[index + 3]) * amount;
}

export function applyGradientPixels(pixels: Uint8ClampedArray, width: number, height: number, options: GradientOptions): void {
  rgbaByteLength(width, height);
  if (pixels.length !== width * height * 4) throw new Error('Gradient dimensions do not match the pixel buffer.');
  if (options.kind !== 'linear' && options.kind !== 'radial') throw new Error('Unsupported gradient type.');
  assertOpacity(options.opacity);
  assertBlendMode(options.blend);
  for (const point of [options.start, options.end]) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('Gradient direction contains an invalid point.');
  }
  const stops = validateGradientStops(options.stops);
  const originX = options.originX ?? 0, originY = options.originY ?? 0;
  if (!Number.isSafeInteger(originX) || !Number.isSafeInteger(originY) || originX < 0 || originY < 0) {
    throw new RangeError('Gradient region origin is invalid.');
  }
  const dx = options.end.x - options.start.x, dy = options.end.y - options.start.y;
  const lengthSquared = dx * dx + dy * dy, radius = Math.sqrt(lengthSquared);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = originX + x + .5, py = originY + y + .5;
    const amount = options.kind === 'radial'
      ? radius ? Math.hypot(px - options.start.x, py - options.start.y) / radius : 0
      : lengthSquared ? ((px - options.start.x) * dx + (py - options.start.y) * dy) / lengthSquared : 0;
    const stop = interpolate(stops, Math.max(0, Math.min(1, amount)));
    const coverage = options.coverageAt?.(px, py) ?? 255;
    const index = (y * width + x) * 4;
    if (options.targetMask) {
      compositeMaskPixel(pixels, index, maskTargetAlpha(stop.color, stop.opacity), options.opacity, coverage);
    } else {
      compositePixel(pixels, index, stop.color, options.opacity / 100 * stop.opacity / 100, options.blend, coverage);
    }
  }
}

function pixelDistance(pixels: Uint8ClampedArray, index: number, seedIndex: number): number {
  const alpha = pixels[index + 3] / 255, seedAlpha = pixels[seedIndex + 3] / 255;
  if (alpha === 0 && seedAlpha === 0) return 0;
  const red = pixels[index] * alpha - pixels[seedIndex] * seedAlpha;
  const green = pixels[index + 1] * alpha - pixels[seedIndex + 1] * seedAlpha;
  const blue = pixels[index + 2] * alpha - pixels[seedIndex + 2] * seedAlpha;
  const alphaDelta = Math.abs(pixels[index + 3] - pixels[seedIndex + 3]);
  return Math.sqrt(((red * red + green * green + blue * blue) / 3 + alphaDelta * alphaDelta) / 2);
}

function antialiasCoverage(distance: number, tolerance: number): number {
  if (distance <= tolerance) return 255;
  if (distance >= tolerance + ANTIALIAS_BAND) return 0;
  return Math.max(2, Math.min(254, Math.round(255 * (1 - (distance - tolerance) / ANTIALIAS_BAND))));
}

export function floodFillPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  options: FloodFillOptions,
): FloodFillResult {
  const pixelCount = assertCanvasDimensions(width, height);
  if (pixels.length !== rgbaByteLength(width, height)) throw new Error('Flood-fill dimensions do not match the pixel buffer.');
  if (!Number.isFinite(options.x) || !Number.isFinite(options.y)) throw new Error('Flood-fill seed is invalid.');
  if (!Number.isFinite(options.tolerance) || options.tolerance < 0 || options.tolerance > 255) throw new RangeError('Flood-fill tolerance must be between 0 and 255.');
  if (typeof options.contiguous !== 'boolean' || typeof options.antiAlias !== 'boolean') throw new Error('Flood-fill options are invalid.');
  const x = Math.floor(options.x), y = Math.floor(options.y);
  if (x < 0 || y < 0 || x >= width || y >= height) throw new RangeError('Flood-fill seed is outside the image.');

  const coverage = new Uint8Array(pixelCount);
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
  const include = (px: number, py: number) => {
    minX = Math.min(minX, px); minY = Math.min(minY, py);
    maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
  };
  const seedIndex = (y * width + x) * 4;
  if (!options.contiguous) {
    for (let index = 0, pixel = 0; pixel < pixelCount; index += 4, pixel++) {
      const distance = pixelDistance(pixels, index, seedIndex);
      const amount = options.antiAlias ? antialiasCoverage(distance, options.tolerance) : distance <= options.tolerance ? 255 : 0;
      if (!amount) continue;
      coverage[pixel] = amount;
      include(pixel % width, Math.floor(pixel / width));
      if (amount === 255) count++;
    }
  } else {
    let chunks: Uint32Array[] = [new Uint32Array(Math.min(QUEUE_CHUNK_SIZE, pixelCount))];
    let read = 0, write = 0;
    const push = (pixel: number) => {
      if (write === pixelCount) throw new Error('Flood-fill traversal exceeded the validated pixel limit.');
      if (write === chunks.length * QUEUE_CHUNK_SIZE) {
        chunks.push(new Uint32Array(Math.min(QUEUE_CHUNK_SIZE, pixelCount - write)));
      }
      chunks[Math.floor(write / QUEUE_CHUNK_SIZE)][write % QUEUE_CHUNK_SIZE] = pixel;
      write++;
    };
    const seedPixel = y * width + x;
    coverage[seedPixel] = 1;
    push(seedPixel);
    while (read < write) {
      const pixel = chunks[Math.floor(read / QUEUE_CHUNK_SIZE)][read % QUEUE_CHUNK_SIZE];
      read++;
      const px = pixel % width, py = Math.floor(pixel / width), index = pixel * 4;
      if (pixelDistance(pixels, index, seedIndex) > options.tolerance) continue;
      coverage[pixel] = 255;
      count++;
      include(px, py);
      if (px > 0 && coverage[pixel - 1] === 0) { coverage[pixel - 1] = 1; push(pixel - 1); }
      if (px + 1 < width && coverage[pixel + 1] === 0) { coverage[pixel + 1] = 1; push(pixel + 1); }
      if (py > 0 && coverage[pixel - width] === 0) { coverage[pixel - width] = 1; push(pixel - width); }
      if (py + 1 < height && coverage[pixel + width] === 0) { coverage[pixel + width] = 1; push(pixel + width); }
    }
    if (options.antiAlias && count) {
      const left = Math.max(0, minX - 1), top = Math.max(0, minY - 1);
      const right = Math.min(width, maxX + 2), bottom = Math.min(height, maxY + 2);
      for (let py = top; py < bottom; py++) for (let px = left; px < right; px++) {
        const pixel = py * width + px;
        if (coverage[pixel] !== 1) continue;
        if (!((px > 0 && coverage[pixel - 1] === 255)
          || (px + 1 < width && coverage[pixel + 1] === 255)
          || (py > 0 && coverage[pixel - width] === 255)
          || (py + 1 < height && coverage[pixel + width] === 255))) continue;
        const amount = antialiasCoverage(pixelDistance(pixels, pixel * 4, seedIndex), options.tolerance);
        if (amount && amount < 255) {
          coverage[pixel] = amount;
          include(px, py);
        }
      }
    }
    for (let index = 0; index < write; index++) {
      const pixel = chunks[Math.floor(index / QUEUE_CHUNK_SIZE)][index % QUEUE_CHUNK_SIZE];
      if (coverage[pixel] === 1) coverage[pixel] = 0;
    }
    chunks = [];
  }
  return {
    width, height, coverage, count,
    bounds: maxX < minX ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
  };
}

export function applyFloodFillPixels(
  pixels: Uint8ClampedArray,
  result: FloodFillResult,
  color: string,
  opacity: number,
  blend: FillBlendMode,
  coverageAt?: (x: number, y: number) => number,
  targetMask = false,
): void {
  if (pixels.length !== rgbaByteLength(result.width, result.height) || result.coverage.length !== result.width * result.height) {
    throw new Error('Flood-fill result dimensions do not match the pixel buffer.');
  }
  assertOpacity(opacity);
  assertBlendMode(blend);
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('Flood-fill colour must use a six-digit RGB value.');
  if (!result.bounds) return;
  const rgb = colorChannels(color);
  for (let y = result.bounds.y; y < result.bounds.y + result.bounds.height; y++) {
    for (let x = result.bounds.x; x < result.bounds.x + result.bounds.width; x++) {
      const pixel = y * result.width + x, alpha = result.coverage[pixel];
      if (!alpha) continue;
      const index = pixel * 4, selectionCoverage = coverageAt?.(x + .5, y + .5) ?? 255;
      if (targetMask) compositeMaskPixel(pixels, index, maskTargetAlpha(rgb, 100), opacity * alpha / 255, selectionCoverage);
      else compositePixel(pixels, index, rgb, opacity / 100 * alpha / 255, blend, selectionCoverage);
    }
  }
}
