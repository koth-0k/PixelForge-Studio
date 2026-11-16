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

const { makeDocument } = require('../src/editor-model.ts');
const { createChannelPreview } = require('../src/channel-engine.ts');
const { createVectorPath, deleteVectorPath, mapVectorPaths, renameVectorPath, selectionToSubpaths, setVectorPathVisibility, shapeLayerToSubpaths } = require('../src/path-engine.ts');
const { rasterizeSelection } = require('../src/selection-engine.ts');

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
globalThis.document = { createElement: () => ({ width: 1, height: 1, getContext: () => ({}) }) };

after(() => {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete globalThis.document;
});

test('paths can be created, renamed, hidden, shown and deleted without mutating prior state', () => {
  const original = createVectorPath('Work Path', [{ closed: false, points: [{ x: 1, y: 1 }, { x: 5, y: 3 }] }], 'path-1');
  const renamed = renameVectorPath([original], original.id, 'Trim');
  const hidden = setVectorPathVisibility(renamed, original.id, false);

  assert.equal(original.name, 'Work Path');
  assert.equal(original.visible, true);
  assert.equal(renamed[0].name, 'Trim');
  assert.equal(hidden[0].visible, false);
  assert.equal(setVectorPathVisibility(hidden, original.id, true)[0].visible, true);
  assert.deepEqual(deleteVectorPath(hidden, original.id), []);
});

test('rectangular and complex selections convert to closed path outlines', () => {
  const rectangle = rasterizeSelection(12, 12, 'rect', { x: 2, y: 3 }, { x: 6, y: 7 }, [], false);
  const rectanglePath = selectionToSubpaths(rectangle);
  assert.equal(rectanglePath.length, 1);
  assert.equal(rectanglePath[0].closed, true);
  assert.deepEqual(rectanglePath[0].points, [{ x: 2, y: 3 }, { x: 6, y: 3 }, { x: 6, y: 7 }, { x: 2, y: 7 }]);

  const ellipse = rasterizeSelection(32, 32, 'ellipse', { x: 4, y: 5 }, { x: 25, y: 27 }, [], true);
  const ellipsePath = selectionToSubpaths(ellipse);
  assert.ok(ellipsePath.length > 0);
  assert.ok(ellipsePath.every(subpath => subpath.closed && subpath.points.length >= 3));
});

test('vector shape conversion includes layer position, rotation and flip', () => {
  const layer = {
    type: 'shape',
    x: 10,
    y: 20,
    width: 8,
    height: 6,
    rotation: 90,
    flipX: true,
    flipY: false,
    shapeData: { kind: 'rectangle', cornerRadius: 0 },
  };
  const [outline] = shapeLayerToSubpaths(layer);
  assert.equal(outline.closed, true);
  assert.deepEqual(outline.points[0], { x: 17, y: 27 });
});

test('mapping document paths preserves path metadata and leaves the source unchanged', () => {
  const path = createVectorPath('Resize me', [{ closed: false, points: [{ x: 2, y: 3 }, { x: 5, y: 7 }] }], 'path-map');
  const mapped = mapVectorPaths([path], point => ({ x: point.x * 2, y: point.y * 3 }));

  assert.deepEqual(mapped[0].subpaths[0].points, [{ x: 4, y: 9 }, { x: 10, y: 21 }]);
  assert.equal(mapped[0].id, path.id);
  assert.deepEqual(path.subpaths[0].points, [{ x: 2, y: 3 }, { x: 5, y: 7 }]);
});

test('RGB and individual channel previews are accurate and leave source pixels unchanged', () => {
  const source = new Uint8ClampedArray([200, 30, 10, 128, 20, 60, 220, 0]);
  const original = new Uint8ClampedArray(source);
  assert.deepEqual([...createChannelPreview(source, 'rgb')], [...original]);
  assert.deepEqual([...createChannelPreview(source, 'red')], [200, 200, 200, 128, 20, 20, 20, 0]);
  assert.deepEqual([...createChannelPreview(source, 'green')], [30, 30, 30, 128, 60, 60, 60, 0]);
  assert.deepEqual([...createChannelPreview(source, 'blue')], [10, 10, 10, 128, 220, 220, 220, 0]);
  assert.deepEqual([...source], [...original]);
});

test('alpha preview shows transparency as grayscale and is opaque', () => {
  const source = new Uint8ClampedArray([200, 30, 10, 128, 20, 60, 220, 0, 100, 110, 120, 255]);

  assert.deepEqual([...createChannelPreview(source, 'alpha')], [128, 128, 128, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
  assert.deepEqual([...source], [200, 30, 10, 128, 20, 60, 220, 0, 100, 110, 120, 255]);
  assert.throws(() => createChannelPreview(new Uint8ClampedArray([1, 2, 3]), 'red'), /complete RGBA pixels/i);
});

test('path and channel state remain isolated between documents', () => {
  const first = makeDocument('First', { w: 8, h: 8 });
  const second = makeDocument('Second', { w: 8, h: 8 });
  first.paths = [createVectorPath('First path', [], 'first-path')];
  first.activePathId = 'first-path';
  first.channelView = 'red';

  assert.deepEqual(second.paths, []);
  assert.equal(second.activePathId, null);
  assert.equal(second.channelView, 'rgb');
});
