/**
 * A year range you drag, over the whole library.
 *
 * The scrubber in `#timeline` answers "what had been collected by then" — one
 * edge, moving forward, and only in the temporal view where an axis of time is
 * on screen. This answers a different question: "what came out of 2023 and
 * 2024", two edges, in any view. Both are about time and neither replaces the
 * other, so they are kept apart: the scrubber owns the galaxy's `timeOn` flag
 * and this owns `yearOn`, and a node has to pass both.
 *
 * A node with no date stays visible whatever the range says. That follows the
 * scrubber, which also lets undated nodes through, and it is the safer of the
 * two readings — a Concept nobody has dated is not evidence about any year, and
 * having it vanish when the handle moves reads as a bug.
 */

/** The years present in a library, oldest first. Undated nodes have no year. */
export function yearsOf(nodes) {
  const years = new Set();
  for (const node of nodes ?? []) {
    const year = Number((node.date ?? '').slice(0, 4));
    if (Number.isInteger(year) && year > 0) years.add(year);
  }
  return [...years].sort((a, b) => a - b);
}

export function yearOf(node) {
  const year = Number((node?.date ?? '').slice(0, 4));
  return Number.isInteger(year) && year > 0 ? year : null;
}

/** Undated nodes pass; dated ones have to fall inside. */
export function inRange(node, from, to) {
  const year = yearOf(node);
  return year === null || (year >= from && year <= to);
}

/** Handles cross over when dragged past each other; read them in order instead. */
export function orderRange(a, b) {
  return a <= b ? [a, b] : [b, a];
}

export function countInRange(nodes, from, to) {
  return (nodes ?? []).filter((node) => inRange(node, from, to)).length;
}

/**
 * Two handles over `host`, and `onChange({ from, to, all })` whenever they move.
 * `all` is true when the range covers everything the library has, which is the
 * caller's cue that there is no constraint to apply.
 *
 * Returns null when there is nothing to range over — a library of one year, or
 * of none, gets no slider rather than a slider that cannot move.
 */
export function createTimelineFilter({ host, nodes, onChange = () => {} }) {
  const years = yearsOf(nodes);
  if (years.length < 2) {
    if (host) host.hidden = true;
    return null;
  }

  const first = years[0];
  const last = years[years.length - 1];
  let from = first;
  let to = last;

  host.hidden = false;
  host.replaceChildren();

  const label = document.createElement('output');
  label.className = 'span';

  function slider(value, aria) {
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(first);
    input.max = String(last);
    input.step = '1';
    input.value = String(value);
    input.setAttribute('aria-label', aria);
    return input;
  }

  const lower = slider(first, 'From year');
  const upper = slider(last, 'To year');

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'reset';
  reset.textContent = 'All years';

  function redraw() {
    const all = from === first && to === last;
    label.textContent = all
      ? `${first}–${last} · all ${countInRange(nodes, from, to)}`
      : `${from}–${to} · ${countInRange(nodes, from, to)}`;
    reset.hidden = all;
    host.setAttribute('data-all', String(all));
  }

  function moved() {
    [from, to] = orderRange(Number(lower.value), Number(upper.value));
    redraw();
    onChange({ from, to, all: from === first && to === last });
  }

  lower.addEventListener('input', moved);
  upper.addEventListener('input', moved);
  reset.addEventListener('click', () => {
    lower.value = String(first);
    upper.value = String(last);
    moved();
  });

  host.append(lower, upper, label, reset);
  redraw();

  return {
    values: () => ({ from, to, all: from === first && to === last }),
    bounds: () => ({ first, last }),
    /** The ids a galaxy should keep, or null when the range constrains nothing. */
    ids() {
      if (from === first && to === last) return null;
      return new Set(nodes.filter((node) => inRange(node, from, to)).map((node) => node.id));
    },
    reset: () => reset.click(),
  };
}
