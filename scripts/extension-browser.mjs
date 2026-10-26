// Optional real-browser integration suite. Build first; supply Playwright via package or env path.
import { createRequire } from 'node:module';
import { mkdir, writeFile, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const playwrightPackage = process.env.DIRECTORY_STUDIO_PLAYWRIGHT || 'playwright';
const { chromium } = require(playwrightPackage);
const { expect } = require(playwrightPackage + '/test');
const root = fileURLToPath(new URL('../', import.meta.url));
const extension = path.resolve(process.env.DIRECTORY_STUDIO_EXTENSION_ROOT || path.join(root, 'dist/extension'));
const testRoot = path.join(root, '.browser-test');
await mkdir(testRoot, { recursive: true });
const run = await mkdtemp(path.join(testRoot, 'run-'));
const fixture = path.join(run, 'files');
await mkdir(fixture);
await mkdir(path.join(fixture, '空目录'));
await mkdir(path.join(fixture, 'archive.md'));
const markdown =
  '# 中文笔记\n\n[相对文件](./other.txt)\n\n![不加载远程图](https://example.invalid/x.png)\n\n<script>globalThis.pwned=true</script>\n\n```mermaid\nflowchart LR\n A[打开] --> B[编辑]\n```\n\n```markmap\n# 工作台\n## 计划\n- 编写\n- 验证\n```\n';
await writeFile(path.join(fixture, 'notes.md'), markdown);
await writeFile(path.join(fixture, 'other.txt'), 'other text');
await writeFile(path.join(fixture, 'a # 中文%.txt'), '中文与路径');
await writeFile(
  path.join(fixture, 'active.html'),
  '<!doctype html><title>Native HTML</title><p>Native HTML</p>'
);
await writeFile(path.join(fixture, 'bad.txt'), new Uint8Array([0xff, 0xfe, 0x61]));
await writeFile(
  path.join(fixture, 'picture.png'),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlKQAAAAASUVORK5CYII=',
    'base64'
  )
);
for (let index = 0; index < 166; index++)
  await writeFile(path.join(fixture, 'item' + index + '.txt'), 'item ' + index);
