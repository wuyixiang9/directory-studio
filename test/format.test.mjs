import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../text-studio.src.js', import.meta.url), 'utf8');
const context = vm.createContext({});
new vm.Script(source, { filename: 'text-studio.src.js' }).runInContext(context);
const format = context.formatLocalJSON;

test('JSON formatter indents without rounding number literals or dropping duplicate keys', () => {
  const input = '{"n":900719925474099312345,"same":1,"same":2,"a":[true,null,{"x":"a b"}],"e":1e+90}';
  const output = format(input);
  assert.match(output, /900719925474099312345/);
  assert.match(output, /"same": 1,\n  "same": 2/);
  assert.match(output, /"e": 1e\+90/);
  assert.match(output, /\n    true,\n    null,/);
  assert.deepEqual(JSON.parse(output), JSON.parse(input));
  assert.equal(format(output), output);
});

test('JSON formatter preserves strings, empty collections and primitives', () => {
  const input = JSON.stringify({ text: '" \\ \n {} [] : ,', empty: {}, list: [] });
  assert.deepEqual(JSON.parse(format(input)), JSON.parse(input));
  assert.equal(format(' [ ] '), '[]');
  assert.equal(format(' {} '), '{}');
  assert.equal(format(' true '), 'true');
  assert.equal(format(' "a  b" '), '"a  b"');
});

test('invalid or excessive JSON never produces a partial replacement', () => {
  for (const input of ['{"x":}', 'not JSON', '{"x":1,}', '[1,2']) assert.throws(() => format(input));
  assert.throws(() => format('['.repeat(129) + '0' + ']'.repeat(129)), /nesting limit/);
  assert.throws(() => format(' '.repeat(2 * 1024 * 1024 + 1)), /input limit/);
});
