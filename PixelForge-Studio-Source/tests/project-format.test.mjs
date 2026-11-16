import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

const { historyStateId, makeDocument, makeLayer, pushHistory, snapshotDocument } = require('../src/editor-model.ts');
const { PROJECT_FORMAT, PROJECT_MAGIC, deserializeNativeProject, parseNativeProjectBytes, serializeNativeProject } = require('../src/project-format.ts');
const { createVectorPath } = require('../src/path-engine.ts');
const { maskAlphaAt, rasterizeSelection } = require('../src/selection-engine.ts');
const { createEffect } = require('../src/adjustment-engine.ts');

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalCreateImageBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

class TestCanvas {
  width = 300;
  height = 260;
  context = {
    drawImage() {},
    clearRect() {},
    putImageData() {},
    getImageData(_x, _y, width, height) { return { data: new Uint8ClampedArray(width * height * 4), width, height }; },
  };

  getContext() {
    return this.context;
  }

  toBlob(callback) {
    const bytes = Buffer.alloc(24);
    bytes.set(pngSignature);
    bytes.set([73, 72, 68, 82], 12);
    bytes.writeUInt32BE(this.width, 16);
    bytes.writeUInt32BE(this.height, 20);
    callback(new Blob([bytes], { type: 'image/png' }));
  }
}

globalThis.document = { createElement: () => new TestCanvas() };
globalThis.createImageBitmap = async blob => {
  const bytes = Buffer.from(await blob.arrayBuffer());
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    close() {},
  };
};

after(() => {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete globalThis.document;
  if (originalCreateImageBitmap) Object.defineProperty(globalThis, 'createImageBitmap', originalCreateImageBitmap);
  else delete globalThis.createImageBitmap;
});

function createDocument(selection = null, previousSelection = null) {
  const doc = makeDocument('Selection test', { w: 300, h: 260 });
  doc.selection = selection;
  doc.previousSelection = previousSelection;
  return doc;
}

async function saveAndReopen(doc) {
  const saved = await serializeNativeProject(doc);
  const manifest = structuredClone(saved.manifest);
  let offset = 0;
  manifest.assets = saved.assets.map(asset => {
    const descriptor = {
      id: asset.id,
      offset,
      length: asset.data.byteLength,
      sha256: createHash('sha256').update(asset.data).digest('hex'),
      mimeType: asset.mimeType,
    };
    offset += asset.data.byteLength;
    return descriptor;
  });
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const header = Buffer.alloc(12);
  Buffer.from(PROJECT_MAGIC).copy(header);
  header.writeUInt32LE(manifestBytes.byteLength, 8);
  const fileBytes = Buffer.concat([header, manifestBytes, ...saved.assets.map(asset => Buffer.from(asset.data))]);
  const parsed = await parseNativeProjectBytes(fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength));
  const reopened = await deserializeNativeProject(parsed);
  return { saved, reopened };
}

function assertSelectionsEqual(actual, expected) {
  assert.ok(actual);
  assert.equal(actual.kind, expected.kind);
  assert.equal(actual.feather, expected.feather);
  assert.equal(actual.visible, expected.visible);
  assert.deepEqual(actual.bounds, expected.bounds);
  assert.deepEqual([...actual.mask.tiles.keys()].sort(), [...expected.mask.tiles.keys()].sort());
  for (const [key, values] of expected.mask.tiles) {
    assert.deepEqual(actual.mask.tiles.get(key), values);
  }
}

test('rectangular selections save and reopen with canonical tile keys', async () => {
  const selection = rasterizeSelection(300, 260, 'rect', { x: 120, y: 120 }, { x: 140, y: 140 }, [], false);
  const { saved, reopened } = await saveAndReopen(createDocument(selection));
  const serialized = saved.manifest.document.selection.tiles;

  assert.ok(serialized.length > 1);
  assert.ok(serialized.every(tile => /^\d+:\d+$/.test(tile.key)));
  assertSelectionsEqual(reopened.selection, selection);
});

test('complex selections save and reopen without losing tile data', async () => {
  const points = [{ x: 100, y: 110 }, { x: 245, y: 125 }, { x: 220, y: 235 }, { x: 130, y: 245 }];
  const selection = rasterizeSelection(300, 260, 'polygon', points[0], points.at(-1), points, true);
  const { reopened } = await saveAndReopen(createDocument(selection));

  assertSelectionsEqual(reopened.selection, selection);
  assert.equal(maskAlphaAt(reopened.selection.mask, 150, 150), maskAlphaAt(selection.mask, 150, 150));
});

test('deselecting preserves the prior selection across save and reopen', async () => {
  const previousSelection = rasterizeSelection(300, 260, 'ellipse', { x: 125, y: 100 }, { x: 230, y: 220 }, [], true);
  const doc = createDocument(previousSelection);
  doc.previousSelection = doc.selection;
  doc.selection = null;
  const { reopened } = await saveAndReopen(doc);

  assert.equal(reopened.selection, null);
  assertSelectionsEqual(reopened.previousSelection, previousSelection);
});

