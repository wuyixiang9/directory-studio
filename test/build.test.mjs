import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, cp, rm, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => readFile(path.join(root, file), 'utf8');
const publicBase = 'https://raw.githubusercontent.com/wuyixiang9/directory-studio/main/';
const sources = ['directory-studio.src.js', 'core-runtime.src.js', 'directory-model.src.js', 'favorites-store.src.js', 'favorites-menu.src.js', 'image-viewer.src.js', 'text-studio.src.js', 'markdown-preview.src.js', 'mermaid-studio.src.js'];
const resourceTags = metadata => [...metadata.matchAll(/@resource\s+(\S+)\s+([^#\s]+)#sha256=([a-f0-9]{64})/g)];
const copyInputs = async temp => {
  for (const file of ['build.mjs', 'package.json', ...sources, 'vendor-manifest.json', 'vendor']) await cp(path.join(root, file), path.join(temp, file), { recursive: true });
};

test('formal metadata uses public versioned hash-pinned resources and consistent GitHub update entrypoints', async () => {
  const source = await read('directory-studio.src.js');
  const end = source.indexOf('// ==/UserScript==') + '// ==/UserScript=='.length;
  const metadata = source.slice(0, end) + '\n';
  const meta = await read('directory-studio.meta.js');
  const payload = await read('directory-studio.user.js');
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(meta.replace(/^\/\/ @resource[^\n]*\n/gm, ''), metadata);
  assert.ok(payload.startsWith(meta));
  assert.ok(meta.includes('// @version      ' + pkg.version + '\n'));
  assert.equal(pkg.version, '1.5.0');
  assert.match(meta, /@namespace\s+local\.directory-studio/);
  assert.ok(meta.includes('// @downloadURL  ' + publicBase + 'directory-studio.user.js\n'));
  assert.ok(meta.includes('// @updateURL    ' + publicBase + 'directory-studio.meta.js\n'));
  assert.doesNotMatch(meta, /127\.0\.0\.1|localhost|@require|@connect|GM_xmlhttpRequest/);
  assert.deepEqual([...meta.matchAll(/@grant\s+(\S+)/g)].map(match => match[1]), ['GM_getValue', 'GM_setValue', 'GM_setClipboard', 'GM_getResourceText', 'GM.getValue', 'GM.setValue', 'GM_addValueChangeListener', 'GM_removeValueChangeListener']);
  assert.match(meta, /@sandbox\s+DOM/);
  assert.match(meta, /@noframes/);
  assert.doesNotMatch(meta, /GM[._]xml[Hh]ttpRequest|GM[._]deleteValue/);
  const resources = resourceTags(meta);
  assert.deepEqual(resources.map(match => match[1]), ['editor', 'editorCSS', 'markdown', 'mermaid']);
  for (const [, , url] of resources) assert.ok(url.startsWith(publicBase + 'resources/' + pkg.version + '/'));
  assert.ok(Buffer.byteLength(payload) < 180 * 1024, 'core must not embed the heavy libraries');
  assert.doesNotMatch(payload, /function createTextStudioLibraries|function getTextStudioMermaidBundle|function startLoadedTextStudio/);
  assert.match(await read('.gitattributes'), /^resources\/\*\* -text$/m, 'Git must preserve generated SRI bytes verbatim');
});

test('generated core and maintainable browser sources parse without running browser code', async () => {
  for (const file of ['directory-studio.user.js', ...sources]) {
    const source = await read(file);
    assert.doesNotThrow(() => new vm.Script(source, { filename: file }));
  }
});

test('default formal build is reproducible and every public resource matches SRI and retained licenses', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'directory-studio-release-'));
  try {
    await copyInputs(temp);
    const artifactRoot = path.join(temp, 'not-a-release-output');
    const options = { cwd: temp, stdio: 'pipe', env: {
      ...process.env, DIRECTORY_STUDIO_ARTIFACT_ROOT: artifactRoot,
      DIRECTORY_STUDIO_INSTALL_PORT: 'not-used-in-release', DIRECTORY_STUDIO_LOCAL_VERSION: '1.5.0-local.99'
    } };
    execFileSync(process.execPath, ['build.mjs'], options);
    await assert.rejects(access(artifactRoot), { code: 'ENOENT' });
    const firstUser = await readFile(path.join(temp, 'directory-studio.user.js'));
    const firstMeta = await readFile(path.join(temp, 'directory-studio.meta.js'));
    assert.deepEqual(firstUser, await readFile(path.join(root, 'directory-studio.user.js')));
    assert.deepEqual(firstMeta, await readFile(path.join(root, 'directory-studio.meta.js')));
    const snapshots = new Map();
    const vendor = JSON.parse(await read('vendor-manifest.json'));
    const licenses = {
      editor: 'vendor/codemirror-' + vendor.codemirror.version + '/LICENSE',
      markdown: 'vendor/markdown-it-' + vendor.markdownIt.version + '/LICENSE',
      mermaid: 'vendor/mermaid-' + vendor.mermaid.version + '/LICENSE'
    };
    const resources = resourceTags(firstMeta.toString());
    assert.equal(resources.length, 4);
    for (const [, name, url, hash] of resources) {
      const relative = url.slice(publicBase.length);
      const bytes = await readFile(path.join(temp, relative));
      snapshots.set(relative, bytes);
      assert.deepEqual(bytes, await readFile(path.join(root, relative)));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
      if (['editor', 'markdown'].includes(name)) assert.doesNotThrow(() => new Function('environment', bytes.toString()));
      if (licenses[name]) assert.ok(bytes.toString().includes(await read(licenses[name])));
    }
    execFileSync(process.execPath, ['build.mjs'], options);
    assert.deepEqual(await readFile(path.join(temp, 'directory-studio.user.js')), firstUser);
    assert.deepEqual(await readFile(path.join(temp, 'directory-studio.meta.js')), firstMeta);
    for (const [file, bytes] of snapshots) assert.deepEqual(await readFile(path.join(temp, file)), bytes);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('explicit local builds isolate metadata and refuse to overwrite any existing candidate', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'directory-studio-local-'));
  try {
    await copyInputs(temp);
    const baseOptions = { cwd: temp, stdio: 'pipe', env: { ...process.env } };
    execFileSync(process.execPath, ['build.mjs'], baseOptions);
    const releaseUser = await readFile(path.join(temp, 'directory-studio.user.js'));
    const releaseMeta = await readFile(path.join(temp, 'directory-studio.meta.js'));
    const artifactRoot = path.join(temp, 'local-artifacts');
    const prior = path.join(artifactRoot, '1.5.0-local.3');
    await mkdir(prior, { recursive: true });
    await writeFile(path.join(prior, 'directory-studio.user.js'), 'preserved local.3 bytes');
    const options = { ...baseOptions, env: { ...baseOptions.env, DIRECTORY_STUDIO_ARTIFACT_ROOT: artifactRoot, DIRECTORY_STUDIO_LOCAL_VERSION: '1.5.0-local.4', DIRECTORY_STUDIO_INSTALL_PORT: '43819' } };
    execFileSync(process.execPath, ['build.mjs', '--local'], options);
    const manifest = JSON.parse(await readFile(path.join(artifactRoot, 'manifest.json'), 'utf8'));
    assert.equal(manifest.mode, 'local'); assert.equal(manifest.version, '1.5.0-local.4'); assert.equal(manifest.port, 43819);
    const candidate = path.join(artifactRoot, manifest.version);
    const meta = await readFile(path.join(candidate, 'directory-studio.meta.js'), 'utf8');
    assert.match(meta, /@version\s+1\.5\.0-local\.4/);
    assert.doesNotMatch(meta, /@downloadURL|@updateURL/);
    const resources = resourceTags(meta);
    assert.equal(resources.length, 4);
    for (const [, name, url, hash] of resources) {
      assert.ok(url.startsWith('http://127.0.0.1:43819/1.5.0-local.4/'));
      const identity = manifest.resources[name];
      const bytes = await readFile(path.join(candidate, identity.file));
      assert.equal(bytes.length, identity.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), hash); assert.equal(hash, identity.sha256);
      assert.deepEqual(bytes, await readFile(path.join(temp, 'resources/1.5.0', identity.file)));
    }
    const firstLocalUser = await readFile(path.join(candidate, 'directory-studio.user.js'));
    assert.throws(() => execFileSync(process.execPath, ['build.mjs', '--local'], options), /EEXIST/);
    assert.deepEqual(await readFile(path.join(candidate, 'directory-studio.user.js')), firstLocalUser);
    assert.throws(() => execFileSync(process.execPath, ['build.mjs', '--local'], { ...options, env: { ...options.env, DIRECTORY_STUDIO_LOCAL_VERSION: '1.5.0-local.3' } }), /EEXIST/);
    assert.equal(await readFile(path.join(prior, 'directory-studio.user.js'), 'utf8'), 'preserved local.3 bytes');
    assert.deepEqual(await readFile(path.join(temp, 'directory-studio.user.js')), releaseUser);
    assert.deepEqual(await readFile(path.join(temp, 'directory-studio.meta.js')), releaseMeta);
    assert.throws(() => execFileSync(process.execPath, ['build.mjs', '--local'], { ...options, env: { ...options.env, DIRECTORY_STUDIO_LOCAL_VERSION: '' } }), /DIRECTORY_STUDIO_LOCAL_VERSION/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
