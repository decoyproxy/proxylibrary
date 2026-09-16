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
  refreshTags();
  refreshTagList();
  galaxy.setTags(picked);
  showNode(graph, node);
  status.textContent = `Saved to ${payload.wrote}`;
  return true;
}

// Commit a text-ish field on Enter or on leaving it, and only when it really
// changed — every save rewrites the file and re-embeds the document.
function editable(element, node, current, toChange) {
  element.value = current;
  const commit = () => {
    if (element.value.trim() === String(current).trim()) return;
    if (!element.value.trim()) {
      element.value = current; // an empty title or date is a slip, not an edit
      return;
    }
    saveNode(node, toChange(element.value));
  };
  element.addEventListener('keydown', (event) => event.key === 'Enter' && element.blur());
  element.addEventListener('blur', commit);
  if (element.type === 'date') element.addEventListener('change', commit);
}

function buildEditor(node) {
  editable(inspector.querySelector('.title'), node, node.title, (value) => ({ title: value }));
  editable(inspector.querySelector('.date'), node, node.date ?? '', (value) => ({ date: value }));

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

  // Tags are chips plus a one-tag field. A comma-separated string could not use
  // the browser's completion list, which matches the whole value — and the
  // whole point of suggesting existing tags is to stop "darkroom" and
  // "dark room" from both existing.
  const chips = inspector.querySelector('.chips');
  const current = node.tags ?? [];
  chips.replaceChildren(...current.map((tag) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.title = `Remove ${tag}`;
    chip.innerHTML = '<span></span>×';
    chip.querySelector('span').textContent = tag;
    chip.addEventListener('click', () =>
      saveNode(node, { tags: current.filter((other) => other !== tag) }));
    return chip;
  }));

  const tags = inspector.querySelector('.tags');
  const add = () => {
    const tag = tags.value.trim();
    tags.value = '';
    if (!tag || current.includes(tag)) return;
    saveNode(node, { tags: [...current, tag] });
  };
  tags.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    add();
  });
  tags.addEventListener('blur', add);
}

// Link changes come back with the whole graph: an edge belongs to two nodes, so
// there is no patching one node's copy of it.
async function changeLinks(node, request) {
  status.textContent = `Rewiring ${node.id}…`;
  const res = await fetch(request.url, request.init);
  const body = await res.text();
  let payload = body;
  try {
    payload = JSON.parse(body);
  } catch {}
  if (!res.ok) {
    status.textContent = `Link failed (${res.status}): ${String(payload?.detail ?? payload).slice(0, 160)}`;
    return;
  }
  graph.nodes.forEach((existing) => {
    const fresh = payload.nodes.find((n) => n.id === existing.id);
    if (fresh) Object.assign(existing, fresh);
  });
  graph.edges = payload.edges;
  galaxy.setEdges(graph.edges);
  galaxy.updateNode(node);
  refreshRelations();
  showNode(graph, node);
  status.textContent = `Saved to ${payload.wrote}`;
}

async function deleteNode(node) {
  const warning = `Delete "${node.title}"?\n\n` +
    `${node.path} moves to backend/data/.trash — nothing is erased, and putting ` +
    'it back is a single mv. Links to it from other notes stay as written.';
  if (!confirm(warning)) return;

  status.textContent = `Deleting ${node.id}…`;
  const res = await fetch(`/api/v1/nodes/${encodeURIComponent(node.id)}`, { method: 'DELETE' });
  const body = await res.text();
  let payload = body;
  try {
    payload = JSON.parse(body);
  } catch {}
  if (!res.ok) {
    status.textContent = `Delete failed (${res.status}): ${String(payload?.detail ?? payload).slice(0, 140)}`;
    return;
  }

  inspector.hidden = true;
  await galaxy.removeNode(node.id); // let it shrink away before the edges move
  graph.nodes = payload.nodes;
  graph.edges = payload.edges;
  galaxy.setEdges(graph.edges);
  refreshTypes();
  refreshDomains();
  refreshRelations();
  refreshTags();
  refreshTagList();
  refreshNodeList();
  status.textContent = `Moved to ${payload.trashed.join(', ')}`;
}

