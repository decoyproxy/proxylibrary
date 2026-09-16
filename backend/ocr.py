"""Read the text in pictures, for the pages that carry none of their own.

A scanned photobook page and a photograph of a notebook are text as far as the
reader is concerned; to the ingest they are a wall of pixels that embeds as
nothing in particular. This pulls the words out.

The engine is macOS's own Vision framework: no model to download, no binary to
install, and it reads Korean, Japanese and Chinese alongside Latin scripts,
which matters for a library written in Korean. pytesseract is used instead if
it happens to be installed and Vision is not; with neither, ingest carries on
without OCR rather than failing.
"""
import os

LANGUAGES = [lang.strip() for lang in
             os.environ.get("OCR_LANGUAGES", "ko-KR,en-US,ja-JP").split(",") if lang.strip()]
ENABLED = os.environ.get("OCR", "1") != "0"
# A PDF with less text than this per page is treated as scanned rather than
# typeset — a real page of prose runs to thousands of characters.
MIN_CHARS = int(os.environ.get("OCR_MIN_CHARS", 180))
PDF_PAGES = int(os.environ.get("OCR_PDF_PAGES", 5))
DPI = int(os.environ.get("OCR_DPI", 200))

BEGIN = "<!-- ocr -->"
END = "<!-- /ocr -->"


def engine():
    """-> a name, or None when this machine cannot read pictures."""
    if not ENABLED:
        return None
    try:
        import Vision  # noqa: F401

        return "vision"
    except ImportError:
        pass
    try:
        import pytesseract  # noqa: F401

        return "tesseract"
    except ImportError:
        return None


def _vision(data):
    """Text out of image bytes, via the OS. Lines come back in reading order."""
    import Vision
    from Foundation import NSData

    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(0)  # accurate, not fast: these are read once
    request.setRecognitionLanguages_(LANGUAGES)
    request.setUsesLanguageCorrection_(True)
    handler = Vision.VNImageRequestHandler.alloc().initWithData_options_(
        NSData.dataWithBytes_length_(data, len(data)), None
    )
    handler.performRequests_error_([request], None)
    lines = []
    for observation in request.results() or []:
        candidates = observation.topCandidates_(1)
        if candidates:
            lines.append(str(candidates[0].string()))
    return "\n".join(lines)


def _tesseract(data):
    import io

    import pytesseract
    from PIL import Image

    return pytesseract.image_to_string(Image.open(io.BytesIO(data)))


def read_image(path):
    """OCR one image file."""
    reader = {"vision": _vision, "tesseract": _tesseract}.get(engine())
    return reader(path.read_bytes()).strip() if reader else ""


def read_pdf(path, pages=PDF_PAGES):
    """OCR the first few pages of a PDF by rendering them to images first."""
    reader = {"vision": _vision, "tesseract": _tesseract}.get(engine())
    if not reader:
        return ""
    import pymupdf

    out = []
    with pymupdf.open(path) as document:
        for page in list(document)[:pages]:
            out.append(reader(page.get_pixmap(dpi=DPI).tobytes("png")).strip())
    return "\n\n".join(part for part in out if part)


def needed(kind, text):
    """Would OCR add anything? Images always; PDFs only when they came up empty."""
    if kind == "image":
        return True
    return kind == "pdf" and len(text.strip()) < MIN_CHARS


def block(text):
    return f"{BEGIN}\n{text.strip()}\n{END}" if text.strip() else ""


def merge(sidecar, text):
    """Put the OCR text into a sidecar's body, replacing an earlier run's.

    Fenced with markers so re-reading a file overwrites what the machine wrote
    last time and leaves anything the reader wrote around it alone.
    """
    fresh = block(text)
    if BEGIN in sidecar and END in sidecar:
        head, rest = sidecar.split(BEGIN, 1)
        _, tail = rest.split(END, 1)
        return f"{head}{fresh}{tail}".strip() + "\n"
    if not fresh:
        return sidecar
    return (sidecar.rstrip() + "\n\n" + fresh).strip() + "\n"


def demo():
    assert needed("image", "anything")
    assert needed("pdf", "short")
    assert not needed("pdf", "x" * 500)
    assert not needed("text", "")

    kept = "written by hand\n\n" + block("first pass") + "\n\nalso by hand"
    again = merge(kept, "second pass")
    assert "second pass" in again and "first pass" not in again, again
    assert "written by hand" in again and "also by hand" in again
    assert merge("nothing yet", "") == "nothing yet"
    print(f"ocr ok (engine: {engine() or 'none available'})")


if __name__ == "__main__":
    demo()
