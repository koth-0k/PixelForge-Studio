import type { DocumentModel, LayerModel, PathSubpath, SelectionState, VectorPath } from './editor-model';
import { DEFAULT_ADJUSTMENTS, makeCanvas } from './editor-model';
import { normalizeLegacyMaskPixels } from './mask-engine';
import { isAdjustmentBlendMode, validateEffectStack } from './adjustment-engine';
import { SELECTION_TILE_SIZE } from './selection-engine';
import { MAX_PATH_POINTS } from './path-engine';
import {
  assertCanvasDimensions, MAX_PROJECT_ASSET_BYTES, MAX_PROJECT_DECODED_PIXELS, MAX_PROJECT_FILE_BYTES,
  MAX_PROJECT_MANIFEST_BYTES, MAX_SELECTION_TILES_PER_DOCUMENT, readPngDimensions,
} from './resource-limits';

export const PROJECT_FORMAT = 'PixelForge Studio Project';
export const PROJECT_VERSION = 1;
export const PROJECT_EXTENSION = '.pforge';
export const PROJECT_MAGIC = new Uint8Array([80, 70, 71, 80, 82, 79, 74, 0]); // PFGPROJ\0

export type ProjectAsset = { id: string; mimeType: 'image/png' | 'application/x-pforge-selection-tile'; data: Uint8Array };
export type ProjectAssetDescriptor = { id: string; offset: number; length: number; sha256: string; mimeType: string };
export type NativeProjectManifest = {
  format: string;
  version: number;
  document: Record<string, unknown>;
  assets?: ProjectAssetDescriptor[];
};
export type NativeProjectPackage = { path?: string; manifest: NativeProjectManifest; assets: ProjectAsset[] };

type SerializedSelection = null | {
  width: number; height: number; bounds: SelectionState['bounds']; kind: SelectionState['kind'];
  feather: number; visible: boolean; tiles: Array<{ key: string; assetId: string }>;
};
type SerializedPath = { id: string; name: string; visible: boolean; subpaths: PathSubpath[] };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function finite(value: unknown, min = -1e9, max = 1e9): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}
function stringValue(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength;
}
function validatePaths(value: unknown): VectorPath[] {
  if (value === undefined) return [];
  assert(Array.isArray(value) && value.length <= 10000, 'The project path list is invalid.');
  const ids = new Set<string>();
  let totalPoints = 0;
  return value.map((item: any) => {
    assert(item && typeof item === 'object' && stringValue(item.id, 128) && item.id.length > 0 && !ids.has(item.id), 'Path IDs must be unique non-empty strings.');
    ids.add(item.id);
    assert(stringValue(item.name, 255) && item.name.trim().length > 0 && typeof item.visible === 'boolean', `Path ${item.id} has invalid name or visibility settings.`);
    assert(Array.isArray(item.subpaths) && item.subpaths.length <= 10000, `Path ${item.id} has an invalid subpath list.`);
    const subpaths: PathSubpath[] = item.subpaths.map((subpath: any) => {
      assert(subpath && typeof subpath === 'object' && typeof subpath.closed === 'boolean' && Array.isArray(subpath.points), `Path ${item.id} contains an invalid subpath.`);
      assert(subpath.points.length >= (subpath.closed ? 3 : 2), `Path ${item.id} contains a subpath with too few points.`);
      totalPoints += subpath.points.length;
      assert(totalPoints <= MAX_PATH_POINTS, `The project paths exceed the ${MAX_PATH_POINTS.toLocaleString()}-point limit.`);
      const points = subpath.points.map((point: any) => {
        assert(point && finite(point.x) && finite(point.y), `Path ${item.id} contains an invalid point.`);
        return { x: point.x, y: point.y };
      });
      return { points, closed: subpath.closed };
    });
    return { id: item.id, name: item.name, visible: item.visible, subpaths };
  });
}
function parseSelectionTileKey(value: unknown): { x: number; y: number } | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const match = /^(0|[1-9]\d*)([:,])(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const x = Number(match[1]), y = Number(match[3]);
  return Number.isSafeInteger(x) && Number.isSafeInteger(y) ? { x, y } : null;
}
function bytesFromBlob(blob: Blob): Promise<Uint8Array> {
  return blob.arrayBuffer().then(buffer => new Uint8Array(buffer));
}
function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (!blob) { reject(new Error('Could not encode a layer image')); return; }
    void bytesFromBlob(blob).then(resolve, reject);
  }, 'image/png'));
}

