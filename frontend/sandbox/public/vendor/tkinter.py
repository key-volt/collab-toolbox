"""tkinter for the browser sandbox.

A pure-Python emulation of the tkinter API. Real Tcl/Tk cannot exist in a
WebAssembly interpreter, so widget operations are forwarded as data through
``_sandbox_bridge`` to the sandbox page, which renders them as DOM elements;
DOM events come back through ``_dispatch_event`` and run the Python callbacks.

Widget state lives on the Python side: input events keep it current, so
``entry.get()`` and friends answer synchronously without asking the DOM.
``mainloop()`` cannot block in a browser - it flushes and returns while
callbacks keep firing.
"""

import asyncio
import json
import re
import sys
import traceback
import types

import _sandbox_bridge

__all__ = [
    "TclError", "Tk", "Frame", "Label", "Button", "Entry", "Text", "Canvas",
    "Checkbutton", "Radiobutton", "Listbox", "Scale", "Scrollbar",
    "Variable", "StringVar", "IntVar", "DoubleVar", "BooleanVar", "Event",
    "Toplevel", "Menu", "Menubutton", "Spinbox", "PanedWindow", "LabelFrame",
    "Message", "OptionMenu", "PhotoImage", "BitmapImage",
    "TOP", "BOTTOM", "LEFT", "RIGHT", "BOTH", "X", "Y", "NONE", "CENTER",
    "N", "S", "E", "W", "NE", "NW", "SE", "SW", "NS", "EW", "NSEW",
    "HORIZONTAL", "VERTICAL", "NORMAL", "DISABLED", "ACTIVE", "END", "INSERT",
    "WORD", "CHAR", "TRUE", "FALSE", "BROWSE", "SINGLE", "EXTENDED", "MULTIPLE",
]


class TclError(Exception):
    pass


# Geometry and option constants, matching tkinter's string values.
TOP, BOTTOM, LEFT, RIGHT = "top", "bottom", "left", "right"
BOTH, X, Y, NONE = "both", "x", "y", "none"
CENTER = "center"
N, S, E, W = "n", "s", "e", "w"
NE, NW, SE, SW, NS, EW, NSEW = "ne", "nw", "se", "sw", "ns", "ew", "nsew"
HORIZONTAL, VERTICAL = "horizontal", "vertical"
NORMAL, DISABLED, ACTIVE = "normal", "disabled", "active"
END, INSERT = "end", "insert"
WORD, CHAR = "word", "char"
TRUE, FALSE = 1, 0
BROWSE, SINGLE, EXTENDED, MULTIPLE = "browse", "single", "extended", "multiple"

_widgets = {}
_ops = []
_dirty_canvases = []
_app = None
_id_counter = 0
_group_counter = 0


def _next_id():
    global _id_counter
    _id_counter += 1
    return _id_counter


def _emit(op):
    _ops.append(op)


def _flush():
    """Ship queued widget operations to the renderer. Called by the engine after
    every REPL line, file run and event dispatch, and by mainloop()/update()."""
    global _ops
    for canvas in _dirty_canvases:
        if not canvas._destroyed:
            _ops.append(canvas._scene_op())
    _dirty_canvases.clear()
    if _ops:
        payload = json.dumps(_ops)
        _ops = []
        _sandbox_bridge.emit_tk(payload)


def _dispatch_event(payload):
    """Entry point for DOM events forwarded by the engine."""
    data = json.loads(payload)
    widget = _widgets.get(data.get("wid"))
    try:
        if widget is not None and not widget._destroyed:
            widget._handle(data)
    except Exception:
        print("Exception in Tkinter callback", file=sys.stderr)
        traceback.print_exc()
    finally:
        _flush()


def _call_safely(func, *args):
    try:
        func(*args)
    except Exception:
        print("Exception in Tkinter callback", file=sys.stderr)
        traceback.print_exc()


class Event:
    """The object handed to bind() callbacks."""

    def __init__(self):
        self.widget = None
        self.x = 0
        self.y = 0
        self.x_root = 0
        self.y_root = 0
        self.char = ""
        self.keysym = ""
        self.num = 0
        self.width = 0
        self.height = 0
        self.type = ""

    def __repr__(self):
        return f"<Event {self.type or 'event'} x={self.x} y={self.y} keysym={self.keysym!r}>"


