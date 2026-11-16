import { cloneEffect, type LayerEffect } from './adjustment-engine';
import { assertCanvasDimensions, MAX_HISTORY_BYTES_PER_DOCUMENT } from './resource-limits';

export type BlendMode = GlobalCompositeOperation;
export type LayerType = 'pixel' | 'group' | 'text' | 'shape' | 'adjustment';
export type TextLayerData = {
  content: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: 400 | 500 | 600 | 700 | 800 | 900;
  italic: boolean;
  alignment: 'left' | 'center' | 'right';
  color: string;
  letterSpacing: number;
  lineSpacing: number;
  underline: boolean;
  strikethrough: boolean;
  boxWidth: number;
  boxHeight: number;
};
export type ShapeKind = 'rectangle' | 'roundedRectangle' | 'ellipse' | 'line' | 'polygon' | 'star';
export type ShapeLayerData = {
  kind: ShapeKind;
  lineStart?: { x: number; y: number };
  lineEnd?: { x: number; y: number };
  fillEnabled: boolean;
  fill: string;
  strokeEnabled: boolean;
  stroke: string;
  strokeWidth: number;
  cornerRadius: number;
  sides: number;
  points: number;
};
export type CanvasSize = { w: number; h: number };
export type Rect = { x: number; y: number; width: number; height: number } | null;
export type SelectionBounds = { x: number; y: number; width: number; height: number };
export type SelectionMask = { width: number; height: number; tiles: Map<string, Uint8Array>; bounds: SelectionBounds | null };
export type SelectionKind = 'rect' | 'ellipse' | 'row' | 'column' | 'lasso' | 'polygon' | 'wand' | 'all' | 'inverted';
export type SelectionState = { mask: SelectionMask; bounds: SelectionBounds | null; kind: SelectionKind; feather: number; visible: boolean; outlineBounds?: SelectionBounds };
export type MaskMode = 'alpha';
export type Adjustments = { brightness: number; contrast: number; saturate: number; blur: number };
export type ChannelView = 'rgb' | 'red' | 'green' | 'blue' | 'alpha';
export type PathPoint = { x: number; y: number };
export type PathSubpath = { points: PathPoint[]; closed: boolean };
export type VectorPath = { id: string; name: string; visible: boolean; subpaths: PathSubpath[] };

export type LayerModel = {
  id: number;
  name: string;
  type: LayerType;
  parentId?: number;
  expanded: boolean;
  canvas: HTMLCanvasElement;
  visible: boolean;
  opacity: number;
  blend: BlendMode;
  locked: boolean;
  mask?: HTMLCanvasElement;
  maskEnabled: boolean;
  maskMode: MaskMode;
  filter: string;
  effects: LayerEffect[];
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
  textData?: TextLayerData;
  shapeData?: ShapeLayerData;
};

export type PixelTile = { x: number; y: number; before: ImageData; after: ImageData };
export type DocumentSnapshot = {
  name: string;
  size: CanvasSize;
  layers: LayerModel[];
  activeLayerId: number;
  selectedLayerIds: number[];
  selection: SelectionState | null;
  previousSelection: SelectionState | null;
  paths: VectorPath[];
  activePathId: string | null;
  adjustments: Adjustments;
  background: string;
};
export type HistoryEntry = {
  id: string;
  label: string;
  timestamp: number;
  before: DocumentSnapshot;
  after: DocumentSnapshot;
  pixelLayerId?: number;
  pixelTarget?: 'canvas' | 'mask';
  pixelTiles?: PixelTile[];
  memoryBytes: number;
};
export type DocumentHistory = { entries: HistoryEntry[]; cursor: number; limit: number; baseStateId: string | null };
export type DocumentModel = DocumentSnapshot & {
  id: string;
  resolution: number;
  transparent: boolean;
  zoom: number;
  dirty: boolean;
  projectPath?: string;
  channelView: ChannelView;
  savedHistoryId: string | null;
  createdAt: number;
  modifiedAt: number;
  history: DocumentHistory;
};

export const DEFAULT_ADJUSTMENTS: Adjustments = { brightness: 100, contrast: 100, saturate: 100, blur: 0 };