test('legacy comma-separated selection tile keys load and normalize', async () => {
  const selection = rasterizeSelection(300, 260, 'rect', { x: 120, y: 120 }, { x: 140, y: 140 }, [], false);
  const saved = await serializeNativeProject(createDocument(selection));
  const manifest = structuredClone(saved.manifest);
  for (const tile of manifest.document.selection.tiles) tile.key = tile.key.replace(':', ',');

  const reopened = await deserializeNativeProject({ manifest, assets: saved.assets });

  assertSelectionsEqual(reopened.selection, selection);
  assert.ok([...reopened.selection.mask.tiles.keys()].every(key => /^\d+:\d+$/.test(key)));
});

test('malformed selection tile references are rejected with a useful error', async () => {
  const selection = rasterizeSelection(300, 260, 'rect', { x: 120, y: 120 }, { x: 140, y: 140 }, [], false);
  const saved = await serializeNativeProject(createDocument(selection));
  const manifest = structuredClone(saved.manifest);
  manifest.document.selection.tiles[0].key = '1:invalid';

  await assert.rejects(
    deserializeNativeProject({ manifest, assets: saved.assets }),
    /selection tile key is malformed/i,
  );
});

test('projects without selections save and reopen normally', async () => {
  const { reopened } = await saveAndReopen(createDocument());

  assert.equal(reopened.selection, null);
  assert.equal(reopened.previousSelection, null);
  assert.equal(reopened.size.w, 300);
  assert.equal(reopened.size.h, 260);
});

test('layer masks preserve enabled state and use the explicit alpha encoding', async () => {
  const doc = createDocument();
  const layer = doc.layers[0];
  layer.mask = new TestCanvas();
  layer.maskEnabled = false;
  const { saved, reopened } = await saveAndReopen(doc);

  assert.equal(saved.manifest.document.layers[0].maskMode, 'alpha');
  assert.equal(saved.manifest.document.layers[0].maskEnabled, false);
  assert.ok(reopened.layers[0].mask);
  assert.equal(reopened.layers[0].maskEnabled, false);
});

test('legacy layer masks without an encoding marker restore as enabled alpha masks', async () => {
  const doc = createDocument();
  doc.layers[0].mask = new TestCanvas();
  doc.layers[0].maskEnabled = true;
  const saved = await serializeNativeProject(doc);
  const manifest = structuredClone(saved.manifest);
  delete manifest.document.layers[0].maskMode;
  delete manifest.document.layers[0].maskEnabled;

  const reopened = await deserializeNativeProject({ manifest, assets: saved.assets });

  assert.ok(reopened.layers[0].mask);
  assert.equal(reopened.layers[0].maskEnabled, true);
});

test('adjustment layers and ordered effect stacks save and reopen intact', async () => {
  const doc = createDocument();
  const layer = makeLayer(1, 1, 'Color grade', 'adjustment');
  layer.width = doc.size.w;
  layer.height = doc.size.h;
  layer.mask = new TestCanvas(doc.size.w, doc.size.h);
  layer.maskEnabled = true;
  const exposure = createEffect('exposure', 'exposure-1');
  exposure.params.exposure = 1.25;
  const invert = createEffect('invert', 'invert-1');
  invert.enabled = false;
  layer.effects = [exposure, invert];
  doc.layers.push(layer);
  doc.activeLayerId = layer.id;
  doc.selectedLayerIds = [layer.id];

  const { saved, reopened } = await saveAndReopen(doc);

  assert.equal(saved.manifest.document.layers[1].type, 'adjustment');
  assert.deepEqual(saved.manifest.document.layers[1].effects, layer.effects);
  assert.equal(reopened.layers[1].type, 'adjustment');
  assert.deepEqual(reopened.layers[1].effects, layer.effects);
  assert.equal(reopened.layers[1].maskEnabled, true);
});

test('older projects without effect stacks open, while malformed effects are rejected', async () => {
  const saved = await serializeNativeProject(createDocument());
  const olderManifest = structuredClone(saved.manifest);
  delete olderManifest.document.layers[0].effects;
  const older = await deserializeNativeProject({ manifest: olderManifest, assets: saved.assets });
  assert.deepEqual(older.layers[0].effects, []);

  const malformedManifest = structuredClone(saved.manifest);
  malformedManifest.document.layers[0].effects = [{
    id: 'bad-effect', kind: 'unsupported', enabled: true, params: {},
  }];
  await assert.rejects(
    deserializeNativeProject({ manifest: malformedManifest, assets: saved.assets }),
    /unsupported effect type/i,
  );

  const adjustmentDoc = createDocument();
  const adjustment = makeLayer(1, 1, 'Adjustment', 'adjustment');
  adjustment.effects = [createEffect('invert', 'invert-1')];
  adjustmentDoc.layers.push(adjustment);
  const savedAdjustment = await serializeNativeProject(adjustmentDoc);
  const malformedBlend = structuredClone(savedAdjustment.manifest);
  malformedBlend.document.layers[1].blend = 'destination-in';
  await assert.rejects(
    deserializeNativeProject({ manifest: malformedBlend, assets: savedAdjustment.assets }),
    /unsupported blend mode/i,
  );
});

