import test from 'node:test';
import assert from 'node:assert/strict';
import { localURL, fileKind, parseDirectory, decodeText, saveFile, pathLabel } from '../extension/model.js';

test('external local paths normalize without mistaking HTML or remote pages for supported files', () => {
  assert.equal(localURL('D:\\笔记\\a #1.md'), 'file:///D:/%E7%AC%94%E8%AE%B0/a%20%231.md');
  assert.equal(localURL('https://example.org/a.md'), null);
  assert.equal(fileKind('file:///D:/a/'), 'directory');
  assert.equal(fileKind('file:///D:/a.MD#x'), 'text');
  assert.equal(fileKind('file:///D:/a%2Emd'), 'text');
  assert.equal(fileKind('file:///D:/log'), null);
  assert.equal(fileKind('file:///D:/a.svg'), 'image');
  for (const ext of ['html', 'htm', 'pdf', 'exe', 'zip']) assert.equal(fileKind('file:///D:/a.' + ext), null);
  assert.equal(pathLabel('file://server/share/a%20b.md'), '\\\\server\\share\\a b.md');
});

const listing = (rows) =>
  '<script>function addRow(name,url,isdir,size,size_string,date_modified,date_modified_string){}</script><tbody id="tbody"></tbody>' +
  rows.map((row) => '<script>addRow(' + JSON.stringify(row).slice(1, -1) + ');</script>').join('');
test('directory parser handles escaped names, empty directories, metadata and rejects escapes without execution', () => {
  const rows = [
    ['目录', '%E7%9B%AE%E5%BD%95', 1, 0, '', 123, 'date'],
    ['x"<.txt', 'x%22%3C.txt', 0, 12, '12 B', 124, 'date']
  ];
  const entries = parseDirectory(listing(rows), 'file:///D:/notes/');
  assert.equal(entries[0].href, 'file:///D:/notes/%E7%9B%AE%E5%BD%95/');
  assert.equal(entries[1].name, 'x"<.txt');
  assert.equal(entries[1].modified, 124000);
  assert.deepEqual(parseDirectory(listing([]), 'file:///D:/notes/'), []);
  for (const url of ['../secret', 'file:///C:/secret', 'https://evil/a', 'a%2fb', 'a%5cb', '#a', '?a']) {
    assert.throws(() => parseDirectory(listing([['a', url, 0, 0, '', 0, '']]), 'file:///D:/notes/'));
  }
  assert.throws(() => parseDirectory('<script>globalThis.pwned=true</script>', 'file:///D:/notes/'));
});

test('text decoding preserves BOM and CRLF and refuses binary and invalid UTF-8', () => {
  const bytes = new TextEncoder().encode('\uFEFF一\r\n二\r\n');
  const doc = decodeText(bytes);
  assert.equal(doc.text, '一\r\n二\r\n');
  assert.equal(doc.bom, true);
  assert.equal(doc.newline, '\r\n');
  assert.throws(() => decodeText(new Uint8Array([0xff, 0xfe, 0x61])));
  assert.throws(() => decodeText(new Uint8Array([0x61, 0, 0x62])));
});

test('save refuses concurrent disk changes before opening a writable and commits only after close', async () => {
  const baseline = new TextEncoder().encode('before');
  let disk = baseline;
  let opened = 0;
  let closed = false;
  const handle = {
    getFile: async () => ({ arrayBuffer: async () => disk.buffer }),
    createWritable: async () => {
      opened++;
      return {
        write: async (value) => {
          disk = value;
        },
        close: async () => {
          closed = true;
        },
        abort: async () => {}
      };
    }
  };
  disk = new TextEncoder().encode('external');
  await assert.rejects(saveFile(handle, 'after', { bytes: baseline, bom: false, newline: '\n' }), /磁盘/);
  assert.equal(opened, 0);
  disk = baseline;
  const saved = await saveFile(handle, 'after', { bytes: baseline, bom: false, newline: '\n' });
  assert.equal(closed, true);
  assert.equal(new TextDecoder().decode(saved.bytes), 'after');
});

test('save close errors reject and CRLF/BOM encoding is preserved', async () => {
  const baseline = new TextEncoder().encode('\uFEFFa\r\n');
  let written;
  let aborted = false;
  const handle = {
    getFile: async () => ({ arrayBuffer: async () => baseline.buffer }),
    createWritable: async () => ({
      write: async (b) => {
        written = b;
      },
      close: async () => {
        throw Error('disk full');
      },
      abort: async () => {
        aborted = true;
      }
    })
  };
  await assert.rejects(saveFile(handle, 'b\n', { bytes: baseline, bom: true, newline: '\r\n' }), /disk full/);
  assert.equal(new TextDecoder('utf-8', { ignoreBOM: true }).decode(written), '\uFEFFb\r\n');
  assert.equal(aborted, true);
});

test('oversize changed files and mixed line endings are rejected before reading or writing huge data', async () => {
  let touched = false;
  const handle = {
    getFile: async () => ({
      size: 3 * 1024 * 1024,
      arrayBuffer: async () => {
        touched = true;
        throw Error('must not allocate');
      }
    }),
    createWritable: async () => {
      touched = true;
      throw Error('must not write');
    }
  };
  await assert.rejects(saveFile(handle, 'draft', { bytes: new Uint8Array(), newline: '\n' }), /大小限制/);
  assert.equal(touched, false);
  await assert.rejects(
    saveFile(handle, 'draft', { bytes: new Uint8Array(), newline: '\n', mixedNewlines: true }),
    /换行符/
  );
  assert.equal(touched, false);
});
