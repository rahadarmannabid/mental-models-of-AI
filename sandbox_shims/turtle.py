"""Turtle graphics for the browser IDE.

The standard turtle module needs a desktop window (Tk), which a server does not have. This module
offers the same commands, records what the turtles draw, and when the program calls done(),
mainloop() or exitonclick() (or simply ends) shows the drawing in the terminal as an SVG that
replays it at the turtles' speed. Keyboard, mouse and timer events are not available.
"""
import math
import re

import _sandbox_display

__all__ = ["Turtle", "Pen", "RawTurtle", "RawPen", "Screen", "TurtleScreen", "Vec2D", "Terminator",
           "done", "mainloop", "exitonclick", "bye"]


class Terminator(Exception):
    pass


class TurtleGraphicsError(Exception):
    pass


class Vec2D(tuple):
    def __new__(cls, x, y):
        return tuple.__new__(cls, (x, y))

    def __add__(self, other):
        return Vec2D(self[0] + other[0], self[1] + other[1])

    def __sub__(self, other):
        return Vec2D(self[0] - other[0], self[1] - other[1])

    def __mul__(self, other):
        if isinstance(other, Vec2D):
            return self[0] * other[0] + self[1] * other[1]
        return Vec2D(self[0] * other, self[1] * other)

    __rmul__ = __mul__

    def __neg__(self):
        return Vec2D(-self[0], -self[1])

    def __abs__(self):
        return math.hypot(self[0], self[1])

    def rotate(self, angle):
        a = math.radians(angle)
        c, s = math.cos(a), math.sin(a)
        return Vec2D(self[0] * c - self[1] * s, self[0] * s + self[1] * c)

    def __repr__(self):
        return "(%.2f,%.2f)" % self


_HEX_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}){1,2}$")
MAX_ITEMS = 4000  # lines, dots and text recorded; beyond that the drawing is too big to send
_SPEEDS = {"fastest": 0, "fast": 10, "normal": 6, "slow": 3, "slowest": 1}


def _fmt(v):
    return ("%.2f" % v).rstrip("0").rstrip(".")


def _esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


# ── The screen: one per program, shared by every turtle ──────────────────────