export async function serializeNativeProject(doc: DocumentModel): Promise<{ manifest: NativeProjectManifest; assets: ProjectAsset[] }> {
  assertCanvasDimensions(doc.size.w, doc.size.h);
  const assets: ProjectAsset[] = [];
  const paths = validatePaths(doc.paths);
  assert(doc.activePathId === null || (stringValue(doc.activePathId, 128) && paths.some(path => path.id === doc.activePathId)), 'The active path does not exist.');
  let totalAssetBytes = 0;
  const addAsset = (id: string, data: Uint8Array, mimeType: ProjectAsset['mimeType']) => {
    totalAssetBytes += data.byteLength;
    assert(Number.isSafeInteger(totalAssetBytes) && totalAssetBytes <= MAX_PROJECT_ASSET_BYTES, `The project assets exceed the ${Math.round(MAX_PROJECT_ASSET_BYTES / 1024 / 1024)} MB safety limit.`);
    assets.push({ id, data, mimeType });
    return id;
  };
  const layers: Array<Record<string, unknown>> = [];
  for (const [index, layer] of doc.layers.entries()) {
    if (layer.type === 'adjustment') assert(isAdjustmentBlendMode(layer.blend), `Adjustment layer ${layer.name} uses an unsupported blend mode.`);
    const record: Record<string, unknown> = {
      id: layer.id, name: layer.name, type: layer.type, parentId: layer.parentId, expanded: layer.expanded,
      visible: layer.visible, opacity: layer.opacity, blend: layer.blend, locked: layer.locked,
      maskEnabled: layer.mask ? layer.maskEnabled : false, maskMode: layer.mask ? 'alpha' : undefined,
      filter: layer.filter, effects: validateEffectStack(layer.effects ?? []), x: layer.x, y: layer.y, width: layer.width, height: layer.height,
      rotation: layer.rotation ?? 0, flipX: !!layer.flipX, flipY: !!layer.flipY,
      textData: layer.textData ? { ...layer.textData } : undefined,
      shapeData: layer.shapeData ? { ...layer.shapeData } : undefined,
    };
    if (layer.type === 'pixel') record.canvasAssetId = addAsset(`layer-${index}-pixels`, await canvasPng(layer.canvas), 'image/png');
    if (layer.mask) record.maskAssetId = addAsset(`layer-${index}-mask`, await canvasPng(layer.mask), 'image/png');
    layers.push(record);
  }
  let serializedSelectionTiles = 0;
  const serializeSelection = (selection: SelectionState | null, prefix: string): SerializedSelection => {
    if (!selection) return null;
    assertCanvasDimensions(selection.mask.width, selection.mask.height);
    assert(selection.mask.width === doc.size.w && selection.mask.height === doc.size.h, 'Selection dimensions do not match the document canvas.');
    assert(selection.mask.tiles.size <= MAX_SELECTION_TILES_PER_DOCUMENT, `Selection tiles exceed the ${MAX_SELECTION_TILES_PER_DOCUMENT.toLocaleString()}-tile safety limit.`);
    const tiles: Array<{ key: string; assetId: string }> = [];
    const seenKeys = new Set<string>();
    for (const [index, [key, values]] of [...selection.mask.tiles.entries()].entries()) {
      const coordinates = parseSelectionTileKey(key);
      assert(coordinates, `Selection tile key "${key}" is malformed.`);
      const canonicalKey = `${coordinates.x}:${coordinates.y}`;
      assert(!seenKeys.has(canonicalKey), `Duplicate selection tile key "${canonicalKey}".`);
      assert(coordinates.x < Math.ceil(selection.mask.width / SELECTION_TILE_SIZE) && coordinates.y < Math.ceil(selection.mask.height / SELECTION_TILE_SIZE), `Selection tile "${key}" is outside the canvas.`);
      assert(seenKeys.size < MAX_SELECTION_TILES_PER_DOCUMENT, `Selection tiles exceed the ${MAX_SELECTION_TILES_PER_DOCUMENT.toLocaleString()}-tile safety limit.`);
      serializedSelectionTiles++;
      assert(serializedSelectionTiles <= MAX_SELECTION_TILES_PER_DOCUMENT, `Selection data exceeds the ${MAX_SELECTION_TILES_PER_DOCUMENT.toLocaleString()}-tile safety limit.`);
      assert(values instanceof Uint8Array && values.byteLength === SELECTION_TILE_SIZE * SELECTION_TILE_SIZE, `Selection tile "${key}" has an invalid size.`);
      seenKeys.add(canonicalKey);
      const assetId = `${prefix}-tile-${index}`;
      addAsset(assetId, new Uint8Array(values), 'application/x-pforge-selection-tile');
      tiles.push({ key: canonicalKey, assetId });
    }
    return {
      width: selection.mask.width, height: selection.mask.height, bounds: selection.mask.bounds ? { ...selection.mask.bounds } : null,
      kind: selection.kind, feather: selection.feather, visible: selection.visible, tiles,
    };
  };
  const manifest: NativeProjectManifest = {
    format: PROJECT_FORMAT, version: PROJECT_VERSION,
    document: {
      name: doc.name, size: { ...doc.size }, resolution: doc.resolution, transparent: doc.transparent,
      zoom: doc.zoom, background: doc.background, adjustments: { ...doc.adjustments },
      activeLayerId: doc.activeLayerId, selectedLayerIds: [...doc.selectedLayerIds], layers,
      paths, activePathId: doc.activePathId,
      selection: serializeSelection(doc.selection, 'selection'),
      previousSelection: serializeSelection(doc.previousSelection, 'previous-selection'),
    },
  };
  return { manifest, assets };
}

