import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

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

const { drawTextContent } = require('../src/vector-engine.ts');

test('long unbroken text wraps with linear canvas text measurements', () => {
  const content = 'x'.repeat(2048);
  let measureCalls = 0, drawCalls = 0;
  const context = {
    save() {},
    beginPath() {},
    rect() {},
    clip() {},
    restore() {},
    measureText() {
      measureCalls++;
      return { width: 1 };
    },
    fillText() { drawCalls++; },
  };

  drawTextContent(context, {
    content,
    fontFamily: 'Arial',
    fontSize: 12,
    fontWeight: 400,
    italic: false,
    alignment: 'left',
    color: '#000000',
    letterSpacing: 0,
    lineSpacing: 1,
    underline: false,
    strikethrough: false,
    boxWidth: 32,
    boxHeight: 128,
  });

  assert.ok(measureCalls <= content.length * 8, `expected linear measurement work, got ${measureCalls} calls`);
  assert.equal(drawCalls, content.length);
});
