/**
 * The text behind a picture, in the card.
 *
 * A scan of a photobook page and a photograph of a notebook are text to the
 * reader and pixels to everything else, so ingest runs OCR over them and writes
 * what it read into the node's sidecar, fenced between `<!-- ocr -->` markers
 * (backend/ocr.py). The card showed the picture and none of the words.
 *
 * Reading that file is the server's job, not this module's. `/api/v1/nodes/
 * {id}/ocr` (backend/routes_nodes.py) opens the sidecar, strips the front
 * matter and the markers, and answers with the machine's reading and the
 * reader's own notes already apart:
 *
 *   { id, has_ocr, ocr_text, has_note, note_text }
 *
 * This once fetched the sidecar from `/media` and split it here, which put the
 * same marker grammar in two languages — one of them would have drifted. The
 * rule lives next to ocr.py now, and this draws what comes back: each text
 * behind a closed toggle with a button that copies it out.
 *
 * Both sections start closed. The card is read at a glance — type, date, links
 * — and a wall of OCR would bury that; the text is there when it is asked for.
 *
 * One card is open at a time, so one request is in flight at a time: opening a
 * node abandons the one before it. Without that, clicking through nodes faster
 * than the server answers lets an earlier reply land in a later card — the
 * picture of one scan above the words of another, which is worse than no words
 * at all because nothing about it looks wrong.
 */

/** Where the text for a node comes from. */
export function ocrUrl(node) {
  return node?.id ? `/api/v1/nodes/${encodeURIComponent(node.id)}/ocr` : null;
}

/**
 * The panels to draw, in order, or none at all. A node whose sidecar holds
 * neither renders nothing: a toggle that opens onto nothing is worse than no
 * toggle. `has_ocr`/`has_note` are believed only as far as the text agrees —
 * the flags are a convenience, the text is the fact.
 */
export function sections(payload) {
  const out = [];
  const ocr = (payload?.ocr_text ?? '').trim();
  const note = (payload?.note_text ?? '').trim();
  if (ocr) out.push({ kind: 'ocr', label: 'OCR text', text: ocr });
  if (note) out.push({ kind: 'note', label: 'Note', text: note });
  return out;
}

async function copyText(text, clipboard) {
  if (!clipboard?.writeText) throw new Error('this browser keeps the clipboard to itself');
  await clipboard.writeText(text);
}

export function createOcrViewer({
  fetch: fetchImpl = fetch,
  clipboard = navigator.clipboard,
  onStatus = () => {},
  AbortController: AbortControllerImpl = AbortController,
} = {}) {
  // Which card the answer belongs to. A reply for anything but the current
  // generation is dropped even if the abort lost the race to it.
  let generation = 0;
  let inFlight = null;

  function cancel() {
    generation += 1;
    inFlight?.abort();
    inFlight = null;
  }

  function panel({ label, text }) {
    const section = document.createElement('section');
    section.className = 'panel';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'reveal';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = `${label} · ${text.length} chars`;

    const body = document.createElement('pre');
    body.className = 'text';
    body.textContent = text;
    body.hidden = true;

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'copy';
    copy.textContent = 'Copy text';
    copy.hidden = true;
    copy.addEventListener('click', async () => {
      try {
        await copyText(text, clipboard);
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy text'; }, 1200);
      } catch (error) {
        copy.textContent = 'Copy text';
        onStatus(`Could not copy: ${error.message}`);
      }
    });

    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      body.hidden = open;
      copy.hidden = open;
    });

    section.append(toggle, body, copy);
    return section;
  }

  /**
   * Ask the server what `node`'s file says and put the panels into `host`,
   * before `before` when one is given. Returns the element, or null when there
   * is nothing to show — a node with no file (the route answers 404), a sidecar
   * with no text in it, or a backend that cannot be reached.
   */
  async function attach(node, host, before = null) {
    cancel(); // whatever the last card asked for, nobody is waiting for it now
    const url = ocrUrl(node);
    if (!url || !host) return null;

    const mine = ++generation;
    const controller = new AbortControllerImpl();
    inFlight = controller;

    const holder = document.createElement('div');
    holder.className = 'sidecar';
    if (before) before.before(holder);
    else host.append(holder);

    let payload = null;
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      if (mine !== generation) {
        holder.remove(); // a later card is on screen; this answer is for the last one
        return null;
      }
      if (!res.ok) {
        holder.remove();
        return null; // 404 is the ordinary case: a node with no file of its own
      }
      payload = await res.json();
    } catch (error) {
      holder.remove();
      // An abandoned request is not a failure to report: we abandoned it.
      if (mine !== generation || error.name === 'AbortError') return null;
      onStatus(`Could not read the text for ${node.id}: ${error.message}`);
      return null;
    }
    if (mine !== generation) {
      holder.remove();
      return null;
    }

    const panels = sections(payload);
    if (!panels.length) {
      holder.remove();
      return null;
    }
    holder.append(...panels.map(panel));
    return holder;
  }

  return { attach, cancel };
}
