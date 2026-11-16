import type { LayerModel, PathPoint, PathSubpath, SelectionState, VectorPath } from './editor-model';

export const MAX_PATH_POINTS = 200_000;
const MAX_SELECTION_SCAN_PIXELS = 16_000_000;

function copySubpaths(subpaths: PathSubpath[]): PathSubpath[] {
  return subpaths.map(subpath => ({ closed: subpath.closed, points: subpath.points.map(point => ({ ...point })) }));
}

function pointCount(subpaths: PathSubpath[]): number {
  return subpaths.reduce((total, subpath) => total + subpath.points.length, 0);
}

function createPathId(): string {
  return `path-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createVectorPath(name: string, subpaths: PathSubpath[] = [], id = createPathId()): VectorPath {
  const trimmedName = name.trim();
  if (!trimmedName || trimmedName.length > 255) throw new Error('Path names must contain 1 to 255 characters.');
  if (!id || id.length > 128) throw new Error('The path identifier is invalid.');
  if (pointCount(subpaths) > MAX_PATH_POINTS) throw new Error(`A path cannot contain more than ${MAX_PATH_POINTS.toLocaleString()} points.`);
  return { id, name: trimmedName, visible: true, subpaths: copySubpaths(subpaths) };
}

export function appendSubpathsToPath(paths: VectorPath[], activePathId: string | null, subpaths: PathSubpath[], name: string): { paths: VectorPath[]; pathId: string } {
  if (pointCount(subpaths) > MAX_PATH_POINTS) throw new Error(`A path cannot contain more than ${MAX_PATH_POINTS.toLocaleString()} points.`);
  const active = paths.find(path => path.id === activePathId);
  if (!active) {
    const path = createVectorPath(name, subpaths);
    return { paths: [...paths, path], pathId: path.id };
  }
  const existingPoints = pointCount(active.subpaths);
  if (existingPoints + pointCount(subpaths) > MAX_PATH_POINTS) throw new Error(`A path cannot contain more than ${MAX_PATH_POINTS.toLocaleString()} points.`);
  return {
    paths: paths.map(path => path.id === active.id ? { ...path, subpaths: [...path.subpaths, ...copySubpaths(subpaths)] } : path),
    pathId: active.id,
  };
}

export function renameVectorPath(paths: VectorPath[], pathId: string, name: string): VectorPath[] {
  const trimmedName = name.trim();
  if (!trimmedName || trimmedName.length > 255) throw new Error('Path names must contain 1 to 255 characters.');
  return paths.map(path => path.id === pathId ? { ...path, name: trimmedName } : path);
}

export function setVectorPathVisibility(paths: VectorPath[], pathId: string, visible: boolean): VectorPath[] {
  return paths.map(path => path.id === pathId ? { ...path, visible } : path);
}

export function deleteVectorPath(paths: VectorPath[], pathId: string): VectorPath[] {
  return paths.filter(path => path.id !== pathId);
}

export function mapVectorPaths(paths: VectorPath[], mapPoint: (point: PathPoint) => PathPoint): VectorPath[] {
  return paths.map(path => ({
    ...path,
    subpaths: path.subpaths.map(subpath => ({ ...subpath, points: subpath.points.map(mapPoint) })),
  }));
}

type BoundaryEdge = { from: number; to: number; direction: number };

export function selectionToSubpaths(selection: SelectionState): PathSubpath[] {
  const bounds = selection.bounds;
  if (!bounds) throw new Error('The current selection has no pixels to convert to a path.');
  const left = Math.max(0, Math.floor(bounds.x)), top = Math.max(0, Math.floor(bounds.y));
  const right = Math.min(selection.mask.width, Math.ceil(bounds.x + bounds.width));
  const bottom = Math.min(selection.mask.height, Math.ceil(bounds.y + bounds.height));
  if (right <= left || bottom <= top) throw new Error('The current selection has no pixels to convert to a path.');
  if ((right - left) * (bottom - top) > MAX_SELECTION_SCAN_PIXELS) {
    throw new Error('This selection is too large to convert to a path in one operation.');
  }

  const stride = selection.mask.width + 1;
  const vertex = (x: number, y: number) => y * stride + x;
  const edges: BoundaryEdge[] = [];
  const outgoing = new Map<number, number[]>();
  const addEdge = (from: number, to: number, direction: number) => {
    if (edges.length >= MAX_PATH_POINTS) throw new Error(`The selection outline exceeds the ${MAX_PATH_POINTS.toLocaleString()}-point path limit.`);
    const index = edges.length;
    edges.push({ from, to, direction });
    const starts = outgoing.get(from);
    if (starts) starts.push(index);
    else outgoing.set(from, [index]);
  };
  const selectedAt = (x: number, y: number): boolean => {
    if (x < left || x >= right || y < top || y >= bottom) return false;
    const tx = Math.floor(x / 128), ty = Math.floor(y / 128);
    const tile = selection.mask.tiles.get(`${tx}:${ty}`);
    return (tile?.[(y - ty * 128) * 128 + x - tx * 128] ?? 0) >= 128;
  };

  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    if (!selectedAt(x, y)) continue;
    if (!selectedAt(x, y - 1)) addEdge(vertex(x, y), vertex(x + 1, y), 0);
    if (!selectedAt(x + 1, y)) addEdge(vertex(x + 1, y), vertex(x + 1, y + 1), 1);
    if (!selectedAt(x, y + 1)) addEdge(vertex(x + 1, y + 1), vertex(x, y + 1), 2);
    if (!selectedAt(x - 1, y)) addEdge(vertex(x, y + 1), vertex(x, y), 3);
  }

  const used = new Uint8Array(edges.length);
  const toPoint = (value: number): PathPoint => ({ x: value % stride, y: Math.floor(value / stride) });
  const subpaths: PathSubpath[] = [];
  const turnOrder = [1, 0, 3, 2];
  for (let first = 0; first < edges.length; first++) {
    if (used[first]) continue;
    const start = edges[first].from;
    const points = [toPoint(start)];
    let current = first, closed = false;
    while (!used[current]) {
      used[current] = 1;
      const edge = edges[current];
      if (edge.to === start) { closed = true; break; }
      points.push(toPoint(edge.to));
      const candidates = outgoing.get(edge.to) ?? [];
      let next = -1;
      for (const turn of turnOrder) {
        next = candidates.find(index => !used[index] && (edges[index].direction - edge.direction + 4) % 4 === turn) ?? -1;
        if (next >= 0) break;
      }
      if (next < 0) break;
      current = next;
    }
    if (closed && points.length >= 3) {
      const simplified = points.filter((point, index) => {
        const previous = points[(index + points.length - 1) % points.length];
        const next = points[(index + 1) % points.length];
        return (point.x - previous.x) * (next.y - point.y) !== (point.y - previous.y) * (next.x - point.x);
      });
      subpaths.push({ points: simplified.length >= 3 ? simplified : points, closed: true });
    } else if (points.length >= 2) subpaths.push({ points, closed: false });
  }
  if (!subpaths.length) throw new Error('The current selection has no solid pixels to convert to a path.');
  return subpaths;
}

function transformShapePoint(layer: LayerModel, point: PathPoint): PathPoint {
  const x = layer.flipX ? layer.width - point.x : point.x;
  const y = layer.flipY ? layer.height - point.y : point.y;
  const angle = (layer.rotation ?? 0) * Math.PI / 180;
  const dx = x - layer.width / 2, dy = y - layer.height / 2;
  return {
    x: layer.x + layer.width / 2 + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: layer.y + layer.height / 2 + dx * Math.sin(angle) + dy * Math.cos(angle),
  };
}

function roundedRectanglePoints(width: number, height: number, radius: number): PathPoint[] {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (!r) return [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
  const points: PathPoint[] = [];
  const corners: Array<[number, number, number]> = [
    [width - r, r, -Math.PI / 2], [width - r, height - r, 0],
    [r, height - r, Math.PI / 2], [r, r, Math.PI],
  ];
  for (const [cx, cy, start] of corners) for (let step = 0; step <= 8; step++) {
    const angle = start + step * Math.PI / 16;
    points.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
  }
  return points;
}

export function supportsPathFromLayer(layer: LayerModel | undefined): boolean {
  return layer?.type === 'shape' && !!layer.shapeData;
}

export function shapeLayerToSubpaths(layer: LayerModel): PathSubpath[] | null {
  if (!supportsPathFromLayer(layer) || !layer.shapeData) return null;
  const data = layer.shapeData, width = layer.width, height = layer.height;
  let points: PathPoint[];
  let closed = data.kind !== 'line';
  if (data.kind === 'ellipse') {
    points = Array.from({ length: 64 }, (_, index) => {
      const angle = index * Math.PI * 2 / 64;
      return { x: width / 2 + Math.cos(angle) * width / 2, y: height / 2 + Math.sin(angle) * height / 2 };
    });
  } else if (data.kind === 'line') {
    points = [data.lineStart ?? { x: 0, y: height / 2 }, data.lineEnd ?? { x: width, y: height / 2 }];
  } else if (data.kind === 'polygon' || data.kind === 'star') {
    const count = data.kind === 'star' ? Math.max(2, data.points) * 2 : Math.max(3, data.sides);
    points = Array.from({ length: count }, (_, index) => {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / count;
      const radius = data.kind === 'star' && index % 2 ? .45 : 1;
      return { x: width / 2 + Math.cos(angle) * width / 2 * radius, y: height / 2 + Math.sin(angle) * height / 2 * radius };
    });
  } else if (data.kind === 'roundedRectangle') {
    points = roundedRectanglePoints(width, height, data.cornerRadius);
  } else {
    points = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
  }
  return [{ points: points.map(point => transformShapePoint(layer, point)), closed }];
}
