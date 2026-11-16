import type { SelectionBounds, SelectionKind, SelectionMask, SelectionState } from './editor-model';
import { assertCanvasDimensions, rgbaByteLength } from './resource-limits';

export const SELECTION_TILE_SIZE = 128;
export type SelectionMode = 'replace' | 'add' | 'subtract' | 'intersect';
export type SelectionPoint = { x: number; y: number };
export type ShapeKind = 'rect' | 'ellipse' | 'row' | 'column' | 'polygon';

const keyFor = (tx: number, ty: number) => `${tx}:${ty}`;
function emptyMask(width: number, height: number): SelectionMask {
  assertCanvasDimensions(width, height);
  return { width, height, tiles: new Map(), bounds: null };
}

function writeAlpha(mask: SelectionMask, x: number, y: number, alpha: number): void {
  if (alpha <= 0 || x < 0 || y < 0 || x >= mask.width || y >= mask.height) return;
  const tx = Math.floor(x / SELECTION_TILE_SIZE), ty = Math.floor(y / SELECTION_TILE_SIZE), key = keyFor(tx, ty);
  let tile = mask.tiles.get(key);
  if (!tile) { tile = new Uint8Array(SELECTION_TILE_SIZE * SELECTION_TILE_SIZE); mask.tiles.set(key, tile); }
  tile[(y - ty * SELECTION_TILE_SIZE) * SELECTION_TILE_SIZE + x - tx * SELECTION_TILE_SIZE] = alpha;
  const b = mask.bounds;
  mask.bounds = b ? { x: Math.min(b.x, x), y: Math.min(b.y, y), width: Math.max(b.x + b.width, x + 1) - Math.min(b.x, x), height: Math.max(b.y + b.height, y + 1) - Math.min(b.y, y) } : { x, y, width: 1, height: 1 };
}

export function maskAlphaAt(mask: SelectionMask, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return 0;
  const tx = Math.floor(x / SELECTION_TILE_SIZE), ty = Math.floor(y / SELECTION_TILE_SIZE);
  const tile = mask.tiles.get(keyFor(tx, ty));
  return tile?.[(y - ty * SELECTION_TILE_SIZE) * SELECTION_TILE_SIZE + x - tx * SELECTION_TILE_SIZE] ?? 0;
}

function boundsOf(mask: SelectionMask): SelectionBounds | null {
  let minX = mask.width, minY = mask.height, maxX = -1, maxY = -1;
  for (const [key, tile] of mask.tiles) {
    const [tx, ty] = key.split(':').map(Number);
    const x0 = tx * SELECTION_TILE_SIZE, y0 = ty * SELECTION_TILE_SIZE;
    const w = Math.min(SELECTION_TILE_SIZE, mask.width - x0), h = Math.min(SELECTION_TILE_SIZE, mask.height - y0);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (tile[y * SELECTION_TILE_SIZE + x]) {
      minX = Math.min(minX, x0 + x); minY = Math.min(minY, y0 + y);
      maxX = Math.max(maxX, x0 + x); maxY = Math.max(maxY, y0 + y);
    }
  }
  return maxX < minX ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function simplifyPolygon(points: SelectionPoint[], tolerance: number): SelectionPoint[] {
  if (points.length <= 2) return points;
  const toleranceSquared = tolerance * tolerance, keep = new Uint8Array(points.length), stack: Array<[number, number]> = [[0, points.length - 1]];
  keep[0] = keep[points.length - 1] = 1;
  while (stack.length) {
    const [start, end] = stack.pop()!;
    const a = points[start], b = points[end], dx = b.x - a.x, dy = b.y - a.y, lengthSquared = dx * dx + dy * dy;
    let bestIndex = -1, bestDistance = toleranceSquared;
    for (let index = start + 1; index < end; index++) {
      const point = points[index];
      const amount = lengthSquared ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared)) : 0;
      const distanceX = point.x - (a.x + amount * dx), distanceY = point.y - (a.y + amount * dy);
      const distance = distanceX * distanceX + distanceY * distanceY;
      if (distance > bestDistance) { bestDistance = distance; bestIndex = index; }
    }
    if (bestIndex >= 0) { keep[bestIndex] = 1; stack.push([start, bestIndex], [bestIndex, end]); }
  }
  return points.filter((_point, index) => keep[index] === 1);
}