class Variable:
    _default = ""

    def __init__(self, master=None, value=None, name=None):
        global _group_counter
        _group_counter += 1
        self._group = _group_counter
        self._value = self._default if value is None else self._coerce(value)
        self._traces = {}
        self._trace_counter = 0
        self._watchers = []

    def _coerce(self, value):
        return value

    def get(self):
        return self._value

    def set(self, value):
        self._value = self._coerce(value)
        for callback in list(self._traces.values()):
            _call_safely(callback, str(id(self)), "", "write")
        for widget in list(self._watchers):
            if not widget._destroyed:
                widget._var_changed()

    initialize = set

    def trace_add(self, mode, callback):
        if mode not in ("write", "w"):
            raise TclError("only 'write' traces are supported in this sandbox")
        self._trace_counter += 1
        name = f"trace{self._trace_counter}"
        self._traces[name] = callback
        return name

    def trace(self, mode, callback):
        return self.trace_add(mode, callback)

    trace_variable = trace

    def trace_remove(self, mode, name):
        self._traces.pop(name, None)


class StringVar(Variable):
    _default = ""

    def _coerce(self, value):
        return str(value)


class IntVar(Variable):
    _default = 0

    def _coerce(self, value):
        return int(float(value))


class DoubleVar(Variable):
    _default = 0.0

    def _coerce(self, value):
        return float(value)


class BooleanVar(Variable):
    _default = False

    def _coerce(self, value):
        return bool(value)


# Options the renderer draws; everything else is either accepted-and-ignored
# (purely visual Tk details with no browser equivalent) or a TclError, matching
# how real Tk rejects unknown options.
_RENDERED = {
    "text", "fg", "bg", "width", "height", "font", "state", "justify", "wrap",
    "show", "orient", "from_", "to", "resolution", "label", "showvalue",
    "selectmode",
}
_IGNORED = {
    "relief", "bd", "borderwidth", "highlightthickness", "highlightbackground",
    "highlightcolor", "cursor", "takefocus", "anchor", "underline",
    "activebackground", "activeforeground", "disabledforeground",
    "insertbackground", "selectbackground", "selectforeground", "padx", "pady",
    "ipadx", "ipady", "exportselection", "wraplength", "repeatdelay",
    "repeatinterval", "sliderlength", "tickinterval", "digits", "name",
    "yscrollcommand", "xscrollcommand",
}
_ALIASES = {"foreground": "fg", "background": "bg", "borderwidth": "bd"}

_KEYSYMS = {
    "Return", "Escape", "space", "BackSpace", "Tab", "Left", "Right", "Up",
    "Down", "Delete", "Home", "End", "Prior", "Next", "Shift_L", "Control_L",
}

_SEQUENCE_ALIASES = {
    "<1>": "<Button-1>", "<2>": "<Button-2>", "<3>": "<Button-3>",
    "<ButtonPress-1>": "<Button-1>", "<ButtonPress-2>": "<Button-2>",
    "<ButtonPress-3>": "<Button-3>", "<Double-1>": "<Double-Button-1>",
    "<KeyPress>": "<Key>",
}

_PLAIN_SEQUENCES = {
    "<Button-1>", "<Button-2>", "<Button-3>", "<ButtonRelease-1>",
    "<Double-Button-1>", "<Motion>", "<B1-Motion>", "<Key>", "<KeyRelease>",
    "<Enter>", "<Leave>", "<FocusIn>", "<FocusOut>", "<Configure>",
}

_VIRTUAL_SEQUENCES = {"<<ListboxSelect>>"}


def _normalize_sequence(sequence):
    sequence = _SEQUENCE_ALIASES.get(sequence, sequence)
    if sequence in _PLAIN_SEQUENCES or sequence in _VIRTUAL_SEQUENCES:
        return sequence
    match = re.fullmatch(r"<(?:Key|KeyPress)-(\w+)>", sequence)
    if match is None:
        single = re.fullmatch(r"<(\w+)>", sequence)
        if single is not None and (single.group(1) in _KEYSYMS or len(single.group(1)) == 1):
            return f"<Key-{single.group(1)}>"
        raise TclError(f'event sequence "{sequence}" is not supported in this sandbox')
    return f"<Key-{match.group(1)}>"


