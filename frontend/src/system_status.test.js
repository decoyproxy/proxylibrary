import assert from 'node:assert/strict';
import test from 'node:test';

import { createSystemStatus, describe as read, reasons, STATUS_URL } from './system_status.js';

// What backend/routes_health.py answers when all is well.
const HEALTHY = {
  status: 'ok',
  node_count: 1024,
  edge_count: 3210,
  geometry_3d_nodes: 1024,
  chromadb: { healthy: true, synced: true, text_vectors: 1024, clip_vectors: 1024 },
  hybrid_search: { index_warmed: true, memory_loaded: true },
  errors: [],
};

function fakeElement(tag = 'span') {
  return {
    tag,
    children: [],
    dataset: {},
    attributes: {},
    className: '',
    textContent: '',
    title: '',
    hidden: false,
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name]; },
    replaceChildren(...nodes) { this.children = nodes; },
    find(className) { return this.children.find((child) => child.className === className); },
  };
}

function fakeHost() {
  globalThis.document = { createElement: (tag) => fakeElement(tag) };
  return fakeElement('span');
}

function once(payload, ok = true) {
  return async () => ({ ok, json: async () => payload });
}

test('a healthy backend reads as ok, with the library counts', () => {
  assert.deepEqual(read(HEALTHY), {
    state: 'ok',
    label: '1,024 nodes · 3,210 edges',
    detail: 'Everything is answering',
  });
});

test('no answer at all is its own state, not a health reading', () => {
  assert.equal(read(null).state, 'down');
  assert.equal(read(null).label, 'backend unreachable');
});

test('degraded says what is wrong, not only that something is', () => {
  const stale = {
    ...HEALTHY,
    status: 'degraded',
    chromadb: { healthy: true, synced: false, text_vectors: 900, clip_vectors: 1024 },
  };
  assert.deepEqual(read(stale), {
    state: 'degraded',
    label: '1,024 nodes · 3,210 edges',
    detail: 'index out of step (900 vectors for 1,024 nodes)',
  });

  const cold = { ...HEALTHY, status: 'degraded', chromadb: { healthy: false, synced: false } };
  assert.match(read(cold).detail, /vector store not answering/);

  const flat = { ...HEALTHY, status: 'degraded', geometry_3d_nodes: 1000 };
  assert.match(read(flat).detail, /24 nodes without 3D coordinates/);
});

test('the errors the route reports are kept, and come first', () => {
  const broken = { ...HEALTHY, status: 'degraded', errors: ['chromadb: RuntimeError'] };
  assert.equal(reasons(broken)[0], 'chromadb: RuntimeError');
});

test('a degraded payload that explains nothing still says something', () => {
  assert.equal(read({ status: 'degraded', node_count: 1, edge_count: 0 }).detail, 'Something is off');
});

test('the badge draws the dot, the count and the reason', async () => {
  const host = fakeHost();
  const asked = [];
  const badge = createSystemStatus({
    host,
    fetch: async (url) => { asked.push(url); return once(HEALTHY)(); },
    setInterval: () => 1,
    clearInterval: () => {},
  });

  assert.equal(host.hidden, true, 'nothing is claimed before the first answer');
  await badge.refresh();

  assert.deepEqual(asked, [STATUS_URL]);
  assert.equal(host.hidden, false);
  assert.equal(host.dataset.state, 'ok');
  assert.equal(host.find('what').textContent, '1,024 nodes · 3,210 edges');
  assert.equal(host.title, 'Everything is answering');
  assert.match(host.getAttribute('aria-label'), /^Backend: ok\./);
  assert.equal(host.getAttribute('role'), 'status');
});

test('a backend that stops answering shows as down, not as the last good reading', async () => {
  const host = fakeHost();
  let alive = true;
  const badge = createSystemStatus({
    host,
    fetch: async () => {
      if (!alive) throw new Error('connection refused');
      return once(HEALTHY)();
    },
    setInterval: () => 1,
    clearInterval: () => {},
  });

  await badge.refresh();
  assert.equal(host.dataset.state, 'ok');

  alive = false;
  await badge.refresh();
  assert.equal(host.dataset.state, 'down');
  assert.equal(host.find('what').textContent, 'backend unreachable');
});

test('a 500 is an answer about nothing, so it reads as down too', async () => {
  const host = fakeHost();
  const badge = createSystemStatus({
    host, fetch: once(null, false), setInterval: () => 1, clearInterval: () => {},
  });
  await badge.refresh();
  assert.equal(host.dataset.state, 'down');
});

test('a tick behind a slow answer is not a second question', async () => {
  const host = fakeHost();
  let calls = 0;
  let settle;
  const badge = createSystemStatus({
    host,
    fetch: () => { calls += 1; return new Promise((resolve) => { settle = resolve; }); },
    setInterval: () => 1,
    clearInterval: () => {},
  });

  const first = badge.refresh();
  await badge.refresh(); // the timer fires again while the first is still out
  assert.equal(calls, 1);

  settle({ ok: true, json: async () => HEALTHY });
  await first;
  assert.equal(host.dataset.state, 'ok');
});

test('start polls on a timer and stop puts it down', async () => {
  const host = fakeHost();
  let ticks = 0;
  let cleared = null;
  const badge = createSystemStatus({
    host,
    fetch: once(HEALTHY),
    interval: 5000,
    setInterval: (fn, ms) => { ticks = ms; return 'timer-1'; },
    clearInterval: (id) => { cleared = id; },
  });

  badge.start();
  assert.equal(ticks, 5000);
  badge.stop();
  assert.equal(cleared, 'timer-1');
});
