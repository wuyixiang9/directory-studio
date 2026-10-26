export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const TEXT_EXTENSIONS = new Set(
  'txt log csv tsv env md markdown json jsonc js mjs cjs jsx ts tsx css scss yaml yml toml ini cfg conf properties py pyw rs go c h cpp hpp cc cxx hxx java cs sh bash zsh ps1 psm1 psd1 sql bat cmd xml'.split(
    ' '
  )
);
export function localURL(input) {
  if (typeof input !== 'string' || input.length > 32768) return null;
  let value = input.trim();
  if (/^[a-z]:[\\/]/i.test(value))
    value =
      'file:///' +
      value
        .replaceAll('\\', '/')
        .split('/')
        .map((part, index) => (index ? encodeURIComponent(part) : part))
        .join('/');
  else if (value.startsWith('\\\\')) {
    const [host, ...parts] = value.slice(2).split('\\');
    value = 'file://' + host + '/' + parts.map(encodeURIComponent).join('/');
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:' || url.username || url.password || /%2f|%5c/i.test(url.pathname))
      return null;
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/^\/([a-z]):/i, (_, drive) => '/' + drive.toUpperCase() + ':');
    return url.href;
  } catch {
    return null;
  }
}
export function fileKind(value) {
  const href = localURL(value);
  if (!href) return null;
  const path = new URL(href).pathname;
  if (path.endsWith('/')) return 'directory';
  let name = path.split('/').pop();
  try {
    name = decodeURIComponent(name);
  } catch {
    return null;
  }
  if (!name.includes('.')) return null;
  const ext = name.split('.').pop().toLowerCase();
  return TEXT_EXTENSIONS.has(ext)
    ? 'text'
    : /^(?:jpe?g|png|gif|webp|avif|bmp|ico|svg)$/.test(ext)
      ? 'image'
      : null;
}
export function pathLabel(value) {
  const url = new URL(value);
  let name;
  try {
    name = decodeURIComponent(url.pathname);
  } catch {
    name = url.pathname;
  }
  return url.hostname
    ? '\\\\' + url.hostname + name.replaceAll('/', '\\')
    : /^\/[a-z]:\//i.test(name)
      ? name.slice(1).replaceAll('/', '\\')
      : name;
}
export function parseDirectory(source, value) {
  const base = localURL(value);
  if (
    !base ||
    !base.endsWith('/') ||
    typeof source !== 'string' ||
    source.length > 20 * 1024 * 1024 ||
    !/function\s+addRow\s*\(/.test(source) ||
    !/id=["']tbody["']/.test(source)
  )
    throw Error('目录格式无法识别，请使用原生打开。');
  const entries = [];
  const seen = new Set();
  // Chromium's directory listing contains JSON-compatible addRow arguments. Never execute its scripts.
  for (const match of source.matchAll(/<script>addRow\(([^\n]*?)\);<\/script>/g)) {
    let row;
    try {
      row = JSON.parse('[' + match[1] + ']');
    } catch {
      throw Error('目录条目格式无效。');
    }
    const [name, relative, dir, size, , modified] = row;
    if (
      row.length !== 7 ||
      typeof name !== 'string' ||
      !name ||
      /[\\/\0]/.test(name) ||
      ['.', '..'].includes(name) ||
      typeof relative !== 'string' ||
      ![0, 1].includes(dir) ||
      !Number.isFinite(size) ||
      size < 0 ||
      !Number.isFinite(modified)
    )
      throw Error('目录条目无效。');
    if (/%2f|%5c/i.test(relative) || /[\\/?#]/.test(relative) || relative === '.' || relative === '..')
      throw Error('目录条目超出当前目录。');
    const href = localURL(new URL(relative + (dir ? '/' : ''), base).href);
    let decoded;
    try {
      decoded = decodeURIComponent(relative);
    } catch {
      throw Error('目录条目路径无效。');
    }
    if (!href || !href.startsWith(base) || decoded !== name || seen.has(href))
      throw Error('目录条目路径无效。');
    seen.add(href);
    entries.push({
      name,
      href,
      isDirectory: !!dir,
      size,
      modified: modified * 1000,
      searchName: name.toLocaleLowerCase()
    });
    if (entries.length > 100000) throw Error('目录超过 100,000 项，请使用原生打开。');
  }
  if ((source.match(/<script>addRow\(/g) || []).length !== entries.length) throw Error('目录条目不完整。');
  return entries;
}
export function decodeText(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength > MAX_TEXT_BYTES) throw Error('文件超过 2 MiB，请使用原生打开。');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw Error('文件不是有效 UTF-8，请使用原生打开，避免错误转码。');
  }
  if (text.includes('\0')) throw Error('文件包含二进制内容，请使用原生打开。');
  if (text.split(/\r\n|\r|\n/).length > 50000) throw Error('文件超过 50,000 行，请使用原生打开。');
  const bom = bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191;
  const endings = text.match(/\r\n|\r|\n/g) || [];
  const newline = endings[0] || '\n';
  return { text, bytes: bytes.slice(), bom, newline, mixedNewlines: endings.some((end) => end !== newline) };
}
export function equalBytes(a, b) {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
export async function saveFile(handle, text, baseline) {
  if (!handle || typeof handle.createWritable !== 'function') throw Error('尚未授权写入原文件。');
  if (baseline.mixedNewlines) throw Error('原文件混用了换行符，请下载副本或另存为。');
  const diskFile = await handle.getFile();
  if (diskFile.size > MAX_TEXT_BYTES) throw Error('磁盘文件已改变且超过大小限制，请重新打开比较。');
  const disk = new Uint8Array(await diskFile.arrayBuffer());
  if (!equalBytes(disk, baseline.bytes)) throw Error('磁盘文件已被其他程序修改，请重新打开比较后再保存。');
  if (typeof text !== 'string' || text.length > MAX_TEXT_BYTES)
    throw Error('编辑内容超过 2 MiB，请下载副本。');
  const normalized = text.replace(/\r\n|\r|\n/g, baseline.newline);
  const bytes = new TextEncoder().encode((baseline.bom ? '\uFEFF' : '') + normalized);
  if (bytes.length > MAX_TEXT_BYTES) throw Error('编辑内容超过 2 MiB，请下载副本。');
  const stream = await handle.createWritable();
  try {
    await stream.write(bytes);
    await stream.close();
  } catch (error) {
    try {
      await stream.abort();
    } catch {
      /* Preserve original failure. */
    }
    throw error;
  }
  return { ...baseline, bytes, text };
}