class _Screen:
    def __init__(self):
        self._reset_state()

    def _reset_state(self):
        self._bg = "white"
        self._size = None          # (width, height) from setup()
        self._title = ""
        self._cmode = 1.0
        self._animate = True       # tracer(0) turns the replay off
        self._turtles = []
        self.items = []            # drawing in z-order: dicts with "step"
        self.step = 0
        self.version = 0
        self.shown_version = 0

    # colours
    def _color(self, args):
        if len(args) == 1:
            args = args[0]
        if isinstance(args, str):
            c = args.strip()
            if _HEX_RE.match(c):
                return c
            name = c.lower().replace(" ", "")
            if re.match(r"^[a-z]+[0-9]*$", name):
                return name
            raise TurtleGraphicsError("bad color string: %s" % c)
        try:
            r, g, b = args
        except (TypeError, ValueError):
            raise TurtleGraphicsError("bad color arguments: %r" % (args,))
        scale = 255.0 / self._cmode
        vals = [int(round(v * scale)) for v in (r, g, b)]
        if any(v < 0 or v > 255 for v in vals):
            raise TurtleGraphicsError("bad color sequence: %r" % (args,))
        return "#%02x%02x%02x" % tuple(vals)

    def _changed(self):
        self.version += 1

    def _add(self, item, at=None):
        if len(self.items) >= MAX_ITEMS:
            _sandbox_display._warn("turtle-big", "(Turtle: the drawing has more than %d parts; only the first %d are shown.)"
                                   % (MAX_ITEMS, MAX_ITEMS))
            return
        self.step += 1
        item.setdefault("step", self.step)
        if at is None:
            self.items.append(item)
        else:
            self.items.insert(at, item)
        self._changed()

    # screen methods
    def bgcolor(self, *args):
        if not args:
            return self._bg
        self._bg = self._color(args)
        self._changed()

    def setup(self, width=0.5, height=0.75, startx=None, starty=None):
        w = width * 800 if isinstance(width, float) and width <= 1 else width
        h = height * 600 if isinstance(height, float) and height <= 1 else height
        self._size = (max(50, int(w)), max(50, int(h)))

    def screensize(self, canvwidth=None, canvheight=None, bg=None):
        if bg is not None:
            self.bgcolor(bg)
        if canvwidth is None and canvheight is None:
            return self._size or (640, 480)
        self._size = (int(canvwidth or 640), int(canvheight or 480))

    def title(self, titlestring):
        self._title = str(titlestring)

    def colormode(self, cmode=None):
        if cmode is None:
            return self._cmode
        if cmode not in (1.0, 255, 1):
            raise TurtleGraphicsError("colormode must be 1.0 or 255")
        self._cmode = 255 if cmode == 255 else 1.0

    def tracer(self, n=None, delay=None):
        if n is None:
            return 1 if self._animate else 0
        self._animate = bool(n)

    def update(self):
        pass

    def delay(self, delay=None):
        return 0 if delay is None else None

    def mode(self, mode=None):
        return "standard" if mode is None else None

    def window_width(self):
        return (self._size or (640, 480))[0]

    def window_height(self):
        return (self._size or (640, 480))[1]

    def turtles(self):
        return list(self._turtles)

    def clear(self):
        self.items = []
        self._changed()

    clearscreen = clear

    def reset(self):
        for t in self._turtles:
            t.reset()

    resetscreen = reset

    def textinput(self, title, prompt):
        try:
            return input("%s " % prompt)
        except EOFError:
            return None

    def numinput(self, title, prompt, default=None, minval=None, maxval=None):
        while True:
            try:
                text = input("%s " % prompt)
            except EOFError:
                return default
            try:
                v = float(text)
            except ValueError:
                print("Please type a number.")
                continue
            if (minval is not None and v < minval) or (maxval is not None and v > maxval):
                print("Please type a number between %s and %s." % (minval, maxval))
                continue
            return v

    def _no_events(self, *args, **kwargs):
        _sandbox_display._warn("turtle-events", "(Turtle: keyboard, mouse and timer events are not "
                                               "available in the browser terminal, so they are ignored.)")

    listen = onkey = onkeypress = onkeyrelease = onclick = onscreenclick = onrelease = ontimer = _no_events

    def register_shape(self, name, shape=None):
        pass

    addshape = register_shape

    def getshapes(self):
        return ["arrow", "blank", "circle", "classic", "square", "triangle", "turtle"]

    def getcanvas(self):
        raise TurtleGraphicsError("The drawing canvas is not available in the browser terminal.")

    def done(self):
        show()

    mainloop = done

    def exitonclick(self):
        show()

    def bye(self):
        show()


_screen = None


def Screen():
    global _screen
    if _screen is None:
        _screen = _Screen()
    return _screen


TurtleScreen = Screen


# ── Turtles ──────────────────────────────────────────────────────────────────