class Misc:
    _kind = "widget"
    _var_option = None

    def __init__(self, master=None, **options):
        self._id = _next_id()
        self._destroyed = False
        self._children = []
        self._bindings = {}
        self._manager = None
        self._child_manager = None
        self._options = {}
        self._variable = None
        self._command = None
        self._grid_tracks = {"row": {}, "column": {}}
        self.master = master
        _widgets[self._id] = self
        if master is not None:
            master._ensure_alive()
            master._children.append(self)
        self._apply_options(options, initial=True)
        if master is not None:
            opts = self._render_options()
            extra = self._config_extra()
            if extra:
                opts.update(extra)
            _emit({
                "op": "create",
                "wid": self._id,
                "parent": master._id,
                "kind": self._kind,
                "opts": opts,
            })

    # ——— option handling ————————————————————————————————————————————————

    def _apply_options(self, options, initial=False):
        for key, value in options.items():
            key = _ALIASES.get(key, key)
            if key == "command":
                self._command = value
            elif self._var_option is not None and key == self._var_option:
                self._attach_variable(value)
            elif key in _RENDERED:
                self._options[key] = value
            elif key in _IGNORED:
                continue
            elif key in ("onvalue", "offvalue", "value"):
                self._options[key] = value
            else:
                raise TclError(f'unknown option "-{key}"')
        if self._variable is not None and not initial:
            self._var_changed()

    def _attach_variable(self, variable):
        if self._variable is not None and self in self._variable._watchers:
            self._variable._watchers.remove(self)
        self._variable = variable
        if variable is not None:
            variable._watchers.append(self)
            self._sync_from_variable()

    def _sync_from_variable(self):
        pass

    def _var_changed(self):
        pass

    def _render_options(self):
        rendered = {}
        for key, value in self._options.items():
            if key in _RENDERED:
                rendered[key] = list(value) if isinstance(value, tuple) else value
        return rendered

    def _push_config(self, extra=None):
        self._ensure_alive()
        opts = self._render_options()
        if extra:
            opts.update(extra)
        _emit({"op": "config", "wid": self._id, "opts": opts})

    def config(self, **options):
        if not options:
            return dict(self._options)
        self._ensure_alive()
        self._apply_options(options)
        self._push_config(self._config_extra())
        return None

    configure = config

    def _config_extra(self):
        return None

    def cget(self, key):
        key = _ALIASES.get(key, key)
        if key == "command":
            return self._command
        return self._options.get(key, "")

    __getitem__ = cget

    def __setitem__(self, key, value):
        self.config(**{key: value})

    # ——— layout ————————————————————————————————————————————————————————

    def _set_layout(self, manager, options):
        self._ensure_alive()
        if self.master is None:
            raise TclError("cannot pack the root window")
        if manager in ("pack", "grid"):
            other = "grid" if manager == "pack" else "pack"
            if self.master._child_manager == other:
                raise TclError(f"cannot use {manager} inside a master already managed by {other}")
            self.master._child_manager = manager
        self._manager = manager
        _emit({"op": "layout", "wid": self._id, "manager": manager, "opts": options})

    def pack(self, side=TOP, fill=NONE, expand=0, padx=0, pady=0, anchor=None, **ignored):
        self._set_layout("pack", {
            "side": side, "fill": fill, "expand": 1 if expand else 0,
            "padx": padx, "pady": pady,
        })

    def grid(self, row=None, column=0, rowspan=1, columnspan=1, sticky="",
             padx=0, pady=0, **ignored):
        self._set_layout("grid", {
            "row": row, "column": column, "rowspan": rowspan,
            "columnspan": columnspan, "sticky": sticky, "padx": padx, "pady": pady,
        })

    def place(self, x=0, y=0, width=None, height=None, **ignored):
        self._set_layout("place", {"x": x, "y": y, "width": width, "height": height})

    def _forget(self):
        if self._manager is not None:
            self._manager = None
            _emit({"op": "forget", "wid": self._id})

    def pack_forget(self):
        self._forget()

    def grid_forget(self):
        self._forget()

    def place_forget(self):
        self._forget()

    def columnconfigure(self, index, weight=0, **ignored):
        self._grid_tracks["column"][int(index)] = int(weight)
        _emit({"op": "tracks", "wid": self._id, "axis": "column",
               "tracks": self._grid_tracks["column"]})

    def rowconfigure(self, index, weight=0, **ignored):
        self._grid_tracks["row"][int(index)] = int(weight)
        _emit({"op": "tracks", "wid": self._id, "axis": "row",
               "tracks": self._grid_tracks["row"]})

    grid_columnconfigure = columnconfigure
    grid_rowconfigure = rowconfigure

    # ——— events ————————————————————————————————————————————————————————

    def bind(self, sequence, func, add=None):
        self._ensure_alive()
        sequence = _normalize_sequence(sequence)
        if add:
            self._bindings.setdefault(sequence, []).append(func)
        else:
            self._bindings[sequence] = [func]
        if sequence not in _VIRTUAL_SEQUENCES:
            _emit({"op": "listen", "wid": self._id, "seq": sequence})
        return sequence

    def _fire_binding(self, sequence, event):
        for func in self._bindings.get(sequence, []):
            _call_safely(func, event)

    def _make_event(self, data):
        event = Event()
        event.widget = self
        event.type = data.get("seq", data.get("event", ""))
        event.x = int(data.get("x", 0))
        event.y = int(data.get("y", 0))
        event.x_root, event.y_root = event.x, event.y
        event.char = data.get("char", "")
        event.keysym = data.get("keysym", "")
        event.num = int(data.get("num", 0))
        event.width = int(data.get("w", 0))
        event.height = int(data.get("h", 0))
        return event

    def _handle(self, data):
        if data.get("event") == "bind":
            self._fire_binding(data.get("seq", ""), self._make_event(data))
        elif data.get("event") == "command":
            self._handle_command(data)
        elif data.get("event") == "var":
            self._handle_input(str(data.get("value", "")))

    def _handle_command(self, data):
        if self._options.get("state") == DISABLED:
            return
        if self._command is not None:
            _call_safely(self._command)

    def _handle_input(self, value):
        pass

    # ——— timers, focus, introspection ——————————————————————————————————

    def after(self, ms, func=None, *args):
        if func is None:
            raise TclError("after() without a callback cannot sleep in a browser -"
                           " schedule a callback instead")
        root = _app
        if root is None:
            raise TclError("no application is running")
        root._after_counter += 1
        token = f"after#{root._after_counter}"

        def fire():
            root._afters.pop(token, None)
            _call_safely(func, *args)
            _flush()

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = asyncio.get_event_loop()
        root._afters[token] = loop.call_later(ms / 1000, fire)
        return token

    def after_cancel(self, token):
        root = _app
        if root is None:
            return
        handle = root._afters.pop(token, None)
        if handle is not None:
            handle.cancel()

    def focus_set(self):
        self._ensure_alive()
        _emit({"op": "focus", "wid": self._id})

    focus = focus_set

    def winfo_children(self):
        return list(self._children)

    def winfo_exists(self):
        return 0 if self._destroyed else 1

    def winfo_width(self):
        # The renderer owns real pixel sizes; this answers with the configured
        # size, like an unmapped Tk widget answers with its request.
        return int(self._options.get("width", 1) or 1)

    def winfo_height(self):
        return int(self._options.get("height", 1) or 1)

    def winfo_screenwidth(self):
        return 800

    def winfo_screenheight(self):
        return 600

    def yview(self, *args):
        # Scrolling is native in the renderer; the scrollbar recipe's plumbing
        # is accepted so those programs run unchanged.
        return (0.0, 1.0)

    xview = yview

    def update(self):
        _flush()

    update_idletasks = update

    def _ensure_alive(self):
        if self._destroyed:
            raise TclError("this widget has been destroyed")

    def destroy(self):
        if self._destroyed:
            return
        root_call = self.master is not None
        self._teardown()
        if root_call:
            _emit({"op": "destroy", "wid": self._id})

    def _teardown(self):
        self._destroyed = True
        if self._variable is not None and self in self._variable._watchers:
            self._variable._watchers.remove(self)
        for child in list(self._children):
            child._teardown()
        if self.master is not None and self in self.master._children:
            self.master._children.remove(self)
        _widgets.pop(self._id, None)