export async function deserializeNativeProject(project: NativeProjectPackage): Promise<DocumentModel> {
  const { manifest, assets } = project;
  assert(manifest?.format === PROJECT_FORMAT, 'This is not a PixelForge Studio project.');
  assert(manifest.version === PROJECT_VERSION, `Unsupported project version ${String(manifest.version)}.`);
  assert(manifest.document && typeof manifest.document === 'object', 'The project document section is missing.');
  const raw = manifest.document as Record<string, any>;
  assert(stringValue(raw.name, 255), 'The project document name is invalid.');
  assert(raw.size && typeof raw.size === 'object', 'The project canvas dimensions are invalid.');
  try { assertCanvasDimensions(raw.size.w, raw.size.h); }
  catch (error) { throw new Error(`The project canvas dimensions are invalid: ${error instanceof Error ? error.message : 'unsupported dimensions'}`); }
  assert(Array.isArray(raw.layers) && raw.layers.length > 0 && raw.layers.length <= 10000, 'The project layer list is invalid.');
  assert(Array.isArray(assets) && assets.length <= 100000, 'The project asset list is invalid.');
  const assetMap = new Map<string, ProjectAsset>();
  const pngDimensions = new Map<string, { width: number; height: number }>();
  let totalAssetBytes = 0;
  for (const asset of assets) {
    assert(asset && stringValue(asset.id, 200) && asset.data instanceof Uint8Array, 'A project asset is invalid.');
    assert(asset.mimeType === 'image/png' || asset.mimeType === 'application/x-pforge-selection-tile', `Project asset ${asset.id} has an unsupported type.`);
    totalAssetBytes += asset.data.byteLength;
    assert(Number.isSafeInteger(totalAssetBytes) && totalAssetBytes <= MAX_PROJECT_ASSET_BYTES, `Project assets exceed the ${Math.round(MAX_PROJECT_ASSET_BYTES / 1024 / 1024)} MB safety limit.`);
    if (asset.mimeType === 'application/x-pforge-selection-tile') assert(asset.data.byteLength === SELECTION_TILE_SIZE * SELECTION_TILE_SIZE, `Project selection tile ${asset.id} has an invalid size.`);
    else {
      let dimensions: { width: number; height: number };
      try {
        dimensions = readPngDimensions(asset.data);
        assertCanvasDimensions(dimensions.width, dimensions.height);
      } catch (error) {
        throw new Error(`Project image asset ${asset.id} has unsafe or malformed dimensions: ${error instanceof Error ? error.message : 'invalid dimensions'}`);
      }
      pngDimensions.set(asset.id, dimensions);
    }
    assert(!assetMap.has(asset.id), `Duplicate project asset ${asset.id}.`);
    assetMap.set(asset.id, asset);
  }
  const readAsset = (id: unknown, required: boolean, expectedMime?: ProjectAsset['mimeType']): Uint8Array | undefined => {
    if (id === undefined && !required) return undefined;
    assert(stringValue(id, 200), 'A layer asset reference is invalid.');
    const asset = assetMap.get(id);
    assert(asset && asset.data.byteLength > 0, `A required project asset is missing: ${id}.`);
    if (expectedMime) assert(asset.mimeType === expectedMime, `Project asset ${id} has the wrong type.`);
    return asset.data;
  };
  let decodedPixels = 0;
  for (const item of raw.layers as Array<Record<string, any>>) {
    assert(item && typeof item === 'object', 'The project contains an invalid layer record.');
    const referencedPngs = [item.type === 'pixel' ? item.canvasAssetId : undefined, item.maskAssetId].filter(id => id !== undefined);
    for (const id of referencedPngs) {
      readAsset(id, true, 'image/png');
      const dimensions = pngDimensions.get(id);
      assert(dimensions, `Project image asset ${String(id)} has invalid dimensions.`);
      decodedPixels += dimensions.width * dimensions.height;
      assert(Number.isSafeInteger(decodedPixels) && decodedPixels <= MAX_PROJECT_DECODED_PIXELS, `Project raster data exceeds the ${MAX_PROJECT_DECODED_PIXELS.toLocaleString()}-pixel decoded safety limit.`);
    }
  }
  let selectionTileCount = 0;
  for (const value of [raw.selection, raw.previousSelection] as Array<SerializedSelection | undefined>) {
    if (value === undefined || value === null) continue;
    assert(value.width === raw.size.w && value.height === raw.size.h && Array.isArray(value.tiles), 'Selection dimensions do not match the document canvas.');
    const maximumTiles = Math.ceil(value.width / SELECTION_TILE_SIZE) * Math.ceil(value.height / SELECTION_TILE_SIZE);
    assert(value.tiles.length <= Math.min(maximumTiles, MAX_SELECTION_TILES_PER_DOCUMENT), 'A selection mask has too many tiles.');
    const keys = new Set<string>();
    for (const entry of value.tiles) {
      const coordinates = parseSelectionTileKey(entry?.key);
      assert(coordinates && coordinates.x < Math.ceil(value.width / SELECTION_TILE_SIZE) && coordinates.y < Math.ceil(value.height / SELECTION_TILE_SIZE), 'A selection tile key is malformed or outside the canvas.');
      const key = `${coordinates.x}:${coordinates.y}`;
      assert(!keys.has(key), `Duplicate selection tile reference "${key}".`);
      keys.add(key);
      readAsset(entry.assetId, true, 'application/x-pforge-selection-tile');
      selectionTileCount++;
      assert(selectionTileCount <= MAX_SELECTION_TILES_PER_DOCUMENT, `Selection data exceeds the ${MAX_SELECTION_TILES_PER_DOCUMENT.toLocaleString()}-tile safety limit.`);
    }
  }
  const loadPng = async (id: unknown, required: boolean, normalizeLegacyMask = false): Promise<HTMLCanvasElement | undefined> => {
    const bytes = readAsset(id, required, 'image/png');
    if (!bytes) return undefined;
    const expectedDimensions = pngDimensions.get(String(id));
    assert(expectedDimensions, `Project image asset ${String(id)} has invalid dimensions.`);
    const blobView = bytes.buffer instanceof ArrayBuffer
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : (() => {
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        return new Uint8Array(buffer);
      })();
    const bitmap = await createImageBitmap(new Blob([blobView], { type: 'image/png' }));
    try {
      assert(bitmap.width === expectedDimensions.width && bitmap.height === expectedDimensions.height, 'A decoded layer image does not match its validated dimensions.');
      const canvas = makeCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      if (normalizeLegacyMask) {
        const tileSize = 512;
        for (let y = 0; y < canvas.height; y += tileSize) for (let x = 0; x < canvas.width; x += tileSize) {
          const image = context.getImageData(x, y, Math.min(tileSize, canvas.width - x), Math.min(tileSize, canvas.height - y));
          image.data.set(normalizeLegacyMaskPixels(image.data));
          context.putImageData(image, x, y);
        }
      }
      return canvas;
    } finally {
      bitmap.close();
    }
  };
  const ids = new Set<number>();
  const layers: LayerModel[] = [];
  for (const item of raw.layers as Array<Record<string, any>>) {
    assert(item && finite(item.id, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) && !ids.has(item.id), 'Layer IDs must be unique finite numbers.');
    ids.add(item.id);
    assert(['pixel', 'group', 'text', 'shape', 'adjustment'].includes(item.type), `Unsupported layer type: ${String(item.type)}.`);
    assert(stringValue(item.name, 1024), 'A layer name is invalid.');
    assert(finite(item.x) && finite(item.y) && finite(item.width, 1, 8192) && finite(item.height, 1, 8192), `Layer ${item.name} has invalid geometry.`);
    assert(finite(item.opacity, 0, 100) && typeof item.visible === 'boolean' && typeof item.locked === 'boolean', `Layer ${item.name} has invalid appearance settings.`);
    assert(stringValue(item.blend, 64) && stringValue(item.filter ?? 'none', 256), `Layer ${item.name} has invalid rendering settings.`);
    if (item.type === 'adjustment') assert(isAdjustmentBlendMode(item.blend), `Adjustment layer ${item.name} uses an unsupported blend mode.`);
    assert(item.maskMode === undefined || item.maskMode === 'alpha', `Layer ${item.name} uses an unsupported mask encoding.`);
    assert(item.maskEnabled === undefined || typeof item.maskEnabled === 'boolean', `Layer ${item.name} has an invalid mask visibility setting.`);
    const canvas = await loadPng(item.canvasAssetId, item.type === 'pixel') ?? makeCanvas(1, 1);
    const mask = await loadPng(item.maskAssetId, false, !!item.maskAssetId && item.maskMode === undefined);
    const textData = item.type === 'text' ? item.textData : undefined;
    const shapeData = item.type === 'shape' ? item.shapeData : undefined;
    if (item.type === 'text') {
      assert(textData && stringValue(textData.content, 2_000_000) && stringValue(textData.fontFamily, 256), `Text layer ${item.name} is invalid.`);
      assert(finite(textData.fontSize, 1, 2000) && finite(textData.fontWeight, 100, 1000) && ['left', 'center', 'right'].includes(textData.alignment), `Text layer ${item.name} has invalid typography.`);
      assert(stringValue(textData.color, 128) && finite(textData.letterSpacing, -100, 1000) && finite(textData.lineSpacing, .1, 10), `Text layer ${item.name} has invalid style settings.`);
      assert(finite(textData.boxWidth, 1, 8192) && finite(textData.boxHeight, 1, 8192), `Text layer ${item.name} has invalid box dimensions.`);
    }
    if (item.type === 'shape') {
      assert(shapeData && ['rectangle', 'roundedRectangle', 'ellipse', 'line', 'polygon', 'star'].includes(shapeData.kind), `Shape layer ${item.name} is invalid.`);
      assert(typeof shapeData.fillEnabled === 'boolean' && typeof shapeData.strokeEnabled === 'boolean' && stringValue(shapeData.fill, 128) && stringValue(shapeData.stroke, 128), `Shape layer ${item.name} has invalid fill or stroke.`);
      assert(finite(shapeData.strokeWidth, 0, 1000) && finite(shapeData.cornerRadius, 0, 30000) && finite(shapeData.sides, 3, 100) && finite(shapeData.points, 2, 100), `Shape layer ${item.name} has invalid geometry properties.`);
      for (const endpoint of [shapeData.lineStart, shapeData.lineEnd]) if (endpoint) assert(finite(endpoint.x, -30000, 30000) && finite(endpoint.y, -30000, 30000), `Shape layer ${item.name} has invalid line endpoints.`);
    }
    layers.push({
      id: item.id, name: item.name, type: item.type, parentId: item.parentId,
      expanded: item.expanded !== false, canvas, visible: item.visible, opacity: item.opacity,
      blend: item.blend as GlobalCompositeOperation, locked: item.locked, mask,
      maskEnabled: mask ? item.maskEnabled !== false : false, maskMode: 'alpha', filter: item.filter ?? 'none',
      effects: validateEffectStack(item.effects ?? []),
      x: item.x, y: item.y, width: item.width, height: item.height, rotation: finite(item.rotation) ? item.rotation : 0,
      flipX: item.flipX === true, flipY: item.flipY === true,
      textData: textData ? { ...textData } : undefined, shapeData: shapeData ? { ...shapeData } : undefined,
    });
  }
  for (const layer of layers) if (layer.parentId !== undefined) {
    const parent = layers.find(candidate => candidate.id === layer.parentId);
    assert(parent?.type === 'group' && parent.id !== layer.id, `Layer ${layer.name} has an invalid parent group.`);
  }
  for (const layer of layers) {
    const seen = new Set<number>([layer.id]); let parentId = layer.parentId;
    while (parentId !== undefined) {
      assert(!seen.has(parentId), 'The project contains a cyclic group hierarchy.'); seen.add(parentId);
      parentId = layers.find(candidate => candidate.id === parentId)?.parentId;
    }
  }
  const decodeSelection = (value: SerializedSelection, expectedWidth: number, expectedHeight: number): SelectionState | null => {
    if (value === null || value === undefined) return null;
    assert(finite(value.width, 1, 8192) && finite(value.height, 1, 8192) && Array.isArray(value.tiles) && value.tiles.length <= MAX_SELECTION_TILES_PER_DOCUMENT, 'A selection mask is invalid.');
    assert(value.width === expectedWidth && value.height === expectedHeight, 'Selection dimensions do not match the document canvas.');
    const tiles = new Map<string, Uint8Array>();
    for (const entry of value.tiles) {
      assert(entry && typeof entry === 'object', 'A selection tile reference is invalid.');
      const coordinates = parseSelectionTileKey(entry.key);
      assert(coordinates, 'A selection tile key is malformed; expected "x:y" or legacy "x,y".');
      const key = `${coordinates.x}:${coordinates.y}`;
      assert(!tiles.has(key), `Duplicate selection tile reference "${key}".`);
      const bytes = readAsset(entry.assetId, true, 'application/x-pforge-selection-tile')!;
      assert(bytes.byteLength === SELECTION_TILE_SIZE * SELECTION_TILE_SIZE, 'A selection tile has an invalid size.');
      assert(coordinates.x < Math.ceil(value.width / SELECTION_TILE_SIZE) && coordinates.y < Math.ceil(value.height / SELECTION_TILE_SIZE), `Selection tile "${entry.key}" is outside the canvas.`);
      tiles.set(key, new Uint8Array(bytes));
    }
    const bounds = value.bounds;
    if (bounds) assert(finite(bounds.x, 0, value.width) && finite(bounds.y, 0, value.height) && finite(bounds.width, 0, value.width) && finite(bounds.height, 0, value.height), 'Selection bounds are invalid.');
    assert(['rect', 'ellipse', 'row', 'column', 'lasso', 'polygon', 'wand', 'all', 'inverted'].includes(value.kind), 'Selection kind is invalid.');
    return { mask: { width: value.width, height: value.height, tiles, bounds }, bounds, kind: value.kind, feather: finite(value.feather, 0, 256) ? value.feather : 0, visible: value.visible !== false };
  };
  const size = { w: raw.size.w, h: raw.size.h };
  const paths = validatePaths(raw.paths);
  const activePathId = raw.activePathId ?? null;
  assert(activePathId === null || (stringValue(activePathId, 128) && paths.some(path => path.id === activePathId)), 'The active path does not exist.');
  assert(ids.has(raw.activeLayerId), 'The active layer does not exist.');
  assert(Array.isArray(raw.selectedLayerIds) && raw.selectedLayerIds.every((id: unknown) => finite(id, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) && ids.has(id)), 'The selected layer list is invalid.');
  const adjustments = raw.adjustments ?? { brightness: 100, contrast: 100, saturate: 100, blur: 0 };
  assert(['brightness', 'contrast', 'saturate', 'blur'].every(key => finite(adjustments[key], 0, 500)), 'Document adjustments are invalid.');
  const now = Date.now();
  const doc: DocumentModel = {
    id: `doc-${now}-${Math.random().toString(36).slice(2, 8)}`, name: raw.name, size, layers,
    activeLayerId: raw.activeLayerId, selectedLayerIds: [...raw.selectedLayerIds],
    selection: decodeSelection(raw.selection, size.w, size.h), previousSelection: decodeSelection(raw.previousSelection, size.w, size.h),
    paths, activePathId,
    adjustments: { ...DEFAULT_ADJUSTMENTS, ...adjustments }, background: stringValue(raw.background, 128) ? raw.background : '#121315',
    resolution: finite(raw.resolution, 1, 100000) ? raw.resolution : 72, transparent: raw.transparent !== false,
    zoom: finite(raw.zoom, 10, 150) ? raw.zoom : 62, dirty: false, savedHistoryId: null, projectPath: project.path, channelView: 'rgb',
    createdAt: now, modifiedAt: now, history: { entries: [], cursor: 0, limit: 60, baseStateId: null },
  };
  return doc;
}

