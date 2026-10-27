import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/studio.js', import.meta.url), 'utf8');
const start = source.indexOf('function attachEditorStatus()');
const end = source.indexOf('function targetHash(', start);
assert.ok(start >= 0 && end > start);

function fixture() {
  class Element {
    constructor(className = '') {
      this.className = className;
      this.children = [];
      this.parentNode = null;
      this.dataset = {};
      this.textContent = '';
    }
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this);
      this.parentNode = null;
    }
    append(...nodes) {
      for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); }
    }
    prepend(node) { node.remove(); node.parentNode = this; this.children.unshift(node); }
    querySelector(selector) {
      for (const node of this.children) {
        if (node.className === selector.slice(1)) return node;
        const match = node.querySelector(selector);
        if (match) return match;
      }
      return null;
    }
  }
  const host = new Element(), details = new Element('lts-status'), notice = new Element('lts-notice');
  const labels = ['lts-dirty', 'lts-cursor', 'lts-encoding'].map(name => new Element(name));
  labels[2].textContent = 'UTF-8 with original authorization hint';
  details.append(...labels);
  host.append(details, notice);
  const footer = new Element(), status = new Element(), loading = new Element();
  footer.append(status, loading);
  let disposed = 0;
  const context = vm.createContext({
    $: id => ({ 'local-text-studio': host, 'app-status': footer })[id],
    make: (_tag, className) => new Element(className),
    releaseEditorStatus: null,
    editor: { dispose() {
      assert.deepEqual(details.children, labels, 'Return labels before their owner disposes');
      assert.equal(notice.parentNode, host);
      assert.deepEqual(footer.children, [status, loading], 'Never destroy persistent shell IDs');
      disposed++;
    } }
  });
  vm.runInContext(source.slice(start, end), context);
  return { context, host, details, notice, labels, footer, status, loading, disposed: () => disposed };
}

test('editor status borrows existing labels and live notice without moving shell status IDs', () => {
  const f = fixture();
  f.context.releaseEditorStatus = f.context.attachEditorStatus();
  const group = f.footer.children[0];
  assert.deepEqual(group.children, [...f.labels, f.notice]);
  assert.equal(f.footer.dataset.editor, 'true');
  assert.equal(f.labels[2].textContent, 'UTF-8');
  assert.equal(f.status.parentNode, f.footer);
  assert.equal(f.loading.parentNode, f.footer);
  f.notice.textContent = 'Save cancelled; draft kept';
  f.status.textContent = 'Read failed';
  f.loading.hidden = false;
  assert.equal(group.children[3].textContent, 'Save cancelled; draft kept');
  assert.equal(f.status.textContent, 'Read failed');
  assert.equal(f.loading.hidden, false);
  f.context.disposeEditor();
  assert.equal(f.disposed(), 1);
  assert.equal(f.context.editor, null);
  assert.equal(f.context.releaseEditorStatus, null);
  assert.equal(f.footer.dataset.editor, undefined);
  assert.equal(f.labels[2].textContent, 'UTF-8 with original authorization hint');
  f.context.disposeEditor();
  assert.equal(f.disposed(), 1);
});

test('a failed pending read or original-text view does not hide the persistent status region', () => {
  const f = fixture();
  f.context.releaseEditorStatus = f.context.attachEditorStatus();
  f.host.hidden = true;
  f.details.hidden = true;
  const group = f.footer.children[0];
  assert.equal(group.parentNode, f.footer);
  assert.equal(f.notice.parentNode, group);
  assert.equal(f.labels[0].parentNode, group);
  assert.equal(f.status.parentNode, f.footer);
  assert.equal(f.loading.parentNode, f.footer);
  f.context.disposeEditor();
  assert.equal(f.disposed(), 1);
});
