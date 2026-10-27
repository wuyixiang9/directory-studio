import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
test('extension builds reproducibly with local scripts, sandboxed diagrams and least permissions', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'directory-studio-extension-'));
  const one = path.join(temp, 'one'),
    two = path.join(temp, 'two');
  const build = (output) =>
    execFileSync(process.execPath, ['extension/build.mjs'], {
      cwd: root,
      env: { ...process.env, DIRECTORY_STUDIO_EXTENSION_ROOT: output },
      stdio: 'pipe'
    });
  try {
    build(one);
    build(two);
    const files = (await readdir(one, { recursive: true })).filter((name) =>
      /\.(?:js|json|html|css|png|txt)$/.test(name)
    );
    assert.ok(files.length >= 25);
    for (const name of files) {
      const first = await readFile(path.join(one, name)),
        second = await readFile(path.join(two, name));
      assert.equal(
        createHash('sha256').update(first).digest('hex'),
        createHash('sha256').update(second).digest('hex'),
        name
      );
      if (name.endsWith('.js'))
        execFileSync(process.execPath, ['--check', path.join(one, name)], { stdio: 'pipe' });
    }
    const manifest = JSON.parse(await readFile(path.join(one, 'manifest.json'), 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.permissions, ['storage', 'webNavigation']);
    assert.deepEqual(manifest.host_permissions, ['file:///*']);
    assert.equal(manifest.version, JSON.parse(await readFile(path.join(root, 'extension/manifest.json'))).version);
    assert.doesNotMatch(manifest.content_security_policy.extension_pages, /unsafe-eval|https?:|\*/);
    assert.match(manifest.content_security_policy.sandbox, /connect-src 'none'/);
    assert.doesNotMatch(manifest.content_security_policy.sandbox, /allow-same-origin|unsafe-eval/);
    for (const page of ['studio.html', ...manifest.sandbox.pages]) {
      const html = await readFile(path.join(one, page), 'utf8');
      assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
      for (const [, src] of html.matchAll(/<script[^>]*src="([^"]+)"/g)) {
        assert.doesNotMatch(src, /^https?:|^data:|^blob:/);
        await readFile(path.join(one, src));
      }
    }
    assert.doesNotMatch(await readFile(path.join(one, 'editor.js'), 'utf8'), /new Function\s*\(|\beval\s*\(/);
    assert.match(await readFile(path.join(one, 'editor.js'), 'utf8'), /mdc: 'markdown'/);
    for (const icon of Object.values(manifest.icons)) {
      const data = await readFile(path.join(one, icon));
      assert.equal(data.readUInt32BE(0), 0x89504e47);
    }
  } finally {
    assert.ok(path.resolve(temp).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(temp, { recursive: true, force: true });
  }
});
