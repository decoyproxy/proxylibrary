/**
 * Saved views: the list in the HUD, which one is showing, and forgetting one.
 *
 * A research angle — "Art plus SPARK edges" — is a combination of every filter
 * at once, and retyping it is the kind of thing you stop doing. `main.js` knows
 * how to read the current view and how to put one back (`getState`/`applyState`);
 * `selection.js` knows the shape a node-set preset takes. This module owns only
 * the part in between: where the named views are kept, the buttons that list
 * them, and the `?preset=` link that points at one.
 *
 * Where they are kept is behind a store, because that answer is changing. Until
 * now a preset lived in this browser — the library is local, and a preset is a
 * way of looking at it rather than part of it. A REST store (`/api/v1/presets`)
 * makes a view outlive the browser profile and travel with the library. Both
 * shapes are here and `detectPresetStore()` picks the one that answers, so the
 * panel keeps working whether or not the backend route exists yet.
 */

export const PRESETS_KEY = 'proxylibrary.presets';
export const PRESETS_ENDPOINT = '/api/v1/presets';

/**
 * What the server will refuse (backend/routes_presets.py): a name that is
 * blank once trimmed, or one with a `/` in it. Saying so at the prompt costs
 * nothing and beats a 422 read back off the status line.
 *
 * -> a sentence to show, or null when the name is fine.
 */
export function nameProblem(name) {
  const trimmed = (name ?? '').trim();
  if (!trimmed || trimmed.includes('/')) {
    return "Preset name cannot contain '/' or be blank";
  }
  return null;
}

/** Presets in this browser. Unreadable storage is not a reason to lose the galaxy. */
export function localPresetStore({ storage = localStorage, key = PRESETS_KEY } = {}) {
  function read() {
    try {
      return JSON.parse(storage.getItem(key)) ?? {};
    } catch {
      return {};
    }
  }

  function write(presets) {
    storage.setItem(key, JSON.stringify(presets));
  }

  return {
    kind: 'local',
    async all() {
      return read();
    },
    async put(name, state) {
      write({ ...read(), [name]: state });
    },
    async remove(name) {
      const presets = read();
      delete presets[name];
      write(presets);
    },
  };
}

/**
 * Presets on the server.
 *
 *   GET    /api/v1/presets          -> { presets: { name: state } } | [{ name, state }]
 *   POST   /api/v1/presets          <- { name, state }
 *   DELETE /api/v1/presets/{name}
 *
 * Both list shapes are accepted: this module is written against a route that is
 * still being built, and the reading end is the cheap place to absorb that.
 */
export function remotePresetStore({ endpoint = PRESETS_ENDPOINT, fetch: fetchImpl = fetch } = {}) {
  async function send(path, options) {
    const res = await fetchImpl(`${endpoint}${path}`, options);
    if (!res.ok) throw new Error(`${options?.method ?? 'GET'} ${endpoint}${path} → ${res.status}`);
    return res;
  }

  return {
    kind: 'remote',
    async all() {
      const payload = await (await send('', {})).json();
      const listed = Array.isArray(payload) ? payload : payload.presets ?? payload;
      if (!Array.isArray(listed)) return listed ?? {};
      return Object.fromEntries(listed.map((row) => [row.name, row.state ?? row.preset ?? row]));
    },
    async put(name, state) {
      await send('', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, state }),
      });
    },
    async remove(name) {
      await send(`/${encodeURIComponent(name)}`, { method: 'DELETE' });
    },
  };
}

/**
 * The server store if the route answers, this browser's otherwise. One probe at
 * startup: a missing route is the expected case today, not an error to report.
 */
export async function detectPresetStore({
  endpoint = PRESETS_ENDPOINT,
  fetch: fetchImpl = fetch,
  storage = localStorage,
} = {}) {
  const remote = remotePresetStore({ endpoint, fetch: fetchImpl });
  try {
    await remote.all();
    return remote;
  } catch {
    return localPresetStore({ storage });
  }
}

/**
 * The panel. `nav` is the `#presets` element; it fills with one button per saved
 * view plus a button that saves the current one. The showing view carries
 * `aria-pressed="true"` — the badge is the button's own state rather than a
 * second element, so a screen reader and the stylesheet read the same fact.
 */
export function createPresetManager({
  nav,
  store = null,
  getState,
  applyState,
  onStatus = () => {},
  ask = (question) => prompt(question),
  history: historyImpl = history,
  location: locationImpl = location,
}) {
  let cached = {};

  /** The store, chosen on first use so the caller needs no top-level await. */
  async function ready() {
    return (store ??= await detectPresetStore());
  }

  function currentName() {
    return new URLSearchParams(locationImpl.search).get('preset');
  }

  function setUrl(name) {
    const url = new URL(locationImpl.href);
    if (name) url.searchParams.set('preset', name);
    else url.searchParams.delete('preset');
    historyImpl.replaceState(null, '', url);
  }

  function render() {
    const current = currentName();
    nav.replaceChildren(...Object.keys(cached).sort().map((name) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.preset = name;
      button.setAttribute('aria-pressed', String(name === current));
      button.innerHTML = '<span class="name"></span><span class="forget">×</span>';
      button.querySelector('.name').textContent = name;
      return button;
    }));

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'save-preset';
    save.textContent = '+ Save view';
    save.addEventListener('click', () => saveCurrent());
    nav.append(save);
  }

  async function refresh() {
    try {
      cached = await (await ready()).all();
    } catch (error) {
      onStatus(`Could not read the saved views: ${error.message}`);
    }
    render();
  }

  async function saveCurrent() {
    const typed = ask('Name this view');
    if (typed === null || typed === undefined) return; // cancelling is not an error
    const name = typed.trim();
    const problem = nameProblem(name);
    if (problem) {
      onStatus(problem);
      return;
    }
    try {
      await (await ready()).put(name, getState());
    } catch (error) {
      onStatus(`Could not save the view: ${error.message}`);
      return;
    }
    await refresh();
    select(name);
  }

  /** Put a saved view back and point the URL at it. */
  function select(name) {
    const preset = cached[name];
    if (!preset) return false;
    applyState(preset);
    setUrl(name);
    render();
    onStatus(`View "${name}"`);
    return true;
  }

  async function forget(name) {
    try {
      await (await ready()).remove(name);
    } catch (error) {
      onStatus(`Could not forget "${name}": ${error.message}`);
      return;
    }
    if (currentName() === name) setUrl(null);
    await refresh();
  }

  nav.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-preset]');
    if (!button) return;
    if (event.target.closest('.forget')) forget(button.dataset.preset);
    else select(button.dataset.preset);
  });

  /** Fill the panel, then honour a `?preset=` the page was opened with. */
  async function start() {
    await refresh();
    const wanted = currentName();
    if (wanted && !select(wanted)) onStatus(`No saved view called "${wanted}"`);
  }

  return { start, refresh, select, forget, saveCurrent, names: () => Object.keys(cached) };
}
