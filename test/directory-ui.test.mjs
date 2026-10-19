import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const directory = await readFile(new URL('../directory-studio.src.js', import.meta.url), 'utf8');
const build = await readFile(new URL('../build.mjs', import.meta.url), 'utf8');

test('directory shell has no text quick preview or enhanced type/time filter implementation', () => {
  assert.doesNotMatch(directory, /createStudioReadingPreview|preview-transport|advanced-filters|directoryStudioDateBounds|directoryStudioFamily/i);
  assert.doesNotMatch(directory, /文件快速预览|文件类别与修改日期|起始日期|自定义日期/);
  assert.doesNotMatch(directory, /state\.(?:family|period|from|to|selected)/);
  assert.doesNotMatch(build, /preview-transport|createStudioReadingPreview/);
  for (const retained of ['directoryStudioCreateFavoritesStore', 'directoryStudioContext', '搜索当前目录', "['folders', '文件夹']", "['files', '文件']", "option('name', '名称排序')", "option('modified', '修改时间')", "option('size', '文件大小')", "['list', '列表视图']", "['grid', '网格视图']", 'const pageSize = 160']) assert.ok(directory.includes(retained), retained);
});

test('ordinary file iframes execute no dispatcher, DOM access or capture code', () => {
  let dispatched = 0;
  const context = vm.createContext({
    location: { protocol: 'file:' }, window: { top: {}, self: {} },
    startLocalTextStudio() { dispatched++; throw new Error('iframe must not dispatch'); },
    document: new Proxy({}, { get() { throw new Error('iframe must not inspect DOM'); } })
  });
  new vm.Script(directory).runInContext(context);
  assert.equal(dispatched, 0);
  assert.match(directory, /@noframes/);
});

test('top-level supported text files still enter the full-file editor before directory DOM inspection', () => {
  let dispatched = 0;
  const window = {}; window.top = window; window.self = window;
  const context = vm.createContext({
    location: { protocol: 'file:' }, window,
    startLocalTextStudio() { dispatched++; return true; },
    document: new Proxy({}, { get() { throw new Error('text file must not inspect directory DOM'); } })
  });
  new vm.Script(directory).runInContext(context);
  assert.equal(dispatched, 1);
});

test('abandoned capture transport source and test are removed', async () => {
  await assert.rejects(readFile(new URL('../preview-transport.src.js', import.meta.url)), { code: 'ENOENT' });
  await assert.rejects(readFile(new URL('./preview-transport.test.mjs', import.meta.url)), { code: 'ENOENT' });
});