class Turtle:
    _ids = 0

    def __init__(self, shape="classic", undobuffersize=1000, visible=True, canvas=None):
        Turtle._ids += 1
        self._id = Turtle._ids
        self.screen = Screen()
        self.screen._turtles.append(self)
        self._shape = shape
        self._visible = visible
        self._full = 360.0
        self._home()
        self._pencolor = "black"
        self._fillcolor = "black"
        self._width = 1
        self._down = True
        self._speed = 3
        self._fill = None

    def _home(self):
        self._x, self._y, self._h = 0.0, 0.0, 0.0  # heading in degrees, 0 = east, counter-clockwise

    # motion
    def _move_to(self, x, y, draw=True):
        x, y = float(x), float(y)
        if draw and self._down and (x, y) != (self._x, self._y):
            self.screen._add({"kind": "line", "tid": self._id, "pts": [(self._x, self._y), (x, y)],
                              "color": self._pencolor, "width": self._width, "speed": self._speed})
        if self._fill is not None:
            self._fill["pts"].append((x, y))
        self._x, self._y = x, y
        self.screen._changed()

    def forward(self, distance):
        a = math.radians(self._h)
        self._move_to(self._x + distance * math.cos(a), self._y + distance * math.sin(a))

    fd = forward

    def backward(self, distance):
        self.forward(-distance)

    bk = back = backward

    def _rotate(self, angle):
        self._h = (self._h + angle * 360.0 / self._full) % 360.0
        self.screen._changed()

    def left(self, angle):
        self._rotate(angle)

    lt = left

    def right(self, angle):
        self._rotate(-angle)

    rt = right

    def goto(self, x, y=None):
        if y is None:
            x, y = x
        self._move_to(x, y)

    setpos = setposition = goto

    def teleport(self, x=None, y=None, *, fill_gap=False):
        self._move_to(self._x if x is None else x, self._y if y is None else y, draw=False)

    def setx(self, x):
        self._move_to(x, self._y)

    def sety(self, y):
        self._move_to(self._x, y)

    def setheading(self, to_angle):
        self._h = (to_angle * 360.0 / self._full) % 360.0

    seth = setheading

    def home(self):
        self._move_to(0, 0)
        self._h = 0.0

    def circle(self, radius, extent=None, steps=None):
        # Same polygon approximation as the standard module, so headings and end points match.
        if extent is None:
            extent = self._full
        if steps is None:
            frac = abs(extent) / self._full
            steps = 1 + int(min(11 + abs(radius) / 6.0, 59.0) * frac)
        w = 1.0 * extent / steps
        w2 = 0.5 * w
        length = 2.0 * radius * math.sin(math.radians(w2 * 360.0 / self._full))
        if radius < 0:
            length, w, w2 = -length, -w, -w2
        self._rotate(w2)
        for _ in range(steps):
            self.forward(length)
            self._rotate(w)
        self._rotate(-w2)

    def dot(self, size=None, *color):
        if size is not None and not isinstance(size, (int, float)):
            color, size = (size,) + color, None
        if size is None:
            size = max(self._width + 4, self._width * 2)
        c = self.screen._color(color) if color else self._pencolor
        self.screen._add({"kind": "dot", "tid": self._id, "x": self._x, "y": self._y, "r": size / 2.0,
                          "color": c, "speed": self._speed})

    def stamp(self):
        self.screen._add({"kind": "stamp", "tid": self._id, "x": self._x, "y": self._y, "h": self._h,
                          "color": self._pencolor, "fill": self._fillcolor, "speed": self._speed})
        return self.screen.step

    def clearstamp(self, stampid):
        self.screen.items = [i for i in self.screen.items if not (i["kind"] == "stamp" and i["step"] == stampid)]

    def clearstamps(self, n=None):
        self.screen.items = [i for i in self.screen.items if not (i["kind"] == "stamp" and i["tid"] == self._id)]

    def write(self, arg, move=False, align="left", font=("Arial", 8, "normal")):
        font = tuple(font) + ("Arial", 8, "normal")[len(tuple(font)):]
        self.screen._add({"kind": "text", "tid": self._id, "x": self._x, "y": self._y, "text": str(arg),
                          "align": align, "font": font, "color": self._pencolor, "speed": self._speed})

    # pen
    def penup(self):
        self._down = False

    pu = up = penup

    def pendown(self):
        self._down = True

    pd = down = pendown

    def isdown(self):
        return self._down

    def pensize(self, width=None):
        if width is None:
            return self._width
        self._width = max(0, width)

    width = pensize

    def pencolor(self, *args):
        if not args:
            return self._pencolor
        self._pencolor = self.screen._color(args)

    def fillcolor(self, *args):
        if not args:
            return self._fillcolor
        self._fillcolor = self.screen._color(args)

    def color(self, *args):
        if not args:
            return self._pencolor, self._fillcolor
        if len(args) == 2 and not all(isinstance(a, (int, float)) for a in args):
            self._pencolor = self.screen._color((args[0],))
            self._fillcolor = self.screen._color((args[1],))
        else:
            self._pencolor = self._fillcolor = self.screen._color(args)

    def pen(self, pen=None, **pendict):
        if pen is None and not pendict:
            return {"shown": self._visible, "pendown": self._down, "pencolor": self._pencolor,
                    "fillcolor": self._fillcolor, "pensize": self._width, "speed": self._speed}
        opts = dict(pen or {}, **pendict)
        if "pendown" in opts:
            self._down = bool(opts["pendown"])
        if "pencolor" in opts:
            self.pencolor(opts["pencolor"])
        if "fillcolor" in opts:
            self.fillcolor(opts["fillcolor"])
        if "pensize" in opts:
            self.pensize(opts["pensize"])
        if "speed" in opts:
            self.speed(opts["speed"])
        if "shown" in opts:
            self._visible = bool(opts["shown"])

    def begin_fill(self):
        self._fill = {"kind": "fill", "tid": self._id, "pts": [(self._x, self._y)], "at": len(self.screen.items)}

    def end_fill(self):
        f, self._fill = self._fill, None
        if f and len(f["pts"]) > 2:
            # Under the outline drawn while filling, but revealed when the fill is complete.
            self.screen._add({"kind": "fill", "tid": self._id, "pts": f["pts"], "color": self._fillcolor,
                              "speed": self._speed}, at=min(f["at"], len(self.screen.items)))

    def filling(self):
        return self._fill is not None

    # state
    def position(self):
        return Vec2D(self._x, self._y)

    pos = position

    def xcor(self):
        return self._x

    def ycor(self):
        return self._y

    def heading(self):
        return self._h * self._full / 360.0

    def towards(self, x, y=None):
        if y is None:
            x, y = x
        return (math.degrees(math.atan2(y - self._y, x - self._x)) % 360.0) * self._full / 360.0

    def distance(self, x, y=None):
        if y is None:
            x, y = x
        return math.hypot(x - self._x, y - self._y)

    def degrees(self, fullcircle=360.0):
        self._full = float(fullcircle)

    def radians(self):
        self._full = 2 * math.pi

    def speed(self, speed=None):
        if speed is None:
            return self._speed
        if isinstance(speed, str):
            speed = _SPEEDS.get(speed, 3)
        self._speed = int(speed) if 0.5 < speed < 10.5 else 0

    def hideturtle(self):
        self._visible = False

    ht = hideturtle

    def showturtle(self):
        self._visible = True

    st = showturtle

    def isvisible(self):
        return self._visible

    def shape(self, name=None):
        if name is None:
            return self._shape
        self._shape = name

    def shapesize(self, stretch_wid=None, stretch_len=None, outline=None):
        return (1, 1, 1) if stretch_wid is None else None

    turtlesize = shapesize

    def tilt(self, angle):
        pass

    def settiltangle(self, angle):
        pass

    def clear(self):
        self.screen.items = [i for i in self.screen.items if i.get("tid") != self._id]
        self.screen._changed()

    def reset(self):
        self.clear()
        self._home()
        self._pencolor = self._fillcolor = "black"
        self._width, self._down = 1, True

    def undo(self):
        for i in range(len(self.screen.items) - 1, -1, -1):
            if self.screen.items[i].get("tid") == self._id:
                del self.screen.items[i]
                self.screen._changed()
                return

    def getscreen(self):
        return self.screen

    def getturtle(self):
        return self

    getpen = getturtle

    def clone(self):
        t = Turtle(self._shape, visible=self._visible)
        for k in ("_x", "_y", "_h", "_pencolor", "_fillcolor", "_width", "_down", "_speed", "_full"):
            setattr(t, k, getattr(self, k))
        return t

    def onclick(self, *args, **kwargs):
        self.screen._no_events()

    onrelease = ondrag = onclick

    def done(self):
        show()


