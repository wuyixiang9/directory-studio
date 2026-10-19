import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../directory-studio.src.js', import.meta.url), 'utf8');
const start = source.indexOf('    const modifiedTimeFormatter = ');
const end = source.indexOf('    function readEntries()', start);
const entriesEnd = source.indexOf('    function kind(entry)', end);
assert.ok(start >= 0 && end > start && entriesEnd > end);
const context = vm.createContext({});
new vm.Script(source.slice(start, end)).runInContext(context);
const format = context.formatModifiedTime;

const secondsAt = (year, month, day, hour, minute, second) =>
  new Date(year, month - 1, day, hour, minute, second).getTime() / 1000;

test('directory timestamps use Chinese year-month-day order and 24-hour local time', () => {
  assert.equal(format(secondsAt(2026, 10, 19, 14, 30, 5), '10/19/26, 2:30 PM'), '2026/10/19 14:30:05');
  assert.equal(format(secondsAt(2026, 1, 2, 0, 4, 9), '1/2/26, 12:04 AM'), '2026/01/02 00:04:09');
  assert.equal(format(secondsAt(2026, 1, 2, 12, 0, 0), '1/2/26, 12:00 PM'), '2026/01/02 12:00:00');
});

test('missing or invalid timestamps preserve native text instead of inventing a date', () => {
  for (const seconds of [null, undefined, NaN, Infinity, 1e20]) {
    assert.equal(format(seconds, 'native date'), 'native date');
    assert.equal(format(seconds, ''), '-');
  }
  assert.equal(format(0, ''), '-');
  assert.notEqual(format(0, 'epoch'), 'epoch');
});

test('directory row parsing uses formatted dates without changing sort timestamps', () => {
  const modified = secondsAt(2026, 10, 19, 14, 30, 5);
  const cell = (value, textContent) => ({ getAttribute: () => value, textContent });
  const row = (name, timestamp, text, directory = false) => ({
    querySelector: () => ({
      getAttribute: () => name,
      classList: { contains: () => directory },
      textContent: name
    }),
    cells: [null, cell('128', '128 B'), cell(timestamp, text)]
  });
  let renders = 0;
  const rowsContext = vm.createContext({
    URL,
    native: { body: { rows: [row('file.txt', String(modified), '10/19/26, 2:30 PM'), row('folder/', '0', '', true)] } },
    document: { baseURI: 'file:///C:/fixture/' },
    parseNumber: cell => Number(cell.getAttribute('data-value')),
    render: () => { renders++; }
  });
  new vm.Script('let entries;\n' + source.slice(start, entriesEnd)).runInContext(rowsContext);
  rowsContext.readEntries();
  const entries = vm.runInContext('entries', rowsContext);
  assert.equal(entries[0].dateText, '2026/10/19 14:30:05');
  assert.equal(entries[0].modified, modified);
  assert.equal(entries[1].dateText, '-');
  assert.equal(entries[1].isDirectory, true);
  assert.equal(renders, 1);
});
