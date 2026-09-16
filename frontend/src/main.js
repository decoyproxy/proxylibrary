import { createGalaxy } from './galaxy.js';

const status = document.querySelector('#status');
const inspector = document.querySelector('#inspector');

function showNode(graph, node) {
  if (!node) {
    inspector.hidden = true;
    return;
  }
  const links = graph.edges
    .filter((e) => e.source === node.id || e.target === node.id)
    .map((e) => {
      const otherId = e.source === node.id ? e.target : e.source;
      const other = graph.nodes.find((n) => n.id === otherId);
      return `[${e.type}] ${other ? other.title : otherId}`;
    });
  inspector.innerHTML = `
    <h2></h2>
    <dl>
      <dt>type</dt><dd class="v-type"></dd>
      <dt>domain</dt><dd class="v-domain"></dd>
      <dt>importance</dt><dd class="v-importance"></dd>
      <dt>date</dt><dd class="v-date"></dd>
      <dt>file</dt><dd><button type="button" class="open" title="Open in the macOS default app"></button></dd>
    </dl>
    <ul></ul>`;
  if (node.media === 'image') {
    const img = document.createElement('img');
    img.src = `/media/${node.path}`;
    img.alt = node.title;
    img.className = 'thumb';
    inspector.querySelector('h2').after(img);
  }
  inspector.querySelector('h2').textContent = node.title;
  for (const key of ['type', 'domain', 'importance', 'date']) {
    inspector.querySelector(`.v-${key}`).textContent = node[key] ?? '—';
  }

  // Hands the file to macOS, which knows what opens a .ARW better than a
  // browser does. The server takes the node id, never a path.
  const open = inspector.querySelector('.open');
  open.textContent = node.path ?? '—';
  open.disabled = !node.path;
  open.addEventListener('click', async () => {
    open.textContent = 'opening…';
    const res = await fetch(`/api/v1/open/${encodeURIComponent(node.id)}`, { method: 'POST' });
    const body = await res.text();
    let detail = body;
    try {
      detail = JSON.parse(body).detail ?? body;
    } catch {}
    open.textContent = res.ok ? node.path : `failed: ${String(detail).slice(0, 60)}`;
  });
  const list = inspector.querySelector('ul');
  for (const text of links) {
    const li = document.createElement('li');
    li.textContent = text;
    list.append(li);
  }
  inspector.hidden = false;
}

const res = await fetch('/api/v1/nodes');
if (!res.ok) {
  status.textContent = `backend error ${res.status} — is uvicorn running on :8000?`;
  throw new Error(`/api/v1/nodes ${res.status}`);
}
const graph = await res.json();

const galaxy = createGalaxy(
  document.querySelector('#galaxy'),
  graph,
  (node) => showNode(graph, node),
);
galaxy.setView('semantic');
status.textContent = `${graph.nodes.length} nodes · ${graph.edges.length} edges · drag to orbit, click a node`;

// Type filter. Buttons are built from the types actually present, so a library
// without images never shows an Asset toggle.
const TYPE_ORDER = ['Project', 'Concept', 'Source', 'Fragment', 'Asset'];
const present = TYPE_ORDER.filter((type) => graph.nodes.some((n) => n.type === type));
const shown = new Set(present);
const types = document.querySelector('#types');

for (const type of present) {
  const count = graph.nodes.filter((n) => n.type === type).length;
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.type = type;
  button.setAttribute('aria-pressed', 'true');
  button.style.setProperty('--swatch', `#${galaxy.typeColors[type].toString(16).padStart(6, '0')}`);
  button.innerHTML = '<span class="swatch"></span><span class="name"></span><span class="count"></span>';
  button.querySelector('.swatch').style.background = button.style.getPropertyValue('--swatch');
  button.querySelector('.name').textContent = type;
  button.querySelector('.count').textContent = count;
  types.append(button);
}

types.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-type]');
  if (!button) return;
  const type = button.dataset.type;
  // Turning the last one off would leave an empty screen; treat that click as
  // "show only this one" instead.
  if (shown.has(type) && shown.size === 1) present.forEach((t) => shown.add(t));
  else if (shown.has(type)) shown.delete(type);
  else shown.add(type);
  for (const b of types.children) b.setAttribute('aria-pressed', String(shown.has(b.dataset.type)));
  galaxy.setTypes(shown);
});

document.querySelector('#views').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-view]');
  if (!button) return;
  for (const b of document.querySelectorAll('#views button')) b.classList.toggle('active', b === button);
  galaxy.setView(button.dataset.view);
});

const results = document.querySelector('#results');

function clearSearch() {
  results.hidden = true;
  results.replaceChildren();
  galaxy.highlight(null);
}

document.querySelector('#search').addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = new FormData(event.target).get('q').trim();
  if (!query) return clearSearch();

  status.textContent = `Searching "${query}"… (the first search loads the model, a few seconds)`;
  const res = await fetch(`/api/v1/search?q=${encodeURIComponent(query)}&limit=8`);
  if (!res.ok) {
    // A 500 answers with plain text, so res.json() would throw and leave the
    // search stuck on "검색 중…" with no explanation.
    const body = await res.text();
    let detail = body;
    try {
      detail = JSON.parse(body).detail ?? body;
    } catch {}
    status.textContent = `Search failed (${res.status}): ${detail.slice(0, 120)}`;
    clearSearch();
    return;
  }
  const { results: found, images = [] } = await res.json();
  if (!found.length) {
    status.textContent = `"${query}" — no results`;
    return clearSearch();
  }

  galaxy.highlight(new Set(found.map((r) => r.id)));
  galaxy.focus(found[0].id);
  showNode(graph, graph.nodes.find((n) => n.id === found[0].id));
  const row = (r) => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="title"></span><span class="score"></span>';
    li.querySelector('.title').textContent = r.title;
    li.querySelector('.score').textContent = r.score.toFixed(2);
    li.addEventListener('click', () => {
      galaxy.focus(r.id);
      showNode(graph, graph.nodes.find((n) => n.id === r.id));
    });
    return li;
  };
  const rows = found.map(row);
  if (images.length) {
    const heading = document.createElement('li');
    heading.className = 'heading';
    heading.textContent = 'Images (CLIP — a different scale from the scores above)';
    rows.push(heading, ...images.map(row));
  }
  results.replaceChildren(...rows);
  results.hidden = false;
  status.textContent = `"${query}" — ${found.length} results (Esc to clear)`;
});

addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  document.querySelector('#search input').value = '';
  clearSearch();
  status.textContent = `${graph.nodes.length} nodes · ${graph.edges.length} edges`;
});