export function makeSelection(mask: SelectionMask, kind: SelectionKind, feather = 0, visible = true): SelectionState {
  const bounds = boundsOf(mask);
  mask.bounds = bounds;
  return { mask, bounds, kind, feather, visible };
}

export function rasterizeSelection(width: number, height: number, kind: ShapeKind, first: SelectionPoint, second: SelectionPoint, points: SelectionPoint[] = [], antiAlias = true): SelectionState {
  let x0 = Math.min(first.x, second.x), x1 = Math.max(first.x, second.x);
  let y0 = Math.min(first.y, second.y), y1 = Math.max(first.y, second.y);
  if (kind === 'row') { y0 = Math.floor(first.y); y1 = y0 + 1; x0 = 0; x1 = width; }
  if (kind === 'column') { x0 = Math.floor(first.x); x1 = x0 + 1; y0 = 0; y1 = height; }
  const polygon = kind === 'polygon' ? (points.length > 512 ? simplifyPolygon(points, .5) : points) : [];
  if (polygon.length) {
    x0 = x1 = polygon[0].x; y0 = y1 = polygon[0].y;
    for (const point of polygon) {
      x0 = Math.min(x0, point.x); x1 = Math.max(x1, point.x);
      y0 = Math.min(y0, point.y); y1 = Math.max(y1, point.y);
    }
  }
  const left = Math.max(0, Math.floor(x0)), top = Math.max(0, Math.floor(y0));
  const right = Math.min(width, Math.ceil(Math.max(x1, x0 + 1))), bottom = Math.min(height, Math.ceil(Math.max(y1, y0 + 1)));
  const mask = emptyMask(width, height);
  const samples = antiAlias ? 4 : 1;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.max(.5, (x1 - x0) / 2), ry = Math.max(.5, (y1 - y0) / 2);
  if (kind === 'rect' || kind === 'row' || kind === 'column') {
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const coverageX = antiAlias ? Math.max(0, Math.min(x + 1, x1) - Math.max(x, x0)) : Number(x + .5 >= x0 && x + .5 <= x1);
      const coverageY = antiAlias ? Math.max(0, Math.min(y + 1, y1) - Math.max(y, y0)) : Number(y + .5 >= y0 && y + .5 <= y1);
      const coverage = coverageX * coverageY;
      if (coverage) writeAlpha(mask, x, y, Math.round(255 * coverage));
    }
    const state = makeSelection(mask, kind);
    state.outlineBounds = { x: left, y: top, width: right - left, height: bottom - top };
    return state;
  }
  if (kind === 'polygon' && polygon.length >= 3) {
    for (let y = top; y < bottom; y++) {
      const coverage = new Uint8Array(right - left);
      for (let sy = 0; sy < samples; sy++) {
        const py = y + (sy + .5) / samples, intersections: number[] = [];
        for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
          const a = polygon[previous], b = polygon[index];
          if ((a.y > py) !== (b.y > py)) intersections.push(a.x + (py - a.y) * (b.x - a.x) / (b.y - a.y));
        }
        intersections.sort((a, b) => a - b);
        let interval = 0;
        for (let x = left; x < right; x++) {
          for (let sx = 0; sx < samples; sx++) {
            const px = x + (sx + .5) / samples;
            while (interval + 1 < intersections.length && px >= intersections[interval + 1]) interval += 2;
            if (interval + 1 < intersections.length && px >= intersections[interval] && px < intersections[interval + 1]) coverage[x - left]++;
          }
        }
      }
      for (let x = left; x < right; x++) {
        const hits = coverage[x - left];
        if (hits) writeAlpha(mask, x, y, Math.round(255 * hits / (samples * samples)));
      }
    }
    return makeSelection(mask, kind);
  }
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    let coverage = 0;
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const px = x + (sx + .5) / samples, py = y + (sy + .5) / samples;
      let hit = false;
      if (kind === 'ellipse') hit = ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1;
      else hit = false;
      if (hit) coverage++;
    }
    if (coverage) writeAlpha(mask, x, y, Math.round(255 * coverage / (samples * samples)));
  }
  return makeSelection(mask, kind);
}

