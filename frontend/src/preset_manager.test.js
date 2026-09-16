import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPresetManager,
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