function linkEditor(node) {
  const list = inspector.querySelector('ul');
  const outgoing = new Set(
    graph.edges.filter((e) => e.source === node.id).map((e) => e.target),
  );

  for (const edge of graph.edges.filter((e) => e.source === node.id || e.target === node.id)) {
    const otherId = edge.source === node.id ? edge.target : edge.source;
    const other = graph.nodes.find((n) => n.id === otherId);
    const row = document.createElement('li');
    row.innerHTML =
      '<select class="relation"></select><span class="who"></span><button type="button" class="drop">×</button>';
    const relation = row.querySelector('.relation');
    for (const name of RELATIONS) {
      const option = document.createElement('option');
      option.value = option.textContent = name;
      option.selected = name === edge.type;
      relation.append(option);
    }
    row.querySelector('.who').textContent = other ? other.title : otherId;

    // Only the note that contains the link can change it; the other end is
    // shown for context and marked as belonging elsewhere.
    const mine = outgoing.has(otherId) && edge.source === node.id;
    relation.disabled = !mine;
    row.querySelector('.drop').disabled = !mine;
    if (!mine) row.classList.add('inbound');

    relation.addEventListener('change', () => changeLinks(node, {
      url: `/api/v1/nodes/${encodeURIComponent(node.id)}/links`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: otherId, relation: relation.value }),
      },
    }));
    row.querySelector('.drop').addEventListener('click', () => changeLinks(node, {
      url: `/api/v1/nodes/${encodeURIComponent(node.id)}/links/${encodeURIComponent(otherId)}`,
      init: { method: 'DELETE' },
    }));
    list.append(row);
  }

  const adder = document.createElement('li');
  adder.className = 'add-link';
  adder.innerHTML =
    '<select class="relation"></select><input class="target" list="all-nodes" placeholder="link to…" aria-label="Link to" />';
  const relation = adder.querySelector('.relation');
  for (const name of RELATIONS) {
    const option = document.createElement('option');
    option.value = option.textContent = name;
    relation.append(option);
  }
  const target = adder.querySelector('.target');
  const add = () => {
    const wanted = target.value.trim();
    target.value = '';
    if (!wanted) return;
    const match = graph.nodes.find((n) => n.id === wanted || n.title === wanted);
    if (!match) {
      status.textContent = `No node called "${wanted}"`;
      return;
    }
    changeLinks(node, {
      url: `/api/v1/nodes/${encodeURIComponent(node.id)}/links`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: match.id, relation: relation.value }),
      },
    });
  };
  target.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    add();
  });
  target.addEventListener('blur', add);
  list.append(adder);
}

function refreshNodeList() {
  const list = document.querySelector('#all-nodes');
  list.replaceChildren(...graph.nodes.map((node) => {
    const option = document.createElement('option');
    option.value = node.title;
    option.label = node.id;
    return option;
  }));
}

