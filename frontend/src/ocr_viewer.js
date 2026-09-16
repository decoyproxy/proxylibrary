/**
 * The text behind a picture, in the card.
 *
 * A scan of a photobook page and a photograph of a notebook are text to the
 * reader and pixels to everything else, so ingest runs OCR over them and writes
 * what it read into the node's sidecar, fenced between `<!-- ocr -->` markers
 * (backend/ocr.py). Until now that text was only on disk: the card showed the
 * picture and the metadata, and the words in the picture were not in the
 * browser at all.
 *
 * Nothing new is needed on the server to read them. The library folder is
 * already mounted read-only at `/media` so the card can show thumbnails, and a
 * sidecar sits next to its file inside that folder — `Sources/SCAN.jpg` is
 * described by `Sources/SCAN.jpg.md`. This fetches that file and shows what is
 * in it: the machine's reading under one toggle, whatever the reader wrote by
 * hand under another, each with a button that copies the text out.
 *
 * Both sections start closed. The card is read at a glance — type, date, links
 * — and a wall of OCR would bury that; the text is there when it is asked for.
 */

export const OCR_BEGIN = '<!-- ocr -->';
export const OCR_END = '<!-- /ocr -->';

/** Where a node's sidecar lives under `/media`, or null when it has no file. */
export function sidecarPath(node) {
  const path = node?.path;
  if (!path) return null;
  return path.toLowerCase().endsWith('.md') ? path : `${path}.md`;
}

/** Drop the YAML front matter: it is already on the card as type, date, tags. */
export function stripFrontMatter(text) {
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  return end === -1 ? text : text.slice(text.indexOf('\n', end + 1) + 1);
}

/**
 * A sidecar split into what the machine read and what the reader wrote.
 * An unclosed marker is treated as no OCR block rather than swallowing the
 * rest of the file, so a half-written sidecar still shows its notes.
 */
export function splitSidecar(text) {
  const body = stripFrontMatter(text ?? '').trim();
  const begin = body.indexOf(OCR_BEGIN);
  const end = body.indexOf(OCR_END, begin + 1);
  if (begin === -1 || end === -1) return { ocr: '', notes: body };
  return {
    ocr: body.slice(begin + OCR_BEGIN.length, end).trim(),
    // Closing the gap the block leaves behind: what was written above and
    // below it is one text, not two paragraphs with a hole between them.
    notes: `${body.slice(0, begin)}\n${body.slice(end + OCR_END.length)}`
      .replace(/\n{3,}/g, '\n\n').trim(),
  };
}

/**
 * The panels to draw, in order, or none at all. An empty sidecar renders
 * nothing: a toggle that opens onto nothing is worse than no toggle.
 */
export function sections(text) {
  const { ocr, notes } = splitSidecar(text);
  const out = [];
  if (ocr) out.push({ kind: 'ocr', label: 'OCR text', text: ocr });
  if (notes) out.push({ kind: 'note', label: 'Note', text: notes });
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
} = {}) {
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
   * Read `node`'s sidecar and put its panels into `host`, after `before` when
   * one is given. Returns the element, or null when there is nothing to show —
   * a node with no file, no sidecar on disk, or an empty one.
   */
  async function attach(node, host, before = null) {
    const path = sidecarPath(node);
    if (!path || !host) return null;

    const holder = document.createElement('div');
    holder.className = 'sidecar';
    if (before) before.before(holder);
    else host.append(holder);

    let text = '';
    try {
      const res = await fetchImpl(`/media/${path}`);
      if (!res.ok) {
        holder.remove();
        return null; // no sidecar is the ordinary case, not a failure to report
      }
      text = await res.text();
    } catch (error) {
      onStatus(`Could not read ${path}: ${error.message}`);
      holder.remove();
      return null;
    }

    const panels = sections(text);
    if (!panels.length) {
      holder.remove();
      return null;
    }
    holder.append(...panels.map(panel));
    return holder;
  }

  return { attach };
}
