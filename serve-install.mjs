import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.DIRECTORY_STUDIO_ARTIFACT_ROOT
  ? pathToFileURL(resolve(process.env.DIRECTORY_STUDIO_ARTIFACT_ROOT) + sep)
  : new URL('../artifacts/chrome-directory-studio/local-build/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
if (!/^[0-9]+\.[0-9]+\.[0-9]+-local\.[0-9]+$/.test(manifest.version)) throw new Error('Not a local candidate');
if (manifest.mode !== 'local') throw new Error('Not an explicit local build');
if (!Number.isInteger(manifest.port) || manifest.port < 1024 || manifest.port > 65535) throw new Error('Invalid port');
const prefix = '/' + manifest.version + '/';
const allowlist = new Set(['directory-studio.user.js', 'directory-studio.meta.js', 'editor.js', 'editor.css', 'markdown.js', 'mermaid.js', 'markmap.js']);
const server = http.createServer(async (request, response) => {
  const host = '127.0.0.1:' + manifest.port;
  if (request.headers.host !== host || !['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(403); response.end(); return;
  }
  const path = request.url || '';
  const file = path.startsWith(prefix) ? path.slice(prefix.length) : '';
  if (!allowlist.has(file) || path !== prefix + file) {
    response.writeHead(404); response.end(); return;
  }
  try {
    const bytes = await readFile(new URL(manifest.version + '/' + file, root));
    response.writeHead(200, {
      'Content-Type': file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8',
      'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
    });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch (_) { response.writeHead(404); response.end(); }
});
server.listen(manifest.port, '127.0.0.1', () => {
  console.log('Install: http://127.0.0.1:' + manifest.port + prefix + 'directory-studio.user.js');
  console.log('Stop this artifact-only server after installation. Browsing uses Tampermonkey cached resources.');
});
