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

const limits = require('../src/resource-limits.ts');
const model = require('../src/editor-model.ts');
const maskEngine = require('../src/mask-engine.ts');
const { BoundedSurfaceCache, canCompositeRegion, unionDirtyRect } = require('../src/render-cache.ts');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

after(() => {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete globalThis.document;
});

function pngHeader(width, height) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  new DataView(bytes.buffer).setUint32(16, width, false);
  new DataView(bytes.buffer).setUint32(20, height, false);
  return bytes;
}

test('canvas dimension and RGBA byte limits accept the exact pixel ceiling and reject overflow', () => {
  assert.equal(limits.assertCanvasDimensions(8192, 2048), limits.MAX_DOCUMENT_PIXELS);
  assert.equal(limits.rgbaByteLength(8192, 2048), limits.MAX_DOCUMENT_PIXELS * 4);
  assert.throws(() => limits.assertCanvasDimensions(8193, 1), /per side/i);
  assert.throws(() => limits.assertCanvasDimensions(4096, 4097), /pixels/i);
  assert.throws(() => limits.rgbaByteLength(Number.MAX_SAFE_INTEGER + 1, 2), /safe integers/i);
  assert.throws(() => limits.assertRgbaBufferLength(Number.MAX_SAFE_INTEGER), /buffer size/i);
  assert.throws(() => maskEngine.whiteMaskPixels(8193, 1), /per side/i);
});

test('canvas allocation rejects unsafe sizes before touching the browser allocator and reports allocation failure', () => {
  let created = 0;
  globalThis.document = {
    createElement() {
      created++;
      return { width: 0, height: 0, getContext: () => ({}) };
    },
  };
  assert.throws(() => model.makeCanvas(8193, 1), /per side/i);
  assert.equal(created, 0);
  assert.equal(model.makeCanvas(4, 3).width, 4);

  globalThis.document = { createElement: () => { throw new Error('simulated allocation failure'); } };
  assert.throws(() => model.makeCanvas(4, 3), /close other documents or use smaller dimensions/i);
});

test('image metadata preflight handles common formats and rejects unsafe or malformed dimensions', async () => {
  const jpeg = new Uint8Array(20);
  jpeg.set([255, 216, 255, 192, 0, 17, 8, 0, 16, 0, 32]);
  assert.deepEqual(limits.readImageDimensions(jpeg), { width: 32, height: 16 });

  const webp = new Uint8Array(30);
  webp.set([82, 73, 70, 70], 0);
  webp.set([87, 69, 66, 80], 8);
  webp.set([86, 80, 56, 88], 12);
  webp[24] = 255;
  webp[25] = 7;
  webp[27] = 255;
  webp[28] = 7;
  assert.deepEqual(limits.readImageDimensions(webp), { width: 2048, height: 2048 });

  assert.deepEqual(await limits.inspectImageBlob(new Blob([pngHeader(8192, 2048)])), { width: 8192, height: 2048 });
  await assert.rejects(limits.inspectImageBlob(new Blob([pngHeader(4096, 4097)])), /pixels/i);
  await assert.rejects(limits.inspectImageBlob(new Blob([new Uint8Array([0, 1, 2, 3])])), /unsupported|dimensions/i);
  assert.throws(() => limits.readPngDimensions(new Uint8Array(24)), /header is invalid/i);
  await assert.rejects(
    limits.inspectImageBlob({ size: limits.MAX_IMPORT_IMAGE_BYTES + 1, slice() { throw new Error('must not read oversized image'); } }),
    /100 MB/i,
  );
});

test('render cache reuses unchanged isolated surfaces and evicts within its byte budget', () => {
  const cache = new BoundedSurfaceCache(8, 8);
  const sourceA = {}, sourceB = {}, sourceC = {};
  let created = 0;
  const create = () => ({ id: ++created, width: 1, height: 1 });
  const resize = (canvas, width, height) => { canvas.width = width; canvas.height = height; };

  const first = cache.acquire('a', sourceA, 1, 1, create, resize);
  assert.equal(first.needsRender, true);
  const hit = cache.acquire('a', sourceA, 1, 1, create, resize);
  assert.equal(hit.needsRender, false);
  assert.equal(hit.canvas, first.canvas);
  const changed = cache.acquire('a', sourceB, 1, 1, create, resize);
  assert.equal(changed.needsRender, true);
  assert.equal(changed.canvas, first.canvas);
  cache.acquire('b', sourceB, 1, 1, create, resize);
  cache.acquire('c', sourceC, 1, 1, create, resize);
  assert.equal(cache.size, 2);
  assert.equal(cache.bytes, 8);
  assert.equal(cache.acquire('large', {}, 2, 2, create, resize), null);
  cache.prune(['c']);
  assert.equal(cache.size, 1);
  assert.equal(cache.bytes, 4);
});

test('regional compositing is enabled only for simple source-over pixel stacks', () => {
  const layer = {
    type: 'pixel', parentId: undefined, blend: 'source-over', filter: 'none', effects: [],
    x: 0, y: 0, width: 100, height: 80, rotation: 0, flipX: false, flipY: false,
  };
  assert.equal(canCompositeRegion([layer], 100, 80), true);
  assert.equal(canCompositeRegion([{ ...layer, mask: {} }], 100, 80), false);
  assert.equal(canCompositeRegion([{ ...layer, type: 'adjustment' }], 100, 80), false);
  assert.equal(canCompositeRegion([{ ...layer, blend: 'multiply' }], 100, 80), false);
  assert.deepEqual(unionDirtyRect({ x: 1, y: 2, width: 4, height: 3 }, { x: 3, y: -1, width: 5, height: 4 }), { x: 1, y: -1, width: 7, height: 6 });
});

test('history memory trimming keeps the current cursor state and the nearest affordable undo entries', () => {
  const entries = [
    { id: 'one', memoryBytes: 40 },
    { id: 'two', memoryBytes: 40 },
    { id: 'three', memoryBytes: 40 },
    { id: 'four', memoryBytes: 40 },
  ].map(item => ({ ...item, label: item.id, timestamp: 1, before: {}, after: {} }));
  const original = { entries, cursor: 4, limit: 10, baseStateId: null };
  const trimmed = model.trimHistory(original, 10, 100);
  assert.deepEqual(trimmed.entries.map(entry => entry.id), ['three', 'four']);
  assert.equal(trimmed.cursor, 2);
  assert.equal(trimmed.baseStateId, 'two');
  assert.equal(model.historyStateId(trimmed), 'four');

  const afterUndo = model.trimHistory({ ...original, cursor: 2 }, 10, 100);
  assert.deepEqual(afterUndo.entries.map(entry => entry.id), ['one', 'two']);
  assert.equal(afterUndo.cursor, 2);
  assert.equal(afterUndo.baseStateId, null);
  const noBudget = model.trimHistory(original, 10, 0);
  assert.deepEqual(noBudget.entries, []);
  assert.equal(noBudget.cursor, 0);
  assert.equal(noBudget.baseStateId, 'four');
  assert.equal(model.historyStateId(noBudget), 'four');
  assert.throws(() => model.trimHistory(original, 10, -1), /memory limit/i);
});
