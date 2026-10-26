import {
  localURL,
  fileKind,
  parseDirectory,
  decodeText,
  equalBytes,
  saveFile,
  MAX_TEXT_BYTES
} from './model.js';
async function boundedBytes(response, limit, signal) {
  if (response.status >= 400) throw Error('文件不存在或无法读取（' + response.status + '）。');
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw Error('读取内容超过大小限制，请使用原生打开。');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export async function readLocal(href, { signal } = {}) {
  if (!localURL(href)) throw Error('只支持本地文件路径。');
  if (!(await chrome.extension.isAllowedFileSchemeAccess()))
    throw Error('请先在扩展详情开启「允许访问文件网址」。');
  const kind = fileKind(href);
  if (!kind) throw Error('此文件类型由浏览器原生打开。');
  const response = await fetch(href, { signal, cache: 'no-store' });
  // Chromium directory responses have status 0 / ok=false but a readable listing body.
  const bytes = await boundedBytes(
    response,
    kind === 'directory' || response.status === 0 ? 20 * 1024 * 1024 : MAX_TEXT_BYTES,
    signal
  );
  if (kind !== 'directory' && response.status === 0) {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/function\s+addRow\s*\(/.test(source) && /id=["']tbody["']/.test(source)) {
      const directory = href.endsWith('/') ? href : href + '/';
      return { kind: 'directory', href: directory, entries: parseDirectory(source, directory) };
    }
  }
  if (kind === 'directory')
    return { kind, entries: parseDirectory(new TextDecoder('utf-8', { fatal: true }).decode(bytes), href) };
  if (kind === 'text') return { kind, ...decodeText(bytes) };
  throw Error('图片应由查看器打开。');
}
let database;
async function db() {
  if (!database)
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open('directory-studio-handles', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  return database;
}
async function stored(key, value) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('files', value === undefined ? 'readonly' : 'readwrite');
    const request =
      value === undefined ? tx.objectStore('files').get(key) : tx.objectStore('files').put(value, key);
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || Error('句柄存储失败。'));
  });
}
export async function pickDocument() {
  const [handle] = await showOpenFilePicker({ multiple: false });
  if (fileKind('file:///' + encodeURIComponent(handle.name)) !== 'text')
    throw Error('请选择支持的 UTF-8 文本或代码文件。');
  const file = await handle.getFile();
  if (file.size > MAX_TEXT_BYTES) throw Error('文件超过 2 MiB。');
  decodeText(await file.arrayBuffer());
  const id = crypto.randomUUID();
  await stored('picked:' + id, handle);
  return 'picked:' + id;
}
export async function readPicked(key) {
  if (!/^picked:[a-f0-9-]{36}$/.test(key)) throw Error('授权文件标识无效。');
  const handle = await stored(key);
  if (!handle) throw Error('找不到授权文件，请重新选择。');
  const file = await handle.getFile();
  if (file.size > MAX_TEXT_BYTES) throw Error('文件超过 2 MiB。');
  return { kind: 'text', ...decodeText(await file.arrayBuffer()), handle, name: handle.name, picked: true };
}
async function requireWritePermission(handle) {
  if (
    (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted' &&
    (await handle.requestPermission({ mode: 'readwrite' })) !== 'granted'
  )
    throw Error('未获得写入权限，编辑内容保留。');
}
export async function persistDocument(href, document, text) {
  let handle = document.handle;
  if (!handle) {
    const [chosen] = await showOpenFilePicker({ multiple: false });
    const name = decodeURIComponent(new URL(href).pathname.split('/').pop());
    if (chosen.name !== name) throw Error('请选择同名原文件「' + name + '」，编辑内容保留。');
    // Request while picker selection still supplies transient activation, before slow reads or confirmation.
    await requireWritePermission(chosen);
    const file = await chosen.getFile();
    if (file.size > MAX_TEXT_BYTES || !equalBytes(new Uint8Array(await file.arrayBuffer()), document.bytes))
      throw Error('所选文件与打开时的原文不同，请重新打开比较。');
    // The picker deliberately does not expose an absolute path. Do not silently assume identity.
    if (
      !confirm(
        '请选择并确认原文件：\n' + href + '\n\n浏览器不提供所选文件的完整路径；请确认选择的是这个文件。'
      )
    )
      throw new DOMException('取消保存', 'AbortError');
    handle = chosen;
  } else await requireWritePermission(handle);
  const saved = await saveFile(handle, text, document);
  Object.assign(document, saved, { handle });
}
