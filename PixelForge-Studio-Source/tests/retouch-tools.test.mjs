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

const retouch = require('../src/retouch-engine.ts');
const brushEngine = require('../src/brush-engine.ts');
const model = require('../src/editor-model.ts');
const projectFormat = require('../src/project-format.ts');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalCreateImageBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');

after(() => {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete globalThis.document;
  if (originalCreateImageBitmap) Object.defineProperty(globalThis, 'createImageBitmap', originalCreateImageBitmap);
  else delete globalThis.createImageBitmap;
});

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

function pixels(width, height, color) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(color, i);
  return data;
}

function sample(data, width, height) {
  return (x, y) => {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    const i = (y * width + x) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };
}

function stamp(data, width, height, center, sourceCenter, sourceAt, overrides = {}) {
  retouch.applyRetouchStamp({ data, width, height, x: 0, y: 0 }, center, sourceCenter, sourceAt, {
    size: 1, hardness: 100, opacity: 100, flow: 100, ...overrides.settings,
  }, { kind: 'clone', ...overrides.options });
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

test('clone sampling follows source offsets and distinguishes aligned from non-aligned strokes', () => {
  assert.deepEqual(
    retouch.mapRetouchSourcePoint({ x: 13, y: 5 }, { x: 3, y: 2 }, { x: 10, y: 5 }, { x: 2, y: -1 }),
    { x: 8, y: 1 },
  );
  assert.deepEqual(
    retouch.mapRetouchSourcePoint({ x: 13, y: 5 }, { x: 3, y: 2 }, { x: 13, y: 5 }, { x: 2, y: -1 }),
    { x: 5, y: 1 },
  );

  const source = pixels(3, 1, [0, 0, 0, 255]);
  source.set([230, 20, 10, 255], 4);
  const target = pixels(5, 1, [0, 0, 0, 0]);
  stamp(target, 5, 1, { x: 2.5, y: .5 }, { x: 1.5, y: .5 }, sample(source, 3, 1));
  assert.deepEqual([...target.slice(8, 12)], [230, 20, 10, 255]);
});

test('clone overlap reads cached source pixels from the pre-stroke tile', () => {
  const original = pixels(4, 1, [20, 0, 0, 255]);
  original.set([220, 0, 0, 255], 4);
  const readTile = (x, y, width, height) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row++) {
      const start = ((y + row) * 4 + x) * 4;
      data.set(original.subarray(start, start + width * 4), row * width * 4);
    }
    return { data, x, y, width, height };
  };
  const sourceAt = retouch.createTiledPixelSampler(4, 1, readTile, 2);
  assert.deepEqual(sourceAt(1, 0), [220, 0, 0, 255]);
  original.set([0, 250, 0, 255], 4);
  assert.deepEqual(sourceAt(1, 0), [220, 0, 0, 255]);
});

test('retouch strokes reuse brush spacing and carry distance between pointer events', () => {
  const settings = { size: 10, spacing: 50 };
  const spacing = { distanceSinceStamp: 0 };
  const points = [];
  brushEngine.forEachBrushStamp({ x: 0, y: 0, pressure: 1 }, { x: 12, y: 0, pressure: 1 }, spacing, settings, point => points.push(point.x));
  assert.deepEqual(points, [5, 10]);
  assert.equal(spacing.distanceSinceStamp, 2);
  const continued = [];
  brushEngine.forEachBrushStamp({ x: 12, y: 0, pressure: 1 }, { x: 20, y: 0, pressure: 1 }, spacing, settings, point => continued.push(point.x));
  assert.deepEqual(continued, [15, 20]);
});

test('brush hardness, opacity, flow, pressure, and selection coverage constrain cloning', () => {
  const source = pixels(5, 1, [255, 0, 0, 255]);
  const target = pixels(5, 1, [0, 0, 0, 0]);
  stamp(target, 5, 1, { x: 2.5, y: .5 }, { x: 2.5, y: .5 }, sample(source, 5, 1), {
    settings: { opacity: 50, flow: 50 },
    options: { coverageAt: x => x === 2 ? 255 : 0 },
  });
  assert.equal(target[11], 64);
  assert.equal(target[7], 0);

  const hardEdge = pixels(7, 1, [0, 0, 0, 0]);
  retouch.applyRetouchStamp({ data: hardEdge, width: 7, height: 1, x: 0, y: 0 },
    { x: 3.5, y: .5 }, { x: 3.5, y: .5 }, sample(source, 5, 1),
    { size: 4, hardness: 100, opacity: 100, flow: 100 }, { kind: 'clone' });
  assert.equal(hardEdge[15], 255);
  assert.equal(hardEdge[3], 0);

  const pressure = pixels(5, 1, [0, 0, 0, 0]);
  retouch.applyRetouchStamp({ data: pressure, width: 5, height: 1, x: 0, y: 0 },
    { x: 2.5, y: .5, pressure: .5 }, { x: 2.5, y: .5 }, sample(source, 5, 1),
    { size: 4, hardness: 100, opacity: 100, flow: 100, pressureOpacity: true }, { kind: 'clone' });
  assert.equal(pressure[11], 128);
});

