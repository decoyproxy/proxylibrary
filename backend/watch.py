"""Re-ingest the library whenever its files change.

    python watch.py

Runs as its own process next to the API server. A change does not re-ingest
immediately: edits arrive in bursts (editors write, rename, touch), so it waits
for QUIET seconds of no further events and then re-runs the whole pipeline.

Only the changed files are re-embedded, and only they move in the galaxy — see
ingest.build. Because this process is long-lived, the models stay loaded, so a
save costs a second or two rather than the fifteen a cold run spends loading
them.
"""
import time

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

import ingest

QUIET = 3.0  # seconds of calm before re-ingesting
POLL = 0.5


class Debounced(FileSystemEventHandler):
    def __init__(self):
        self.pending = None

    def on_any_event(self, event):
        if event.is_directory:
            return
        path = getattr(event, "dest_path", "") or event.src_path
        name = path.rsplit("/", 1)[-1]
        if name.startswith(".") or not name:
            return
        self.pending = time.monotonic()
        print(f"  {event.event_type}: {name}", flush=True)


def main():
    if not ingest.LIBRARY.is_dir():
        raise SystemExit(f"nothing to watch at {ingest.LIBRARY}")

    handler = Debounced()
    observer = Observer()
    observer.schedule(handler, str(ingest.LIBRARY), recursive=True)
    observer.start()
    print(f"watching {ingest.LIBRARY} (ctrl-c to stop)", flush=True)
    try:
        while True:
            time.sleep(POLL)
            if handler.pending and time.monotonic() - handler.pending >= QUIET:
                handler.pending = None
                try:
                    ingest.main()
                except Exception as error:  # a broken file shouldn't kill the watcher
                    print(f"ingest failed: {error}", flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        observer.stop()
        observer.join()


if __name__ == "__main__":
    main()