class Widget(Misc):
    pass


class Tk(Misc):
    _kind = "window"

    def __init__(self, screenName=None, baseName=None, className="Tk"):
        global _app
        if _app is not None and not _app._destroyed:
            _app.destroy()
        self._title_text = "tk"
        self._protocols = {}
        self._afters = {}
        self._after_counter = 0
        super().__init__(master=None)
        _app = self
        _emit({"op": "window", "wid": self._id, "title": self._title_text})

    def title(self, text=None):
        if text is None:
            return self._title_text
        self._ensure_alive()
        self._title_text = str(text)
        _emit({"op": "window", "wid": self._id, "title": self._title_text})
        return None

    wm_title = title

    def geometry(self, spec=None):
        if spec is None or spec == "":
            return f"{self.winfo_width()}x{self.winfo_height()}"
        match = re.fullmatch(r"(\d+)x(\d+)(?:[+-]\d+[+-]\d+)?", spec)
        if match is None:
            raise TclError(f'bad geometry specifier "{spec}"')
        self._options["width"] = int(match.group(1))
        self._options["height"] = int(match.group(2))
        self._push_config()
        return None

    def resizable(self, *args, **kw):
        return (0, 0)

    def protocol(self, name, func=None):
        self._protocols[name] = func

    def mainloop(self, n=0):
        # A browser cannot block; the page keeps delivering events after this
        # returns, so callbacks behave as programs expect.
        _flush()

    def quit(self):
        self.destroy()

    def deiconify(self):
        pass

    iconify = deiconify
    withdraw = deiconify

    def _handle(self, data):
        if data.get("event") == "wm-close":
            handler = self._protocols.get("WM_DELETE_WINDOW")
            if handler is None:
                self.destroy()
            else:
                _call_safely(handler)
        else:
            super()._handle(data)

    def destroy(self):
        global _app
        if self._destroyed:
            return
        for handle in self._afters.values():
            handle.cancel()
        self._afters.clear()
        self._teardown()
        if _app is self:
            _app = None
        _emit({"op": "close"})