export async function parseNativeProjectBytes(buffer: ArrayBuffer, projectPath?: string): Promise<NativeProjectPackage> {
  const bytes = new Uint8Array(buffer);
  assert(bytes.byteLength >= 12 && bytes.byteLength <= MAX_PROJECT_FILE_BYTES, `The project file size is invalid or exceeds the ${Math.round(MAX_PROJECT_FILE_BYTES / 1024 / 1024)} MB safety limit.`);
  assert(PROJECT_MAGIC.every((value, index) => bytes[index] === value), 'The file does not have a PixelForge project signature.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const manifestLength = view.getUint32(8, true);
  assert(manifestLength > 1 && manifestLength <= MAX_PROJECT_MANIFEST_BYTES && 12 + manifestLength <= bytes.byteLength, 'The project manifest length is invalid.');
  let manifest: NativeProjectManifest;
  try { manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + manifestLength))) as NativeProjectManifest; }
  catch { throw new Error('The project manifest is corrupted or incomplete.'); }
  assert(manifest.format === PROJECT_FORMAT, 'This is not a PixelForge Studio project.');
  assert(manifest.version === PROJECT_VERSION, `Unsupported project version ${String(manifest.version)}.`);
  assert(Array.isArray(manifest.assets) && manifest.assets.length <= 100000, 'The project asset directory is invalid.');
  const payloadOffset = 12 + manifestLength, payloadLength = bytes.byteLength - payloadOffset;
  const assets: ProjectAsset[] = [];
  let expectedOffset = 0;
  for (const asset of manifest.assets) {
    assert(stringValue(asset.id, 200) && Number.isSafeInteger(asset.offset) && Number.isSafeInteger(asset.length) && asset.offset === expectedOffset && asset.length > 0 && asset.offset + asset.length <= payloadLength, 'A project asset range is invalid.');
    const assetBytes = bytes.subarray(payloadOffset + asset.offset, payloadOffset + asset.offset + asset.length);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', assetBytes));
    const sha256 = [...hash].map(value => value.toString(16).padStart(2, '0')).join('');
    assert(sha256 === asset.sha256, `Project asset ${asset.id} failed its integrity check.`);
    assert(asset.mimeType === 'image/png' || asset.mimeType === 'application/x-pforge-selection-tile', `Project asset ${asset.id} has an unsupported type.`);
    assets.push({ id: asset.id, mimeType: asset.mimeType, data: assetBytes }); expectedOffset += asset.length;
  }
  assert(expectedOffset === payloadLength, 'The project contains missing or unreferenced binary data.');
  return { path: projectPath, manifest, assets };
}
