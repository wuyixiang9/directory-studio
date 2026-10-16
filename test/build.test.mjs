import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => readFile(path.join(root, file), 'utf8');

test('metadata-only update file and installable payload share authoritative metadata', async () => {
  const source = await read('directory-studio.src.js');
  const end = source.indexOf('// ==/UserScript==') + '// ==/UserScript=='.length;
  const metadata = source.slice(0, end) + '\n';
  const meta = await read('directory-studio.meta.js');
  const payload = await read('directory-studio.user.js');
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(meta, metadata);
  assert.ok(payload.startsWith(metadata));
  assert.ok(meta.includes('// @version      ' + pkg.version + '\n'));
  assert.match(meta, /@namespace\s+local\.directory-studio/);
  assert.match(meta, /@downloadURL\s+https:\/\/raw\.githubusercontent\.com\/wuyixiang9\/directory-studio\/main\/directory-studio\.user\.js/);
  assert.match(meta, /@updateURL\s+https:\/\/raw\.githubusercontent\.com\/wuyixiang9\/directory-studio\/main\/directory-studio\.meta\.js/);
  assert.doesNotMatch(meta, /@require|@connect|GM_xmlhttpRequest/);
  assert.deepEqual([...meta.matchAll(/@grant\s+(\S+)/g)].map(match => match[1]), ['GM_getValue', 'GM_setValue', 'GM_setClipboard']);
});

test('generated payload and maintainable scripts parse without executing browser code', async () => {
  for (const file of ['directory-studio.user.js', 'directory-studio.src.js', 'text-studio.src.js', 'mermaid-studio.src.js']) {
    const source = await read(file);
    assert.doesNotThrow(() => new vm.Script(source, { filename: file }));
  }
});

test('generation matches committed outputs and is deterministic in a temporary copy', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'directory-studio-build-'));
  try {
    for (const file of ['build.mjs', 'directory-studio.src.js', 'text-studio.src.js', 'mermaid-studio.src.js', 'vendor-manifest.json', 'vendor']) await cp(path.join(root, file), path.join(temp, file), { recursive: true });
    execFileSync(process.execPath, ['build.mjs'], { cwd: temp, stdio: 'pipe' });
    const firstUser = await readFile(path.join(temp, 'directory-studio.user.js'));
    const firstMeta = await readFile(path.join(temp, 'directory-studio.meta.js'));
    assert.deepEqual(firstUser, await readFile(path.join(root, 'directory-studio.user.js')));
    assert.deepEqual(firstMeta, await readFile(path.join(root, 'directory-studio.meta.js')));
    execFileSync(process.execPath, ['build.mjs'], { cwd: temp, stdio: 'pipe' });
    assert.deepEqual(await readFile(path.join(temp, 'directory-studio.user.js')), firstUser);
    assert.deepEqual(await readFile(path.join(temp, 'directory-studio.meta.js')), firstMeta);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
