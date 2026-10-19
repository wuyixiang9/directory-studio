import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = new URL('./', import.meta.url);
const read = file => readFile(new URL(file, base), 'utf8');
const manifest = JSON.parse(await read('vendor-manifest.json'));
const pkg = JSON.parse(await read('package.json'));
const arguments_ = process.argv.slice(2);
if (arguments_.some(value => value !== '--local')) throw new Error('Unknown build argument');
const local = arguments_.includes('--local');
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Release version must be a stable semantic version');
const directory = await read('directory-studio.src.js');
const metadataEnd = directory.indexOf('// ==/UserScript==') + '// ==/UserScript=='.length;
if (metadataEnd < '// ==/UserScript=='.length) throw new Error('Userscript metadata missing');
const sourceMetadata = directory.slice(0, metadataEnd);
if (sourceMetadata.match(/@version\s+(\S+)/)?.[1] !== pkg.version) throw new Error('Source/package version mismatch');
const directoryCode = directory.slice(metadataEnd).trim();
const cmRoot = 'vendor/codemirror-' + manifest.codemirror.version + '/';
const mdRoot = 'vendor/markdown-it-' + manifest.markdownIt.version + '/';
const mermaidRoot = 'vendor/mermaid-' + manifest.mermaid.version + '/';
const stripSourceMaps = source => source.replace(/^\/\/[#@] sourceMappingURL=.*$/gm, '');
const moduleWrapper = source => '(function(module, exports, require) {\n' + stripSourceMaps(source) + '\n})(localModule, localModule.exports, localRequire);\n';
const license = async (name, root, version) => '/*\n' + name + ' ' + version + '\n' + await read(root + 'LICENSE') + '\n*/\n';
let editor = await license('CodeMirror', cmRoot, manifest.codemirror.version) +
  '"use strict";\nconst { GM_getValue, GM_setValue, GM_setClipboard } = environment;\n' +
  'let localModule = { exports: {} };\nlet localRequire = () => { throw new Error("Unexpected core dependency"); };\n' +
  moduleWrapper(await read(cmRoot + 'lib/codemirror.js')) +
  'const CodeMirror = localModule.exports;\nlocalRequire = () => CodeMirror;\n';
for (const file of manifest.codemirror.modules) {
  editor += '// Upstream module: ' + file + '\nlocalModule = { exports: {} };\n' + moduleWrapper(await read(cmRoot + file));
}
editor += await read('text-studio.src.js') + '\nreturn { CodeMirror, startLoadedTextStudio };\n';
const markdown = await license('markdown-it', mdRoot, manifest.markdownIt.version) +
  '"use strict";\nlet localModule = { exports: {} };\nconst localRequire = () => { throw new Error("Unexpected Markdown dependency"); };\n' +
  moduleWrapper(await read(mdRoot + manifest.markdownIt.distribution)) +
  'const MarkdownIt = localModule.exports;\nfunction getTextStudioMermaidBundle() { return environment.getResourceText("mermaid"); }\n' +
  await read('mermaid-studio.src.js') + '\n' + await read('markdown-preview.src.js') +
  '\nreturn { MarkdownIt, createMermaidPreviewController, createStudioMarkdownRenderer, scheduleStudioDiagramRender };\n';

// The upstream CSS has selector blocks, media rules, and simple cursor keyframes.
function scopeEditorCSS(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\bblink\b/g, 'lts-cm-blink')
    .replace(/([^{}]+)\{([^{}]*)\}/g, (whole, selectors, body) => {
      const selector = selectors.trim();
      if (selector.startsWith('@') || /^(?:from|to|[\d.]+%)(?:\s*,\s*(?:from|to|[\d.]+%))*$/.test(selector)) return whole;
      return '\n' + selector.split(',').map(value => '#local-text-studio ' + value.trim()).join(',\n') + '{' + body + '}';
    });
}
const assets = {
  editor: { file: 'editor.js', text: editor },
  editorCSS: { file: 'editor.css', text: scopeEditorCSS(await read(cmRoot + 'lib/codemirror.css')) },
  markdown: { file: 'markdown.js', text: markdown },
  mermaid: { file: 'mermaid.js', text: await license('Mermaid', mermaidRoot, manifest.mermaid.version) + await read(mermaidRoot + manifest.mermaid.distribution) }
};
const publicBase = 'https://raw.githubusercontent.com/wuyixiang9/directory-studio/main/';
const version = local ? process.env.DIRECTORY_STUDIO_LOCAL_VERSION : pkg.version;
if (local && (!version || !version.startsWith(pkg.version + '-local.') || !/^\d+\.\d+\.\d+-local\.[1-9]\d*$/.test(version))) throw new Error('Set DIRECTORY_STUDIO_LOCAL_VERSION to a new release-local.N version');
const port = local ? Number(process.env.DIRECTORY_STUDIO_INSTALL_PORT || 43817) : null;
if (local && (!Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error('Invalid installation port');
const prefix = local ? 'http://127.0.0.1:' + port + '/' + version + '/' : publicBase + 'resources/' + version + '/';
const identities = Object.fromEntries(Object.entries(assets).map(([name, asset]) => [name, {
  file: asset.file, bytes: Buffer.byteLength(asset.text), sha256: createHash('sha256').update(asset.text).digest('hex')
}]));
const resources = Object.entries(identities).map(([name, identity]) => '// @resource     ' + name + ' ' + prefix + identity.file + '#sha256=' + identity.sha256).join('\n');
const header = local
  ? sourceMetadata.replace(/^\/\/ @(?:downloadURL|updateURL)[^\n]*\n/gm, '').replace(/(@version\s+)\S+/, (_match, prefix) => prefix + version)
  : sourceMetadata;
const metadata = header.replace('// ==/UserScript==', resources + '\n// ==/UserScript==');
const payload = metadata + '\n\n// Generated by build.mjs. Edit .src.js files, not generated assets.\n(() => {\n"use strict";\n' +
  await read('directory-model.src.js') + '\n' + await read('favorites-store.src.js') + '\n' + await read('favorites-menu.src.js') + '\n' +
  await read('core-runtime.src.js') + '\n' + directoryCode + '\n})();\n';
if (local) {
  const artifactRoot = process.env.DIRECTORY_STUDIO_ARTIFACT_ROOT
    ? pathToFileURL(resolve(process.env.DIRECTORY_STUDIO_ARTIFACT_ROOT) + sep)
    : new URL('../artifacts/chrome-directory-studio/local-build/', base);
  await mkdir(artifactRoot, { recursive: true });
  const candidateRoot = new URL(version + '/', artifactRoot);
  // An explicit local build must never overwrite a previously installed candidate.
  await mkdir(candidateRoot);
  for (const asset of Object.values(assets)) await writeFile(new URL(asset.file, candidateRoot), asset.text);
  await writeFile(new URL('directory-studio.user.js', candidateRoot), payload);
  await writeFile(new URL('directory-studio.meta.js', candidateRoot), metadata + '\n');
  await writeFile(new URL('manifest.json', artifactRoot), JSON.stringify({ mode: 'local', version, port, prefix, resources: identities }, null, 2) + '\n');
} else {
  const resourceRoot = new URL('resources/' + version + '/', base);
  await mkdir(resourceRoot, { recursive: true });
  for (const asset of Object.values(assets)) await writeFile(new URL(asset.file, resourceRoot), asset.text);
  await writeFile(new URL('directory-studio.user.js', base), payload);
  await writeFile(new URL('directory-studio.meta.js', base), metadata + '\n');
}
console.log('Generated ' + (local ? 'local candidate ' : 'release ') + version + ' (' + Buffer.byteLength(payload) + ' UTF-8 core bytes) and four install-cached resources.');