function showNode(graph, node) {
  if (!node) {
    inspector.hidden = true;
    return;
  }
  inspector.innerHTML = `
    <h2><input class="title" aria-label="Title" /></h2>
    <dl>
      <dt>type</dt><dd class="v-type"></dd>
      <dt>date</dt><dd><input type="date" class="date" aria-label="Date" /></dd>
      <dt>file</dt><dd><button type="button" class="open" title="Open in the macOS default app"></button></dd>
      <dt>importance</dt><dd class="stars" role="group" aria-label="Importance"></dd>
      <dt>domain</dt><dd><select class="domain"></select></dd>
      <dt>tags</dt><dd class="tag-editor">
        <span class="chips"></span>
        <input class="tags" list="all-tags" placeholder="add tag" aria-label="Add a tag" />
      </dd>
    </dl>
    <ul></ul>`;
  if (node.media === 'image') {
    const img = document.createElement('img');
    img.src = `/media/${node.path}`;
    img.alt = node.title;
    img.className = 'thumb';
    inspector.querySelector('h2').after(img);
  }
  inspector.querySelector('.v-type').textContent = node.type ?? '—';
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
  linkEditor(node);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'delete';
  remove.textContent = 'Delete node';
  remove.addEventListener('click', () => deleteNode(node));
  inspector.append(remove);

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

const RELATIONS = ['SPARK', 'RESEARCH', 'ASSEMBLE'];

// Filter bars. Type and domain work the same way, so they are the same code:
// one toggle per value actually present, with its count.
const TYPE_ORDER = ['Project', 'Concept', 'Source', 'Fragment', 'Asset'];
const DOMAIN_ORDER = ['Art', 'Science', 'Philosophy'];

// `keyOf` reads a node's value for this bar; pass null for a bar over edges
// (relations), which are counted instead of nodes.
function filterBar(nav, keyOf, order, colourOf, apply) {
  const count = keyOf
    ? (value) => graph.nodes.filter((node) => keyOf(node) === value).length
    : (value) => graph.edges.filter((edge) => edge.type === value).length;
  const values = order.filter((value) => count(value) > 0);
  if (keyOf) {
    for (const node of graph.nodes) {
      if (!values.includes(keyOf(node))) values.push(keyOf(node));
    }
  }
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
      button.querySelector('.count').textContent = count(button.dataset.value);
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
// Tag chips. The other bars start fully on and narrow as you switch things off;
// tags start off, because a library has far more of them than fit on screen and
// "all tags" is the same as no filter anyway.
const TAG_CHIPS = 14;
const tagsNav = document.querySelector('#tags');
const picked = new Set();

function tagCounts() {
  const counts = new Map();
  for (const node of graph.nodes) {
    for (const tag of node.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  // Most used first, then alphabetical so the row does not reshuffle on every
  // edit that ties two counts.
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function refreshTagList() {
  const list = document.querySelector('#all-tags');
  list.replaceChildren(...tagCounts().map(([tag]) => {
    const option = document.createElement('option');
    option.value = tag;
    return option;
  }));
}

function refreshTags() {
  const counts = tagCounts();
  // A picked tag stays on the bar even if it drops out of the top slice —
  // otherwise the filter would be on with no way to switch it off.
  const visible = counts.slice(0, TAG_CHIPS);
  for (const entry of counts.slice(TAG_CHIPS)) {
    if (picked.has(entry[0])) visible.push(entry);
  }
  for (const tag of picked) {
    if (!counts.some(([name]) => name === tag)) picked.delete(tag);
  }

  tagsNav.replaceChildren(...visible.map(([tag, count]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.tag = tag;
    button.setAttribute('aria-pressed', String(picked.has(tag)));
    button.innerHTML = '<span class="name"></span><span class="count"></span>';
    button.querySelector('.name').textContent = tag;
    button.querySelector('.count').textContent = count;
    return button;
  }));
  tagsNav.hidden = !visible.length;
}

tagsNav.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-tag]');
  if (!button) return;
  const tag = button.dataset.tag;
  if (picked.has(tag)) picked.delete(tag);
  else picked.add(tag);
  for (const b of tagsNav.children) b.setAttribute('aria-pressed', String(picked.has(b.dataset.tag)));
  galaxy.setTags(picked);
});

refreshTags();
refreshTagList();
refreshNodeList();

const refreshRelations = filterBar(
  document.querySelector('#relations'),
  null,
  RELATIONS,
  (relation) => `#${(galaxy.relationColors[relation] ?? 0).toString(16).padStart(6, '0')}`,
  (shown) => galaxy.setRelations(shown),
);

const refreshDomains = filterBar(
  document.querySelector('#domains'),
  (node) => node.domain,
  DOMAIN_ORDER,
  null,
  (shown) => galaxy.setDomains(shown),
);

// Writing a note from inside the galaxy. The node's position is not the click
// position — it comes from the text, like every other node — so the form does
// not pretend otherwise.
const composer = document.querySelector('#composer');
const NODE_TYPES = ['Fragment', 'Concept', 'Source', 'Project', 'Asset'];

for (const type of NODE_TYPES) {
  const option = document.createElement('option');
  option.value = option.textContent = type;
  composer.type.append(option);
}

function openComposer() {
  composer.hidden = false;
  composer.title.focus();
}

function closeComposer() {
  composer.reset();
  composer.hidden = true;
}

document.querySelector('#new-node').addEventListener('click', openComposer);
composer.querySelector('.cancel').addEventListener('click', closeComposer);
galaxy.onEmptyDoubleClick(openComposer);
addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !composer.hidden) closeComposer();
});

composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(composer);
  const title = form.get('title').trim();
  if (!title) return;
  status.textContent = `Writing "${title}"…`;

  const res = await fetch('/api/v1/nodes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: form.get('type'),
      title,
      body: form.get('body'),
      tags: form.get('tags').split(',').map((tag) => tag.trim()).filter(Boolean),
    }),
  });
  const payload = await res.text();
  let parsed = payload;
  try {
    parsed = JSON.parse(payload);
  } catch {}
  if (!res.ok) {
    status.textContent = `Could not write it (${res.status}): ${String(parsed?.detail ?? parsed).slice(0, 140)}`;
    return;
  }

  graph.nodes.forEach((existing) => {
    const fresh = parsed.nodes.find((n) => n.id === existing.id);
    if (fresh) Object.assign(existing, fresh);
  });
  graph.nodes.push(parsed.node);
  graph.edges = parsed.edges;
  galaxy.addNode(parsed.node);
  galaxy.setEdges(graph.edges);
  refreshTypes();
  refreshDomains();
  refreshRelations();
  refreshTags();
  refreshTagList();
  refreshNodeList();
  closeComposer();
  galaxy.focus(parsed.node.id);
  showNode(graph, parsed.node);
  status.textContent = `Wrote ${parsed.wrote}`;
});

// Timeline. Only the temporal view has an axis where "before this month" means
// anything, so the scrubber appears with it and releases the graph when you
// leave.
const timeline = document.querySelector('#timeline');
const scrub = document.querySelector('#scrub');
const when = document.querySelector('#when');
const play = document.querySelector('#play');
const STEP_MS = 420;
const PLAY_SECONDS = 20; // however wide the library's dates are, Play takes about this long

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
// A library spanning 1968 to now is 700 months; one month per tick would take
// five minutes to play through.
const stride = Math.max(1, Math.ceil(months.length / ((PLAY_SECONDS * 1000) / STEP_MS)));

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
    scrub.value = Math.min(Number(scrub.value) + stride, Number(scrub.max));
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
