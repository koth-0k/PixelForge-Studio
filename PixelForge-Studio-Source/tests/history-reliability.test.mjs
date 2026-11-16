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
    this.context = { drawImage() {}, putImageData() {} };
  }
  getContext() { return this.context; }
}

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
globalThis.document = { createElement: () => new TestCanvas() };

const model = require('../src/editor-model.ts');

after(() => {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete globalThis.document;
});

function entry(id, before, after) {
  return { id, label: id, timestamp: 1, before, after, memoryBytes: 1 };
}

function named(snapshot, name) {
  return { ...snapshot, name };
}

function createHistoryWithEntries(count) {
  const doc = model.makeDocument('State 0', { w: 2, h: 2 });
  let history = doc.history;
  let state = model.snapshotDocument(doc);
  for (let index = 1; index <= count; index++) {
    const next = named(state, `State ${index}`);
    history = model.pushHistory(history, entry(`state-${index}`, state, next));
    state = next;
  }
  return { doc, history, state };
}

test('multiple undo and redo operations preserve the current history state', () => {
  const { history } = createHistoryWithEntries(3);
  assert.equal(history.cursor, 3);
  assert.equal(model.historyStateId(history), 'state-3');

  const twiceUndone = { ...history, cursor: 1 };
  assert.equal(model.historyCanUndo(twiceUndone), true);
  assert.equal(model.historyCanRedo(twiceUndone), true);
  assert.equal(model.historyStateId(twiceUndone), 'state-1');

  const redone = { ...twiceUndone, cursor: 3 };
  assert.equal(model.historyStateId(redone), 'state-3');
  assert.equal(model.historyCanRedo(redone), false);
});

test('editing after undo discards only the redo branch', () => {
  const { history, doc } = createHistoryWithEntries(3);
  const atFirstEdit = { ...history, cursor: 1 };
  const before = history.entries[0].after;
  const after = named(before, 'Branched state');
  const branch = model.pushHistory(atFirstEdit, entry('branch', before, after));

  assert.deepEqual(branch.entries.map(item => item.id), ['state-1', 'branch']);
  assert.equal(branch.cursor, 2);
  assert.equal(model.historyCanRedo(branch), false);
  assert.equal(model.historyStateId(branch), 'branch');
  assert.equal(doc.history.cursor, 0);
});

test('trimming preserves the current state and a valid undo/redo window', () => {
  const { history } = createHistoryWithEntries(5);
  const trimmedBehindCursor = model.trimHistory({ ...history, cursor: 3 }, 4);

  assert.deepEqual(trimmedBehindCursor.entries.map(item => item.id), ['state-1', 'state-2', 'state-3', 'state-4']);
  assert.equal(trimmedBehindCursor.cursor, 3);
  assert.equal(model.historyStateId(trimmedBehindCursor), 'state-3');
  assert.equal(model.historyCanRedo(trimmedBehindCursor), true);

  const trimmedAfterCursor = model.trimHistory({ ...history, cursor: 5 }, 2);
  assert.deepEqual(trimmedAfterCursor.entries.map(item => item.id), ['state-4', 'state-5']);
  assert.equal(trimmedAfterCursor.cursor, 2);
  assert.equal(trimmedAfterCursor.baseStateId, 'state-3');
  assert.equal(model.historyStateId(trimmedAfterCursor), 'state-5');
  assert.equal(model.historyStateId({ ...trimmedAfterCursor, cursor: 0 }), 'state-3');

  const redoWindow = model.trimHistory({ ...history, cursor: 0 }, 2);
  assert.equal(redoWindow.cursor, 0);
  assert.equal(redoWindow.entries.length, 2);
  assert.equal(model.historyCanRedo(redoWindow), true);
});

test('saved state remains clean through undo, redo, and history trimming', () => {
  const doc = model.makeDocument('Saved', { w: 2, h: 2 });
  const initial = model.snapshotDocument(doc);
  const first = named(initial, 'Saved after first edit');
  let history = model.pushHistory(doc.history, entry('saved-state', initial, first));
  const saved = model.markDocumentSaved({ ...doc, history }, model.historyStateId(history), 'G:\\Projects\\Saved.pforge');

  assert.equal(saved.dirty, false);
  assert.equal(saved.projectPath, 'G:\\Projects\\Saved.pforge');

  const second = named(first, 'Unsaved edit');
  history = model.pushHistory(history, entry('unsaved-state', first, second));
  assert.equal(model.isHistoryDirty(history, saved.savedHistoryId), true);
  assert.equal(model.isHistoryDirty({ ...history, cursor: 1 }, saved.savedHistoryId), false);
  assert.equal(model.isHistoryDirty({ ...history, cursor: 2 }, saved.savedHistoryId), true);

  const trimmed = model.trimHistory(history, 1);
  assert.equal(trimmed.baseStateId, 'saved-state');
  assert.equal(model.isHistoryDirty(trimmed, saved.savedHistoryId), true);
  const undoneToSaved = { ...trimmed, cursor: 0 };
  assert.equal(model.historyStateId(undoneToSaved), saved.savedHistoryId);
  assert.equal(model.isHistoryDirty(undoneToSaved, saved.savedHistoryId), false);
});

