import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

const fillEngine = require('../src/fill-engine.ts');
const model = require('../src/editor-model.ts');
const projectFormat = require('../src/project-format.ts');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalCreateImageBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');

class PixelCanvas {
  constructor(width = 1, height = 1) {
    this._width = width;
    this._height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
    this.context = {
      getImageData: (x, y, width, height) => {
        const data = new Uint8ClampedArray(width * height * 4);
        for (let row = 0; row < height; row++) {
          const from = ((y + row) * this.width + x) * 4;
          data.set(this.data.subarray(from, from + width * 4), row * width * 4);
        }
        return { data, width, height };
      },
      putImageData: (image, x, y) => {
        for (let row = 0; row < image.height; row++) {
          const to = ((y + row) * this.width + x) * 4;
          this.data.set(image.data.subarray(row * image.width * 4, (row + 1) * image.width * 4), to);
        }
      },
      drawImage: (image, x, y) => {
        for (let row = 0; row < image.height; row++) {
          const to = ((y + row) * this.width + x) * 4;
          this.data.set(image.data.subarray(row * image.width * 4, (row + 1) * image.width * 4), to);
        }
      },
    };
  }

  get width() { return this._width; }
  set width(value) { this._width = value; this.data = new Uint8ClampedArray(this._width * this._height * 4); }
  get height() { return this._height; }
  set height(value) { this._height = value; this.data = new Uint8ClampedArray(this._width * this._height * 4); }
  getContext() { return this.context; }

  toBlob(callback) {
    const bytes = Buffer.alloc(24 + this.data.byteLength);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    bytes.set([73, 72, 68, 82], 12);
    bytes.writeUInt32BE(this.width, 16);
    bytes.writeUInt32BE(this.height, 20);
    bytes.set(this.data, 24);
    callback(new Blob([bytes], { type: 'image/png' }));
  }
}

after(() => {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete globalThis.document;
  if (originalCreateImageBitmap) Object.defineProperty(globalThis, 'createImageBitmap', originalCreateImageBitmap);
  else delete globalThis.createImageBitmap;
});

function opaquePixels(width, height, color = [0, 0, 0, 255]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) pixels.set(color, index);
  return pixels;
}

function stops(...items) {
  return items.map(([position, color, opacity = 100]) => ({ position, color, opacity }));
}

