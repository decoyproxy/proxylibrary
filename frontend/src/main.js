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
    </dl>
    <ul></ul>`;
  inspector.querySelector('h2').textContent = node.title;
  for (const key of ['type', 'domain', 'importance', 'date']) {
    inspector.querySelector(`.v-${key}`).textContent = node[key] ?? '—';
  }
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

document.querySelector('#views').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-view]');
  if (!button) return;
  for (const b of document.querySelectorAll('#views button')) b.classList.toggle('active', b === button);
  galaxy.setView(button.dataset.view);
});
