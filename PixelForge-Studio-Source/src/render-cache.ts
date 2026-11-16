import { MAX_CACHED_SURFACE_BYTES, MAX_COMPOSITE_CACHE_BYTES, rgbaByteLength } from './resource-limits';
import type { LayerModel } from './editor-model';

type SurfaceEntry<TCanvas> = {
  source: unknown;
  canvas: TCanvas;
  width: number;
  height: number;
  bytes: number;
  lastUsed: number;
};

export class BoundedSurfaceCache<TCanvas> {
  private readonly entries = new Map<string | number, SurfaceEntry<TCanvas>>();
  private clock = 0;
  private retainedBytes = 0;

  constructor(
    private readonly maxBytes = MAX_COMPOSITE_CACHE_BYTES,
    private readonly maxSurfaceBytes = MAX_CACHED_SURFACE_BYTES,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxSurfaceBytes) || maxSurfaceBytes < 0) {
      throw new RangeError('Render cache memory limits must be non-negative safe integers.');
    }
  }

  get bytes(): number { return this.retainedBytes; }
  get size(): number { return this.entries.size; }

  acquire(
    key: string | number,
    source: unknown,
    width: number,
    height: number,
    create: () => TCanvas,
    resize: (canvas: TCanvas, width: number, height: number) => void,
  ): { canvas: TCanvas; needsRender: boolean } | null {
    const bytes = rgbaByteLength(width, height);
    if (bytes > this.maxSurfaceBytes || bytes > this.maxBytes) {
      this.delete(key);
      return null;
    }

    const existing = this.entries.get(key);
    const existingBytes = existing?.bytes ?? 0;
    this.makeRoom(bytes - existingBytes, key);
    if (this.retainedBytes - existingBytes + bytes > this.maxBytes) {
      this.delete(key);
      return null;
    }

    if (existing) {
      const needsRender = existing.source !== source || existing.width !== width || existing.height !== height;
      if (existing.width !== width || existing.height !== height) resize(existing.canvas, width, height);
      this.retainedBytes += bytes - existing.bytes;
      existing.source = source;
      existing.width = width;
      existing.height = height;
      existing.bytes = bytes;
      existing.lastUsed = ++this.clock;
      return { canvas: existing.canvas, needsRender };
    }

    const canvas = create();
    this.entries.set(key, { source, canvas, width, height, bytes, lastUsed: ++this.clock });
    this.retainedBytes += bytes;
    return { canvas, needsRender: true };
  }

  prune(keepKeys: Iterable<string | number>): void {
    const keep = new Set(keepKeys);
    for (const key of this.entries.keys()) if (!keep.has(key)) this.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.retainedBytes = 0;
  }

  private makeRoom(requiredBytes: number, protectedKey: string | number): void {
    while (requiredBytes > 0 && this.retainedBytes + requiredBytes > this.maxBytes) {
      let oldestKey: string | number | undefined;
      let oldestTime = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        if (key !== protectedKey && entry.lastUsed < oldestTime) {
          oldestKey = key;
          oldestTime = entry.lastUsed;
        }
      }
      if (oldestKey === undefined) break;
      this.delete(oldestKey);
    }
  }

  delete(key: string | number): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.retainedBytes -= entry.bytes;
    this.entries.delete(key);
  }
}

export function canCompositeRegion(layers: readonly LayerModel[], width: number, height: number): boolean {
  return layers.every(layer =>
    layer.type === 'pixel' &&
    layer.parentId === undefined &&
    layer.blend === 'source-over' &&
    layer.filter === 'none' &&
    !layer.mask &&
    !layer.effects.some(effect => effect.enabled) &&
    layer.x === 0 &&
    layer.y === 0 &&
    layer.width === width &&
    layer.height === height &&
    (layer.rotation ?? 0) === 0 &&
    !layer.flipX &&
    !layer.flipY,
  );
}

export function unionDirtyRect(
  current: { x: number; y: number; width: number; height: number } | null,
  next: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  if (!current) return { ...next };
  const left = Math.min(current.x, next.x), top = Math.min(current.y, next.y);
  const right = Math.max(current.x + current.width, next.x + next.width);
  const bottom = Math.max(current.y + current.height, next.y + next.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}
