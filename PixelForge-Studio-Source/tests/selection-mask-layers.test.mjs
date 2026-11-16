import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const ts = require(process.env.PIXELFORGE_TYPESCRIPT_PATH || 'typescript');
require.extensions['.ts'] = (module, filename) => {
  const source = readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

class TestCanvas {
  constructor(width = 1, height = 1) {
    this.width = width;
    this.height = height;
    this.context = {
      drawImage() {},
      getImageData(_x, _y, width, height) { return { data: new Uint8ClampedArray(width * height * 4), width, height }; },
      putImageData() {},
    };
  }
  getContext() { return this.context; }
}

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalPath2D = Object.getOwnPropertyDescriptor(globalThis, 'Path2D');
globalThis.document = { createElement: () => new TestCanvas() };
globalThis.Path2D = class {
  commands = [];
  moveTo(...args) { this.commands.push(['moveTo', ...args]); }
  lineTo(...args) { this.commands.push(['lineTo', ...args]); }
};

const model = require('../src/editor-model.ts');
const selectionEngine = require('../src/selection-engine.ts');
const maskEngine = require('../src/mask-engine.ts');

after(() => {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete globalThis.document;
  if (originalPath2D) Object.defineProperty(globalThis, 'Path2D', originalPath2D);
  else delete globalThis.Path2D;
});

test('selection modes, feather, expand, contract, inversion and boundary paths stay consistent', () => {
  const base = selectionEngine.rasterizeSelection(20, 20, 'rect', { x: 2, y: 2 }, { x: 7, y: 7 }, [], false);
  const addition = selectionEngine.rasterizeSelection(20, 20, 'rect', { x: 6, y: 6 }, { x: 11, y: 11 }, [], false);
  assert.equal(selectionEngine.maskAlphaAt(selectionEngine.combineSelection(base, addition, 'add').mask, 9, 9), 255);
  assert.equal(selectionEngine.maskAlphaAt(selectionEngine.combineSelection(base, addition, 'subtract').mask, 6, 6), 0);
  assert.equal(selectionEngine.maskAlphaAt(selectionEngine.combineSelection(base, addition, 'intersect').mask, 4, 4), 0);
  assert.equal(selectionEngine.maskAlphaAt(selectionEngine.invertSelection(base, 20, 20).mask, 4, 4), 0);
  assert.ok(selectionEngine.featherSelection(base, 2).bounds);
  assert.ok(selectionEngine.modifySelection(base, 1, true).bounds.width > base.bounds.width);
  assert.ok(selectionEngine.modifySelection(base, 1, false).bounds.width < base.bounds.width);
  assert.ok(selectionEngine.marchingAntsPath(base).commands.length > 0);
});

test('moving an existing selection translates its coverage without changing the source', () => {
  const original = selectionEngine.rasterizeSelection(12, 8, 'rect', { x: 2, y: 2 }, { x: 5, y: 4 }, [], false);
  const moved = selectionEngine.translateSelection(original, 3, 2);

  assert.equal(selectionEngine.maskAlphaAt(original.mask, 2, 2), 255);
  assert.equal(selectionEngine.maskAlphaAt(original.mask, 5, 4), 0);
  assert.equal(selectionEngine.maskAlphaAt(moved.mask, 2, 2), 0);
  assert.equal(selectionEngine.maskAlphaAt(moved.mask, 5, 4), 255);
  assert.deepEqual(moved.bounds, { x: 5, y: 4, width: 3, height: 2 });
});

test('polygon bounds handle large lasso point lists without argument-spread limits', () => {
  const points = Array.from({ length: 140_000 }, (_, index) => {
    const side = Math.floor(index / 35_000), offset = index % 35_000 / 34_999;
    if (side === 0) return { x: offset, y: 0 };
    if (side === 1) return { x: 1, y: offset };
    if (side === 2) return { x: 1 - offset, y: 1 };
    return { x: 0, y: 1 - offset };
  });
  const selection = selectionEngine.rasterizeSelection(2, 2, 'polygon', points[0], points.at(-1), points, false);
  assert.ok(selection.mask.tiles.size > 0);
});

test('mask pixel helpers create, normalize, invert and transform grayscale coverage', () => {
  const white = maskEngine.whiteMaskPixels(2, 1);
  assert.deepEqual([...white], [255, 255, 255, 255, 255, 255, 255, 255]);
  const selected = maskEngine.selectionMaskPixels(3, 1, { x: 1, y: 0, width: 1, height: 1 }, x => x ? 128 : 0);
  assert.deepEqual([...selected], [0, 0, 0, 0, 255, 255, 255, 128, 0, 0, 0, 0]);

  const legacy = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 128]);
  assert.deepEqual([...maskEngine.normalizeLegacyMaskPixels(legacy)], [255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 64]);
  assert.deepEqual([...maskEngine.invertMaskPixels(legacy)], [255, 255, 255, 0, 255, 255, 255, 0, 255, 255, 255, 127]);
  assert.deepEqual(maskEngine.maskBrushStyle('#000000'), { color: '#ffffff', opacityMultiplier: 0, erase: true });
  assert.deepEqual(maskEngine.maskBrushStyle('#ffffff'), { color: '#ffffff', opacityMultiplier: 1, erase: false });
  assert.equal(maskEngine.maskBrushStyle('#808080').opacityMultiplier, 128 / 255);

  const geometry = { x: 11, y: 17, width: 20, height: 12, rotation: 37, flipX: true, flipY: true };
  const point = { x: 18.5, y: 20.25 };
  const local = maskEngine.documentToMaskPoint(point, geometry);
  const restored = maskEngine.maskToDocumentPoint(local, geometry);
  assert.ok(Math.abs(restored.x - point.x) < 1e-9);
  assert.ok(Math.abs(restored.y - point.y) < 1e-9);
});

