import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPresetManager,
  nameProblem,
  detectPresetStore,
  localPresetStore,
  remotePresetStore,
} from './preset_manager.js';

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
  };
}

function fakeElement() {
  return {
    children: [],
    dataset: {},
    attributes: {},
    textContent: '',
    innerHTML: '',
    listeners: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name]; },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(type, handler) { this.listeners[type] = handler; },
    querySelector() { return (this.named ??= fakeElement()); },
  };
}

function fakeBrowser(search = '') {
  globalThis.document = { createElement: () => fakeElement() };
  const state = { search, href: `https://library.test/${search}` };
  return {
    nav: fakeElement(),
    location: state,
    history: {
      replaceState(_a, _b, url) {
        state.search = url.search;
        state.href = url.href;
      },
    },
  };
}

test('a local preset survives a round trip and can be forgotten', async () => {
  const store = localPresetStore({ storage: memoryStorage() });
  await store.put('art', { view: 'semantic', domains: ['Art'] });
  assert.deepEqual(await store.all(), { art: { view: 'semantic', domains: ['Art'] } });
  await store.remove('art');
  assert.deepEqual(await store.all(), {});
});

test('unreadable storage reads as no presets rather than throwing', async () => {
  const store = localPresetStore({ storage: memoryStorage({ 'proxylibrary.presets': '{oops' }) });
  assert.deepEqual(await store.all(), {});
});

test('the remote store accepts either list shape the route may return', async () => {
  const mapping = remotePresetStore({
    fetch: async () => ({ ok: true, json: async () => ({ presets: { art: { view: 'semantic' } } }) }),
  });
  assert.deepEqual(await mapping.all(), { art: { view: 'semantic' } });

  const rows = remotePresetStore({
    fetch: async () => ({ ok: true, json: async () => [{ name: 'art', state: { view: 'semantic' } }] }),
  });
  assert.deepEqual(await rows.all(), { art: { view: 'semantic' } });
});

test('the remote store sends the name in the path when forgetting a view', async () => {
  const calls = [];
  const store = remotePresetStore({
    fetch: async (url, options) => {
      calls.push([url, options.method]);
      return { ok: true, json: async () => ({}) };
    },
  });
  await store.remove('art plus spark');
  assert.deepEqual(calls, [['/api/v1/presets/art%20plus%20spark', 'DELETE']]);
});

test('a missing route falls back to this browser instead of failing', async () => {
  const store = await detectPresetStore({
    fetch: async () => ({ ok: false, status: 404 }),
    storage: memoryStorage(),
  });
  assert.equal(store.kind, 'local');
});

test('opening with ?preset= applies that view and badges its button', async () => {
  const browser = fakeBrowser('?preset=art');
  const applied = [];
  const manager = createPresetManager({
    nav: browser.nav,
    store: localPresetStore({
      storage: memoryStorage({ 'proxylibrary.presets': JSON.stringify({ art: { view: 'semantic' }, old: {} }) }),
    }),
    getState: () => ({ view: 'temporal' }),
    applyState: (state) => applied.push(state),
    location: browser.location,
    history: browser.history,
  });

  await manager.start();

  assert.deepEqual(applied, [{ view: 'semantic' }]);
  const badges = browser.nav.children
    .filter((child) => child.dataset.preset)
    .map((child) => [child.dataset.preset, child.getAttribute('aria-pressed')]);
  assert.deepEqual(badges, [['art', 'true'], ['old', 'false']]);
});

test('forgetting the view being shown drops it from the URL as well', async () => {
  const browser = fakeBrowser('?preset=art');
  const manager = createPresetManager({
    nav: browser.nav,
    store: localPresetStore({
      storage: memoryStorage({ 'proxylibrary.presets': JSON.stringify({ art: { view: 'semantic' } }) }),
    }),
    getState: () => ({}),
    applyState: () => {},
    location: browser.location,
    history: browser.history,
  });

  await manager.start();
  await manager.forget('art');

  assert.equal(browser.location.search, '');
  assert.deepEqual(manager.names(), []);
});

// The route landed in 4ce4a40 (backend/routes_presets.py): GET returns
// { presets: { name: state } }, POST takes { name, state } and answers 201,
// DELETE takes the name in the path. This holds the client to that contract.
test('the remote store speaks the shape backend/routes_presets.py serves', async () => {
  const sent = [];
  const store = remotePresetStore({
    fetch: async (url, options) => {
      sent.push({ url, method: options.method ?? 'GET', body: options.body });
      return { ok: true, status: 201, json: async () => ({ presets: { 'Umwelt set': { view: 'semantic' } } }) };
    },
  });

  assert.deepEqual(await store.all(), { 'Umwelt set': { view: 'semantic' } });
  await store.put('Umwelt set', { nodes: ['CON_UEXKULL'], view: 'semantic' });

  assert.equal(sent[0].url, '/api/v1/presets');
  assert.deepEqual(sent[1], {
    url: '/api/v1/presets',
    method: 'POST',
    body: JSON.stringify({ name: 'Umwelt set', state: { nodes: ['CON_UEXKULL'], view: 'semantic' } }),
  });
});

test('a name the server would refuse is caught at the prompt', () => {
  assert.equal(nameProblem('Umwelt set'), null);
  assert.equal(nameProblem('  padded  '), null);
  const refusal = "Preset name cannot contain '/' or be blank";
  assert.equal(nameProblem('folder/view'), refusal);
  assert.equal(nameProblem('/'), refusal);
  assert.equal(nameProblem('   '), refusal);
  assert.equal(nameProblem(''), refusal);
});

test('saving a refused name says so and never reaches the store', async () => {
  const browser = fakeBrowser();
  const said = [];
  const puts = [];
  const manager = createPresetManager({
    nav: browser.nav,
    store: { kind: 'test', all: async () => ({}), put: async (...args) => puts.push(args), remove: async () => {} },
    getState: () => ({ view: 'semantic' }),
    applyState: () => {},
    onStatus: (message) => said.push(message),
    ask: () => 'folder/view',
    location: browser.location,
    history: browser.history,
  });

  await manager.start();
  await manager.saveCurrent();

  assert.deepEqual(said, ["Preset name cannot contain '/' or be blank"]);
  assert.deepEqual(puts, []);
});

test('cancelling the prompt is silent, not a complaint', async () => {
  const browser = fakeBrowser();
  const said = [];
  const manager = createPresetManager({
    nav: browser.nav,
    store: { kind: 'test', all: async () => ({}), put: async () => {}, remove: async () => {} },
    getState: () => ({}),
    applyState: () => {},
    onStatus: (message) => said.push(message),
    ask: () => null,
    location: browser.location,
    history: browser.history,
  });

  await manager.start();
  await manager.saveCurrent();

  assert.deepEqual(said, []);
});

test('a good name is trimmed on the way to the store', async () => {
  const browser = fakeBrowser();
  const puts = [];
  const manager = createPresetManager({
    nav: browser.nav,
    store: {
      kind: 'test',
      all: async () => ({}),
      put: async (name, state) => puts.push([name, state]),
      remove: async () => {},
    },
    getState: () => ({ view: 'temporal' }),
    applyState: () => {},
    ask: () => '  Umwelt set  ',
    location: browser.location,
    history: browser.history,
  });

  await manager.start();
  await manager.saveCurrent();

  assert.deepEqual(puts, [['Umwelt set', { view: 'temporal' }]]);
});
