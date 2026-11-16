export type RetouchKind = 'clone' | 'healing';
export type RetouchPoint = { x: number; y: number; pressure?: number };
export type RetouchPixel = readonly [number, number, number, number];
export type RetouchPixelSampler = (x: number, y: number) => RetouchPixel | null;
export type RetouchBrushSettings = {
  size: number;
  hardness: number;
  opacity: number;
  flow: number;
  pressureSize?: boolean;
  pressureOpacity?: boolean;
  pressureFlow?: boolean;
};
export type RetouchBuffer = { data: Uint8ClampedArray; width: number; height: number; x: number; y: number };
export const MAX_RETOUCH_BRUSH_SIZE = 500;

export function mapRetouchSourcePoint(
  point: RetouchPoint,
  source: RetouchPoint,
  targetAnchor: RetouchPoint,
  offset: RetouchPoint = { x: 0, y: 0 },
): RetouchPoint {
  return {
    x: source.x + offset.x + point.x - targetAnchor.x,
    y: source.y + offset.y + point.y - targetAnchor.y,
  };
}

export function createTiledPixelSampler(
  width: number,
  height: number,
  readTile: (x: number, y: number, width: number, height: number) => RetouchBuffer | null,
  tileSize = 128,
): RetouchPixelSampler {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || !Number.isSafeInteger(tileSize) || tileSize < 1) {
    throw new RangeError('Retouch sampling dimensions and tile size must be positive safe integers.');
  }
  const tiles = new Map<string, RetouchBuffer | null>();
  return (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const px = Math.floor(x), py = Math.floor(y);
    if (px < 0 || py < 0 || px >= width || py >= height) return null;
    const tileX = Math.floor(px / tileSize) * tileSize, tileY = Math.floor(py / tileSize) * tileSize;
    const key = `${tileX}:${tileY}`;
    if (!tiles.has(key)) {
      const tileWidth = Math.min(tileSize, width - tileX), tileHeight = Math.min(tileSize, height - tileY);
      tiles.set(key, readTile(tileX, tileY, tileWidth, tileHeight));
    }
    const tile = tiles.get(key);
    if (!tile) return null;
    const index = ((py - tile.y) * tile.width + px - tile.x) * 4;
    if (index < 0 || index + 3 >= tile.data.length) return null;
    return [tile.data[index], tile.data[index + 1], tile.data[index + 2], tile.data[index + 3]];
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function brushCoverage(distance: number, radius: number, hardness: number): number {
  if (distance > radius) return 0;
  const softness = Math.max(0, Math.min(100, hardness)) / 100;
  if (softness >= 1) return 1;
  const edgeWidth = Math.max(1, radius * (1 - softness));
  return clamp01((radius - distance) / edgeWidth);
}

function averageColor(sample: RetouchPixelSampler, center: RetouchPoint, radius: number): [number, number, number] | null {
  const extent = Math.max(1, Math.min(4, Math.floor(radius * .12) + 1));
  const total = [0, 0, 0], weights = [0, 0, 0];
  for (let y = -extent; y <= extent; y++) for (let x = -extent; x <= extent; x++) {
    const pixel = sample(Math.floor(center.x) + x, Math.floor(center.y) + y);
    if (!pixel || pixel[3] === 0) continue;
    const alpha = pixel[3] / 255;
    for (let channel = 0; channel < 3; channel++) {
      total[channel] += pixel[channel] * alpha;
      weights[channel] += alpha;
    }
  }
  if (weights.every(weight => weight === 0)) return null;
  return total.map((value, channel) => weights[channel] ? value / weights[channel] : 0) as [number, number, number];
}

/** Transfers source detail with alpha-weighted local-mean colour compensation per dab. */
export function applyRetouchStamp(
  target: RetouchBuffer,
  center: RetouchPoint,
  sourceCenter: RetouchPoint,
  sourceAt: RetouchPixelSampler,
  settings: RetouchBrushSettings,
  options: {
    kind: RetouchKind;
    destinationBeforeAt?: RetouchPixelSampler;
    coverageAt?: (x: number, y: number) => number;
    maskTarget?: boolean;
  },
): void {
  const expectedLength = target.width * target.height * 4;
  if (!Number.isSafeInteger(target.width) || !Number.isSafeInteger(target.height)
    || target.width < 1 || target.height < 1 || !Number.isSafeInteger(expectedLength) || target.data.length !== expectedLength
    || !Number.isFinite(center.x) || !Number.isFinite(center.y)
    || !Number.isFinite(sourceCenter.x) || !Number.isFinite(sourceCenter.y)
    || !Number.isSafeInteger(target.x) || !Number.isSafeInteger(target.y)) {
    throw new RangeError('The retouch target buffer or brush position is invalid.');
  }
  if (!Number.isFinite(settings.size) || settings.size <= 0 || settings.size > MAX_RETOUCH_BRUSH_SIZE) {
    throw new RangeError(`Brush size must be greater than zero and no larger than ${MAX_RETOUCH_BRUSH_SIZE}.`);
  }
  if (!Number.isFinite(settings.hardness) || settings.hardness < 0 || settings.hardness > 100
    || !Number.isFinite(settings.opacity) || settings.opacity < 0 || settings.opacity > 100
    || !Number.isFinite(settings.flow) || settings.flow < 0 || settings.flow > 100
    || (center.pressure !== undefined && !Number.isFinite(center.pressure))) {
    throw new RangeError('Retouch brush settings are outside their supported ranges.');
  }

  const pressure = clamp01(center.pressure ?? 1);
  const radius = Math.max(.25, settings.size * (settings.pressureSize ? Math.max(.05, pressure) : 1) / 2);
  const amount = clamp01(settings.opacity / 100) * clamp01(settings.flow / 100)
    * (settings.pressureOpacity ? pressure : 1) * (settings.pressureFlow ? pressure : 1);
  if (amount <= 0) return;

  const left = Math.max(target.x, Math.floor(center.x - radius));
  const top = Math.max(target.y, Math.floor(center.y - radius));
  const right = Math.min(target.x + target.width, Math.ceil(center.x + radius));
  const bottom = Math.min(target.y + target.height, Math.ceil(center.y + radius));
  if (right <= left || bottom <= top) return;

  const sourceMean = options.kind === 'healing' ? averageColor(sourceAt, sourceCenter, radius) : null;
  const destinationMean = options.kind === 'healing'
    ? averageColor(options.destinationBeforeAt ?? (() => null), center, radius)
    : null;

  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const distance = Math.hypot(x + .5 - center.x, y + .5 - center.y);
    const selection = clamp01((options.coverageAt?.(x, y) ?? 255) / 255);
    const coverage = brushCoverage(distance, radius, settings.hardness) * amount * selection;
    if (coverage <= 0) continue;
    const source = sourceAt(Math.floor(sourceCenter.x + x + .5 - center.x), Math.floor(sourceCenter.y + y + .5 - center.y));
    if (!source || source[3] === 0) continue;
    const index = ((y - target.y) * target.width + x - target.x) * 4;
    const destination: RetouchPixel = [
      target.data[index], target.data[index + 1], target.data[index + 2], target.data[index + 3],
    ];

    if (options.maskTarget) {
      const oldAlpha = destination[3] / 255;
      target.data[index] = target.data[index + 1] = target.data[index + 2] = 255;
      target.data[index + 3] = Math.round((oldAlpha + (source[3] / 255 - oldAlpha) * coverage) * 255);
      continue;
    }

    const sourceAlpha = source[3] / 255;
    if (options.kind === 'healing' && sourceMean && destinationMean) {
      const effectiveAlpha = sourceAlpha * coverage;
      const outputAlpha = effectiveAlpha + destination[3] / 255 * (1 - effectiveAlpha);
      if (outputAlpha <= 0) continue;
      for (let channel = 0; channel < 3; channel++) {
        const adapted = Math.max(0, Math.min(255, source[channel] + destinationMean[channel] - sourceMean[channel]));
        const premultiplied = adapted * effectiveAlpha + destination[channel] * destination[3] / 255 * (1 - effectiveAlpha);
        target.data[index + channel] = Math.round(premultiplied / outputAlpha);
      }
      target.data[index + 3] = Math.round(outputAlpha * 255);
      continue;
    }

    const effectiveAlpha = sourceAlpha * coverage;
    const outputAlpha = effectiveAlpha + destination[3] / 255 * (1 - effectiveAlpha);
    if (outputAlpha <= 0) continue;
    for (let channel = 0; channel < 3; channel++) {
      const premultiplied = source[channel] * effectiveAlpha + destination[channel] * destination[3] / 255 * (1 - effectiveAlpha);
      target.data[index + channel] = Math.round(premultiplied / outputAlpha);
    }
    target.data[index + 3] = Math.round(outputAlpha * 255);
  }
}
