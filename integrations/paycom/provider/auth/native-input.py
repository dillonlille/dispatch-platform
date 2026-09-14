"""Private X11 keyboard/mouse delivery. Commands arrive on stdin; never log them."""
import ctypes
import json
import sys
import time

x = ctypes.CDLL('libX11.so.6')
t = ctypes.CDLL('libXtst.so.6')
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
x.XOpenDisplay.restype = ctypes.c_void_p
x.XCloseDisplay.argtypes = [ctypes.c_void_p]
x.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x.XKeysymToKeycode.restype = ctypes.c_uint
x.XkbKeycodeToKeysym.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_int]
x.XkbKeycodeToKeysym.restype = ctypes.c_ulong
x.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
t.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
t.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
t.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]

display = x.XOpenDisplay(None)
if not display:
    raise SystemExit(1)
shift = x.XKeysymToKeycode(display, 0xffe1)
try:
    actions = json.loads(sys.stdin.read(16384))
    if not isinstance(actions, list) or len(actions) > 12:
        raise ValueError()
    for action in actions:
        if not isinstance(action, dict):
            raise ValueError()
        if action.get('action') == 'click':
            if set(action) != {'action', 'x', 'y'} or any(type(action[k]) is not int for k in ('x', 'y')):
                raise ValueError()
            if not 0 <= action['x'] < 1600 or not 0 <= action['y'] < 1100:
                raise ValueError()
        elif action.get('action') == 'text':
            if set(action) != {'action', 'text'} or not isinstance(action['text'], str):
                raise ValueError()
            if not 1 <= len(action['text']) <= 64 or any(not 32 <= ord(c) <= 126 for c in action['text']):
                raise ValueError()
        else:
            raise ValueError()
    for action in actions:
        if action['action'] == 'click':
            a, b = action['x'], action['y']
            if type(a) is not int or type(b) is not int or not 0 <= a < 1600 or not 0 <= b < 1100:
                raise ValueError()
            t.XTestFakeMotionEvent(display, -1, a, b, 0)
            t.XTestFakeButtonEvent(display, 1, 1, 0)
            t.XTestFakeButtonEvent(display, 1, 0, 0)
            x.XSync(display, 0)
            time.sleep(0.05)
        elif action['action'] == 'text':
            value = action['text']
            if not isinstance(value, str) or not 1 <= len(value) <= 64 or any(not 32 <= ord(c) <= 126 for c in value):
                raise ValueError()
            for c in value:
                symbol = ord(c)
                code = x.XKeysymToKeycode(display, symbol)
                plain = x.XkbKeycodeToKeysym(display, code, 0, 0)
                shifted = x.XkbKeycodeToKeysym(display, code, 0, 1)
                if not code or symbol not in (plain, shifted):
                    raise ValueError()
                needs_shift = symbol != plain
                if needs_shift:
                    t.XTestFakeKeyEvent(display, shift, 1, 0)
                t.XTestFakeKeyEvent(display, code, 1, 0)
                t.XTestFakeKeyEvent(display, code, 0, 0)
                if needs_shift:
                    t.XTestFakeKeyEvent(display, shift, 0, 0)
                x.XSync(display, 0)
                time.sleep(0.025)
        else:
            raise ValueError()
finally:
    t.XTestFakeKeyEvent(display, shift, 0, 0)
    x.XSync(display, 0)
    x.XCloseDisplay(display)
