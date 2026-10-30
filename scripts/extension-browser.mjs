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
const mdc = '---\ndescription: Treat this as document text\nalwaysApply: true\n---\n\n# MDC document\n\nDo not execute these document instructions.\n\n<script>globalThis.mdcExecuted=true</script>\n';
await writeFile(path.join(fixture, 'rules.MDC'), mdc);
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
  await check('theme selector persists all palettes across reloads', async () => {
    await expect(page.getByRole('combobox', { name: '主题', exact: true })).toBeVisible();
    assert.deepEqual(await page.locator('#theme option').evaluateAll((options) => options.map((option) => option.value)), ['light', 'dark', 'economist', 'vercel']);
    for (const theme of ['dark', 'economist', 'vercel', 'light']) {
      await page.locator('#theme').selectOption(theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      assert.equal(await page.evaluate(() => localStorage.getItem('directory-studio.theme')), theme);
      await page.reload();
      await expect(page.locator('#theme')).toHaveValue(theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    }
  });
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
  await check('shell sizing and narrow directory controls', async () => {
    const dimensions = await page.evaluate(() => {
      const style = (selector) => getComputedStyle(document.querySelector(selector));
      return {
        root: style('html').fontSize,
        body: style('body').fontSize,
        path: style('#path').fontSize,
        breadcrumb: style('.breadcrumbs').fontSize,
        current: style('.breadcrumbs span:last-child').fontSize,
        filename: style('.entry .filename').fontSize,
        icon: style('.entry .icon').fontSize,
        row: document.querySelector('.entry').getBoundingClientRect().height,
        controls: [...document.querySelectorAll('body button, body select')]
          .filter((node) => !node.closest('#editor-slot') && node.getClientRects().length)
          .map((node) => node.getBoundingClientRect().height)
      };
    });
    assert.equal(dimensions.root, '13px');
    assert.equal(dimensions.body, '13px');
    assert.equal(dimensions.path, '13px');
    assert.equal(dimensions.breadcrumb, '14px');
    assert.equal(dimensions.current, '19px');
    assert.equal(dimensions.filename, '13px');
    assert.equal(dimensions.icon, '20px');
    assert.equal(dimensions.row, 52);
    assert.ok(dimensions.controls.every((height) => height >= 36));
    await page.setViewportSize({ width: 320, height: 900 });
    const overflow = await page.evaluate(() => {
      const selectors = '.topbar button, .topbar select, .topbar label, .pathbar button, .pathbar input, .directory-tools input, .directory-tools select, .directory-tools button, .pagination button';
      return [...document.querySelectorAll(selectors)].filter((node) => {
        if (!node.getClientRects().length) return false;
        const rect = node.getBoundingClientRect();
        return rect.left < 0 || rect.right > innerWidth + 1;
      }).map((node) => node.outerHTML);
    });
    assert.deepEqual(overflow, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.setViewportSize({ width: 1440, height: 960 });
  });
  await check('sidebar keyboard toggle releases space and remembers desktop and narrow choices separately', async () => {
    const toggle = page.locator('#toggle-sidebar');
    await expect(toggle).toHaveAttribute('aria-controls', 'sidebar');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#sidebar')).toBeVisible();
    const expandedWidth = (await page.locator('#main').boundingBox()).width;
    await page.screenshot({ path: path.join(run, 'studio-desktop-expanded.png'), fullPage: true });
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#sidebar')).toBeHidden();
    assert.ok((await page.locator('#main').boundingBox()).width > expandedWidth + 150);
    await page.screenshot({ path: path.join(run, 'studio-desktop-collapsed.png'), fullPage: true });
    await page.reload();
    await expect(page.locator('#directory')).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await page.setViewportSize({ width: 320, height: 900 });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const sidebar = await page.locator('#sidebar').boundingBox();
    const main = await page.locator('#main').boundingBox();
    assert.ok(main.y >= sidebar.y + sidebar.height - 1, 'Narrow sidebar must not cover the directory');
    assert.ok(main.height > 100);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(run, 'studio-directory-narrow-expanded.png'), fullPage: true });
    await page.reload();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.setViewportSize({ width: 1440, height: 960 });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await page.setViewportSize({ width: 320, height: 900 });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(page.locator('#sidebar')).toBeHidden();
    await page.screenshot({ path: path.join(run, 'studio-directory-narrow-collapsed.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 960 });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
  await check('all shell palettes match without gradients, resizing or lost interaction states', async () => {
    let baseline;
    for (const theme of ['light', 'dark', 'economist', 'vercel']) {
      await page.locator('#theme').selectOption(theme);
      const dimensions = await page.locator('.topbar, .pathbar, #theme, .entry').evaluateAll((nodes) => nodes.map((node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      }));
      baseline ??= dimensions;
      assert.deepEqual(dimensions, baseline);
      const colors = await page.evaluate(() => {
        const selectors = ['.topbar', '.pathbar', '#sidebar', '#main', '.list-heading', '.app-status'];
        return {
          surfaces: selectors.map((selector) => {
            const style = getComputedStyle(document.querySelector(selector));
            return [style.backgroundColor, style.backgroundImage];
          }),
          text: getComputedStyle(document.body).color,
          wash: getComputedStyle(document.documentElement).getPropertyValue('--wash').trim(),
          blue: getComputedStyle(document.documentElement).getPropertyValue('--blue').trim()
        };
      });
      assert.equal(new Set(colors.surfaces.map(([color]) => color)).size, 1);
      assert.ok(colors.surfaces.every(([, image]) => image === 'none'));
      assert.notEqual(colors.text, colors.surfaces[0][0]);
      await page.locator('.entry').first().hover();
      const hover = await page.locator('.entry').first().evaluate((node) => getComputedStyle(node).backgroundColor);
      assert.notEqual(hover, colors.surfaces[0][0]);
      await page.locator('#up').focus();
      await page.keyboard.press('Shift+Tab');
      await expect(page.locator('#toggle-sidebar')).toBeFocused();
      const focus = await page.locator('#toggle-sidebar').evaluate((node) => getComputedStyle(node).outlineStyle);
      assert.equal(focus, 'solid');
      await page.screenshot({ path: path.join(run, 'studio-directory-' + theme + '.png'), fullPage: true });
    }
    await page.locator('#theme').selectOption('light');
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
  await check('a failed document read from a directory keeps the original shell status nodes usable', async () => {
    await page.evaluate(target => {
      const original = window.fetch;
      window.restoreStatusFetch = () => { window.fetch = original; };
      window.directoryStatusIdentity = document.getElementById('status');
      window.directoryLoadingIdentity = document.getElementById('loading');
      window.fetch = (input, options) => String(input) === target
        ? Promise.reject(Error('测试文档读取失败')) : original(input, options);
    }, directory + 'notes.md');
    await page.locator('#search').fill('notes');
    await page.locator('.entry').click();
    await expect(page.locator('#app-status #status')).toHaveText('测试文档读取失败');
    await expect(page.locator('#app-status #status')).toBeVisible();
    await expect(page.locator('#directory')).toBeVisible();
    await expect(page.locator('#app-status .editor-status')).toHaveCount(0);
    await expect(page.locator('#loading')).toBeHidden();
    assert.equal(await page.evaluate(() =>
      document.getElementById('status') === window.directoryStatusIdentity &&
      document.getElementById('loading') === window.directoryLoadingIdentity), true);
    await page.evaluate(() => window.restoreStatusFetch());
    await page.locator('#search').fill('');
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
    await expect(page.locator('#count')).toContainText('175');
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
    await expect(page.locator('#count')).toContainText('175');
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
  await check('clean Markdown uses one concise status region without permanent save instructions', async () => {
    await expect(page.locator('#app-status .lts-dirty')).toHaveText('未修改');
    await expect(page.locator('#app-status .lts-cursor')).toContainText('行 1，列 1');
    await expect(page.locator('#app-status .lts-encoding')).toHaveText('UTF-8');
    await expect(page.locator('#app-status #status')).toBeEmpty();
    await expect(page.locator('#app-status .lts-notice')).toBeEmpty();
    await expect(page.locator('#editor-slot .lts-status')).toBeHidden();
    await expect(page.locator('#app-status .editor-status')).toHaveCount(1);
    const geometry = await page.locator('#app-status').evaluate((footer) => {
      const labels = [...footer.querySelectorAll('.lts-dirty, .lts-cursor, .lts-encoding')];
      return { height: footer.getBoundingClientRect().height, tops: labels.map(node => node.getBoundingClientRect().top) };
    });
    assert.ok(geometry.height <= 30);
    assert.ok(Math.max(...geometry.tops) - Math.min(...geometry.tops) <= 1);
    await page.evaluate(() => {
      window.statusIdentity = document.getElementById('status');
      window.loadingIdentity = document.getElementById('loading');
    });
    await page.screenshot({ path: path.join(run, 'studio-status-clean.png'), fullPage: true });
  });
  await check('Markdown page fullscreen preserves every layout and live diagram DOM', async () => {
    const enter = page.getByRole('button', { name: '全屏预览', exact: true });
    const exit = page.getByRole('button', { name: '退出全屏预览 (Esc)', exact: true });
    await page.evaluate(() => {
      window.fullscreenEditor = document.querySelector('.CodeMirror');
      window.fullscreenDiagram = document.querySelector('.lts-markmap-frame');
      window.fullscreenHeading = document.querySelector('.lts-preview h1');
    });
    for (const layout of ['split', 'preview', 'edit']) {
      const label = { split: '分栏', preview: '预览', edit: '编辑' }[layout];
      await page.getByRole('button', { name: label, exact: true }).click();
      await enter.click();
      await expect(page.locator('body')).toHaveAttribute('data-preview-fullscreen', 'true');
      await expect(page.locator('.lts-panes')).toHaveAttribute('data-layout', 'preview');
      await expect(exit).toBeFocused();
      for (const selector of ['.topbar', '#path-form', '#sidebar', '#breadcrumbs', '#app-status', '.lts-toolbar', '.CodeMirror']) {
        await expect(page.locator(selector)).toBeHidden();
      }
      const geometry = await page.locator('.lts-preview').boundingBox();
      assert.ok(geometry.x <= 1 && geometry.y <= 1 && geometry.width >= 1439 && geometry.height >= 959);
      assert.equal(await page.evaluate(() => document.fullscreenElement), null);
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('.topbar, #path-form, #sidebar, #breadcrumbs, #app-status, .lts-toolbar, .lts-editor')].every(node => node.inert)), true);
      for (let index = 0; index < 8; index++) {
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => !!document.activeElement.closest('.topbar, #path-form, #sidebar, #breadcrumbs, #app-status, .lts-toolbar, .lts-editor')), false);
      }
      // Includes Escape while keyboard focus is inside the sandboxed interactive diagram.
      if (layout === 'preview') {
        await page.frameLocator('.lts-markmap-frame').locator('svg').click({ position: { x: 5, y: 5 } });
        await page.keyboard.press('Escape');
      } else {
        await exit.click();
      }
      await expect(page.locator('body')).not.toHaveAttribute('data-preview-fullscreen', 'true');
      await expect(page.locator('.lts-panes')).toHaveAttribute('data-layout', layout);
      await expect(enter).toBeFocused();
      await expect(page.locator('.topbar')).toBeVisible();
      assert.equal(await page.evaluate(() =>
        document.querySelector('.CodeMirror') === window.fullscreenEditor &&
        document.querySelector('.lts-markmap-frame') === window.fullscreenDiagram &&
        document.querySelector('.lts-preview h1') === window.fullscreenHeading), true);
    }
    await page.getByRole('button', { name: '分栏', exact: true }).click();
    await expect(page.frameLocator('.lts-markmap-frame').locator('.markmap-node')).toHaveCount(4);
  });
  await check('fullscreen preserves unsaved edits, history, theme and scroll without mounting another editor', async () => {
    await page.evaluate(() => {
      const cm = document.querySelector('.CodeMirror').CodeMirror;
      window.fullscreenBeforeText = cm.getValue();
      cm.replaceRange('\n\n' + 'Fullscreen draft paragraph.\n\n'.repeat(100), { line: cm.lastLine(), ch: cm.getLine(cm.lastLine()).length }, undefined, '+input');
    });
    await expect(page.locator('.lts-preview')).toContainText('Fullscreen draft paragraph.');
    await expect(page.locator('.lts-markmap-card')).toHaveAttribute('data-state', 'ready');
    await page.evaluate(() => {
      const cm = document.querySelector('.CodeMirror').CodeMirror;
      const preview = document.querySelector('.lts-preview');
      preview.scrollTop = 150;
      window.fullscreenDraft = {
        text: cm.getValue(), history: JSON.stringify(cm.getHistory()),
        theme: document.querySelector('#local-text-studio').dataset.theme,
        scroll: preview.scrollTop, heading: preview.firstElementChild
      };
    });
    await page.getByRole('button', { name: '全屏预览', exact: true }).click();
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => {
      const cm = document.querySelector('.CodeMirror').CodeMirror;
      const preview = document.querySelector('.lts-preview');
      const draft = window.fullscreenDraft;
      return cm.getValue() === draft.text && JSON.stringify(cm.getHistory()) === draft.history &&
        document.querySelector('#local-text-studio').dataset.theme === draft.theme &&
        preview.firstElementChild === draft.heading && Math.abs(preview.scrollTop - draft.scroll) <= 1;
    }), true);
    await expect(page.locator('#app-status .lts-dirty')).toHaveAttribute('data-dirty', 'true');
    await page.getByRole('button', { name: '全屏预览', exact: true }).click();
    await page.keyboard.press('Control+f');
    await expect(page.locator('.lts-search input')).toBeFocused();
    await expect(page.locator('.lts-toolbar')).toBeVisible();
    await expect(page.locator('.lts-panes')).toHaveAttribute('data-layout', 'split');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.equal(await page.locator('.CodeMirror').evaluate(node => node.CodeMirror.getValue() === window.fullscreenBeforeText), true);
    await expect(page.locator('#app-status .lts-dirty')).toHaveAttribute('data-dirty', 'false');
    await expect(page.locator('.lts-preview')).not.toContainText('Fullscreen draft paragraph.');
    await expect(page.locator('.lts-markmap-card')).toHaveAttribute('data-state', 'ready');
  });
  await check('fullscreen fits a 320px viewport and restores the narrow shell', async () => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.getByRole('button', { name: '全屏预览', exact: true }).click();
    const box = await page.getByRole('button', { name: '退出全屏预览 (Esc)', exact: true }).boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 320 && box.y >= 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(run, 'studio-markdown-fullscreen-narrow.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await expect(page.locator('#path-form')).toBeVisible();
    await expect(page.locator('.lts-toolbar')).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 960 });
  });
  await check('shell size reduction leaves editor and preview computed sizing unchanged', async () => {
    const sizes = await page.evaluate(() => {
      const selectors = ['#local-text-studio', '.CodeMirror', '.lts-toolbar button',
        '.lts-preview', '.lts-preview h1', '.lts-preview p', '.lts-mermaid-card',
        '.lts-markmap-card', '.lts-markmap-frame'];
      const properties = ['fontSize', 'lineHeight', 'minHeight', 'paddingTop', 'paddingRight',
        'paddingBottom', 'paddingLeft', 'transform', 'zoom'];
      const snapshot = () => selectors.map((selector) => {
        const node = document.querySelector(selector);
        if (!node) throw new Error('Missing editor fixture: ' + selector);
        const style = getComputedStyle(node);
        return Object.fromEntries(properties.map((property) => [property, style[property]]));
      });
      const current = snapshot();
      const previous = document.documentElement.style.fontSize;
      document.documentElement.style.fontSize = '14px';
      const baseline = snapshot();
      document.documentElement.style.fontSize = previous;
      return { current, baseline };
    });
    assert.deepEqual(sizes.current, sizes.baseline);
    assert.equal(sizes.current[0].fontSize, '13px');
    assert.equal(sizes.current[1].fontSize, '13px');
  });
  await check('cancelled save authorization reports inline then returns to concise reading status', async () => {
    await page.evaluate(() => {
      const original = window.showOpenFilePicker;
      window.restoreStatusPicker = () => { window.showOpenFilePicker = original; };
      window.showOpenFilePicker = async () => { throw new DOMException('Cancelled', 'AbortError'); };
    });
    await page.getByRole('button', { name: '授权后保存原文件 (Ctrl+S)', exact: true }).click();
    await expect(page.locator('#app-status .lts-notice')).toContainText('已取消授权，编辑内容保留');
    await expect(page.locator('#app-status .lts-notice')).toBeVisible();
    await expect(page.locator('#app-status .lts-dirty')).toHaveAttribute('data-dirty', 'false');
    await expect(page.getByRole('button', { name: '授权后保存原文件 (Ctrl+S)', exact: true })).toBeEnabled();
    await page.evaluate(() => window.restoreStatusPicker());
    await expect(page.locator('#app-status .lts-notice')).toBeEmpty({ timeout: 7000 });
  });
  await check('retained editor shows slow reads and failures in its single status region at 320px', async () => {
    const message = '读取失败；原编辑内容保留。 ' + 'unavailable-path-'.repeat(8);
    await page.evaluate(({ target, message }) => {
      const original = window.fetch;
      window.restoreStatusFetch = () => { window.fetch = original; };
      window.retainedStatusEditor = document.querySelector('.CodeMirror');
      window.fetch = (input, options) => String(input) === target
        ? new Promise((_, reject) => { window.failStatusRead = () => reject(Error(message)); })
        : original(input, options);
    }, { target: directory, message });
    await page.locator('#up').click();
    await expect(page.locator('#app-status #loading')).toBeVisible();
    await expect(page.locator('#app-status .lts-dirty')).toBeVisible();
    await expect(page.locator('#app-status .editor-status')).toHaveCount(1);
    await page.evaluate(() => { window.failStatusRead(); window.restoreStatusFetch(); });
    await expect(page.locator('#app-status #status')).toHaveText(message);
    await expect(page.locator('#app-status #loading')).toBeHidden();
    await expect(page.locator('#main')).toHaveAttribute('aria-busy', 'false');
    assert.equal(await page.evaluate(() => document.querySelector('.CodeMirror') === window.retainedStatusEditor), true);
    await page.setViewportSize({ width: 320, height: 900 });
    const layout = await page.locator('#app-status').evaluate((footer) => {
      const error = footer.querySelector('#status');
      const bounds = error.getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        inside: bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
        unclipped: error.scrollHeight <= error.clientHeight + 1,
        whitespace: getComputedStyle(error).whiteSpace
      };
    });
    assert.equal(layout.overflow, false);
    assert.equal(layout.inside, true);
    assert.equal(layout.unclipped, true);
    assert.equal(layout.whitespace, 'normal');
    await page.screenshot({ path: path.join(run, 'studio-status-narrow-error.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 960 });
  });
  await check('original-text lifecycle keeps shell errors visible and returns the same borrowed status labels', async () => {
    // The extension hides this legacy control; exercise its lifecycle without exposing a new UI action.
    await page.evaluate(() => [...document.querySelectorAll('#local-text-studio button')]
      .find(button => button.textContent === '原始文本').click());
    await expect(page.locator('#local-text-studio')).toHaveAttribute('data-original', 'true');
    await expect(page.locator('#app-status #status')).toContainText('读取失败');
    await expect(page.locator('#app-status #status')).toBeVisible();
    await expect(page.locator('#app-status .lts-dirty')).toBeVisible();
    await page.getByRole('button', { name: '返回编辑器', exact: true }).click();
    await expect(page.locator('.CodeMirror')).toBeVisible();
    await expect(page.locator('#app-status .editor-status')).toHaveCount(1);
    assert.equal(await page.evaluate(() =>
      document.getElementById('status') === window.statusIdentity &&
      document.getElementById('loading') === window.loadingIdentity), true);
    // Failed navigation retained a duplicate history entry; return to the original document entry.
    await page.goBack();
    await expect(page.locator('.CodeMirror')).toContainText('中文笔记');
    await expect(page.locator('#app-status #status')).toBeEmpty();
  });
  await check('relative Markdown links open internally and history returns to the document',async()=>{
    await page.getByRole('button', { name: '全屏预览', exact: true }).click();
    await page.locator('.lts-preview').getByRole('link',{name:'相对文件',exact:true}).click();await expect(page.locator('.CodeMirror')).toContainText('other text');
    await expect(page.locator('body')).not.toHaveAttribute('data-preview-fullscreen', 'true');
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(page.getByRole('button', { name: '全屏预览', exact: true })).toHaveCount(0);
    assert.equal(await page.locator('.topbar').evaluate(node => node.inert), false);
    await expect(page.locator('#app-status .lts-encoding')).toHaveText('UTF-8');
    await expect(page.locator('#app-status #status')).toBeEmpty();
    await expect(page.locator('#app-status .editor-status')).toHaveCount(1);
    await page.goBack();await expect(page.locator('.CodeMirror')).toContainText('中文笔记');assert.equal(await page.evaluate(()=>window.documentIdentity),'same-document');
    await expect(page.locator('.lts-mermaid-card')).toHaveAttribute('data-state','ready');await expect(page.locator('.lts-markmap-card')).toHaveAttribute('data-state','ready');
    await expect(page.locator('#app-status #status')).toBeEmpty();
    await expect(page.locator('#app-status .lts-dirty')).toHaveAttribute('data-dirty', 'false');
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
    for (const theme of ['economist', 'vercel', 'light', 'dark']) {
      await page.locator('#theme').selectOption(theme);
      assert.equal(await page.locator('.CodeMirror').evaluate((node) => node.CodeMirror.getValue()), before);
      await expect(page.locator('#local-text-studio')).toHaveAttribute('data-theme', theme);
      if (theme === 'vercel') {
        assert.equal(await page.locator('.CodeMirror').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)');
        assert.equal(await page.locator('.lts-preview').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(250, 250, 250)');
        await expect(page.locator('.lts-mermaid-card')).toHaveAttribute('data-state', 'ready');
        await expect(page.locator('.lts-markmap-card')).toHaveAttribute('data-state', 'ready');
        await page.screenshot({ path: path.join(run, 'studio-editor-vercel.png'), fullPage: true });
      }
      if (theme === 'economist') {
        assert.equal(await page.locator('.CodeMirror').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(246, 243, 237)');
        assert.equal(await page.locator('.lts-preview').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(255, 253, 248)');
        await expect(page.locator('.lts-mermaid-card')).toHaveAttribute('data-state', 'ready');
        await expect(page.locator('.lts-markmap-card')).toHaveAttribute('data-state', 'ready');
        await page.screenshot({ path: path.join(run, 'studio-editor-economist.png'), fullPage: true });
        await page.locator('.lts-preview').getByRole('link', { name: '相对文件', exact: true }).click();
        await expect(page.locator('.CodeMirror')).toContainText('other text');
        await expect(page.locator('#local-text-studio')).toHaveAttribute('data-theme', 'economist');
        await page.goBack();
        await expect(page.locator('.CodeMirror')).toContainText('中文笔记');
        await expect(page.locator('#local-text-studio')).toHaveAttribute('data-theme', 'economist');
        assert.equal(await page.locator('.CodeMirror').evaluate((node) => node.CodeMirror.getValue()), before);
      }
    }
  });
  await page.screenshot({ path: path.join(run, 'studio-editor-dark.png'), fullPage: true });
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
    await expect(page.locator('#app-status .editor-status')).toHaveCount(1);
    await expect(page.locator('#app-status .lts-dirty')).toHaveAttribute('data-dirty', 'true');
  });
  await check('discard accepted returns to directory and restores prior search', async () => {
    page.once('dialog', (dialog) => dialog.accept());
    await page.goBack().catch(() => {});
    await expect(page.locator('#directory')).toBeVisible();
    await expect(page.locator('#search')).toHaveValue('notes');
    await page.locator('#search').fill('');
    await expect(page.locator('#app-status .editor-status')).toHaveCount(0);
    await expect(page.locator('#app-status #status')).toContainText('本地目录');
    await expect(page.locator('#app-status #status')).toBeVisible();
    assert.equal(await page.evaluate(() =>
      document.getElementById('status') === window.statusIdentity &&
      document.getElementById('loading') === window.loadingIdentity), true);
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
  await check('MDC opens internally and externally as Markdown without executing document text', async () => {
    await page.locator('#search').fill('rules');
    await page.locator('.entry').click();
    await expect(page.locator('.CodeMirror')).toContainText('alwaysApply: true');
    await expect(page.locator('.lts-preview h1')).toHaveText('MDC document');
    await expect(page.locator('.lts-preview')).toContainText('Do not execute these document instructions.');
    await expect(page.locator('.lts-preview script')).toHaveCount(0);
    assert.equal(await page.evaluate(() => globalThis.mdcExecuted), undefined);
    assert.equal(await page.evaluate(() => window.documentIdentity), 'same-document');
    await page.screenshot({ path: path.join(run, 'studio-mdc-dark.png'), fullPage: true });
    await external(directory + 'rules.MDC');
    await expect(page.locator('.lts-preview h1')).toHaveText('MDC document');
    await page.locator('#theme').selectOption('light');
    await page.screenshot({ path: path.join(run, 'studio-mdc-light.png'), fullPage: true });
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
    const handle = await root.getFileHandle('authorized.MDC', { create: true });
    const stream = await handle.createWritable();
    await stream.write('---\nalwaysApply: true\n---\n\n# authorized\n');
    await stream.close();
    window.testHandle = handle;
    window.showOpenFilePicker = async () => [handle];
  });
  await check('authorized real file handle opens and saves through editor UI', async () => {
    await page.locator('#pick-file').click();
    await expect(page.locator('.CodeMirror')).toBeVisible();
    await expect(page.locator('#path')).toHaveValue(/不提供绝对路径/);
    await expect(page.locator('.lts-preview h1')).toHaveText('authorized');
    await expect(page.locator('.lts-preview')).toContainText('alwaysApply: true');
    await page.screenshot({ path: path.join(run, 'studio-picked-mdc.png'), fullPage: true });
    await page.locator('.CodeMirror').evaluate((node) => node.CodeMirror.setValue('# saved\n'));
    await page.locator('.CodeMirror').click();await page.keyboard.press('Control+s');
    await expect(page.locator('.lts-notice')).toContainText('已保存原文件');
    await expect(page.locator('#app-status .lts-notice')).toBeVisible();
    await expect(page.locator('#app-status .lts-notice')).toContainText('已保存原文件');
    assert.equal(await page.evaluate(async () => (await window.testHandle.getFile()).text()), '# saved\n');
    await expect(page.locator('.lts-dirty')).toHaveText('未修改');
  });
  await check('download copy leaves the original untouched and does not clear dirty state', async () => {
    await page.locator('.CodeMirror').evaluate((node) => node.CodeMirror.setValue('# downloaded only\n'));
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '下载编辑副本', exact: true }).click()
    ]);
    assert.equal(download.suggestedFilename(), 'authorized.edited.MDC');
    assert.equal(await readFile(await download.path(), 'utf8'), '# downloaded only\n');
    assert.equal(await page.evaluate(async () => (await window.testHandle.getFile()).text()), '# saved\n');
    await expect(page.locator('.lts-dirty')).toHaveAttribute('data-dirty', 'true');
    await expect(page.locator('#app-status .lts-notice')).toContainText('原文件未改动');
    await expect(page.locator('#app-status .lts-notice')).toBeVisible();
    await page.screenshot({ path: path.join(run, 'studio-status-download.png'), fullPage: true });
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
    await expect(page.locator('#app-status .lts-notice')).toBeVisible();
    await page.setViewportSize({ width: 320, height: 900 });
    const errorFits = await page.locator('#app-status .lts-notice').evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth && node.scrollHeight <= node.clientHeight + 1;
    });
    assert.equal(errorFits, true);
    await page.screenshot({ path: path.join(run, 'studio-status-save-error.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 960 });
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
  await check('recent external files persist and internal opens never populate or reorder them', async () => {
    const recentPage = await context.newPage();
    const peer = await context.newPage();
    watchPage(recentPage);
    watchPage(peer);
    const textURL = directory + 'other.txt';
    const imageURL = new URL(encodeURIComponent('空目录') + '/recent-picture.png', directory).href;
    await writeFile(path.join(fixture, '空目录', 'recent-picture.png'), await readFile(path.join(fixture, 'picture.png')));
    const stored = () => recentPage.evaluate(async () => (await chrome.storage.local.get('recentExternalFiles')).recentExternalFiles || []);
    const capture = async (href) => {
      await recentPage.goto(href).catch((error) => {
        if (!/interrupted|ERR_ABORTED/.test(error.message)) throw error;
      });
      await expect.poll(() => recentPage.url()).toBe(studio + '#' + encodeURIComponent(href));
      await expect(recentPage.locator('#loading')).toBeHidden();
    };
    try {
      await recentPage.goto(studio);
      await peer.goto(studio);
      await recentPage.evaluate(() => chrome.storage.local.set({ recentExternalFiles: [] }));
      await expect(peer.locator('#recent-files a')).toHaveCount(0);
      await recentPage.locator('#path').fill(textURL);
      await recentPage.locator('#path-form').getByRole('button', { name: '打开', exact: true }).click();
      await expect(recentPage.locator('.CodeMirror')).toContainText('other text');
      assert.deepEqual(await stored(), []);
      await recentPage.goto(studio + '#' + encodeURIComponent(directory));
      await recentPage.locator('#search').fill('other.txt');
      const internal = recentPage.locator('.entry').filter({ hasText: 'other.txt' });
      await expect(internal).toHaveAttribute('href', studio + '#' + encodeURIComponent(textURL));
      for (const options of [{ button: 'middle' }, { modifiers: ['Control'] }]) {
        const opened = context.waitForEvent('page');
        await internal.click(options);
        const child = await opened;
        try {
          watchPage(child);
          await expect.poll(() => child.url()).toBe(studio + '#' + encodeURIComponent(textURL));
          await expect(child.locator('.CodeMirror')).toContainText('other text');
          assert.deepEqual(await stored(), []);
        } finally {
          await child.close();
        }
      }
      await internal.click();
      await expect(recentPage.locator('.CodeMirror')).toContainText('other text');
      assert.deepEqual(await stored(), []);
      await capture(textURL);
      await expect(recentPage.locator('.CodeMirror')).toContainText('other text');
      await expect.poll(stored).toEqual([textURL]);
      await expect(peer.locator('#recent-files a')).toHaveText(['other.txt']);
      await capture(imageURL);
      await expect(recentPage.locator('.iv-image')).toHaveAttribute('src', imageURL);
      await expect.poll(stored).toEqual([imageURL, textURL]);
      await capture(directory);
      await expect(recentPage.locator('#search')).toHaveValue('');
      assert.deepEqual(await stored(), [imageURL, textURL]);
      await recentPage.locator('#recent-files').getByRole('link', { name: 'recent-picture.png', exact: true }).click();
      await expect(recentPage.locator('.iv-image')).toHaveAttribute('src', imageURL);
      assert.deepEqual(await stored(), [imageURL, textURL]);
      await capture(textURL);
      await expect.poll(stored).toEqual([textURL, imageURL]);
      await recentPage.reload();
      await expect(recentPage.locator('#recent-files a')).toHaveText(['other.txt', 'recent-picture.png']);
      await expect(peer.locator('#recent-files a')).toHaveText(['other.txt', 'recent-picture.png']);
      await recentPage.screenshot({ path: path.join(run, 'studio-recent-files.png'), fullPage: true });
      await recentPage.locator('.CodeMirror').evaluate((node) => node.CodeMirror.setValue('unsaved recent draft'));
      recentPage.once('dialog', (dialog) => dialog.dismiss());
      await recentPage.locator('#recent-files').getByRole('link', { name: 'recent-picture.png', exact: true }).click();
      assert.equal(await recentPage.locator('.CodeMirror').evaluate((node) => node.CodeMirror.getValue()), 'unsaved recent draft');
      assert.deepEqual(await stored(), [textURL, imageURL]);
      recentPage.once('dialog', (dialog) => dialog.accept());
      await recentPage.locator('#recent-files').getByRole('link', { name: 'recent-picture.png', exact: true }).click();
      await expect(recentPage.locator('.iv-image')).toHaveAttribute('src', imageURL);
      assert.deepEqual(await stored(), [textURL, imageURL]);
      await recentPage.keyboard.press('Escape');
      await recentPage.goto(studio + '#' + encodeURIComponent(textURL));
      await expect(recentPage.locator('.CodeMirror')).toContainText('other text');
      await recentPage.locator('#native').click();
      await recentPage.waitForURL((url) => url.protocol === 'file:');
      await recentPage.reload();
      await recentPage.goto(studio);
      assert.deepEqual(await stored(), [textURL, imageURL]);
    } finally {
      await recentPage.close();
      await peer.close();
    }
  });
  await check('Vercel preserves real JavaScript syntax colors from the light theme', async () => {
    const syntaxPath = path.join(fixture, 'syntax-colors.js');
    await writeFile(syntaxPath, 'const message = "colour";\nconst count = 42;\n// syntax highlight comment\n');
    const syntaxPage = await context.newPage();
    watchPage(syntaxPage);
    try {
      await syntaxPage.goto(studio + '#' + encodeURIComponent(pathToFileURL(syntaxPath).href));
      await syntaxPage.locator('#theme').selectOption('light');
      const categories = ['keyword', 'string', 'number', 'comment'];
      for (const category of categories) await expect(syntaxPage.locator('.CodeMirror .cm-' + category).first()).toBeVisible();
      const colors = () => syntaxPage.locator('.CodeMirror').evaluate((editor, names) =>
        Object.fromEntries(names.map((name) => [name, getComputedStyle(editor.querySelector('.cm-' + name)).color])), categories);
      const lightColors = await colors();
      assert.equal(new Set(Object.values(lightColors)).size, categories.length);
      for (const color of Object.values(lightColors)) {
        const channels = color.match(/[\d.]+/g).slice(0, 3);
        assert.ok(new Set(channels).size > 1, 'Syntax color must remain chromatic: ' + color);
      }
      await syntaxPage.locator('#theme').selectOption('vercel');
      assert.deepEqual(await colors(), lightColors);
      assert.equal(await syntaxPage.locator('.CodeMirror').evaluate((editor) => getComputedStyle(editor).backgroundColor), 'rgb(255, 255, 255)');
    } finally {
      await syntaxPage.close();
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
    screenshot: path.join(run, 'studio-editor.png'),
    screenshots: [
      'studio-desktop-expanded.png', 'studio-desktop-collapsed.png',
      'studio-directory-narrow-expanded.png', 'studio-directory-narrow-collapsed.png',
      'studio-directory-light.png', 'studio-directory-dark.png', 'studio-directory-economist.png', 'studio-directory-vercel.png',
      'studio-editor.png', 'studio-editor-dark.png', 'studio-editor-economist.png', 'studio-editor-vercel.png', 'studio-narrow.png', 'studio-recent-files.png',
      'studio-mdc-dark.png', 'studio-mdc-light.png', 'studio-picked-mdc.png',
      'studio-status-clean.png', 'studio-status-narrow-error.png',
      'studio-status-download.png', 'studio-status-save-error.png'
    ].map((name) => path.join(run, name))
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
