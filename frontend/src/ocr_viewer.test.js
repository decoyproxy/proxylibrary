import assert from 'node:assert/strict';
import test from 'node:test';

import { createOcrViewer, sections, sidecarPath, splitSidecar, stripFrontMatter } from './ocr_viewer.js';

const SCAN = `---
domain: Art
---
<!-- ocr -->
프로보크 1968: 도발하는 사진들
Provoke: grainy, blurred, out of focus photographs
<!-- /ocr -->
`;

function fakeElement(tag = 'div') {
  return {
    tag,
    children: [],
    attributes: {},
    listeners: {},
    className: '',
    textContent: '',
    hidden: false,
    parent: null,
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name]; },
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); },
    click() { for (const handler of this.listeners.click ?? []) handler(); },
    append(...nodes) {
      for (const node of nodes) { node.parent = this; this.children.push(node); }
    },
    before(node) {
      const host = this.parent;
      node.parent = host;
      host.children.splice(host.children.indexOf(this), 0, node);
    },
    remove() {
      if (!this.parent) return;
      this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    },
    find(className) {
      if (this.className === className) return this;
      for (const child of this.children) {
        const hit = child.find?.(className);
        if (hit) return hit;
      }
      return null;
    },
  };
}

function fakeDom() {
  globalThis.document = { createElement: (tag) => fakeElement(tag) };
  return fakeElement('aside');
}

function reply(body, ok = true) {
  return async () => ({ ok, text: async () => body });
}

test('a sidecar sits beside its file, and a note is its own sidecar', () => {
  assert.equal(sidecarPath({ path: 'Sources/SCAN.jpg' }), 'Sources/SCAN.jpg.md');
  assert.equal(sidecarPath({ path: 'Sources/UMWELT.pdf' }), 'Sources/UMWELT.pdf.md');
  assert.equal(sidecarPath({ path: 'Concepts/CON_UEXKULL.md' }), 'Concepts/CON_UEXKULL.md');
  assert.equal(sidecarPath({ path: 'Concepts/SHOUTED.MD' }), 'Concepts/SHOUTED.MD');
  assert.equal(sidecarPath({}), null);
});

test('front matter is dropped: the card already shows it', () => {
  assert.equal(stripFrontMatter('---\ndomain: Art\n---\nbody here\n').trim(), 'body here');
  assert.equal(stripFrontMatter('no front matter'), 'no front matter');
});

test('the machine reading and the reader writing come apart', () => {
  assert.deepEqual(splitSidecar(SCAN), {
    ocr: '프로보크 1968: 도발하는 사진들\nProvoke: grainy, blurred, out of focus photographs',
    notes: '',
  });

  const annotated = '내가 쓴 메모\n\n<!-- ocr -->\nread by machine\n<!-- /ocr -->\n\n뒤에 쓴 메모';
  assert.deepEqual(splitSidecar(annotated), {
    ocr: 'read by machine',
    notes: '내가 쓴 메모\n\n뒤에 쓴 메모',
  });
});

test('an unclosed marker keeps the notes instead of swallowing them', () => {
  const half = 'handwritten\n\n<!-- ocr -->\nhalf written';
  assert.deepEqual(splitSidecar(half), { ocr: '', notes: half });
});

test('an empty sidecar draws no toggle at all', () => {
  assert.deepEqual(sections('---\ndomain: Art\n---\n'), []);
  assert.deepEqual(sections(SCAN).map((s) => s.kind), ['ocr']);
  assert.deepEqual(
    sections('note\n<!-- ocr -->\nread\n<!-- /ocr -->').map((s) => s.kind),
    ['ocr', 'note'],
  );
});

test('attach reads the sidecar under /media and opens on the toggle', async () => {
  const host = fakeDom();
  const asked = [];
  const viewer = createOcrViewer({
    fetch: async (url) => { asked.push(url); return (await reply(SCAN)()); },
  });

  const holder = await viewer.attach({ path: 'Sources/SCAN.jpg' }, host);

  assert.deepEqual(asked, ['/media/Sources/SCAN.jpg.md']);
  assert.equal(host.children.length, 1);
  const toggle = holder.find('reveal');
  const body = holder.find('text');
  const copy = holder.find('copy');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(body.hidden, true);

  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(body.hidden, false);
  assert.equal(copy.hidden, false);
  assert.match(body.textContent, /프로보크/);
});

test('Copy text puts the OCR text on the clipboard', async () => {
  const host = fakeDom();
  const written = [];
  const viewer = createOcrViewer({
    fetch: reply(SCAN),
    clipboard: { writeText: async (text) => written.push(text) },
  });

  const holder = await viewer.attach({ path: 'Sources/SCAN.jpg' }, host);
  holder.find('copy').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(written.length, 1);
  assert.match(written[0], /Provoke: grainy/);
});

test('a node with no sidecar on disk leaves the card as it was', async () => {
  const host = fakeDom();
  const viewer = createOcrViewer({ fetch: reply('', false) });
  assert.equal(await viewer.attach({ path: 'Assets/RAW_0431.ARW' }, host), null);
  assert.deepEqual(host.children, []);
});

test('a node with no file is not asked about', async () => {
  const host = fakeDom();
  let called = false;
  const viewer = createOcrViewer({ fetch: async () => { called = true; } });
  assert.equal(await viewer.attach({ id: 'CON_LATENT' }, host), null);
  assert.equal(called, false);
});

test('an unreachable backend reports once and draws nothing', async () => {
  const host = fakeDom();
  const said = [];
  const viewer = createOcrViewer({
    fetch: async () => { throw new Error('offline'); },
    onStatus: (message) => said.push(message),
  });

  assert.equal(await viewer.attach({ path: 'Sources/SCAN.jpg' }, host), null);
  assert.deepEqual(host.children, []);
  assert.deepEqual(said, ['Could not read Sources/SCAN.jpg.md: offline']);
});
