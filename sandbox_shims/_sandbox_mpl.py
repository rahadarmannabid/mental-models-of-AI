"""Matplotlib backend for the browser IDE (MPLBACKEND=module://_sandbox_mpl).

Renders with Agg; plt.show() sends every open figure to the terminal as a PNG and closes it.
"""
import atexit
import io

from matplotlib._pylab_helpers import Gcf
from matplotlib.backend_bases import FigureManagerBase
from matplotlib.backends.backend_agg import FigureCanvasAgg

import _sandbox_display


class FigureManager(FigureManagerBase):
    def show(self):  # plt.pause() / fig.show(): nothing to open, figures are sent by plt.show()
        pass


class FigureCanvas(FigureCanvasAgg):
    manager_class = FigureManager


def _send(fig, number):
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=100, bbox_inches="tight")
    _sandbox_display.send(buf.getvalue(), "image/png", "figure-%s.png" % number)


def show(*args, **kwargs):
    for manager in Gcf.get_all_fig_managers():
        try:
            _send(manager.canvas.figure, manager.num)
        except Exception as exc:  # a broken figure should not hide the others
            import sys
            sys.stderr.write("Could not draw figure %s: %s\n" % (manager.num, exc))
    Gcf.destroy_all()


# Figures never passed to plt.show() are shown when the program ends. Registered here, after
# matplotlib's own exit handler (which closes all figures), so it runs before it.
atexit.register(_sandbox_display.finish)