class Frame(Widget):
    _kind = "frame"


class Label(Widget):
    _kind = "label"
    _var_option = "textvariable"

    def _sync_from_variable(self):
        self._options["text"] = str(self._variable.get())

    def _var_changed(self):
        self._options["text"] = str(self._variable.get())
        self._push_config()


class Button(Widget):
    _kind = "button"
    _var_option = "textvariable"

    def _sync_from_variable(self):
        self._options["text"] = str(self._variable.get())

    _var_changed = Label._var_changed

    def invoke(self):
        self._handle_command({})


class Entry(Widget):
    _kind = "entry"
    _var_option = "textvariable"

    def __init__(self, master=None, **options):
        self._value = ""
        super().__init__(master, **options)

    def _current(self):
        return str(self._variable.get()) if self._variable is not None else self._value

    def _store(self, value):
        if self._variable is not None:
            self._variable.set(value)
        else:
            self._value = value
            self._push_config(self._config_extra())

    def _sync_from_variable(self):
        self._value = str(self._variable.get())

    def _var_changed(self):
        self._push_config(self._config_extra())

    def _config_extra(self):
        return {"value": self._current()}

    def _handle_input(self, value):
        if self._variable is not None:
            self._value = value
            self._variable.set(value)
        else:
            self._value = value

    def get(self):
        return self._current()

    def insert(self, index, text):
        current = self._current()
        at = len(current) if index in (END, INSERT) else int(index)
        self._store(current[:at] + str(text) + current[at:])

    def delete(self, first, last=None):
        current = self._current()
        start = len(current) if first == END else int(first)
        stop = start + 1 if last is None else (len(current) if last == END else int(last))
        self._store(current[:start] + current[stop:])


class Text(Widget):
    _kind = "text"

    def __init__(self, master=None, **options):
        self._content = ""
        super().__init__(master, **options)

    def _config_extra(self):
        return {"value": self._content}

    def _handle_input(self, value):
        self._content = value

    def _span(self, first, last):
        # Full Tk text indexing has no browser mirror; the whole-buffer forms
        # cover the teaching uses and anything else says so plainly.
        if first not in ("1.0", "0.0"):
            raise TclError('only the "1.0" start index is supported in this sandbox')
        if last in (END, None):
            return True
        if last == "end-1c":
            return False
        raise TclError('only "end" and "end-1c" end indices are supported in this sandbox')

    def get(self, first="1.0", last=END):
        include_newline = self._span(first, last)
        return self._content + "\n" if include_newline else self._content

    def insert(self, index, text):
        if index == END:
            self._content += str(text)
        elif index in ("1.0", "0.0", INSERT):
            self._content = str(text) + self._content if index != INSERT else self._content + str(text)
        else:
            raise TclError('only "1.0", "end" and "insert" indices are supported in this sandbox')
        self._push_config(self._config_extra())

    def delete(self, first="1.0", last=END):
        self._span(first, last)
        self._content = ""
        self._push_config(self._config_extra())