test('transparent source pixels do not contaminate targets and out-of-bounds samples are ignored', () => {
  const source = pixels(2, 1, [200, 30, 0, 0]);
  const target = pixels(2, 1, [5, 10, 15, 255]);
  stamp(target, 2, 1, { x: .5, y: .5 }, { x: .5, y: .5 }, sample(source, 2, 1));
  assert.deepEqual([...target.slice(0, 4)], [5, 10, 15, 255]);
  stamp(target, 2, 1, { x: .5, y: .5 }, { x: -3, y: -3 }, sample(source, 2, 1));
  assert.deepEqual([...target.slice(0, 4)], [5, 10, 15, 255]);
});

test('healing transfers source texture while adapting to the destination local colour', () => {
  const source = pixels(9, 1, [200, 20, 10, 255]);
  source.set([220, 20, 10, 255], 4 * 4);
  const destination = pixels(5, 1, [10, 110, 30, 255]);
  const original = new Uint8ClampedArray(destination);
  retouch.applyRetouchStamp(
    { data: destination, width: 5, height: 1, x: 0, y: 0 },
    { x: 2.5, y: .5 }, { x: 4.5, y: .5 }, sample(source, 9, 1),
    { size: 1, hardness: 100, opacity: 100, flow: 100 },
    { kind: 'healing', destinationBeforeAt: sample(original, 5, 1) },
  );
  assert.deepEqual([...destination.slice(8, 12)], [23, 110, 30, 255]);
});

test('healing and clone respect canvas edges and mask alpha targets', () => {
  const source = pixels(2, 1, [255, 255, 255, 255]);
  const mask = pixels(2, 1, [255, 255, 255, 10]);
  const target = pixels(2, 1, [255, 255, 255, 0]);
  retouch.applyRetouchStamp({ data: target, width: 2, height: 1, x: 0, y: 0 },
    { x: .5, y: .5 }, { x: 1.5, y: .5 }, sample(mask, 2, 1),
    { size: 1, hardness: 100, opacity: 100, flow: 100 },
    { kind: 'clone', maskTarget: true });
  assert.deepEqual([...target.slice(0, 4)], [255, 255, 255, 10]);
  assert.equal(retouch.createTiledPixelSampler(2, 1, () => null)(2, 0), null);
});

test('invalid retouch buffers and brush sizes fail explicitly', () => {
  assert.throws(() => retouch.applyRetouchStamp(
    { data: new Uint8ClampedArray(3), width: 1, height: 1, x: 0, y: 0 },
    { x: .5, y: .5 }, { x: .5, y: .5 }, () => null,
    { size: 1, hardness: 100, opacity: 100, flow: 100 }, { kind: 'clone' },
  ), /buffer or brush position/i);
  assert.throws(() => retouch.applyRetouchStamp(
    { data: new Uint8ClampedArray(4), width: 1, height: 1, x: 0, y: 0 },
    { x: .5, y: .5 }, { x: .5, y: .5 }, () => null,
    { size: Number.NaN, hardness: 100, opacity: 100, flow: 100 }, { kind: 'clone' },
  ), /brush size/i);
});

test('retouched pixels use tile history and persist through native project save and reopen', async () => {
  globalThis.document = { createElement: () => new PixelCanvas() };
  globalThis.createImageBitmap = async blob => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16, false), height: view.getUint32(20, false), data: new Uint8ClampedArray(bytes.slice(24)), close() {} };
  };
  const doc = model.makeDocument('Retouch persistence', { w: 2, h: 1 });
  const canvas = doc.layers[0].canvas;
  canvas.data.set([10, 20, 30, 255, 40, 50, 60, 255]);
  const beforePixels = new Uint8ClampedArray(canvas.data);
  const before = model.snapshotDocument(doc);
  const source = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]);
  retouch.applyRetouchStamp(
    { data: canvas.data, width: 2, height: 1, x: 0, y: 0 },
    { x: 1.5, y: .5 }, { x: .5, y: .5 }, sample(source, 2, 1),
    { size: 1, hardness: 100, opacity: 100, flow: 100 }, { kind: 'clone' },
  );
  const afterPixels = new Uint8ClampedArray(canvas.data);
  assert.deepEqual([...afterPixels.slice(4, 8)], [10, 20, 30, 255]);

  const history = model.pushHistory(doc.history, {
    id: 'retouch', label: 'Clone stroke', timestamp: 1, before,
    after: model.snapshotDocument(doc), pixelLayerId: doc.layers[0].id, pixelTarget: 'canvas',
    pixelTiles: [{
      x: 0, y: 0,
      before: { data: beforePixels, width: 2, height: 1 },
      after: { data: afterPixels, width: 2, height: 1 },
    }],
    memoryBytes: beforePixels.byteLength + afterPixels.byteLength,
  });
  const saved = await projectFormat.serializeNativeProject({ ...doc, history });
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
  const reopened = await projectFormat.deserializeNativeProject(parsed);
  assert.deepEqual([...reopened.layers[0].canvas.data], [...afterPixels]);
  assert.equal(model.applyHistoryPixelTiles(history.entries[0], 'undo', doc.layers), true);
  assert.deepEqual([...canvas.data], [...beforePixels]);
  assert.equal(model.applyHistoryPixelTiles(history.entries[0], 'redo', doc.layers), true);
  assert.deepEqual([...canvas.data], [...afterPixels]);
});
