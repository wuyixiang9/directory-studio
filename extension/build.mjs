import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
const base = new URL('../', import.meta.url);
const read = (name) => readFile(new URL(name, base), 'utf8');
const output = pathToFileURL(resolve(process.env.DIRECTORY_STUDIO_EXTENSION_ROOT || 'dist/extension') + sep);
await mkdir(output, { recursive: true });
const manifest = JSON.parse(await read('extension/manifest.json'));
const vendor = JSON.parse(await read('vendor-manifest.json'));
// Extension fixes can ship independently from the retained userscript release.
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw Error('Invalid extension version');
for (const name of [
  'manifest.json',
  'background.js',
  'bridge.js',
  'model.js',
  'studio.html',
  'studio.css',
  'studio.js',
  'theme.js',
  'files.js'
])
  await cp(new URL('extension/' + name, base), new URL(name, output));
const strip = (source) => source.replace(/^\/\/[#@] sourceMappingURL=.*$/gm, '');
const library = async (root, file) =>
  '/*\n' +
  (await read(root + '/LICENSE')).replaceAll('*/', '* /') +
  '\n*/\n' +
  strip(await read(root + '/' + file)) +
  '\n;\n';
const cmRoot = 'vendor/codemirror-' + vendor.codemirror.version;
let editor = await library(cmRoot, 'lib/codemirror.js');
for (const file of vendor.codemirror.modules) editor += (await read(cmRoot + '/' + file)) + '\n;\n';
editor += await library('vendor/markdown-it-' + vendor.markdownIt.version, vendor.markdownIt.distribution);
editor +=
  '\n(() => {\n"use strict";\nconst environment = { sandboxURL: (kind,nonce) => chrome.runtime.getURL(kind+"-sandbox.html")+"#"+encodeURIComponent(nonce) };\n' +
  'const GM_getValue = (key,fallback) => window.studioPreferences.get(key,fallback);\nconst GM_setValue = (key,value) => window.studioPreferences.set(key,value);\nconst GM_setClipboard = text => navigator.clipboard.writeText(text);\n' +
  (await read('mermaid-studio.src.js')) +
  '\n' +
  (await read('markmap-studio.src.js')) +
  '\n' +
  (await read('markdown-preview.src.js')) +
  '\n' +
  (await read('text-studio.src.js')) +
  '\n' +
  'window.mountStudioEditor = host => startLoadedTextStudio({host,CodeMirror:window.CodeMirror,MarkdownIt:window.markdownit,createMermaidPreviewController,createMarkmapPreviewController,createStudioMarkdownRenderer,scheduleStudioDiagramRender,css:host.css});\n})();\n';
await writeFile(new URL('editor.js', output), editor);
await cp(new URL(cmRoot + '/lib/codemirror.css', base), new URL('editor.css', output));
await writeFile(
  new URL('shared.js', output),
  '(() => {\n' +
    (await read('directory-model.src.js')) +
    '\n' +
    (await read('favorites-store.src.js')) +
    '\n' +
    (await read('favorites-menu.src.js')) +
    '\n' +
    (await read('image-viewer.src.js')) +
    '\nwindow.studioShared = {directoryStudioFavorites,directoryStudioFavoriteIntent,directoryStudioCreateFavoritesMenu,directoryStudioCreateImageViewer,directoryStudioImageSequence};\n})();\n'
);
const mermaid = await library('vendor/mermaid-' + vendor.mermaid.version, vendor.mermaid.distribution);
await writeFile(new URL('mermaid-library.js', output), mermaid);
const markmap =
  (await library('vendor/d3-' + vendor.d3.version, vendor.d3.distribution)) +
  (await library('vendor/markmap-lib-' + vendor.markmapLib.version, vendor.markmapLib.distribution)) +
  (await library('vendor/markmap-view-' + vendor.markmapView.version, vendor.markmapView.distribution));
await writeFile(new URL('markmap-library.js', output), markmap);
for (const kind of ['mermaid', 'markmap']) {
  await writeFile(new URL(kind + '-controller.js', output), await read(kind + '-studio.src.js'));
  const channel = 'directory-studio-' + kind + '-v1';
  await writeFile(
    new URL(kind + '-boot.js', output),
    '"use strict";\nconst nonce=decodeURIComponent(location.hash.slice(1));\nif (/^[a-zA-Z0-9-]{16,80}$/.test(nonce)) ' +
      kind +
      'SandboxMain({channel:' +
      JSON.stringify(channel) +
      ',nonce});\n'
  );
  const style =
    kind === 'mermaid'
      ? 'html,body{margin:0;background:transparent;font:16px "Segoe UI","Microsoft YaHei",sans-serif}#stage{width:1160px;min-height:100px}'
      : 'html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fbfdff;color:#182b49}html[data-theme=dark],html[data-theme=dark] body{background:#17253a;color:#e0eafb}#map{width:100%;height:100%;display:block;--markmap-text-color:#182b49;--markmap-circle-open-bg:#fbfdff;font:14px "Segoe UI","Microsoft YaHei",sans-serif}html[data-theme=dark] #map{--markmap-text-color:#e0eafb;--markmap-circle-open-bg:#17253a}.markmap-foreign{color:var(--markmap-text-color)}';
  await writeFile(
    new URL(kind + '-sandbox.html', output),
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
      style +
      '</style><script src="' +
      kind +
      '-library.js" defer></script><script src="' +
      kind +
      '-controller.js" defer></script><script src="' +
      kind +
      '-boot.js" defer></script></head><body>' +
      (kind === 'mermaid'
        ? '<main id="stage"></main>'
        : '<svg id="map" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="交互脑图"></svg>') +
      '</body></html>'
  );
}
await mkdir(new URL('licenses/', output), { recursive: true });
for (const [name, version] of [
  ['codemirror', vendor.codemirror.version],
  ['markdown-it', vendor.markdownIt.version],
  ['mermaid', vendor.mermaid.version],
  ['markmap-lib', vendor.markmapLib.version],
  ['markmap-view', vendor.markmapView.version],
  ['d3', vendor.d3.version]
])
  await cp(
    new URL('vendor/' + name + '-' + version + '/LICENSE', base),
    new URL('licenses/' + name + '.txt', output)
  );
await cp(
  new URL('vendor/markmap-lib-' + vendor.markmapLib.version + '/THIRD-PARTY-NOTICES', base),
  new URL('licenses/markmap-third-party.txt', output)
);
await cp(new URL('vendor-manifest.json', base), new URL('licenses/vendor-manifest.json', output));
// Small code-drawn folder icon; deterministic PNGs, no external image tool or runtime dependency.
function chunk(type, data) {
  const payload = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const head = Buffer.alloc(4),
    tail = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([head, payload, tail]);
}
await mkdir(new URL('icons/', output), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const rows = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const xx = ((x + 0.5) / size) * 128,
        yy = ((y + 0.5) / size) * 128;
      const folder =
        (xx >= 19 && xx <= 109 && yy >= 43 && yy <= 100) || (xx >= 19 && xx <= 62 && yy >= 29 && yy < 43);
      const stripe = folder && xx >= 33 && xx <= 95 && ((yy >= 59 && yy < 65) || (yy >= 77 && yy < 83));
      const rgba = stripe ? [237, 243, 251, 255] : folder ? [37, 99, 235, 255] : [237, 243, 251, 255];
      rows.set(rgba, y * (1 + size * 4) + 1 + x * 4);
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  await writeFile(
    new URL('icons/' + size + '.png', output),
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(rows)),
      chunk('IEND', Buffer.alloc(0))
    ])
  );
}
console.log('Built Directory Studio extension ' + manifest.version + ' at ' + output.pathname);