class Canvas(Widget):
    _kind = "canvas"

    def __init__(self, master=None, **options):
        options.setdefault("width", 300)
        options.setdefault("height", 200)
        self._bg = options.pop("bg", options.pop("background", "#ffffff"))
        self._items = {}
        self._item_order = []
        self._item_counter = 0
        super().__init__(master, **options)
        self._mark_dirty()

    def _mark_dirty(self):
        if self not in _dirty_canvases:
            _dirty_canvases.append(self)

    def _scene_op(self):
        items = []
        for item_id in self._item_order:
            item = self._items[item_id]
            items.append({"type": item["type"], "coords": item["coords"], "opts": item["opts"]})
        return {
            "op": "canvas", "wid": self._id,
            "width": int(self._options.get("width", 300)),
            "height": int(self._options.get("height", 200)),
            "bg": self._bg, "items": items,
        }

    @staticmethod
    def _flatten(coords):
        flat = []
        for value in coords:
            if isinstance(value, (tuple, list)):
                flat.extend(float(part) for part in value)
            else:
                flat.append(float(value))
        return flat

    def _create(self, item_type, coords, opts):
        for key in ("image", "bitmap"):
            if key in opts:
                raise TclError(f"canvas {key} items are not supported in this sandbox")
        self._item_counter += 1
        item_id = self._item_counter
        self._items[item_id] = {"type": item_type, "coords": self._flatten(coords), "opts": opts}
        self._item_order.append(item_id)
        self._mark_dirty()
        return item_id

    def create_line(self, *coords, **opts):
        return self._create("line", coords, opts)

    def create_rectangle(self, *coords, **opts):
        return self._create("rectangle", coords, opts)

    def create_oval(self, *coords, **opts):
        return self._create("oval", coords, opts)

    def create_polygon(self, *coords, **opts):
        return self._create("polygon", coords, opts)

    def create_arc(self, *coords, **opts):
        return self._create("arc", coords, opts)

    def create_text(self, *coords, **opts):
        opts.setdefault("text", "")
        return self._create("text", coords, opts)

    def create_image(self, *coords, **opts):
        raise TclError("canvas images are not supported in this sandbox")

    create_bitmap = create_image

    def itemconfig(self, item_id, **opts):
        item = self._items.get(item_id)
        if item is None:
            raise TclError(f'unknown canvas item "{item_id}"')
        item["opts"].update(opts)
        self._mark_dirty()

    itemconfigure = itemconfig

    def coords(self, item_id, *coords):
        item = self._items.get(item_id)
        if item is None:
            raise TclError(f'unknown canvas item "{item_id}"')
        if not coords:
            return list(item["coords"])
        item["coords"] = self._flatten(coords)
        self._mark_dirty()
        return None

    def move(self, item_id, dx, dy):
        item = self._items.get(item_id)
        if item is None:
            raise TclError(f'unknown canvas item "{item_id}"')
        moved = []
        for index, value in enumerate(item["coords"]):
            moved.append(value + (dx if index % 2 == 0 else dy))
        item["coords"] = moved
        self._mark_dirty()

    def delete(self, item_id=None):
        if item_id in (None, "all"):
            self._items.clear()
            self._item_order.clear()
        else:
            self._items.pop(item_id, None)
            if item_id in self._item_order:
                self._item_order.remove(item_id)
        self._mark_dirty()

    def find_all(self):
        return tuple(self._item_order)

    def bbox(self, item_id):
        item = self._items.get(item_id)
        if item is None or not item["coords"]:
            return None
        xs = item["coords"][0::2]
        ys = item["coords"][1::2]
        return (int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys)))

    def tag_bind(self, *args, **kw):
        raise TclError("per-item canvas bindings are not supported in this sandbox -"
                       " bind on the canvas and use the event coordinates")

    def config(self, **options):
        bg = options.pop("bg", options.pop("background", None))
        if bg is not None:
            self._bg = bg
            self._mark_dirty()
        if options:
            result = super().config(**options)
            self._mark_dirty()
            return result
        return None

    configure = config