const directory = pathToFileURL(fixture + path.sep).href;
const errors = [];
const requests = [];
const checks = [];
const context = await chromium.launchPersistentContext(path.join(run, 'profile'), {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1440, height: 960 },
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]
});
let page;
const check = async (name, callback) => {
  await callback();
  checks.push(name);
  console.log('PASS', name);
};
try {
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;
  function watchPage(target) {
    target.on('pageerror', (error) => errors.push(error.stack || String(error)));
    target.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
  }
  page = await context.newPage();
  watchPage(page);
  context.on('request', (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  const studio = 'chrome-extension://' + id + '/studio.html';
  await page.goto(studio);
  await expect(page.locator('#welcome')).toBeVisible();
  await check('extension loads with native file access', async () =>
    assert.equal(await page.evaluate(() => chrome.extension.isAllowedFileSchemeAccess()), true)
  );
  async function external(href, expected = href) {
    await page.goto(href).catch((error) => {
      if (!/interrupted|ERR_ABORTED/.test(error.message)) throw error;
    });
    await expect.poll(() => page.url(), { timeout: 15000 }).toBe(studio + '#' + encodeURIComponent(expected));
    await expect(page.locator('#loading')).toBeHidden();
  }
  await check('external file directory automatically opens Studio', async () => {
    await external(directory);
    await expect(page.locator('#directory')).toBeVisible();
    await expect(page.locator('.entry')).toHaveCount(160);
  });
  await check('directory reading keeps the previous list painted and unobscured', async () => {
    await page.evaluate((target) => {
      const original = window.fetch;
      window.restoreDirectoryFetch = () => { window.fetch = original; };
      window.directoryReadPending = false;
      window.retainedDirectoryRow = document.querySelector('.entry');
      window.fetch = async (input, options) => {
        if (String(input) === target) {
          window.directoryReadPending = true;
          await new Promise((resolve) => { window.releaseDirectoryRead = resolve; });
        }
        return original(input, options);
      };
    }, new URL(directory + '空目录/').href);
    await page.locator('.entry').filter({ hasText: '空目录' }).click();
    await expect.poll(() => page.evaluate(() => window.directoryReadPending)).toBe(true);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const visible = await page.evaluate(() => {
      const row = window.retainedDirectoryRow;
      const bounds = row.getBoundingClientRect();
      return row.isConnected && document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest('.entry') === row;
    });
    assert.equal(visible, true, 'The loading UI must not cover the old directory rows');
    await expect(page.locator('#loading')).toBeVisible();
    const indicator = await page.locator('#loading').boundingBox();
    const firstRow = await page.locator('.entry').first().boundingBox();
    assert.ok(indicator.y > firstRow.y + firstRow.height, 'Reading indicator belongs below the list');
    await page.evaluate(() => { window.releaseDirectoryRead(); window.restoreDirectoryFetch(); });
    await expect(page.locator('#count')).toHaveText('0 / 0 项');
    await page.locator('#up').click();
    await expect(page.locator('.entry')).toHaveCount(160);
  });
  await check('a newer directory click wins while the previous read is pending', async () => {
    await page.evaluate((target) => {
      const original = window.fetch;
      window.directoryReadPending = false;
      window.restoreDirectoryFetch = () => { window.fetch = original; };
      window.fetch = async (input, options) => {
        if (String(input) === target) {
          window.directoryReadPending = true;
          await new Promise(resolve => { window.releaseDirectoryRead = resolve; });
        }
        return original(input, options);
      };
    }, new URL(directory + '空目录/').href);
    await page.locator('.entry').filter({ hasText: '空目录' }).click();
    await expect.poll(() => page.evaluate(() => window.directoryReadPending)).toBe(true);
    // The retained old list remains usable: choose a different destination without waiting for the first.
    await page.locator('.entry').filter({ hasText: 'archive.md' }).click();
    await expect(page.locator('#path')).toHaveValue(/archive\.md[\\/]$/);
    await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
    await page.evaluate(() => { window.releaseDirectoryRead(); window.restoreDirectoryFetch(); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('#path')).toHaveValue(/archive\.md[\\/]$/);
    await expect(page.locator('#loading')).toBeHidden();
    await page.locator('#up').click();
    await expect(page.locator('.entry')).toHaveCount(160);
  });
  await check('a failed directory read preserves rows and clears the pending indicator', async () => {
    await page.evaluate(target => {
      const original = window.fetch;
      window.restoreDirectoryFetch = () => { window.fetch = original; };
      window.retainedDirectoryRow = document.querySelector('.entry');
      window.fetch = (input, options) => String(input) === target
        ? Promise.reject(Error('测试目录读取失败')) : original(input, options);
    }, new URL(directory + '空目录/').href);
    await page.locator('.entry').filter({ hasText: '空目录' }).click();
    await expect(page.locator('#status')).toHaveText('测试目录读取失败');
    await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
    assert.equal(await page.evaluate(() => document.querySelector('.entry') === window.retainedDirectoryRow), true);
    await page.evaluate(() => { window.restoreDirectoryFetch(); return new Promise(resolve => setTimeout(resolve, 250)); });
    await expect(page.locator('#loading')).toBeHidden();
    await expect(page.locator('#directory')).toBeVisible();
  });
  await check('directory paths without a trailing slash also open Studio', async () => {
    await external(directory.slice(0, -1), directory);
    await expect(page.locator('#directory')).toBeVisible();
  });
  await check('a directory named like a Markdown file is still browsed as a directory', async () => {
    await page.goto(directory + 'archive.md').catch(() => {});
    await expect(page.locator('#directory')).toBeVisible();
    await expect(page.locator('#count')).toHaveText('0 / 0 项');
    await page.locator('#up').click();
    await expect(page.locator('#count')).toContainText('174');
  });
  await page.evaluate(() => (window.documentIdentity = 'same-document'));
  await check('natural ordering, scope filters and grid controls operate on all entries', async () => {
    await page.locator('#search').fill('item');
    assert.deepEqual((await page.locator('.filename').allTextContents()).slice(0,3),['item0.txt','item1.txt','item2.txt']);
    await page.locator('#direction').click();await expect(page.locator('.filename').first()).toHaveText('item165.txt');
    await page.locator('#direction').click();await page.locator('#filter').selectOption('folders');await expect(page.locator('.entry')).toHaveCount(0);
    await page.locator('#search').fill('');await expect(page.locator('.entry')).toHaveCount(2);
    await page.locator('#filter').selectOption('all');await page.locator('#view').click();await expect(page.locator('#entries')).toHaveAttribute('data-view','grid');await page.locator('#view').click();
  });
  await check('pagination covers full directory and empty directories open without reload', async () => {
    await page.locator('#next').click();
    assert.ok((await page.locator('.entry').count()) > 0);
    await page.locator('#previous').click();
    await page.locator('.entry').filter({ hasText: '空目录' }).click();
    await expect(page.locator('#count')).toHaveText('0 / 0 项');
    assert.equal(await page.evaluate(() => window.documentIdentity), 'same-document');
    await page.locator('#up').click();
    await expect(page.locator('#count')).toContainText('174');
  });
  await check('favorites menu opens and labels can be renamed', async () => {
    await page.locator('#favorite').click();
    await expect(page.locator('#favorites .favorite-item')).toHaveCount(1);
    await page.locator('#favorites button').click();
    await expect(page.getByRole('menu')).toBeVisible();
    page.once('dialog', (dialog) => dialog.accept('测试收藏'));
    await page.getByRole('menuitem', { name: '重命名标签' }).click();
    await expect(page.locator('#favorites')).toContainText('测试收藏');
  });
  await check('text editor, Markdown, Mermaid and Markmap run offline under MV3 CSP', async () => {
    await page.locator('#search').fill('notes');
    await page.locator('.entry').click();
    await expect(page.locator('.CodeMirror')).toBeVisible();
    await expect(page.locator('.lts-mermaid-card')).toHaveAttribute('data-state', 'ready', {
      timeout: 20000
    });
    await expect(page.locator('.lts-markmap-card')).toHaveAttribute('data-state', 'ready', {
      timeout: 20000
    });
    await page.locator('.lts-markmap-card').getByRole('button', { name: '全部展开' }).click();
    await expect(page.frameLocator('.lts-markmap-frame').locator('.markmap-node')).toHaveCount(4);
    assert.equal(await page.evaluate(() => window.pwned), undefined);
    assert.equal(await page.evaluate(() => window.documentIdentity), 'same-document');
    assert.deepEqual(requests, []);
  });
  await check('relative Markdown links open internally and history returns to the document',async()=>{
    await page.locator('.lts-preview').getByRole('link',{name:'相对文件',exact:true}).click();await expect(page.locator('.CodeMirror')).toContainText('other text');
    await page.goBack();await expect(page.locator('.CodeMirror')).toContainText('中文笔记');assert.equal(await page.evaluate(()=>window.documentIdentity),'same-document');
    await expect(page.locator('.lts-mermaid-card')).toHaveAttribute('data-state','ready');await expect(page.locator('.lts-markmap-card')).toHaveAttribute('data-state','ready');
  });
  await page.screenshot({ path: path.join(run, 'studio-editor.png'), fullPage: true });
  await check('narrow viewport keeps controls inside the window', async () => {
    await page.setViewportSize({ width: 680, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const button of await page.locator('.lts-toolbar button:visible').all()) {
      const box = await button.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 681);
    }
    await page.screenshot({ path: path.join(run, 'studio-narrow.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 960 });
  });
  await check('theme changes preserve the editor contents', async () => {
    const before = await page.locator('.CodeMirror').evaluate((node) => node.CodeMirror.getValue());
    await page.locator('#theme').click();
    assert.equal(await page.locator('.CodeMirror').evaluate((node) => node.CodeMirror.getValue()), before);
    await expect(page.locator('#local-text-studio')).toHaveAttribute('data-theme', 'dark');
  });
  await check('unsaved edits cancel internal navigation and browser history', async () => {
    await page.locator('.CodeMirror').evaluate((node) => node.CodeMirror.setValue('# unsaved'));
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.locator('#up').click();
    await expect(page.locator('.CodeMirror')).toBeVisible();
    assert.equal(
      await page.locator('.CodeMirror').evaluate((node) => node.CodeMirror.getValue()),
      '# unsaved'
    );
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.goBack().catch(() => {});
    await expect(page.locator('.CodeMirror')).toBeVisible();
    assert.equal(
      await page.locator('.CodeMirror').evaluate((node) => node.CodeMirror.getValue()),
      '# unsaved'
    );
  });
  await check('discard accepted returns to directory and restores prior search', async () => {
    page.once('dialog', (dialog) => dialog.accept());
    await page.goBack().catch(() => {});
    await expect(page.locator('#directory')).toBeVisible();
    await expect(page.locator('#search')).toHaveValue('notes');
    await page.locator('#search').fill('');
  });
  await check('image viewer decodes images and closes in the current document', async () => {
    await page.locator('#search').fill('picture');
    await page.locator('.entry').click();
    await expect(page.getByRole('dialog', { name: '图片查看器' })).toBeVisible();
    await expect
      .poll(() => page.locator('.iv-image').evaluate((image) => image.naturalWidth))
      .toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '图片查看器' })).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.documentIdentity), 'same-document');
  });
  await check('encoded external filename opens correctly', async () => {
    await external(pathToFileURL(path.join(fixture, 'a # 中文%.txt')).href);
    await expect(page.locator('.CodeMirror')).toContainText('中文与路径');
  });
  await check('native open bypass does not redirect in a loop', async () => {
    await page.locator('#native').click();
    await page.waitForURL((url) => url.protocol === 'file:');
    await expect(page.locator('pre')).toContainText('中文与路径');
    await page.reload();
    assert.ok(page.url().startsWith('file:'));
  });
  await check('pause disables external interception and HTML stays native', async () => {
    await page.goto(studio);
    await page.locator('#capture').uncheck();
    await page.goto(directory + 'other.txt');
    await expect(page.locator('pre')).toContainText('other text');
    assert.ok(page.url().startsWith('file:'));
    await page.goto(studio);
    await page.locator('#capture').check();
    await page.goto(directory + 'active.html');
    await expect(page.getByText('Native HTML')).toBeVisible();
    assert.ok(page.url().startsWith('file:'));
  });
  await check('invalid UTF-8 fails visibly without falling into a redirect loop', async () => {
    await external(directory + 'bad.txt');
    await expect(page.locator('#failure')).toBeVisible();
    await expect(page.locator('#failure-detail')).toContainText('UTF-8');
  });
  await check('revoking file URL access restores native behavior and shows setup help', async () => {
    const management = await context.newPage();
    await management.goto('chrome://extensions/');
    await management.evaluate(() =>
      chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })
    );
    const restarted = context.waitForEvent('serviceworker', { predicate: (item) => item.url().includes(id) });
    await management.evaluate(
      (id) => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, fileAccess: false }),
      id
    );
    await restarted;
    page = await context.newPage();
    watchPage(page);
    await page.goto(studio);
    await expect(page.locator('#permission')).toBeVisible();
    await page.goto(directory + 'other.txt');
    await expect(page.locator('pre')).toContainText('other text');
    assert.ok(page.url().startsWith('file:'));
    const enabledAgain = context.waitForEvent('serviceworker', {
      predicate: (item) => item.url().includes(id)
    });
    await management.evaluate(
      (id) => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, fileAccess: true }),
      id
    );
    await enabledAgain;
    await management.close();
  });
  await page.goto(studio);
  // A real browser FileSystemFileHandle from OPFS exercises writable streams and IDB cloning.
  // Only the native picker boundary is replaced; this does not claim an OS picker click test.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('authorized.md', { create: true });
    const stream = await handle.createWritable();
    await stream.write('# authorized\n');
    await stream.close();
    window.testHandle = handle;
    window.showOpenFilePicker = async () => [handle];
  });
  await check('authorized real file handle opens and saves through editor UI', async () => {
    await page.locator('#pick-file').click();
    await expect(page.locator('.CodeMirror')).toBeVisible();
    await expect(page.locator('#path')).toHaveValue(/不提供绝对路径/);
    await page.locator('.CodeMirror').evaluate((node) => node.CodeMirror.setValue('# saved\n'));
    await page.locator('.CodeMirror').click();await page.keyboard.press('Control+s');
    await expect(page.locator('.lts-notice')).toContainText('已保存原文件');
    assert.equal(await page.evaluate(async () => (await window.testHandle.getFile()).text()), '# saved\n');
    await expect(page.locator('.lts-dirty')).toHaveText('未修改');
  });
  await check('download copy leaves the original untouched and does not clear dirty state', async () => {
    await page.locator('.CodeMirror').evaluate((node) => node.CodeMirror.setValue('# downloaded only\n'));
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '下载编辑副本', exact: true }).click()
    ]);
    assert.equal(download.suggestedFilename(), 'authorized.edited.md');
    assert.equal(await readFile(await download.path(), 'utf8'), '# downloaded only\n');
    assert.equal(await page.evaluate(async () => (await window.testHandle.getFile()).text()), '# saved\n');
    await expect(page.locator('.lts-dirty')).toHaveAttribute('data-dirty', 'true');
  });
  await check('save snapshots retain edits made while writable close is pending', async () => {
    await page.evaluate(() => {
      const original = FileSystemFileHandle.prototype.createWritable;
      window.restoreWritable = () => {
        FileSystemFileHandle.prototype.createWritable = original;
      };
      FileSystemFileHandle.prototype.createWritable = async function (...args) {
        const stream = await original.apply(this, args);
        return {
          write: (data) => stream.write(data),
          abort: () => stream.abort(),
          close: async () => {
            await new Promise((resolve) => (window.releaseSave = resolve));
            await stream.close();
          }
        };
      };
    });
    await page.locator('.CodeMirror').evaluate((node) => node.CodeMirror.setValue('# snapshot\n'));
    await page.getByRole('button', { name: '授权后保存原文件 (Ctrl+S)', exact: true }).click();
    await expect.poll(() => page.evaluate(() => typeof window.releaseSave)).toBe('function');
    await page.locator('.CodeMirror').evaluate((node) => node.CodeMirror.setValue('# newer unsaved\n'));
    await page.evaluate(() => {
      window.releaseSave();
      window.restoreWritable();
    });
    await expect(page.locator('.lts-notice')).toContainText('之后的修改仍未保存');
    assert.equal(await page.evaluate(async () => (await window.testHandle.getFile()).text()), '# snapshot\n');
    await expect(page.locator('.lts-dirty')).toHaveAttribute('data-dirty', 'true');
  });
  await check('external disk edits prevent overwrite and preserve the draft', async () => {
    await page.evaluate(async () => {
      const stream = await window.testHandle.createWritable();
      await stream.write('# external change\n');
      await stream.close();
    });
    await page.getByRole('button', { name: '授权后保存原文件 (Ctrl+S)', exact: true }).click();
    await expect(page.locator('.lts-notice')).toContainText('磁盘文件已被其他程序修改');
    assert.equal(
      await page.evaluate(async () => (await window.testHandle.getFile()).text()),
      '# external change\n'
    );
    await expect(page.locator('.lts-dirty')).toHaveAttribute('data-dirty', 'true');
    await page.locator('.CodeMirror').evaluate((node) => node.CodeMirror.setValue('# snapshot\n'));
  });
  await check('browser cold start with a file argument opens Studio', async () => {
    const profile = path.join(run, 'cold-profile');
    await mkdir(profile);
    const process_ = spawn(
      chromium.executablePath(),
      [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--remote-debugging-port=0',
        '--user-data-dir=' + profile,
        '--disable-extensions-except=' + extension,
        '--load-extension=' + extension,
        directory + 'other.txt'
      ],
      { windowsHide: true, stdio: 'ignore' }
    );
    let cold;
    try {
      let port;
      await expect
        .poll(
          async () => {
            try {
              port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
              return Boolean(port);
            } catch {
              return false;
            }
          },
          { timeout: 15000 }
        )
        .toBe(true);
      cold = await chromium.connectOverCDP('http://127.0.0.1:' + port);
      const pages = () => cold.contexts()[0].pages();
      await expect
        .poll(
          () =>
            pages().some((tab) => tab.url() === studio + '#' + encodeURIComponent(directory + 'other.txt')),
          { timeout: 15000 }
        )
        .toBe(true);
      const tab = pages().find((tab) => tab.url().startsWith(studio));
      await expect(tab.locator('.CodeMirror')).toContainText('other text');
    } finally {
      await cold?.close();
      process_.kill();
    }
  });
  console.log('BROWSER_ERRORS', JSON.stringify(errors));
  assert.deepEqual(errors, []);
  const report = {
    browser: context.browser().version(),
    checks,
    errors,
    networkRequests: requests,
    fixture: directory,
    screenshot: path.join(run, 'studio-editor.png')
  };
  await writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
  console.log('REPORT', path.join(run, 'report.json'));
} catch (error) {
  if (page) {
    console.log('URL', page.url());
    console.log(
      'BODY',
      (
        await page
          .locator('body')
          .innerText()
          .catch(() => '')
      ).slice(0, 5000)
    );
    console.log('ERRORS', JSON.stringify(errors));
    await page.screenshot({ path: path.join(run, 'failure.png'), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  await context.close();
}