export function makeCanvas(width: number, height: number): HTMLCanvasElement {
  assertCanvasDimensions(width, height);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    if (canvas.width !== width || canvas.height !== height || !canvas.getContext('2d')) {
      throw new Error('The browser could not allocate the requested canvas surface.');
    }
    return canvas;
  } catch (error) {
    throw new Error(`Could not allocate a ${width} x ${height} canvas. Close other documents or use smaller dimensions.`, { cause: error });
  }
}

export function makeLayer(width: number, height: number, name: string, type: LayerType = 'pixel', parentId?: number): LayerModel {
  assertCanvasDimensions(width, height);
  return {
    id: Date.now() + Math.random(), name, type, parentId, expanded: true,
    canvas: makeCanvas(width, height), visible: true, opacity: 100,
    blend: 'source-over', locked: false, maskEnabled: false, maskMode: 'alpha', effects: [],
    filter: 'none', x: 0, y: 0, width, height,
  };
}

export function makeDocument(name = 'Untitled-1', size: CanvasSize = { w: 1200, h: 800 }, zoom = 62, background = '#121315'): DocumentModel {
  assertCanvasDimensions(size.w, size.h);
  const now = Date.now();
  const layer = makeLayer(size.w, size.h, 'Layer 1');
  return {
    id: `doc-${now}-${Math.random().toString(36).slice(2, 8)}`, name, size,
    resolution: 72, transparent: true, layers: [layer], activeLayerId: layer.id,
    selectedLayerIds: [layer.id], selection: null, previousSelection: null, paths: [], activePathId: null,
    adjustments: { ...DEFAULT_ADJUSTMENTS },
    background, zoom, dirty: false, projectPath: undefined, savedHistoryId: null, createdAt: now, modifiedAt: now,
    channelView: 'rgb', history: { entries: [], cursor: 0, limit: 60, baseStateId: null },
  };
}

function validHistoryCursor(history: DocumentHistory): number {
  return Number.isInteger(history.cursor) ? Math.max(0, Math.min(history.entries.length, history.cursor)) : 0;
}

export function historyStateId(history: DocumentHistory): string | null {
  const cursor = validHistoryCursor(history);
  return cursor > 0 ? history.entries[cursor - 1]?.id ?? history.baseStateId : history.baseStateId;
}

export function applyHistoryPixelTiles(entry: HistoryEntry, direction: 'undo' | 'redo', fallbackLayers: LayerModel[]): boolean {
  if (!entry.pixelTiles?.length || entry.pixelLayerId === undefined) return false;
  const state = direction === 'undo' ? entry.before : entry.after;
  const stateLayer = state.layers.find(layer => layer.id === entry.pixelLayerId);
  const fallbackLayer = fallbackLayers.find(layer => layer.id === entry.pixelLayerId);
  const canvas = entry.pixelTarget === 'mask'
    ? stateLayer?.mask ?? fallbackLayer?.mask
    : stateLayer?.canvas ?? fallbackLayer?.canvas;
  if (!canvas) return false;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not access the history target canvas.');
  for (const tile of entry.pixelTiles) context.putImageData(direction === 'undo' ? tile.before : tile.after, tile.x, tile.y);
  return true;
}

export function isHistoryDirty(history: DocumentHistory, savedStateId: string | null): boolean {
  return historyStateId(history) !== savedStateId;
}

export function markDocumentSaved(document: DocumentModel, savedStateId: string | null, projectPath: string): DocumentModel {
  return {
    ...document,
    projectPath,
    savedHistoryId: savedStateId,
    dirty: isHistoryDirty(document.history, savedStateId),
    modifiedAt: Date.now(),
  };
}

export function snapshotDocument(document: Pick<DocumentModel, keyof DocumentSnapshot>): DocumentSnapshot {
  return {
    name: document.name, size: { ...document.size }, layers: document.layers.map(layer => ({ ...layer, effects: layer.effects.map(cloneEffect), textData: layer.textData ? { ...layer.textData } : undefined, shapeData: layer.shapeData ? { ...layer.shapeData } : undefined })),
    activeLayerId: document.activeLayerId, selectedLayerIds: [...document.selectedLayerIds],
    selection: document.selection, previousSelection: document.previousSelection,
    paths: document.paths.map(path => ({ ...path, subpaths: path.subpaths.map(subpath => ({ ...subpath, points: subpath.points.map(point => ({ ...point })) })) })),
    activePathId: document.activePathId,
    adjustments: { ...document.adjustments }, background: document.background,
  };
}