test('layer reordering preserves entire group subtrees and moving layers updates hierarchy safely', () => {
  const firstGroup = model.makeLayer(1, 1, 'First', 'group');
  firstGroup.id = 1;
  const child = model.makeLayer(1, 1, 'Child');
  child.id = 2; child.parentId = firstGroup.id;
  const secondGroup = model.makeLayer(1, 1, 'Second', 'group');
  secondGroup.id = 3;
  const secondChild = model.makeLayer(1, 1, 'Nested');
  secondChild.id = 4; secondChild.parentId = secondGroup.id;
  const layers = [firstGroup, child, secondGroup, secondChild];

  const reordered = model.reorderLayer(layers, firstGroup.id, 1);
  assert.deepEqual(reordered.map(layer => layer.id), [3, 4, 1, 2]);
  assert.equal(reordered[1].parentId, secondGroup.id);
  assert.equal(reordered[3].parentId, firstGroup.id);

  const movedIn = model.moveLayer(layers, firstGroup.id, secondGroup.id, 1);
  assert.equal(movedIn[0].id, secondGroup.id);
  assert.equal(movedIn[2].id, firstGroup.id);
  assert.equal(movedIn[2].parentId, secondGroup.id);
  assert.equal(model.moveLayer(layers, firstGroup.id, child.id, 0), null);
  const movedOut = model.moveLayer(layers, child.id, undefined, 0);
  assert.equal(movedOut.find(layer => layer.id === child.id).parentId, undefined);
});

test('grouping and ungrouping preserve sibling order and reject invalid selections', () => {
  const first = model.makeLayer(1, 1, 'First'); first.id = 40;
  const second = model.makeLayer(1, 1, 'Second'); second.id = 41;
  const third = model.makeLayer(1, 1, 'Third'); third.id = 42;
  const layers = [first, second, third];
  const grouped = model.groupLayers(layers, [40, 41], 43);

  assert.deepEqual(grouped.map(layer => layer.id), [43, 40, 41, 42]);
  assert.equal(grouped[1].parentId, 43);
  assert.equal(grouped[2].parentId, 43);
  assert.equal(model.groupLayers(layers, [40, 99], 43), null);
  assert.equal(model.groupLayers(layers, [40, 41], 42), null);
  assert.deepEqual(model.ungroupLayer(grouped, 43).map(layer => [layer.id, layer.parentId]), [[40, undefined], [41, undefined], [42, undefined]]);
});

test('layer duplication copies masks and preserves a duplicated nested group tree', () => {
  const group = model.makeLayer(1, 1, 'Group', 'group'); group.id = 10;
  const child = model.makeLayer(5, 5, 'Masked'); child.id = 11; child.parentId = group.id;
  child.mask = new TestCanvas(5, 5); child.maskEnabled = true;
  const duplicate = model.duplicateLayerTree([group, child], group.id, (() => { let id = 20; return () => id++; })());

  assert.ok(duplicate);
  assert.deepEqual(duplicate.layers.map(layer => layer.id), [10, 11, 20, 21]);
  assert.equal(duplicate.layers[3].parentId, duplicate.duplicatedId);
  assert.notEqual(duplicate.layers[3].mask, child.mask);
  assert.equal(duplicate.layers[3].maskEnabled, true);
});

test('merging accepts only contiguous sibling leaves and history remains cursor-isolated', () => {
  const first = model.makeLayer(2, 2, 'One'); first.id = 31;
  const second = model.makeLayer(2, 2, 'Two'); second.id = 32;
  const third = model.makeLayer(2, 2, 'Three'); third.id = 33;
  const merged = model.makeLayer(2, 2, 'Merged'); merged.id = 34;
  const layers = [first, second, third];
  const mergedLayers = model.mergeLayerSelection(layers, [31, 32], merged);
  assert.deepEqual(mergedLayers.map(layer => layer.id), [34, 33]);
  assert.equal(mergedLayers[0].parentId, undefined);
  assert.equal(model.mergeLayerSelection(layers, [31, 33], merged), null);

  const docA = model.makeDocument('A', { w: 2, h: 2 });
  const docB = model.makeDocument('B', { w: 2, h: 2 });
  const entry = { id: 'history-a', label: 'Rename', timestamp: 1, before: model.snapshotDocument(docA), after: model.snapshotDocument(docA), memoryBytes: 1 };
  docA.history = model.pushHistory(docA.history, entry);
  assert.equal(model.historyCanUndo(docA.history), true);
  assert.equal(model.historyCanUndo(docB.history), false);
  assert.equal(model.historyStateId(docA.history), 'history-a');
  assert.equal(model.historyStateId(docB.history), null);
});