export function combineSelection(current: SelectionState | null, incoming: SelectionState, mode: SelectionMode): SelectionState {
  if (mode === 'replace' || !current) return incoming;
  const a = current?.mask;
  const b = incoming.mask;
  if (!a || a.width !== b.width || a.height !== b.height) return mode === 'subtract' || mode === 'intersect' ? makeSelection(emptyMask(b.width, b.height), incoming.kind) : incoming;
  const mask = emptyMask(b.width, b.height);
  const keys = new Set([...a.tiles.keys(), ...b.tiles.keys()]);
  for (const key of keys) {
    const ta = a.tiles.get(key), tb = b.tiles.get(key);
    if (!ta && !tb) continue;
    const tile = new Uint8Array(SELECTION_TILE_SIZE * SELECTION_TILE_SIZE);
    let any = false;
    for (let i = 0; i < tile.length; i++) {
      const av = ta?.[i] ?? 0, bv = tb?.[i] ?? 0;
      const v = mode === 'add' ? Math.max(av, bv) : mode === 'subtract' ? Math.round(av * (255 - bv) / 255) : Math.round(av * bv / 255);
      tile[i] = v; any ||= v > 0;
    }
    if (any) mask.tiles.set(key, tile);
  }
  return makeSelection(mask, incoming.kind, incoming.feather, current?.visible ?? true);
}

export function invertSelection(state: SelectionState | null, width: number, height: number): SelectionState {
  if (!state) return selectAll(width, height);
  const mask = emptyMask(width, height);
  for (let ty = 0; ty < Math.ceil(height / SELECTION_TILE_SIZE); ty++) for (let tx = 0; tx < Math.ceil(width / SELECTION_TILE_SIZE); tx++) {
    const x0 = tx * SELECTION_TILE_SIZE, y0 = ty * SELECTION_TILE_SIZE;
    const w = Math.min(SELECTION_TILE_SIZE, width - x0), h = Math.min(SELECTION_TILE_SIZE, height - y0);
    const src = state.mask.tiles.get(keyFor(tx, ty));
    const out = new Uint8Array(SELECTION_TILE_SIZE * SELECTION_TILE_SIZE); let any = false;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const value = 255 - (src?.[y * SELECTION_TILE_SIZE + x] ?? 0); out[y * SELECTION_TILE_SIZE + x] = value; any ||= value > 0; }
    if (any) mask.tiles.set(keyFor(tx, ty), out);
  }
  return makeSelection(mask, 'inverted', state.feather, state.visible);
}

export function selectAll(width: number, height: number): SelectionState {
  const mask = emptyMask(width, height);
  for (let ty = 0; ty < Math.ceil(height / SELECTION_TILE_SIZE); ty++) for (let tx = 0; tx < Math.ceil(width / SELECTION_TILE_SIZE); tx++) {
    const tile = new Uint8Array(SELECTION_TILE_SIZE * SELECTION_TILE_SIZE);
    const w = Math.min(SELECTION_TILE_SIZE, width - tx * SELECTION_TILE_SIZE), h = Math.min(SELECTION_TILE_SIZE, height - ty * SELECTION_TILE_SIZE);
    for (let y = 0; y < h; y++) tile.fill(255, y * SELECTION_TILE_SIZE, y * SELECTION_TILE_SIZE + w);
    mask.tiles.set(keyFor(tx, ty), tile);
  }
  const selection = makeSelection(mask, 'all');
  selection.outlineBounds = { x: 0, y: 0, width, height };
  return selection;
}