async function saveAndReopen(doc) {
  const saved = await projectFormat.serializeNativeProject(doc);
  const manifest = structuredClone(saved.manifest);
  let offset = 0;
  manifest.assets = saved.assets.map(asset => {
    const descriptor = {
      id: asset.id, offset, length: asset.data.byteLength,
      sha256: createHash('sha256').update(asset.data).digest('hex'),
      mimeType: asset.mimeType,
    };
    offset += asset.data.byteLength;
    return descriptor;
  });
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const header = Buffer.alloc(12);
  Buffer.from(projectFormat.PROJECT_MAGIC).copy(header);
  header.writeUInt32LE(manifestBytes.byteLength, 8);
  const file = Buffer.concat([header, manifestBytes, ...saved.assets.map(asset => Buffer.from(asset.data))]);
  const parsed = await projectFormat.parseNativeProjectBytes(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
  return projectFormat.deserializeNativeProject(parsed);
}

test('linear gradients interpolate stops in either direction and clamp outside endpoints', () => {
  const pixels = opaquePixels(4, 1);
  fillEngine.applyGradientPixels(pixels, 4, 1, {
    kind: 'linear', start: { x: .5, y: .5 }, end: { x: 3.5, y: .5 },
    stops: stops([0, '#000000'], [1, '#ffffff']), opacity: 100, blend: 'source-over',
  });
  assert.deepEqual([...pixels.filter((_value, index) => index % 4 === 0)], [0, 85, 170, 255]);

  const reversed = opaquePixels(4, 1);
  fillEngine.applyGradientPixels(reversed, 4, 1, {
    kind: 'linear', start: { x: 3.5, y: .5 }, end: { x: .5, y: .5 },
    stops: stops([0, '#000000'], [1, '#ffffff']), opacity: 100, blend: 'source-over',
  });
  assert.deepEqual([...reversed.filter((_value, index) => index % 4 === 0)], [255, 170, 85, 0]);
});

test('radial and custom multi-stop gradients interpolate RGB and stop alpha', () => {
  const radial = opaquePixels(3, 3);
  fillEngine.applyGradientPixels(radial, 3, 3, {
    kind: 'radial', start: { x: .5, y: .5 }, end: { x: 2.5, y: .5 },
    stops: stops([0, '#000000'], [1, '#ffffff']), opacity: 100, blend: 'source-over',
  });
  assert.equal(radial[0], 0);
  assert.equal(radial[(2 * 3 + 2) * 4], 255);
  assert.equal(radial[(0 * 3 + 2) * 4], 255);

  const multi = new Uint8ClampedArray(12);
  fillEngine.applyGradientPixels(multi, 3, 1, {
    kind: 'linear', start: { x: .5, y: .5 }, end: { x: 2.5, y: .5 },
    stops: stops([0, '#ff0000'], [.5, '#00ff00', 50], [1, '#0000ff']), opacity: 100, blend: 'source-over',
  });
  assert.deepEqual([...multi], [255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255]);
});

test('gradient validates custom stops, blends, opacity, and selection coverage', () => {
  const pixels = opaquePixels(2, 1, [100, 100, 100, 255]);
  fillEngine.applyGradientPixels(pixels, 2, 1, {
    kind: 'linear', start: { x: .5, y: .5 }, end: { x: 1.5, y: .5 },
    stops: stops([0, '#ffffff'], [1, '#ffffff']), opacity: 100, blend: 'source-over',
    coverageAt: x => x < 1 ? 0 : 128,
  });
  assert.deepEqual([...pixels], [100, 100, 100, 255, 178, 178, 178, 255]);
  assert.throws(() => fillEngine.validateGradientStops([{ position: 0, color: '#000000', opacity: 100 }]), /between 2 and 16/i);
  assert.throws(() => fillEngine.validateGradientStops(stops([0, '#000'], [1, '#ffffff'])), /six-digit/i);
  assert.throws(() => fillEngine.applyGradientPixels(new Uint8ClampedArray(4), 8193, 1, {
    kind: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, stops: stops([0, '#000000'], [1, '#ffffff']), opacity: 100, blend: 'source-over',
  }), /per side/i);
});

test('flood fill distinguishes contiguous regions from global matching and applies tolerance', () => {
  const pixels = new Uint8ClampedArray([
    255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255,
    255, 0, 0, 255, 255, 0, 0, 255,
  ]);
  const contiguous = fillEngine.floodFillPixels(pixels, 5, 1, { x: 0, y: 0, tolerance: 0, contiguous: true, antiAlias: false });
  const global = fillEngine.floodFillPixels(pixels, 5, 1, { x: 0, y: 0, tolerance: 0, contiguous: false, antiAlias: false });
  assert.deepEqual([...contiguous.coverage], [255, 255, 0, 0, 0]);
  assert.deepEqual([...global.coverage], [255, 255, 0, 255, 255]);
  assert.deepEqual(contiguous.bounds, { x: 0, y: 0, width: 2, height: 1 });

  const near = new Uint8ClampedArray([10, 10, 10, 255, 20, 10, 10, 255, 40, 10, 10, 255]);
  assert.deepEqual([...fillEngine.floodFillPixels(near, 3, 1, { x: 0, y: 0, tolerance: 0, contiguous: false, antiAlias: false }).coverage], [255, 0, 0]);
  assert.deepEqual([...fillEngine.floodFillPixels(near, 3, 1, { x: 0, y: 0, tolerance: 11, contiguous: false, antiAlias: false }).coverage], [255, 255, 0]);
  const maximumTolerance = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 200, 30, 70, 0]);
  assert.deepEqual([...fillEngine.floodFillPixels(maximumTolerance, 3, 1, { x: 0, y: 0, tolerance: 255, contiguous: false, antiAlias: false }).coverage], [255, 255, 255]);
});

test('flood fill respects alpha, antialias coverage, selection coverage, and blend modes', () => {
  const transparent = new Uint8ClampedArray([200, 0, 0, 0, 0, 0, 0, 0]);
  const region = fillEngine.floodFillPixels(transparent, 2, 1, { x: 0, y: 0, tolerance: 0, contiguous: true, antiAlias: false });
  assert.deepEqual([...region.coverage], [255, 255]);
  fillEngine.applyFloodFillPixels(transparent, region, '#336699', 50, 'source-over');
  assert.deepEqual([...transparent], [51, 102, 153, 128, 51, 102, 153, 128]);

  const edge = new Uint8ClampedArray([0, 0, 0, 255, 16, 0, 0, 255, 200, 0, 0, 255]);
  const antialiased = fillEngine.floodFillPixels(edge, 3, 1, { x: 0, y: 0, tolerance: 0, contiguous: true, antiAlias: true });
  assert.equal(antialiased.coverage[0], 255);
  assert.ok(antialiased.coverage[1] > 0 && antialiased.coverage[1] < 255);
  fillEngine.applyFloodFillPixels(edge, antialiased, '#ffffff', 100, 'source-over', x => x > 1 ? 0 : 255);
  assert.equal(edge[4], 16);
  assert.equal(edge[8], 200);

  const blended = opaquePixels(1, 1, [200, 100, 50, 255]);
  const single = fillEngine.floodFillPixels(blended, 1, 1, { x: 0, y: 0, tolerance: 0, contiguous: true, antiAlias: false });
  fillEngine.applyFloodFillPixels(blended, single, '#80ff00', 100, 'multiply');
  assert.deepEqual([...blended], [100, 100, 0, 255]);
});