Pen = RawTurtle = RawPen = Turtle


# ── Drawing the SVG ──────────────────────────────────────────────────────────

_CLASSIC = [(0, 0), (-5, -9), (0, -7), (5, -9)]


def _turtle_shape(x, y, h, stroke, fill):
    a = math.radians(h - 90)
    c, s = math.cos(a), math.sin(a)
    pts = [(x + px * c - py * s, y + px * s + py * c) for px, py in _CLASSIC]
    return pts, stroke, fill


def _svg(screen, animate=True):
    items = screen.items
    xs, ys = [0.0], [0.0]

    def grow(x, y, pad=0.0):
        xs.extend((x - pad, x + pad))
        ys.extend((y - pad, y + pad))

    for it in items:
        if it["kind"] in ("line", "fill"):
            for x, y in it["pts"]:
                grow(x, y, it.get("width", 0))
        elif it["kind"] == "dot":
            grow(it["x"], it["y"], it["r"])
        elif it["kind"] == "stamp":
            grow(it["x"], it["y"], 10)
        elif it["kind"] == "text":
            size = abs(int(it["font"][1] or 8)) * 1.35
            w = len(it["text"]) * size * 0.6
            x0 = it["x"] - (w if it["align"] == "right" else w / 2 if it["align"] == "center" else 0)
            grow(x0, it["y"])
            grow(x0 + w, it["y"] + size)
    turtles = [t for t in screen._turtles if t._visible]
    for t in turtles:
        grow(t._x, t._y, 10)

    width, height = screen._size or (640, 480)
    minx, maxx = min(min(xs) - 20, -width / 2), max(max(xs) + 20, width / 2)
    miny, maxy = min(min(ys) - 20, -height / 2), max(max(ys) + 20, height / 2)
    vw, vh = maxx - minx, maxy - miny

    def X(x):
        return _fmt(x - minx)

    def Y(y):
        return _fmt(maxy - y)

    # Replay timing: each segment takes a share of the time set by the turtle's speed.
    animate = animate and screen._animate
    per_speed = {s: 0.08 / s for s in range(1, 11)}
    t, timeline = 0.0, {}
    for it in sorted(items, key=lambda i: i["step"]):
        d = per_speed.get(it.get("speed", 3), 0.0) if animate else 0.0
        if it["kind"] == "line":
            d *= max(1.0, math.hypot(it["pts"][1][0] - it["pts"][0][0], it["pts"][1][1] - it["pts"][0][1]) / 40.0)
        timeline[it["step"]] = (t, d)
        t += d
    total = t
    if total > 12:  # long drawings replay faster, never longer than ~12 s
        k = 12 / total
        timeline = {s: (a * k, b * k) for s, (a, b) in timeline.items()}
        total = 12
    animate = animate and total > 0.05

    out = ['<svg xmlns="http://www.w3.org/2000/svg" width="%s" height="%s" viewBox="0 0 %s %s">'
           % (_fmt(vw), _fmt(vh), _fmt(vw), _fmt(vh))]
    if screen._title:
        out.append("<title>%s</title>" % _esc(screen._title))
    if animate:
        out.append("<style>.d{stroke-dasharray:1;stroke-dashoffset:1;animation-name:d;animation-timing-function:linear;"
                   "animation-fill-mode:forwards}@keyframes d{to{stroke-dashoffset:0}}"
                   ".s{opacity:0;animation-name:s;animation-duration:.01s;animation-fill-mode:forwards}"
                   "@keyframes s{to{opacity:1}}</style>")
    out.append('<rect width="100%%" height="100%%" fill="%s"/>' % _esc(screen._bg))

    def timing(step, draw=False):
        if not animate:
            return ""
        start, dur = timeline.get(step, (0, 0))
        if draw:
            return ' class="d" pathLength="1" style="animation-delay:%ss;animation-duration:%ss"' % (_fmt(start), _fmt(max(dur, 0.005)))
        return ' class="s" style="animation-delay:%ss"' % _fmt(start + dur)

    for it in items:
        k = it["kind"]
        if k == "line":
            (x1, y1), (x2, y2) = it["pts"]
            out.append('<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="%s" stroke-width="%s" stroke-linecap="round"%s/>'
                       % (X(x1), Y(y1), X(x2), Y(y2), _esc(it["color"]), _fmt(max(it["width"], 0.5)), timing(it["step"], True)))
        elif k == "fill":
            pts = " ".join("%s,%s" % (X(x), Y(y)) for x, y in it["pts"])
            out.append('<polygon points="%s" fill="%s" fill-rule="evenodd"%s/>' % (pts, _esc(it["color"]), timing(it["step"])))
        elif k == "dot":
            out.append('<circle cx="%s" cy="%s" r="%s" fill="%s"%s/>' % (X(it["x"]), Y(it["y"]), _fmt(it["r"]), _esc(it["color"]), timing(it["step"])))
        elif k == "stamp":
            pts, stroke, fill = _turtle_shape(it["x"], it["y"], it["h"], it["color"], it["fill"])
            out.append('<polygon points="%s" fill="%s" stroke="%s"%s/>'
                       % (" ".join("%s,%s" % (X(x), Y(y)) for x, y in pts), _esc(fill), _esc(stroke), timing(it["step"])))
        elif k == "text":
            family, size, style = it["font"][0], abs(int(it["font"][1] or 8)), str(it["font"][2] or "normal")
            anchor = {"center": "middle", "right": "end"}.get(it["align"], "start")
            weight = ' font-weight="bold"' if "bold" in style else ""
            italic = ' font-style="italic"' if "italic" in style else ""
            out.append('<text x="%s" y="%s" font-family="%s, sans-serif" font-size="%s" fill="%s" text-anchor="%s"%s%s%s>%s</text>'
                       % (X(it["x"]), Y(it["y"]), _esc(family), round(size * 1.35), _esc(it["color"]), anchor,
                          weight, italic, timing(it["step"]), _esc(it["text"])))
    end = ' class="s" style="animation-delay:%ss"' % _fmt(total) if animate else ""
    for tt in turtles:
        pts, stroke, fill = _turtle_shape(tt._x, tt._y, tt._h, tt._pencolor, tt._fillcolor)
        out.append('<polygon points="%s" fill="%s" stroke="%s"%s/>'
                   % (" ".join("%s,%s" % (X(x), Y(y)) for x, y in pts), _esc(fill), _esc(stroke), end))
    out.append("</svg>")
    return "".join(out)