class Checkbutton(Widget):
    _kind = "checkbutton"
    _var_option = "variable"

    def _on_off(self):
        return self._options.get("onvalue", 1), self._options.get("offvalue", 0)

    def _checked(self):
        if self._variable is None:
            return False
        return self._variable.get() == self._on_off()[0]

    def _config_extra(self):
        return {"checked": bool(self._checked())}

    def _var_changed(self):
        self._push_config(self._config_extra())

    def _handle_command(self, data):
        if self._options.get("state") == DISABLED:
            return
        on, off = self._on_off()
        if self._variable is not None:
            self._variable.set(on if data.get("checked") else off)
        if self._command is not None:
            _call_safely(self._command)

    def select(self):
        if self._variable is not None:
            self._variable.set(self._on_off()[0])

    def deselect(self):
        if self._variable is not None:
            self._variable.set(self._on_off()[1])

    def toggle(self):
        on, off = self._on_off()
        if self._variable is not None:
            self._variable.set(off if self._checked() else on)

    def invoke(self):
        self.toggle()
        if self._command is not None:
            _call_safely(self._command)


class Radiobutton(Widget):
    _kind = "radiobutton"
    _var_option = "variable"

    def _config_extra(self):
        checked = self._variable is not None and self._variable.get() == self._options.get("value")
        group = self._variable._group if self._variable is not None else 0
        return {"checked": bool(checked), "group": group}

    def _var_changed(self):
        self._push_config(self._config_extra())

    def _handle_command(self, data):
        if self._options.get("state") == DISABLED:
            return
        if self._variable is not None:
            self._variable.set(self._options.get("value"))
        if self._command is not None:
            _call_safely(self._command)

    def invoke(self):
        self._handle_command({})

    def select(self):
        if self._variable is not None:
            self._variable.set(self._options.get("value"))


class Listbox(Widget):
    _kind = "listbox"

    def __init__(self, master=None, **options):
        self._items = []
        self._selection = []
        super().__init__(master, **options)

    def _config_extra(self):
        return {"items": list(self._items), "selection": list(self._selection)}

    def _index(self, index):
        return len(self._items) if index == END else int(index)

    def insert(self, index, *items):
        at = self._index(index)
        self._items[at:at] = [str(item) for item in items]
        self._push_config(self._config_extra())

    def delete(self, first, last=None):
        start = self._index(first)
        if last is None:
            del self._items[start:start + 1]
        elif last == END:
            del self._items[start:]
        else:
            del self._items[start:int(last) + 1]
        self._selection = []
        self._push_config(self._config_extra())

    def get(self, first, last=None):
        if last is None:
            return self._items[self._index(first)]
        stop = len(self._items) if last == END else int(last) + 1
        return tuple(self._items[self._index(first):stop])

    def size(self):
        return len(self._items)

    def curselection(self):
        return tuple(self._selection)

    def selection_set(self, index):
        at = self._index(index)
        if 0 <= at < len(self._items):
            self._selection = [at]
            self._push_config(self._config_extra())

    select_set = selection_set

    def selection_clear(self, first=0, last=None):
        self._selection = []
        self._push_config(self._config_extra())

    select_clear = selection_clear

    def _handle_command(self, data):
        index = int(data.get("index", -1))
        if 0 <= index < len(self._items):
            self._selection = [index]
            self._fire_binding("<<ListboxSelect>>", self._make_event(data))


class Scale(Widget):
    _kind = "scale"
    _var_option = "variable"

    def __init__(self, master=None, **options):
        options.setdefault("from_", 0)
        options.setdefault("to", 100)
        options.setdefault("resolution", 1)
        options.setdefault("orient", HORIZONTAL)
        options.setdefault("showvalue", 1)
        self._value = float(options["from_"])
        super().__init__(master, **options)

    def _round(self, value):
        resolution = float(self._options.get("resolution", 1)) or 1.0
        stepped = round(float(value) / resolution) * resolution
        return int(stepped) if float(stepped).is_integer() else stepped

    def _config_extra(self):
        return {"value": self._value}

    def get(self):
        if self._variable is not None:
            return self._variable.get()
        return self._round(self._value)

    def set(self, value):
        self._value = self._round(value)
        if self._variable is not None:
            self._variable.set(self._value)
        else:
            self._push_config(self._config_extra())

    def _sync_from_variable(self):
        self._value = self._round(self._variable.get())

    def _var_changed(self):
        self._value = self._round(self._variable.get())
        self._push_config(self._config_extra())

    def _handle_command(self, data):
        if self._options.get("state") == DISABLED:
            return
        value = self._round(data.get("value", 0))
        self._value = value
        if self._variable is not None:
            self._variable.set(value)
        if self._command is not None:
            _call_safely(self._command, str(value))