test('large-image fill stays dimension-bounded and rejects unsafe buffers and seeds', () => {
  const width = 1024, height = 512, pixels = opaquePixels(width, height);
  const result = fillEngine.floodFillPixels(pixels, width, height, { x: 0, y: 0, tolerance: 0, contiguous: false, antiAlias: false });
  assert.equal(result.count, width * height);
  assert.deepEqual(result.bounds, { x: 0, y: 0, width, height });
  assert.throws(() => fillEngine.floodFillPixels(new Uint8ClampedArray(), 8193, 1, { x: 0, y: 0, tolerance: 0, contiguous: false, antiAlias: false }), /per side/i);
  assert.throws(() => fillEngine.floodFillPixels(new Uint8ClampedArray(4), 1, 1, { x: 1, y: 0, tolerance: 0, contiguous: true, antiAlias: false }), /outside/i);
});

test('gradient edits undo, redo, and round-trip raster pixels through .pforge', async () => {
  globalThis.document = { createElement: () => new PixelCanvas() };
  globalThis.createImageBitmap = async blob => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16, false), height: view.getUint32(20, false), data: new Uint8ClampedArray(bytes.slice(24)), close() {} };
  };
  const doc = model.makeDocument('Gradient persistence', { w: 4, h: 1 });
  const canvas = doc.layers[0].canvas;
  canvas.data.fill(255);
  const before = new Uint8ClampedArray(canvas.data);
  const snapshotBefore = model.snapshotDocument(doc);
  fillEngine.applyGradientPixels(canvas.data, 4, 1, {
    kind: 'linear', start: { x: .5, y: .5 }, end: { x: 3.5, y: .5 },
    stops: stops([0, '#ff0000'], [1, '#0000ff']), opacity: 100, blend: 'source-over',
  });
  const after = new Uint8ClampedArray(canvas.data);
  const snapshotAfter = model.snapshotDocument(doc);
  const tile = {
    x: 0, y: 0,
    before: { data: before, width: 4, height: 1 },
    after: { data: after, width: 4, height: 1 },
  };
  const entry = {
    id: 'gradient', label: 'Apply gradient', timestamp: 1, before: snapshotBefore, after: snapshotAfter,
    pixelLayerId: doc.layers[0].id, pixelTarget: 'canvas', pixelTiles: [tile], memoryBytes: before.byteLength + after.byteLength,
  };
  const history = model.pushHistory(doc.history, entry);
  const reopened = await saveAndReopen({ ...doc, history });
  assert.deepEqual([...reopened.layers[0].canvas.data], [...after]);
  const saved = model.markDocumentSaved({ ...doc, history }, null, 'G:\\Projects\\Gradient.pforge');
  assert.equal(model.isHistoryDirty(history, saved.savedHistoryId), true);
  assert.equal(model.applyHistoryPixelTiles(entry, 'undo', doc.layers), true);
  assert.deepEqual([...canvas.data], [...before]);
  const undone = { ...history, cursor: 0 };
  assert.equal(model.isHistoryDirty(undone, saved.savedHistoryId), false);
  assert.equal(model.applyHistoryPixelTiles(entry, 'redo', doc.layers), true);
  assert.deepEqual([...canvas.data], [...after]);
  assert.equal(model.isHistoryDirty(history, saved.savedHistoryId), true);
});

test('mask gradients interpolate reveal coverage without discarding the mask data', () => {
  const mask = new Uint8ClampedArray([255, 255, 255, 0, 255, 255, 255, 0]);
  fillEngine.applyGradientPixels(mask, 2, 1, {
    kind: 'linear', start: { x: .5, y: .5 }, end: { x: 1.5, y: .5 },
    stops: stops([0, '#000000'], [1, '#ffffff']), opacity: 100, blend: 'source-over', targetMask: true,
  });
  assert.deepEqual([...mask], [255, 255, 255, 0, 255, 255, 255, 255]);
});

test('mask pixel history restores the mask tile on undo and redo', () => {
  const doc = model.makeDocument('Mask fill history', { w: 2, h: 1 });
  const mask = new PixelCanvas(2, 1);
  mask.data.set([255, 255, 255, 128, 255, 255, 255, 128]);
  const beforePixels = new Uint8ClampedArray(mask.data);
  const before = model.snapshotDocument(doc);
  const layerWithMask = { ...doc.layers[0], mask, maskEnabled: true };
  const after = { ...before, layers: [layerWithMask] };
  const afterPixels = new Uint8ClampedArray([255, 255, 255, 0, 255, 255, 255, 255]);
  mask.data.set(afterPixels);
  const entry = {
    id: 'mask-gradient', label: 'Apply mask gradient', timestamp: 2, before, after,
    pixelLayerId: layerWithMask.id, pixelTarget: 'mask',
    pixelTiles: [{ x: 0, y: 0, before: { data: beforePixels, width: 2, height: 1 }, after: { data: afterPixels, width: 2, height: 1 } }],
    memoryBytes: beforePixels.byteLength + afterPixels.byteLength,
  };

  assert.equal(model.applyHistoryPixelTiles(entry, 'undo', [layerWithMask]), true);
  assert.deepEqual([...mask.data], [...beforePixels]);
  assert.equal(model.applyHistoryPixelTiles(entry, 'redo', [layerWithMask]), true);
  assert.deepEqual([...mask.data], [...afterPixels]);
});
