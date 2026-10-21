"""Send images from a student program to the browser terminal.

The runner passes a pipe as SANDBOX_DISPLAY_FD; each message is one JSON line
{"mime", "name", "data" (base64)}. finish() runs when the program ends (normally, or when the
CPU limit stops it) so open matplotlib figures and turtle drawings are still shown.
"""
import base64
import json
import os
import sys

MAX_IMAGES = 20
MAX_BYTES = 700_000

_fd = int(os.environ.get("SANDBOX_DISPLAY_FD") or -1)
_sent = 0
_finishers = []
_finished = False
_warned = set()


def _warn(key, text):
    if key not in _warned:
        _warned.add(key)
        sys.stderr.write(text + "\n")


def send(data, mime, name=""):
    """Show an image (bytes) in the terminal. Returns False if it was not sent."""
    global _sent
    if _fd < 0:
        return False
    if len(data) > MAX_BYTES:
        _warn("big", "(An image was too large to show: keep figures under %d KB.)" % (MAX_BYTES // 1000))
        return False
    if _sent >= MAX_IMAGES:
        _warn("many", "(Only the first %d images are shown.)" % MAX_IMAGES)
        return False
    _sent += 1
    msg = (json.dumps({"mime": mime, "name": name, "data": base64.b64encode(data).decode("ascii")}) + "\n").encode()
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass
    try:
        view = memoryview(msg)
        while view:
            n = os.write(_fd, view)
            view = view[n:]
    except OSError:
        return False
    return True


def on_finish(fn):
    """Run fn when the program ends (used by the turtle module)."""
    _finishers.append(fn)


def finish():
    global _finished
    if _finished:
        return
    _finished = True
    for fn in list(_finishers):
        try:
            fn()
        except Exception:
            pass
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is not None:
        try:
            if "_sandbox_mpl" in str(plt.get_backend()):
                plt.show()
        except Exception:
            pass
