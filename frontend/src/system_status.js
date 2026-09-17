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
 * The badge is a dot and nothing else. The HUD already prints the counts of
 * what is on screen, and a second row of numbers beside them reads as noise
 * until the moment it disagrees — which is the moment nobody is looking. So
 * the numbers move into the tooltip: at rest the dot is a colour, on hover or
 * focus it is the library's live counts, when the projection was last rebuilt,
 * and what is wrong if anything is.
 *
 * `degraded` covers several different faults, so the tooltip names the one it
 * found rather than only colouring the dot. "Something is wrong" that does not
 * say what is a light people learn to ignore.
 */

export const STATUS_URL = '/api/v1/system/status';
export const POLL_MS = 5000; // the route caches for 5s; asking faster buys nothing

const NUMBER = new Intl.NumberFormat();

/** When the projection was last rebuilt, in the reader's own clock. */
export function whenText(iso) {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const pad = (value) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * What to say for a payload. `null` means the backend could not be reached at
 * all, which is a third state: not the library's health but the absence of an
 * answer about it.
 *
 * -> { state, summary, lines } — `state` is one of ok | degraded | down, and
 * `lines` is the tooltip, most important first.
 */
export function describe(payload) {
  if (!payload) {
    return {
      state: 'down',
      summary: 'No answer from the backend',
      lines: ['No answer from the backend'],
    };
  }

  const nodes = payload.node_count ?? 0;
  const edges = payload.edge_count ?? 0;
  const ok = payload.status === 'ok';
  const summary = ok ? 'Everything is answering' : (reasons(payload).join(' · ') || 'Something is off');
  const updated = whenText(payload.umap_updated_at);

  return {
    state: ok ? 'ok' : 'degraded',
    summary,
    lines: [
      summary,
      `${NUMBER.format(nodes)} nodes · ${NUMBER.format(edges)} edges`,
      updated && `projected ${updated}`,
    ].filter(Boolean),
  };
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

  // The tooltip is an element rather than `title` so it can hold several lines,
  // appear on keyboard focus, and not wait out the browser's own delay.
  const tip = document.createElement('span');
  tip.className = 'tip';

  if (host) {
    host.replaceChildren(dot, tip);
    host.setAttribute('role', 'status');
    host.tabIndex = 0; // reachable without a mouse: the dot alone says only a colour
    host.hidden = true;
  }

  function draw(payload) {
    current = describe(payload);
    if (!host) return current;
    host.dataset.state = current.state;
    host.setAttribute('aria-label', `Backend: ${current.state}. ${current.lines.join('. ')}`);
    tip.replaceChildren(...current.lines.map((line) => {
      const row = document.createElement('span');
      row.className = 'line';
      row.textContent = line;
      return row;
    }));
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
