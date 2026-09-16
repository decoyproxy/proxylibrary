import { createGalaxy } from './galaxy.js';

const status = document.querySelector('#status');
const inspector = document.querySelector('#inspector');

const DOMAINS = ['Art', 'Science', 'Philosophy'];

// Writes go to the file first and the graph is rebuilt from it, so the card
// shows what is actually on disk rather than what was typed into it.
async function saveNode(node, changes) {
  status.textContent = `Saving ${node.id}…`;
  const res = await fetch(`/api/v1/nodes/${encodeURIComponent(node.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  });
  const body = await res.text();
  let payload = body;
  try {
    payload = JSON.parse(body);
  } catch {}
  if (!res.ok) {
    status.textContent = `Save failed (${res.status}): ${JSON.stringify(payload?.detail ?? payload).slice(0, 120)}`;
    return false;
  }
  Object.assign(node, payload.node); // same object the graph holds
  galaxy.updateNode(node);
  refreshTypes();
  refreshDomains();
  showNode(graph, node);
  status.textContent = `Saved to ${payload.wrote}`;
  return true;
}

function buildEditor(node) {
  const stars = inspector.querySelector('.stars');
  for (let value = 1; value <= 5; value++) {
    const star = document.createElement('button');
    star.type = 'button';
    star.textContent = value <= node.importance ? '★' : '☆';
    star.title = `Importance ${value}`;
    star.addEventListener('click', () => saveNode(node, { importance: value }));
    stars.append(star);
  }

  const domain = inspector.querySelector('.domain');
  for (const name of DOMAINS.includes(node.domain) ? DOMAINS : [node.domain, ...DOMAINS]) {
    const option = document.createElement('option');
    option.value = option.textContent = name;
    option.selected = name === node.domain;
    domain.append(option);
  }
  domain.addEventListener('change', () => saveNode(node, { domain: domain.value }));

  // Commit on Enter or on leaving the field, but only when something changed —
  // every save rewrites the file and re-embeds the document.
  const tags = inspector.querySelector('.tags');
  const original = (node.tags ?? []).join(', ');
  tags.value = original;
  const commit = () => {
    if (tags.value.trim() === original.trim()) return;
    saveNode(node, { tags: tags.value.split(',') });
  };
  tags.addEventListener('keydown', (event) => event.key === 'Enter' && tags.blur());
  tags.addEventListener('blur', commit);
}

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
      <dt>date</dt><dd class="v-date"></dd>
      <dt>file</dt><dd><button type="button" class="open" title="Open in the macOS default app"></button></dd>
      <dt>importance</dt><dd class="stars" role="group" aria-label="Importance"></dd>
      <dt>domain</dt><dd><select class="domain"></select></dd>
      <dt>tags</dt><dd><input class="tags" placeholder="comma, separated" aria-label="Tags" /></dd>
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
  for (const key of ['type', 'date']) {
    inspector.querySelector(`.v-${key}`).textContent = node[key] ?? '—';
  }
  buildEditor(node);

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

// Filter bars. Type and domain work the same way, so they are the same code:
// one toggle per value actually present, with its count.
const TYPE_ORDER = ['Project', 'Concept', 'Source', 'Fragment', 'Asset'];
const DOMAIN_ORDER = ['Art', 'Science', 'Philosophy'];

function filterBar(nav, keyOf, order, colourOf, apply) {
  const values = [...new Set([...order, ...graph.nodes.map(keyOf)])]
    .filter((value) => graph.nodes.some((node) => keyOf(node) === value));
  const shown = new Set(values);

  for (const value of values) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.value = value;
    button.setAttribute('aria-pressed', 'true');
    button.innerHTML = '<span class="swatch"></span><span class="name"></span><span class="count"></span>';
    const colour = colourOf?.(value);
    if (colour) button.querySelector('.swatch').style.background = colour;
    else button.querySelector('.swatch').remove();
    button.querySelector('.name').textContent = value;
    nav.append(button);
  }

  // Counts follow the graph, which an inspector edit can change.
  function refresh() {
    for (const button of nav.children) {
      button.querySelector('.count').textContent =
        graph.nodes.filter((node) => keyOf(node) === button.dataset.value).length;
    }
  }

  nav.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (!button) return;
    const value = button.dataset.value;
    // Turning the last one off would leave an empty screen; treat that click as
    // "show everything again" instead.
    if (shown.has(value) && shown.size === 1) values.forEach((v) => shown.add(v));
    else if (shown.has(value)) shown.delete(value);
    else shown.add(value);
    for (const b of nav.children) b.setAttribute('aria-pressed', String(shown.has(b.dataset.value)));
    apply(shown);
  });

  refresh();
  apply(shown);
  return refresh;
}

const refreshTypes = filterBar(
  document.querySelector('#types'),
  (node) => node.type,
  TYPE_ORDER,
  (type) => `#${(galaxy.typeColors[type] ?? 0).toString(16).padStart(6, '0')}`,
  (shown) => galaxy.setTypes(shown),
);
const refreshDomains = filterBar(
  document.querySelector('#domains'),
  (node) => node.domain,
  DOMAIN_ORDER,
  null,
  (shown) => galaxy.setDomains(shown),
);

// Timeline. Only the temporal view has an axis where "before this month" means
// anything, so the scrubber appears with it and releases the graph when you
// leave.
const timeline = document.querySelector('#timeline');
const scrub = document.querySelector('#scrub');
const when = document.querySelector('#when');
const play = document.querySelector('#play');
const STEP_MS = 420;

// Every month between the first and the last collected, gaps included — a
// slider that skips empty months would run at a different speed per library.
function monthsBetween(dates) {
  const stamps = dates.filter(Boolean).map((d) => d.slice(0, 7)).sort();
  if (!stamps.length) return [];
  const [startYear, startMonth] = stamps[0].split('-').map(Number);
  const [endYear, endMonth] = stamps[stamps.length - 1].split('-').map(Number);
  const months = [];
  for (let m = startYear * 12 + startMonth - 1; m <= endYear * 12 + endMonth - 1; m++) {
    months.push(`${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`);
  }
  return months;
}

const months = monthsBetween(graph.nodes.map((n) => n.date));
scrub.min = 0;
scrub.max = Math.max(months.length - 1, 0);
scrub.value = scrub.max;
let playing = null;

function showMonth(index) {
  const month = months[index];
  if (!month) return;
  galaxy.setCutoff(month);
  const count = graph.nodes.filter((n) => (n.date ?? '').slice(0, 7) <= month).length;
  when.textContent = `${month} · ${count}`;
}

function stopPlaying() {
  clearInterval(playing);
  playing = null;
  play.textContent = 'Play';
}

scrub.addEventListener('input', () => {
  stopPlaying();
  showMonth(Number(scrub.value));
});

play.addEventListener('click', () => {
  if (playing) return stopPlaying();
  if (Number(scrub.value) >= Number(scrub.max)) scrub.value = 0;
  showMonth(Number(scrub.value));
  play.textContent = 'Pause';
  playing = setInterval(() => {
    if (Number(scrub.value) >= Number(scrub.max)) return stopPlaying();
    scrub.value = Number(scrub.value) + 1;
    showMonth(Number(scrub.value));
  }, STEP_MS);
});

function setTimelineVisible(on) {
  timeline.hidden = !on || !months.length;
  if (on) {
    showMonth(Number(scrub.value));
  } else {
    stopPlaying();
    galaxy.setCutoff(null);
  }
}

document.querySelector('#views').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-view]');
  if (!button) return;
  for (const b of document.querySelectorAll('#views button')) b.classList.toggle('active', b === button);
  galaxy.setView(button.dataset.view);
  setTimelineVisible(button.dataset.view === 'temporal');
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
