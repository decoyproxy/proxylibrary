import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countInRange,
  createTimelineFilter,
  inRange,
  orderRange,
  yearOf,
  yearsOf,
} from './timeline_filter.js';

const LIBRARY = [
  { id: 'A', date: '2021-03-02' },
  { id: 'B', date: '2023-11-30' },
  { id: 'C', date: '2023-01-01' },
  { id: 'D', date: '2026-09-17' },
  { id: 'E' }, // a concept nobody has dated
  { id: 'F', date: '' },
];

function fakeElement(tag = 'div') {
  return {
    tag,
    children: [],
    attributes: {},
    listeners: {},
    className: '',
    textContent: '',
    value: '',
    type: '',
    hidden: false,
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name]; },
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); },
    dispatch(type) { for (const handler of this.listeners[type] ?? []) handler(); },
    click() { this.dispatch('click'); },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
  };
}

function fakeHost() {
  globalThis.document = { createElement: (tag) => fakeElement(tag) };
  return fakeElement('nav');
}

function handles(host) {
  const [lower, upper] = host.children.filter((child) => child.type === 'range');
  return { lower, upper, label: host.children.find((c) => c.className === 'span') };
}

test('a year is read off the date, and undated nodes have none', () => {
  assert.equal(yearOf({ date: '2023-11-30' }), 2023);
  assert.equal(yearOf({ date: '' }), null);
  assert.equal(yearOf({}), null);
  assert.deepEqual(yearsOf(LIBRARY), [2021, 2023, 2026]);
  assert.deepEqual(yearsOf([]), []);
});

test('an undated node is not evidence about any year, so it stays', () => {
  assert.equal(inRange({ date: '2023-05-05' }, 2023, 2026), true);
  assert.equal(inRange({ date: '2021-05-05' }, 2023, 2026), false);
  assert.equal(inRange({}, 2023, 2023), true);
  assert.equal(countInRange(LIBRARY, 2023, 2023), 4); // B, C, and the two undated
});

test('handles dragged past each other still read as a range', () => {
  assert.deepEqual(orderRange(2021, 2026), [2021, 2026]);
  assert.deepEqual(orderRange(2026, 2021), [2021, 2026]);
});

test('a library of one year gets no slider at all', () => {
  const host = fakeHost();
  const filter = createTimelineFilter({ host, nodes: [{ id: 'A', date: '2026-01-01' }] });
  assert.equal(filter, null);
  assert.equal(host.hidden, true);
});

test('moving a handle reports the range and narrows the ids', () => {
  const host = fakeHost();
  const seen = [];
  const filter = createTimelineFilter({ host, nodes: LIBRARY, onChange: (range) => seen.push(range) });

  assert.deepEqual(filter.bounds(), { first: 2021, last: 2026 });
  assert.deepEqual(filter.values(), { from: 2021, to: 2026, all: true });
  assert.equal(filter.ids(), null, 'the full range constrains nothing');

  const { lower, upper } = handles(host);
  upper.value = '2023';
  upper.dispatch('input');

  assert.deepEqual(seen, [{ from: 2021, to: 2023, all: false }]);
  assert.deepEqual([...filter.ids()].sort(), ['A', 'B', 'C', 'E', 'F']);

  lower.value = '2023';
  lower.dispatch('input');
  assert.deepEqual([...filter.ids()].sort(), ['B', 'C', 'E', 'F']);
});

test('crossing the handles reads as the range between them', () => {
  const host = fakeHost();
  const filter = createTimelineFilter({ host, nodes: LIBRARY });
  const { lower, upper } = handles(host);

  lower.value = '2026';
  lower.dispatch('input');

  assert.deepEqual(filter.values(), { from: 2026, to: 2026, all: false });
  assert.deepEqual([...filter.ids()].sort(), ['D', 'E', 'F']);
  assert.equal(upper.value, '2026');
});

test('All years puts the range back and stops constraining', () => {
  const host = fakeHost();
  const seen = [];
  const filter = createTimelineFilter({ host, nodes: LIBRARY, onChange: (range) => seen.push(range) });
  const { lower } = handles(host);

  lower.value = '2023';
  lower.dispatch('input');
  assert.notEqual(filter.ids(), null);

  filter.reset();

  assert.deepEqual(filter.values(), { from: 2021, to: 2026, all: true });
  assert.equal(filter.ids(), null);
  assert.equal(seen.at(-1).all, true);
});

test('the label counts what is in range and says when it is everything', () => {
  const host = fakeHost();
  const filter = createTimelineFilter({ host, nodes: LIBRARY });
  const { label } = handles(host);
  assert.equal(label.textContent, '2021–2026 · all 6');

  const { upper } = handles(host);
  upper.value = '2021';
  upper.dispatch('input');
  assert.equal(label.textContent, '2021–2021 · 3'); // A, and the two undated
  assert.equal(filter.values().all, false);
});