def show():
    """Send the drawing to the terminal if it changed since it was last shown."""
    s = _screen
    if s is None or s.version == s.shown_version or (not s.items and s._bg == "white"):
        return
    s.shown_version = s.version
    data = _svg(s).encode("utf-8")
    if len(data) > _sandbox_display.MAX_BYTES:
        data = _svg(s, animate=False).encode("utf-8")  # the replay timing roughly doubles the size
    _sandbox_display.send(data, "image/svg+xml", "turtle.svg")


def done():
    show()


mainloop = exitonclick = bye = done


def _make_global(name, owner):
    def fn(*args, **kwargs):
        target = Screen() if owner == "screen" else _getpen()
        return getattr(target, name)(*args, **kwargs)
    fn.__name__ = name
    return fn


_pen = None


def _getpen():
    global _pen
    if _pen is None:
        _pen = Turtle()
    return _pen


getpen = getturtle = _getpen

_SCREEN_FUNCS = ["bgcolor", "setup", "screensize", "title", "colormode", "tracer", "update", "delay", "mode",
                 "window_width", "window_height", "turtles", "clearscreen", "resetscreen", "textinput", "numinput",
                 "listen", "onkey", "onkeypress", "onkeyrelease", "onscreenclick", "ontimer", "register_shape",
                 "addshape", "getshapes", "getcanvas"]
_TURTLE_FUNCS = ["forward", "fd", "backward", "bk", "back", "left", "lt", "right", "rt", "goto", "setpos",
                 "setposition", "teleport", "setx", "sety", "setheading", "seth", "home", "circle", "dot", "stamp",
                 "clearstamp", "clearstamps", "write", "penup", "pu", "up", "pendown", "pd", "down", "isdown",
                 "pensize", "width", "pencolor", "fillcolor", "color", "pen", "begin_fill", "end_fill", "filling",
                 "position", "pos", "xcor", "ycor", "heading", "towards", "distance", "degrees", "radians",
                 "speed", "hideturtle", "ht", "showturtle", "st", "isvisible", "shape", "shapesize", "turtlesize",
                 "tilt", "settiltangle", "clear", "reset", "undo", "clone", "onclick", "onrelease", "ondrag"]
for _n in _SCREEN_FUNCS:
    globals()[_n] = _make_global(_n, "screen")
for _n in _TURTLE_FUNCS:
    globals()[_n] = _make_global(_n, "turtle")
onscreenclick = _make_global("onscreenclick", "screen")
__all__ += _SCREEN_FUNCS + _TURTLE_FUNCS

_sandbox_display.on_finish(show)