export function translateSelection(state: SelectionState, dx: number, dy: number): SelectionState {
  const mask = emptyMask(state.mask.width, state.mask.height), b = state.bounds;
  if (!b) return makeSelection(mask, state.kind, state.feather, state.visible);
  const ox = Math.round(dx), oy = Math.round(dy);
  for (let y = b.y; y < b.y + b.height; y++) for (let x = b.x; x < b.x + b.width; x++) {
    const alpha = maskAlphaAt(state.mask, x, y); if (alpha) writeAlpha(mask, x + ox, y + oy, alpha);
  }
  return makeSelection(mask, state.kind, state.feather, state.visible);
}

/** Rebase a selection mask into a new document rectangle. Pixels outside the old
 * document naturally remain unselected, including when the crop extends beyond it. */
export function cropSelection(state: SelectionState | null, x: number, y: number, width: number, height: number): SelectionState | null {
  if (!state) return null;
  const mask = emptyMask(width, height), bounds = state.bounds;
  if (bounds) {
    const left = Math.max(0, bounds.x - x), top = Math.max(0, bounds.y - y);
    const right = Math.min(width, bounds.x + bounds.width - x), bottom = Math.min(height, bounds.y + bounds.height - y);
    for (let dy = top; dy < bottom; dy++) for (let dx = left; dx < right; dx++) {
      const alpha = maskAlphaAt(state.mask, dx + x, dy + y);
      if (alpha) writeAlpha(mask, dx, dy, alpha);
    }
  }
  return makeSelection(mask, state.kind, state.feather, state.visible);
}

export function remapSelection(state: SelectionState | null, width: number, height: number, sourceAt: (x: number, y: number) => SelectionPoint): SelectionState | null {
  if (!state) return null;
  const mask = emptyMask(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = sourceAt(x, y), alpha = maskAlphaAt(state.mask, Math.floor(source.x), Math.floor(source.y));
    if (alpha) writeAlpha(mask, x, y, alpha);
  }
  return makeSelection(mask, state.kind, state.feather, state.visible);
}

/** Map only selected pixels. Work stays proportional to the selection bounds rather
 * than the whole document, which matters for large canvases with small selections. */
export function mapSelection(state: SelectionState | null, width: number, height: number, targetForSource: (x: number, y: number) => SelectionPoint): SelectionState | null {
  if (!state) return null;
  const mask = emptyMask(width, height), bounds = state.bounds;
  if (bounds) for (let y = bounds.y; y < bounds.y + bounds.height; y++) for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
    const alpha = maskAlphaAt(state.mask, x, y);
    if (!alpha) continue;
    const target = targetForSource(x, y);
    writeAlpha(mask, Math.round(target.x), Math.round(target.y), alpha);
  }
  return makeSelection(mask, state.kind, state.feather, state.visible);
}

function denseMask(state: SelectionState, pad: number): { data: Uint8Array; x: number; y: number; width: number; height: number } {
  const b = state.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
  const right = Math.min(state.mask.width, b.x + b.width + pad), bottom = Math.min(state.mask.height, b.y + b.height + pad);
  const width = Math.max(0, right - x), height = Math.max(0, bottom - y), data = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) data[row * width + col] = maskAlphaAt(state.mask, x + col, y + row);
  return { data, x, y, width, height };
}

function stateFromDense(source: { data: Uint8Array; x: number; y: number; width: number; height: number }, canvasWidth: number, canvasHeight: number, kind: SelectionKind, feather: number, visible: boolean): SelectionState {
  const mask = emptyMask(canvasWidth, canvasHeight);
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) { const alpha = source.data[y * source.width + x]; if (alpha) writeAlpha(mask, source.x + x, source.y + y, alpha); }
  return makeSelection(mask, kind, feather, visible);
}

