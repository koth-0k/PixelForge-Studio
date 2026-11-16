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

const model = require('../src/editor-model.ts');
const engine = require('../src/adjustment-engine.ts');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

after(() => {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete globalThis.document;
});

function effect(kind, params = {}) {
  const item = engine.createEffect(kind, kind);
  item.params = { ...item.params, ...params };
  return item;
}

function pixel(red, green, blue, alpha = 255) {
  return new Uint8ClampedArray([red, green, blue, alpha]);
}

test('brightness, contrast, exposure, levels, grayscale and invert process RGB without changing alpha', () => {
  const source = pixel(100, 120, 140, 37);
  const bright = engine.applyEffectStack(source, 1, 1, [effect('brightnessContrast', { brightness: 20 })]);
  assert.deepEqual([...bright], [151, 171, 191, 37]);

  const exposed = engine.applyEffectStack(pixel(32, 64, 128, 99), 1, 1, [effect('exposure', { exposure: 1 })]);
  assert.deepEqual([...exposed], [64, 128, 255, 99]);

  const leveled = engine.applyEffectStack(pixel(0, 128, 255), 1, 1, [effect('levels', { outputBlack: 10, outputWhite: 210 })]);
  assert.deepEqual([...leveled], [10, 110, 210, 255]);

  const gray = engine.applyEffectStack(source, 1, 1, [effect('grayscale')]);
  assert.equal(gray[0], gray[1]);
  assert.equal(gray[1], gray[2]);
  assert.equal(gray[3], 37);
  assert.deepEqual([...engine.applyEffectStack(pixel(12, 88, 201, 77), 1, 1, [effect('invert')])], [243, 167, 54, 77]);
});

test('hue, saturation, color balance and sepia produce predictable colour changes', () => {
  const green = engine.applyEffectStack(pixel(255, 0, 0), 1, 1, [effect('hueSaturation', { hue: 120 })]);
  assert.deepEqual([...green], [0, 255, 0, 255]);

  const saturated = engine.applyEffectStack(pixel(150, 100, 100), 1, 1, [effect('hueSaturation', { saturation: 100 })]);
  assert.ok(saturated[0] > saturated[1]);

  const balanced = engine.applyEffectStack(pixel(80, 80, 80), 1, 1, [effect('colorBalance', { shadowsR: 20, preserveLuminosity: false })]);
  assert.ok(balanced[0] > balanced[1]);
  assert.deepEqual([...engine.applyEffectStack(pixel(100, 100, 100), 1, 1, [effect('sepia')])].slice(0, 3), [135, 120, 94]);
});

test('blur and sharpen are editable image-processing effects', () => {
  const source = new Uint8ClampedArray([
    0, 0, 0, 255,
    255, 255, 255, 255,
    0, 0, 0, 255,
  ]);
  const blurred = engine.applyEffectStack(source, 3, 1, [effect('blur', { radius: 1 })]);
  assert.equal(blurred[0], 85);
  assert.equal(blurred[4], 85);
  assert.equal(blurred[8], 85);
  const sharpened = engine.applyEffectStack(new Uint8ClampedArray([
    0, 0, 0, 255,
    100, 100, 100, 255,
    0, 0, 0, 255,
  ]), 3, 1, [effect('sharpen', { amount: 100, radius: 1 })]);
  assert.ok(sharpened[4] > 100);
});

test('effect stack order, enabled state, mask and opacity preview do not mutate source pixels', () => {
  const source = pixel(0, 30, 80);
  const invert = effect('invert'), brightness = effect('brightnessContrast', { brightness: 20 });
  const ordered = engine.applyEffectStack(source, 1, 1, [invert, brightness]);
  const reversed = engine.applyEffectStack(source, 1, 1, [brightness, invert]);
  assert.deepEqual([...ordered], [255, 255, 226, 255]);
  assert.deepEqual([...reversed], [204, 174, 124, 255]);
  assert.notDeepEqual([...ordered], [...reversed]);
  const unchanged = engine.applyEffectStack(source, 1, 1, [{ ...invert, enabled: false }]);
  assert.deepEqual([...unchanged], [...source]);
  assert.notEqual(unchanged, source);

  const base = pixel(100, 100, 100);
  const preview = engine.applyAdjustmentLayerPixels(base, 1, 1, [invert], 50, new Uint8ClampedArray([128]));
  assert.deepEqual([...preview], [114, 114, 114, 255]);
  const multiplyPreview = engine.applyAdjustmentLayerPixels(base, 1, 1, [invert], 100, new Uint8ClampedArray([128]), true, 'multiply');
  assert.deepEqual([...multiplyPreview], [80, 80, 80, 255]);
  assert.deepEqual([...engine.applyAdjustmentLayerPixels(base, 1, 1, [invert], 100, undefined, false, 'multiply')], [...base]);
  assert.throws(() => engine.applyAdjustmentLayerPixels(new Uint8ClampedArray(4), 8193, 1, [], 100, undefined, false), /per side/i);
  assert.deepEqual([...base], [100, 100, 100, 255]);
});

test('effect validation rejects malformed stacks and preserves level constraints', () => {
  const valid = effect('levels');
  assert.deepEqual(engine.validateEffectStack([valid]), [valid]);
  assert.throws(() => engine.validateEffectStack([{ ...valid, kind: 'solarize' }]), /unsupported effect type/i);
  assert.throws(() => engine.validateEffectStack([{ ...valid, params: { inputBlack: 254, inputWhite: 254, gamma: 1, outputBlack: 0, outputWhite: 255 } }]), /input white above input black/i);
  assert.throws(() => engine.validateEffectStack([{ ...valid, params: { ...valid.params, gamma: 20 } }]), /invalid gamma/i);
  assert.throws(() => engine.applyEffectStack(new Uint8ClampedArray(4), 4096, 4097, []), /invalid or exceed/i);
});

test('effect snapshots are undoable and isolated between documents', () => {
  globalThis.document = { createElement: () => ({ width: 1, height: 1, getContext: () => ({ drawImage() {} }) }) };
  const first = model.makeDocument('First', { w: 1, h: 1 });
  const second = model.makeDocument('Second', { w: 1, h: 1 });
  const before = model.snapshotDocument(first);
  first.layers[0].effects.push(effect('invert'));
  const after = model.snapshotDocument(first);
  const entry = { id: 'effect-change', label: 'Add effect', timestamp: 1, before, after, memoryBytes: 512 };
  first.history = model.pushHistory(first.history, entry);

  assert.equal(before.layers[0].effects.length, 0);
  assert.equal(after.layers[0].effects.length, 1);
  assert.equal(second.layers[0].effects.length, 0);
  assert.equal(model.historyStateId(first.history), 'effect-change');
  assert.equal(model.historyStateId(second.history), null);
});