test('named paths and the active path survive save and reopen', async () => {
  const doc = createDocument();
  const path = createVectorPath('Logo outline', [
    { closed: true, points: [{ x: 12, y: 18 }, { x: 80, y: 18 }, { x: 72, y: 64 }, { x: 12, y: 64 }] },
    { closed: false, points: [{ x: 20, y: 30 }, { x: 50, y: 45 }] },
  ], 'path-logo');
  path.visible = false;
  doc.paths = [path];
  doc.activePathId = path.id;

  const { saved, reopened } = await saveAndReopen(doc);

  assert.deepEqual(saved.manifest.document.paths, [path]);
  assert.deepEqual(reopened.paths, [path]);
  assert.equal(reopened.activePathId, path.id);
});

test('older version-1 projects without path properties open with no paths', async () => {
  const saved = await serializeNativeProject(createDocument());
  const manifest = structuredClone(saved.manifest);
  delete manifest.document.paths;
  delete manifest.document.activePathId;

  const reopened = await deserializeNativeProject({ manifest, assets: saved.assets });

  assert.deepEqual(reopened.paths, []);
  assert.equal(reopened.activePathId, null);
});

test('malformed path data and missing active paths are rejected', async () => {
  const doc = createDocument();
  const path = createVectorPath('Valid path', [{ closed: false, points: [{ x: 1, y: 1 }, { x: 5, y: 5 }] }], 'path-valid');
  doc.paths = [path];
  doc.activePathId = path.id;
  const saved = await serializeNativeProject(doc);

  const malformedPoints = structuredClone(saved.manifest);
  malformedPoints.document.paths[0].subpaths[0].points[0].x = 'invalid';
  await assert.rejects(deserializeNativeProject({ manifest: malformedPoints, assets: saved.assets }), /invalid point/i);

  const missingActivePath = structuredClone(saved.manifest);
  missingActivePath.document.activePathId = 'path-missing';
  await assert.rejects(deserializeNativeProject({ manifest: missingActivePath, assets: saved.assets }), /active path does not exist/i);
});

test('saved projects reopen with a clean history baseline', async () => {
  const doc = createDocument();
  const before = snapshotDocument(doc);
  const after = { ...before, name: 'Saved edit' };
  doc.name = after.name;
  doc.history = pushHistory(doc.history, {
    id: 'saved-project-state',
    label: 'Rename document',
    timestamp: 1,
    before,
    after,
    memoryBytes: 1,
  });
  doc.savedHistoryId = historyStateId(doc.history);
  doc.dirty = false;

  const { reopened } = await saveAndReopen(doc);

  assert.equal(reopened.name, 'Saved edit');
  assert.equal(reopened.dirty, false);
  assert.equal(reopened.savedHistoryId, null);
  assert.deepEqual(reopened.history.entries, []);
  assert.equal(reopened.history.cursor, 0);
  assert.equal(reopened.history.baseStateId, null);
});

test('oversized embedded PNG dimensions are rejected before image decoding or document mutation', async () => {
  const existing = createDocument();
  const originalLayer = existing.layers[0];
  const image = Buffer.alloc(24);
  image.set(pngSignature);
  image.set([73, 72, 68, 82], 12);
  image.writeUInt32BE(8193, 16);
  image.writeUInt32BE(1, 20);
  let decodeCalls = 0;
  const previousDecoder = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => {
    decodeCalls++;
    throw new Error('unsafe image should not be decoded');
  };
  try {
    await assert.rejects(deserializeNativeProject({
      manifest: {
        format: PROJECT_FORMAT,
        version: 1,
        document: {
          name: 'Unsafe', size: { w: 1, h: 1 },
          layers: [{ id: 1, name: 'Layer', type: 'pixel', x: 0, y: 0, width: 1, height: 1, visible: true, opacity: 100, blend: 'source-over', locked: false, canvasAssetId: 'oversized' }],
          activeLayerId: 1, selectedLayerIds: [1],
        },
        assets: [],
      },
      assets: [{ id: 'oversized', mimeType: 'image/png', data: new Uint8Array(image) }],
    }), /unsafe or malformed dimensions/i);
  } finally {
    globalThis.createImageBitmap = previousDecoder;
  }
  assert.equal(decodeCalls, 0);
  assert.equal(existing.size.w, 300);
  assert.equal(existing.layers[0], originalLayer);
});