export function featherSelection(state: SelectionState, radius: number): SelectionState {
  const r = Math.max(0, Math.min(64, Math.round(radius)));
  if (!r || !state.bounds) return state;
  const src = denseMask(state, r), { width: w, height: h } = src;
  const horizontal = new Uint8Array(w * h), output = new Uint8Array(w * h), windowSize = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0, base = y * w;
    for (let x = -r; x < w + r; x++) {
      const add = x + r; if (add >= 0 && add < w) sum += src.data[base + add];
      const remove = x - r - 1; if (remove >= 0 && remove < w) sum -= src.data[base + remove];
      if (x >= 0 && x < w) horizontal[base + x] = Math.round(sum / windowSize);
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y < h + r; y++) {
      const add = y + r; if (add >= 0 && add < h) sum += horizontal[add * w + x];
      const remove = y - r - 1; if (remove >= 0 && remove < h) sum -= horizontal[remove * w + x];
      if (y >= 0 && y < h) output[y * w + x] = Math.round(sum / windowSize);
    }
  }
  return stateFromDense({ ...src, data: output }, state.mask.width, state.mask.height, state.kind, r, state.visible);
}

function filterLines(src: Uint8Array, width: number, height: number, radius: number, horizontal: boolean, maximum: boolean): Uint8Array {
  const out = new Uint8Array(src.length), lines = horizontal ? height : width, length = horizontal ? width : height;
  const queue = new Int32Array(length + radius * 2 + 1);
  for (let line = 0; line < lines; line++) {
    let head = 0, tail = 0;
    const get = (i: number) => { const p = i - radius; if (p < 0 || p >= length) return 0; return horizontal ? src[line * width + p] : src[p * width + line]; };
    for (let i = 0; i < length + radius * 2; i++) {
      const value = get(i);
      while (tail > head && (maximum ? get(queue[tail - 1]) <= value : get(queue[tail - 1]) >= value)) tail--;
      queue[tail++] = i;
      while (head < tail && queue[head] <= i - radius * 2 - 1) head++;
      if (i >= radius * 2) {
        const p = i - radius * 2, result = get(queue[head]);
        if (horizontal) out[line * width + p] = result; else out[p * width + line] = result;
      }
    }
  }
  return out;
}

export function modifySelection(state: SelectionState, amount: number, expand: boolean): SelectionState {
  const radius = Math.max(1, Math.min(20, Math.round(Math.abs(amount))));
  if (!state.bounds) return state;
  const src = denseMask(state, radius), horizontal = filterLines(src.data, src.width, src.height, radius, true, expand);
  const output = filterLines(horizontal, src.width, src.height, radius, false, expand);
  return stateFromDense({ ...src, data: output }, state.mask.width, state.mask.height, state.kind, state.feather, state.visible);
}

export function colorSelection(image: ImageData, seed: SelectionPoint, tolerance: number, contiguous: boolean, antiAlias: boolean): SelectionState {
  const { width, height, data } = image, mask = emptyMask(width, height);
  if (data.length !== rgbaByteLength(width, height)) throw new Error('Selection source dimensions do not match its pixel buffer.');
  const sx = Math.max(0, Math.min(width - 1, Math.floor(seed.x))), sy = Math.max(0, Math.min(height - 1, Math.floor(seed.y)));
  const offset = (sy * width + sx) * 4, tr = data[offset], tg = data[offset + 1], tb = data[offset + 2], ta = data[offset + 3];
  const limit = Math.max(0, Math.min(255, tolerance));
  const matches = (index: number) => {
    const i = index * 4, dr = data[i] - tr, dg = data[i + 1] - tg, db = data[i + 2] - tb, da = data[i + 3] - ta;
    return Math.sqrt((dr * dr + dg * dg + db * db + da * da) / 4) <= limit;
  };
  if (!contiguous) {
    for (let i = 0, pixels = width * height; i < pixels; i++) if (matches(i)) writeAlpha(mask, i % width, Math.floor(i / width), 255);
  } else {
    const total = width * height, visited = new Uint8Array(total);
    let queue = new Uint32Array(Math.min(total, 4096)), head = 0, tail = 0;
    const push = (index: number) => { if (tail === queue.length) { const next = new Uint32Array(Math.min(total, queue.length * 2)); next.set(queue); queue = next; } queue[tail++] = index; };
    push(sy * width + sx);
    while (head < tail) {
      const index = queue[head++]; if (visited[index] || !matches(index)) continue;
      const y = Math.floor(index / width), x = index - y * width;
      let left = x;
      while (left > 0 && !visited[y * width + left - 1] && matches(y * width + left - 1)) left--;
      let right = x;
      while (right < width && !visited[y * width + right] && matches(y * width + right)) {
        const p = y * width + right; visited[p] = 1; writeAlpha(mask, right, y, 255); right++;
      }
      for (const ny of [y - 1, y + 1]) if (ny >= 0 && ny < height) {
        let inRun = false;
        for (let nx = left; nx < right; nx++) {
          const p = ny * width + nx, good = !visited[p] && matches(p);
          if (good && !inRun) push(p);
          inRun = good;
        }
      }
    }
  }
  if (antiAlias && mask.bounds) {
    const b = mask.bounds, originalBounds = { ...b };
    for (let y = Math.max(0, originalBounds.y - 1); y < Math.min(height, originalBounds.y + originalBounds.height + 1); y++) for (let x = Math.max(0, originalBounds.x - 1); x < Math.min(width, originalBounds.x + originalBounds.width + 1); x++) {
      if (maskAlphaAt(mask, x, y)) continue;
      let neighbors = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && maskAlphaAt(mask, x + dx, y + dy) > 127) neighbors++;
      if (!neighbors) continue;
      const i = (y * width + x) * 4, dr = data[i] - tr, dg = data[i + 1] - tg, db = data[i + 2] - tb, da = data[i + 3] - ta;
      const distance = Math.sqrt((dr * dr + dg * dg + db * db + da * da) / 4);
      if (distance <= limit + 24) writeAlpha(mask, x, y, Math.round(128 * neighbors / 8 * Math.max(0, (limit + 24 - distance) / 24)));
    }
  }
  return makeSelection(mask, 'wand');
}

