import assert from 'node:assert/strict';
import test from 'node:test';

import { createOcrViewer, ocrUrl, sections } from './ocr_viewer.js';

// What backend/routes_nodes.py answers, copied from its own test.
const SCAN = {
  id: 'SRC_SCAN',
  has_ocr: true,
  ocr_text: '첫 줄\nsecond line',
  has_note: true,
  note_text: '앞 메모\n\n뒤 메모',
};
const EMPTY = { id: 'SRC_SCAN', has_ocr: false, ocr_text: '', has_note: false, note_text: '' };

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
    findAll(className, out = []) {
      if (this.className === className) out.push(this);
      for (const child of this.children) child.findAll?.(className, out);
      return out;
    },
  };
}

function fakeDom() {
  globalThis.document = { createElement: (tag) => fakeElement(tag) };
  return fakeElement('aside');
}

function reply(payload, ok = true) {
  return async () => ({ ok, json: async () => payload });
}

test('the text comes from the node route, by id', () => {
  assert.equal(ocrUrl({ id: 'SRC_SCAN' }), '/api/v1/nodes/SRC_SCAN/ocr');
  assert.equal(ocrUrl({ id: 'AST/ODD ID' }), '/api/v1/nodes/AST%2FODD%20ID/ocr');
  assert.equal(ocrUrl({}), null);
});

test('the machine reading and the reader writing get a panel each', () => {
  assert.deepEqual(sections(SCAN).map((s) => [s.kind, s.label]), [
    ['ocr', 'OCR text'],
    ['note', 'Note'],
  ]);
  assert.deepEqual(sections({ ...SCAN, ocr_text: '' }).map((s) => s.kind), ['note']);
  assert.deepEqual(sections({ ...SCAN, note_text: '   ' }).map((s) => s.kind), ['ocr']);
  assert.deepEqual(sections(EMPTY), []);
  assert.deepEqual(sections(null), []);
});

test('attach asks the route and opens each panel on its toggle', async () => {
  const host = fakeDom();
  const asked = [];
  const viewer = createOcrViewer({
    fetch: async (url) => { asked.push(url); return reply(SCAN)(); },
  });

  const holder = await viewer.attach({ id: 'SRC_SCAN', path: 'Sources/scan.jpg' }, host);

  assert.deepEqual(asked, ['/api/v1/nodes/SRC_SCAN/ocr']);
  assert.equal(holder.findAll('reveal').length, 2);

  const [ocrToggle, noteToggle] = holder.findAll('reveal');
  assert.match(ocrToggle.textContent, /^OCR text · \d+ chars$/);
  assert.match(noteToggle.textContent, /^Note · \d+ chars$/);

  const body = holder.find('text');
  assert.equal(body.hidden, true);
  ocrToggle.click();
  assert.equal(ocrToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(body.hidden, false);
  assert.equal(body.textContent, '첫 줄\nsecond line');
});

test('Copy text puts that panel own text on the clipboard', async () => {
  const host = fakeDom();
  const written = [];
  const viewer = createOcrViewer({
    fetch: reply(SCAN),
    clipboard: { writeText: async (text) => written.push(text) },
  });

  const holder = await viewer.attach({ id: 'SRC_SCAN' }, host);
  const [ocrCopy, noteCopy] = holder.findAll('copy');
  ocrCopy.click();
  noteCopy.click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(written, ['첫 줄\nsecond line', '앞 메모\n\n뒤 메모']);
});

test('a sidecar with no text in it leaves the card as it was', async () => {
  const host = fakeDom();
  const viewer = createOcrViewer({ fetch: reply(EMPTY) });
  assert.equal(await viewer.attach({ id: 'SRC_SCAN' }, host), null);
  assert.deepEqual(host.children, []);
});

test('404 — a node with no file of its own — draws nothing and says nothing', async () => {
  const host = fakeDom();
  const said = [];
  const viewer = createOcrViewer({ fetch: reply(null, false), onStatus: (m) => said.push(m) });
  assert.equal(await viewer.attach({ id: 'CON_LATENT' }, host), null);
  assert.deepEqual(host.children, []);
  assert.deepEqual(said, []);
});

test('a node with no id is not asked about', async () => {
  const host = fakeDom();
  let called = false;
  const viewer = createOcrViewer({ fetch: async () => { called = true; } });
  assert.equal(await viewer.attach({ path: 'Sources/scan.jpg' }, host), null);
  assert.equal(called, false);
});

test('an unreachable backend reports once and draws nothing', async () => {
  const host = fakeDom();
  const said = [];
  const viewer = createOcrViewer({
    fetch: async () => { throw new Error('offline'); },
    onStatus: (message) => said.push(message),
  });

  assert.equal(await viewer.attach({ id: 'SRC_SCAN' }, host), null);
  assert.deepEqual(host.children, []);
  assert.deepEqual(said, ['Could not read the text for SRC_SCAN: offline']);
});

// A slow reply for one node and a fast one for the next: the slow one must not
// land in the card that is on screen.
function deferred() {
  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });
  return { promise, settle };
}

test('a slow reply for the previous node never reaches the card on screen', async () => {
  const host = fakeDom();
  const slow = deferred();
  const aborted = [];
  const viewer = createOcrViewer({
    fetch: async (url) => {
      if (url.includes('SLOW')) return slow.promise;
      return { ok: true, json: async () => SCAN };
    },
    AbortController: class {
      constructor() { this.signal = { aborted: false }; }
      abort() { this.signal.aborted = true; aborted.push(this); }
    },
  });

  const first = viewer.attach({ id: 'SLOW' }, host);
  const second = await viewer.attach({ id: 'SRC_SCAN' }, host);

  slow.settle({ ok: true, json: async () => ({ id: 'SLOW', ocr_text: 'from the wrong node' }) });
  assert.equal(await first, null);

  assert.equal(aborted.length, 1, 'the abandoned request was aborted');
  assert.equal(host.children.length, 1, 'one card, one holder');
  assert.equal(host.children[0], second);
  const shown = second.findAll('text').map((pre) => pre.textContent).join('\n');
  assert.doesNotMatch(shown, /wrong node/);
});

test('an aborted request is not reported as a failure', async () => {
  const host = fakeDom();
  const said = [];
  const viewer = createOcrViewer({
    fetch: async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    },
    onStatus: (message) => said.push(message),
  });

  assert.equal(await viewer.attach({ id: 'SRC_SCAN' }, host), null);
  assert.deepEqual(said, []);
  assert.deepEqual(host.children, []);
});

test('the request carries a signal, and cancel() stops it', async () => {
  const host = fakeDom();
  const signals = [];
  let controller = null;
  const viewer = createOcrViewer({
    fetch: async (_url, options) => { signals.push(options?.signal); return { ok: true, json: async () => SCAN }; },
    AbortController: class {
      constructor() { this.signal = { aborted: false }; controller = this; }
      abort() { this.signal.aborted = true; }
    },
  });

  await viewer.attach({ id: 'SRC_SCAN' }, host);
  assert.equal(signals.length, 1);
  assert.equal(signals[0], controller.signal);

  viewer.cancel();
  assert.equal(controller.signal.aborted, true);
});
