/**
 * Whether the machinery behind the galaxy is actually well, in one badge.
 *
 * The HUD says how many nodes are on screen, which is a fact about the picture,
 * not about the library: a stale graph, a ChromaDB that never warmed, and a
 * backend that died two minutes ago all keep drawing the same dots. Searching
 * is how you find out, and by then you are already annoyed.
 *
 * `/api/v1/system/status` (backend/routes_health.py) answers with the counts
 * and the parts that can be unwell. This is a light on the dashboard: a dot, a
 * count, and — when something is wrong — what. It never interrupts; the galaxy
 * keeps working while the badge says the index is out of step.
 *
 * `degraded` covers several different faults, so the badge carries the reason
 * in its tooltip rather than only a colour. "Something is wrong" that does not
 * say what is a light people learn to ignore.
 */

export const STATUS_URL = '/api/v1/system/status';
export const POLL_MS = 5000; // the route caches for 5s; asking faster buys nothing

const NUMBER = new Intl.NumberFormat();

/**
 * What to draw for a payload. `null` means the backend could not be reached at
 * all, which is a third state: not the library's health but the absence of an
 * answer about it.
 *
 * -> { state, label, detail } — `state` is one of ok | degraded | down.
 */
export function describe(payload) {
  if (!payload) {
    return { state: 'down', label: 'backend unreachable', detail: 'No answer from the backend' };
  }

  const nodes = payload.node_count ?? 0;
  const edges = payload.edge_count ?? 0;
  const label = `${NUMBER.format(nodes)} nodes · ${NUMBER.format(edges)} edges`;
  if (payload.status === 'ok') return { state: 'ok', label, detail: 'Everything is answering' };

  return { state: 'degraded', label, detail: reasons(payload).join(' · ') || 'Something is off' };
}

/** Why a payload is degraded, in the order a reader would want them. */
export function reasons(payload) {
  const out = [...(payload?.errors ?? [])];
  const chroma = payload?.chromadb ?? {};
  const nodes = payload?.node_count ?? 0;

  if (chroma.healthy === false) out.push('vector store not answering');
  else if (chroma.synced === false) {
    const text = chroma.text_vectors ?? 0;
    out.push(`index out of step (${NUMBER.format(text)} vectors for ${NUMBER.format(nodes)} nodes)`);
  }

  const geometry = payload?.geometry_3d_nodes;
  if (Number.isInteger(geometry) && geometry < nodes) {
    out.push(`${NUMBER.format(nodes - geometry)} nodes without 3D coordinates`);
  }
  return out;
}

/**
 * The badge in `host`, refreshed on a timer. Returns a handle; nothing happens
 * until `start()`.
 *
 * One request is in flight at a time — a slow answer must not be overtaken by
 * the tick behind it — and a failed poll shows as `down` rather than freezing
 * the last good reading, which would be a lie that looks like health.
 */
export function createSystemStatus({
  host,
  fetch: fetchImpl = fetch,
  interval = POLL_MS,
  setInterval: setIntervalImpl = setInterval,
  clearInterval: clearIntervalImpl = clearInterval,
} = {}) {
  let timer = null;
  let busy = false;
  let current = null;

  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.setAttribute('aria-hidden', 'true');

  const text = document.createElement('span');
  text.className = 'what';

  if (host) {
    host.replaceChildren(dot, text);
    host.setAttribute('role', 'status');
    host.hidden = true;
  }

  function draw(payload) {
    current = describe(payload);
    if (!host) return current;
    host.dataset.state = current.state;
    host.title = current.detail;
    host.setAttribute('aria-label', `Backend: ${current.state}. ${current.detail}`);
    text.textContent = current.label;
    host.hidden = false;
    return current;
  }

  async function refresh() {
    if (busy) return current; // the tick behind a slow answer is not a new question
    busy = true;
    try {
      const res = await fetchImpl(STATUS_URL);
      return draw(res.ok ? await res.json() : null);
    } catch {
      return draw(null); // unreachable is a reading, not an error to shout about
    } finally {
      busy = false;
    }
  }

  function start() {
    refresh();
    timer ??= setIntervalImpl(refresh, interval);
    return handle;
  }

  function stop() {
    if (timer !== null) clearIntervalImpl(timer);
    timer = null;
  }

  const handle = { start, stop, refresh, state: () => current };
  return handle;
}