class Scrollbar(Widget):
    """Accepted but inert: the rendered Text and Listbox scroll natively, so the
    classic scrollbar recipes run unchanged with the browser's own scrolling."""

    _kind = "scrollbar"

    def set(self, first, last):
        pass


def _unsupported(name, hint):
    class _Unsupported:
        def __init__(self, *args, **kw):
            raise TclError(f"{name} is not supported in this sandbox - {hint}")

    _Unsupported.__name__ = name
    return _Unsupported


Toplevel = _unsupported("Toplevel", "the emulation renders a single window")
Menu = _unsupported("Menu", "build controls from buttons instead")
Menubutton = _unsupported("Menubutton", "build controls from buttons instead")
Spinbox = _unsupported("Spinbox", "use an Entry or a Scale instead")
PanedWindow = _unsupported("PanedWindow", "use Frames instead")
LabelFrame = _unsupported("LabelFrame", "use a Frame with a Label instead")
Message = _unsupported("Message", "use a Label instead")
OptionMenu = _unsupported("OptionMenu", "use a Listbox or Radiobuttons instead")
PhotoImage = _unsupported("PhotoImage", "images are not supported in the emulation")
BitmapImage = _unsupported("BitmapImage", "images are not supported in the emulation")


def _blocked_dialog(module_name, hint):
    module = types.ModuleType(f"tkinter.{module_name}")

    def _refuse(*args, **kw):
        raise TclError(f"tkinter.{module_name} is not supported in this sandbox - {hint}")

    for name in (
        "showinfo", "showwarning", "showerror", "askyesno", "askokcancel",
        "askquestion", "askretrycancel", "askyesnocancel", "askstring",
        "askopenfilename", "asksaveasfilename", "askdirectory", "askcolor",
    ):
        setattr(module, name, _refuse)
    return module


class _TtkStyle:
    def configure(self, *args, **kw):
        return None

    def theme_use(self, *args, **kw):
        return "sandbox"


def _build_ttk():
    module = types.ModuleType("tkinter.ttk")
    module.Button = Button
    module.Label = Label
    module.Entry = Entry
    module.Frame = Frame
    module.Checkbutton = Checkbutton
    module.Radiobutton = Radiobutton
    module.Scale = Scale
    module.Scrollbar = Scrollbar
    module.Style = _TtkStyle
    module.Combobox = _unsupported("ttk.Combobox", "use a Listbox instead")
    module.Notebook = _unsupported("ttk.Notebook", "use Frames instead")
    module.Treeview = _unsupported("ttk.Treeview", "use a Listbox instead")
    module.Progressbar = _unsupported("ttk.Progressbar", "use a Scale instead")
    return module


def _build_font():
    module = types.ModuleType("tkinter.font")

    class Font:
        def __init__(self, family="sans-serif", size=13, weight="normal",
                     slant="roman", **ignored):
            self.family, self.size, self.weight, self.slant = family, size, weight, slant

        def actual(self):
            return {"family": self.family, "size": self.size,
                    "weight": self.weight, "slant": self.slant}

    module.Font = Font
    module.BOLD, module.NORMAL, module.ITALIC = "bold", "normal", "italic"
    return module


ttk = _build_ttk()
messagebox = _blocked_dialog("messagebox", "build the dialog from widgets instead")
filedialog = _blocked_dialog("filedialog", "project files are already at /project - use open()")
colorchooser = _blocked_dialog("colorchooser", "pass a color name or #rrggbb value instead")
font = _build_font()
sys.modules["tkinter.ttk"] = ttk
sys.modules["tkinter.messagebox"] = messagebox
sys.modules["tkinter.filedialog"] = filedialog
sys.modules["tkinter.colorchooser"] = colorchooser
sys.modules["tkinter.font"] = font