export function marchingAntsPath(state: SelectionState | null): Path2D | null {
  if (!state?.visible || !state.bounds) return null;
  const path = new Path2D(), b = state.bounds, right = b.x + b.width, bottom = b.y + b.height;
  if (state.outlineBounds) {
    const outline = state.outlineBounds;
    path.moveTo(outline.x, outline.y); path.lineTo(outline.x + outline.width, outline.y);
    path.lineTo(outline.x + outline.width, outline.y + outline.height); path.lineTo(outline.x, outline.y + outline.height);
    path.lineTo(outline.x, outline.y);
    return path;
  }
  for (let y = b.y; y < bottom; y++) {
    let topRun = -1, bottomRun = -1;
    for (let x = b.x; x <= right; x++) {
      const selected = x < right && maskAlphaAt(state.mask, x, y) >= 128;
      const topEdge = selected && maskAlphaAt(state.mask, x, y - 1) < 128;
      const bottomEdge = selected && maskAlphaAt(state.mask, x, y + 1) < 128;
      if (topEdge && topRun < 0) topRun = x; if (!topEdge && topRun >= 0) { path.moveTo(topRun, y); path.lineTo(x, y); topRun = -1; }
      if (bottomEdge && bottomRun < 0) bottomRun = x; if (!bottomEdge && bottomRun >= 0) { path.moveTo(bottomRun, y + 1); path.lineTo(x, y + 1); bottomRun = -1; }
    }
  }
  for (let x = b.x; x < right; x++) {
    let leftRun = -1, rightRun = -1;
    for (let y = b.y; y <= bottom; y++) {
      const selected = y < bottom && maskAlphaAt(state.mask, x, y) >= 128;
      const leftEdge = selected && maskAlphaAt(state.mask, x - 1, y) < 128;
      const rightEdge = selected && maskAlphaAt(state.mask, x + 1, y) < 128;
      if (leftEdge && leftRun < 0) leftRun = y; if (!leftEdge && leftRun >= 0) { path.moveTo(x, leftRun); path.lineTo(x, y); leftRun = -1; }
      if (rightEdge && rightRun < 0) rightRun = y; if (!rightEdge && rightRun >= 0) { path.moveTo(x + 1, rightRun); path.lineTo(x + 1, y); rightRun = -1; }
    }
  }
  return path;
}