export function historyCanUndo(history: DocumentHistory): boolean { return validHistoryCursor(history) > 0; }
export function historyCanRedo(history: DocumentHistory): boolean { return validHistoryCursor(history) < history.entries.length; }

export function trimHistory(history: DocumentHistory, limit = history.limit, maxBytes = MAX_HISTORY_BYTES_PER_DOCUMENT): DocumentHistory {
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError('History limit must be a non-negative integer.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('History memory limit must be a non-negative safe integer.');
  const cursor = validHistoryCursor(history);
  if (history.entries.length <= limit && history.entries.reduce((total, entry) => total + Math.max(0, entry.memoryBytes), 0) <= maxBytes) {
    return { ...history, cursor, limit, baseStateId: history.baseStateId ?? null };
  }

  let start = cursor, end = cursor, retainedBytes = 0;
  const entryBytes = (entry: HistoryEntry) => Number.isSafeInteger(entry.memoryBytes) && entry.memoryBytes >= 0 ? entry.memoryBytes : maxBytes + 1;
  while (start > 0 && end - start < limit) {
    const bytes = entryBytes(history.entries[start - 1]);
    if (bytes > maxBytes - retainedBytes) break;
    start--;
    retainedBytes += bytes;
  }
  while (end < history.entries.length && end - start < limit) {
    const bytes = entryBytes(history.entries[end]);
    if (bytes > maxBytes - retainedBytes) break;
    end++;
    retainedBytes += bytes;
  }
  return {
    ...history,
    entries: history.entries.slice(start, end),
    cursor: cursor - start,
    limit,
    baseStateId: start > 0 ? history.entries[start - 1].id : history.baseStateId ?? null,
  };
}

export function pushHistory(history: DocumentHistory, entry: HistoryEntry): DocumentHistory {
  const cursor = validHistoryCursor(history);
  return trimHistory({
    ...history,
    entries: [...history.entries.slice(0, cursor), entry],
    cursor: cursor + 1,
    baseStateId: history.baseStateId ?? null,
  });
}

export function clonePixelTiles(tiles: PixelTile[], direction: 'before' | 'after'): void {
  for (const tile of tiles) {
    const target = direction === 'before' ? tile.before : tile.after;
    // ImageData is captured in the document's origin-clean renderer and remains valid across tabs.
    // The canvas reference is looked up by the caller so removed layers can be restored first.
    void target;
  }
}

export function groupLayers(layers: LayerModel[], selectedIds: number[], groupId: number, name = 'Group'): LayerModel[] | null {
  const selected = new Set(selectedIds);
  const chosen = layers.filter(layer => selected.has(layer.id));
  if (chosen.length < 1 || chosen.length !== selected.size || layers.some(layer => layer.id === groupId) || chosen.some(layer => layer.type === 'group')) return null;
  const parentId = chosen[0].parentId;
  if (chosen.some(layer => layer.parentId !== parentId)) return null;
  const siblings = layers.filter(layer => layer.parentId === parentId);
  const siblingIndexes = chosen.map(layer => siblings.findIndex(sibling => sibling.id === layer.id)).sort((a, b) => a - b);
  if (siblingIndexes.some((index, i) => i > 0 && index !== siblingIndexes[i - 1] + 1)) return null;
  const insertionIndex = Math.min(...chosen.map(layer => layers.findIndex(item => item.id === layer.id)));
  // Groups contain children and do not need a full document-sized pixel buffer.
  const base = makeLayer(1, 1, name, 'group', parentId);
  const group: LayerModel = { ...base, id: groupId, expanded: true };
  const next = layers.map(layer => selected.has(layer.id) ? { ...layer, parentId: groupId } : layer);
  next.splice(insertionIndex, 0, group);
  return next;
}

export function ungroupLayer(layers: LayerModel[], groupId: number): LayerModel[] | null {
  const group = layers.find(layer => layer.id === groupId && layer.type === 'group');
  if (!group) return null;
  return layers.filter(layer => layer.id !== groupId).map(layer => layer.parentId === groupId ? { ...layer, parentId: group.parentId } : layer);
}

export function reorderLayer(layers: LayerModel[], layerId: number, direction: -1 | 1): LayerModel[] | null {
  const layer = layers.find(item => item.id === layerId);
  if (!layer) return null;
  const siblings = layers.filter(item => item.parentId === layer.parentId);
  const index = siblings.findIndex(item => item.id === layerId);
  const target = index + direction;
  if (target < 0 || target >= siblings.length) return null;
  return moveLayer(layers, layerId, layer.parentId, target);
}

export function duplicateLayer(layers: LayerModel[], layerId: number): LayerModel | null {
  const source = layers.find(layer => layer.id === layerId && layer.type !== 'group');
  if (!source) return null;
  const canvas = makeCanvas(source.canvas.width, source.canvas.height);
  canvas.getContext('2d')!.drawImage(source.canvas, 0, 0);
  const mask = source.mask ? makeCanvas(source.mask.width, source.mask.height) : undefined;
  if (mask && source.mask) mask.getContext('2d')!.drawImage(source.mask, 0, 0);
  return {
    ...source, id: Date.now() + Math.random(), name: `${source.name} copy`, canvas, mask,
    effects: source.effects.map(cloneEffect),
    textData: source.textData ? { ...source.textData } : undefined,
    shapeData: source.shapeData ? { ...source.shapeData } : undefined,
  };
}

function layerIsDescendant(layer: LayerModel, ancestorId: number, layers: LayerModel[]): boolean {
  let parentId = layer.parentId;
  while (parentId !== undefined) {
    if (parentId === ancestorId) return true;
    parentId = layers.find(item => item.id === parentId)?.parentId;
  }
  return false;
}

function cloneLayer(layer: LayerModel, id: number, parentId: number | undefined, copyName = false): LayerModel {
  const canvas = makeCanvas(layer.canvas.width, layer.canvas.height);
  canvas.getContext('2d')!.drawImage(layer.canvas, 0, 0);
  const mask = layer.mask ? makeCanvas(layer.mask.width, layer.mask.height) : undefined;
  if (mask && layer.mask) mask.getContext('2d')!.drawImage(layer.mask, 0, 0);
  return {
    ...layer, id, parentId, canvas, mask,
    effects: layer.effects.map(cloneEffect),
    name: copyName ? `${layer.name} copy` : layer.name,
    textData: layer.textData ? { ...layer.textData } : undefined,
    shapeData: layer.shapeData ? { ...layer.shapeData } : undefined,
  };
}

function subtreeEndIndex(layers: LayerModel[], rootId: number): number {
  let end = layers.findIndex(layer => layer.id === rootId);
  if (end < 0) return end;
  for (let index = end + 1; index < layers.length; index++) {
    if (layerIsDescendant(layers[index], rootId, layers)) end = index;
  }
  return end;
}

export function duplicateLayerTree(
  layers: LayerModel[],
  layerId: number,
  createId: () => number = () => Date.now() + Math.random(),
): { layers: LayerModel[]; duplicatedId: number } | null {
  const root = layers.find(layer => layer.id === layerId);
  if (!root) return null;
  const rootIndex = layers.findIndex(layer => layer.id === layerId);
  const endIndex = subtreeEndIndex(layers, layerId);
  const originals = layers.slice(rootIndex, endIndex + 1);
  const idMap = new Map<number, number>();
  for (const layer of originals) idMap.set(layer.id, createId());
  const copies = originals.map(layer => cloneLayer(
    layer,
    idMap.get(layer.id)!,
    layer.id === layerId ? layer.parentId : idMap.get(layer.parentId!)!,
    layer.id === layerId,
  ));
  const next = [...layers];
  next.splice(endIndex + 1, 0, ...copies);
  return { layers: next, duplicatedId: idMap.get(layerId)! };
}

export function moveLayer(
  layers: LayerModel[],
  layerId: number,
  targetParentId: number | undefined,
  targetSiblingIndex: number,
): LayerModel[] | null {
  const root = layers.find(layer => layer.id === layerId);
  if (!root || !Number.isInteger(targetSiblingIndex)) return null;
  const targetParent = targetParentId === undefined ? undefined : layers.find(layer => layer.id === targetParentId);
  if (targetParentId !== undefined && targetParent?.type !== 'group') return null;
  if (targetParentId === layerId || (targetParentId !== undefined && targetParent && layerIsDescendant(targetParent, layerId, layers))) return null;

  const rootIndex = layers.findIndex(layer => layer.id === layerId);
  const endIndex = subtreeEndIndex(layers, layerId);
  const subtree = layers.slice(rootIndex, endIndex + 1);
  const subtreeIds = new Set(subtree.map(layer => layer.id));
  const remaining = layers.filter(layer => !subtreeIds.has(layer.id));
  const siblings = remaining.filter(layer => layer.parentId === targetParentId);
  const index = Math.max(0, Math.min(targetSiblingIndex, siblings.length));
  let insertionIndex: number;
  if (index < siblings.length) {
    insertionIndex = remaining.findIndex(layer => layer.id === siblings[index].id);
  } else if (siblings.length) {
    insertionIndex = subtreeEndIndex(remaining, siblings[siblings.length - 1].id) + 1;
  } else if (targetParent) {
    insertionIndex = subtreeEndIndex(remaining, targetParent.id) + 1;
  } else {
    insertionIndex = remaining.length;
  }
  subtree[0] = { ...subtree[0], parentId: targetParentId };
  remaining.splice(insertionIndex, 0, ...subtree);
  return remaining;
}

export function mergeLayerSelection(layers: LayerModel[], selectedIds: number[], mergedLayer: LayerModel): LayerModel[] | null {
  const selected = new Set(selectedIds);
  const chosen = layers.filter(layer => selected.has(layer.id));
  if (selected.size < 2 || chosen.length !== selected.size || layers.some(layer => layer.id === mergedLayer.id && !selected.has(layer.id)) || chosen.some(layer => layer.type === 'group' || layer.type === 'adjustment')) return null;
  const parentId = chosen[0].parentId;
  if (chosen.some(layer => layer.parentId !== parentId)) return null;
  const siblings = layers.filter(layer => layer.parentId === parentId);
  const indexes = chosen.map(layer => siblings.findIndex(sibling => sibling.id === layer.id));
  const first = Math.min(...indexes), last = Math.max(...indexes);
  if (last - first + 1 !== chosen.length) return null;
  const insertionIndex = layers.findIndex(layer => layer.id === siblings[first].id);
  const next = layers.filter(layer => !selected.has(layer.id));
  next.splice(insertionIndex - layers.slice(0, insertionIndex).filter(layer => selected.has(layer.id)).length, 0, { ...mergedLayer, parentId });
  return next;
}

export function estimateHistoryBytes(entry: HistoryEntry): number {
  const before = new Map(entry.before.layers.map(layer => [layer.id, layer]));
  const after = new Map(entry.after.layers.map(layer => [layer.id, layer]));
  const retained = new Set<HTMLCanvasElement>();
  let buffers = 0;
  const selectionTiles = new Set<Uint8Array>();
  for (const state of [entry.before.selection, entry.after.selection, entry.before.previousSelection, entry.after.previousSelection]) {
    if (!state) continue;
    for (const tile of state.mask.tiles.values()) if (!selectionTiles.has(tile)) { selectionTiles.add(tile); buffers += tile.byteLength; }
  }
  const add = (canvas?: HTMLCanvasElement) => {
    if (!canvas || retained.has(canvas)) return;
    retained.add(canvas);
    buffers += canvas.width * canvas.height * 4;
  };
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(id), b = after.get(id);
    if (!a || !b || a.canvas !== b.canvas) { add(a?.canvas); add(b?.canvas); }
    if (!a || !b || a.mask !== b.mask) { add(a?.mask); add(b?.mask); }
  }
  const pathPoints = [entry.before.paths, entry.after.paths].reduce((total, paths) =>
    total + paths.reduce((pathTotal, path) => pathTotal + path.subpaths.reduce((subpathTotal, subpath) => subpathTotal + subpath.points.length, 0), 0), 0);
  const tiles = entry.pixelTiles?.reduce((total, tile) => total + tile.before.data.byteLength + tile.after.data.byteLength, 0) ?? 0;
  // Canvas references are shared with the document; count unique buffers the entry
  // can keep alive, plus the compact pixel deltas retained for painting history.
  return 512 + (entry.before.layers.length + entry.after.layers.length) * 160 + pathPoints * 16 + buffers + tiles;
}