test('Save As records the saved path without losing document rename history', () => {
  const doc = model.makeDocument('Original name', { w: 2, h: 2 });
  const beforeRename = model.snapshotDocument(doc);
  const afterRename = named(beforeRename, 'Renamed document');
  const history = model.pushHistory(doc.history, entry('rename', beforeRename, afterRename));
  const savedAs = model.markDocumentSaved({ ...doc, name: afterRename.name, history }, model.historyStateId(history), 'G:\\Projects\\Renamed document.pforge');

  assert.equal(savedAs.name, 'Renamed document');
  assert.equal(savedAs.projectPath, 'G:\\Projects\\Renamed document.pforge');
  assert.equal(savedAs.dirty, false);
  assert.equal(history.entries[0].before.name, 'Original name');
  assert.equal(history.entries[0].after.name, 'Renamed document');
  assert.equal(model.isHistoryDirty({ ...history, cursor: 0 }, savedAs.savedHistoryId), true);
});

test('history and saved checkpoints stay isolated between documents', () => {
  const first = model.makeDocument('First', { w: 2, h: 2 });
  const second = model.makeDocument('Second', { w: 2, h: 2 });
  const before = model.snapshotDocument(first);
  const after = named(before, 'First edit');
  const firstHistory = model.pushHistory(first.history, entry('first-edit', before, after));
  const firstSaved = model.markDocumentSaved({ ...first, history: firstHistory }, 'first-edit', 'G:\\Projects\\First.pforge');

  assert.equal(model.isHistoryDirty(firstHistory, firstSaved.savedHistoryId), false);
  assert.equal(second.history.entries.length, 0);
  assert.equal(second.savedHistoryId, null);
  assert.equal(model.isHistoryDirty(second.history, second.savedHistoryId), false);
});

test('layer, mask, selection, path, and adjustment snapshots are retained', () => {
  const doc = model.makeDocument('Before', { w: 2, h: 2 });
  const before = model.snapshotDocument(doc);
  const mask = new TestCanvas(2, 2);
  const nextLayer = { ...doc.layers[0], opacity: 60, mask, maskEnabled: true };
  const selection = { mask: { width: 2, height: 2, tiles: new Map(), bounds: { x: 0, y: 0, width: 1, height: 1 } }, bounds: { x: 0, y: 0, width: 1, height: 1 }, kind: 'rect', feather: 0, visible: true };
  const path = { id: 'path', name: 'Path', visible: true, subpaths: [{ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], closed: false }] };
  doc.layers = [nextLayer];
  doc.selection = selection;
  doc.paths = [path];
  doc.adjustments = { ...doc.adjustments, brightness: 125 };
  const after = model.snapshotDocument(doc);
  const history = model.pushHistory(doc.history, entry('document-change', before, after));

  assert.equal(history.entries[0].before.layers[0].mask, undefined);
  assert.equal(history.entries[0].after.layers[0].mask, mask);
  assert.equal(history.entries[0].after.layers[0].opacity, 60);
  assert.equal(history.entries[0].after.selection, selection);
  assert.deepEqual(history.entries[0].after.paths, [path]);
  assert.equal(history.entries[0].after.adjustments.brightness, 125);
});

test('grouped property edits commit one history entry and invalid operations do not append', () => {
  const doc = model.makeDocument('Properties', { w: 2, h: 2 });
  const before = model.snapshotDocument(doc);
  const firstChange = { ...doc.layers[0], opacity: 80 };
  const finalChange = { ...firstChange, blend: 'multiply' };
  const after = { ...before, layers: [finalChange], background: '#ffffff' };
  const grouped = model.pushHistory(doc.history, entry('property-gesture', before, after));

  assert.equal(grouped.entries.length, 1);
  assert.equal(grouped.entries[0].after.layers[0].opacity, 80);
  assert.equal(grouped.entries[0].after.layers[0].blend, 'multiply');
  assert.equal(grouped.entries[0].after.background, '#ffffff');

  const invalidMove = model.moveLayer(doc.layers, doc.layers[0].id, doc.layers[0].id, 0);
  assert.equal(invalidMove, null);
  assert.equal(doc.history.entries.length, 0);
  assert.throws(() => model.trimHistory(doc.history, -1), /non-negative integer/i);
  assert.equal(doc.history.entries.length, 0);
});
