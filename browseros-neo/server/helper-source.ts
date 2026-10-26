// Embedded because Paseo evaluates the server bundle from a string, without a source directory.
export const helperSource = String.raw`
import atexit
import base64
import ctypes as C
import hashlib
import json
import math
import os
import re
import signal
import struct
import sys
import time


KEY_NAMES = {
    'Enter': 'Return', 'Backspace': 'BackSpace', 'Tab': 'Tab', 'Escape': 'Escape',
    'Esc': 'Escape', 'Delete': 'Delete', 'Insert': 'Insert', 'Home': 'Home', 'End': 'End',
    'PageUp': 'Prior', 'PageDown': 'Next', 'ArrowLeft': 'Left', 'ArrowRight': 'Right',
    'ArrowUp': 'Up', 'ArrowDown': 'Down', ' ': 'space', 'Spacebar': 'space',
    'ContextMenu': 'Menu', 'Shift': 'Shift_L', 'Control': 'Control_L', 'Alt': 'Alt_L',
    'Meta': 'Super_L', 'CapsLock': 'Caps_Lock', 'NumLock': 'Num_Lock',
    'ScrollLock': 'Scroll_Lock', 'Pause': 'Pause', 'PrintScreen': 'Print',
    'Clear': 'Clear', 'Help': 'Help', 'BackTab': 'ISO_Left_Tab',
}


def key_name(key):
    if len(key) == 1:
        code = ord(key)
        return code if code <= 255 else 0x01000000 + code
    if re.fullmatch(r'F([1-9]|1[0-2])', key):
        return key
    if key not in KEY_NAMES:
        raise ValueError('Unsupported key: ' + key)
    return KEY_NAMES[key]


def fit_size(width, height, max_width, max_height):
    scale = min(1.0, max_width / width, max_height / height)
    return max(1, math.floor(width * scale)), max(1, math.floor(height * scale))


PNG_LIMIT = 1572864
SETTLE_SECONDS = 0.150


def pixel_hash(image, quality, lossless):
    width, height = image.get_width(), image.get_height()
    stride, channels = image.get_rowstride(), image.get_n_channels()
    digest = hashlib.blake2b(digest_size=12)
    digest.update(struct.pack('!III4B', width, height, stride, channels,
                              image.get_bits_per_sample(), int(lossless), quality))
    pixels = memoryview(image.get_pixels())
    row_bytes = width * channels
    if stride == row_bytes:
        digest.update(pixels[:height * stride])
    else:
        # Row padding is not image data and can contain uninitialized bytes.
        for row in range(height):
            digest.update(pixels[row * stride:row * stride + row_bytes])
    return digest.hexdigest()


def frame_response(result, saved, since, include_image=False):
    result.update({k: v for k, v in saved.items() if k not in ('pixels', 'changedAt')})
    if saved['hash'] == since and not include_image:
        result.update(changed=False, image=None)
    return result


def encode_image(image, quality, lossless, png_limit=PNG_LIMIT):
    if lossless:
        ok, encoded = image.save_to_bufferv('png', ['compression'], ['1'])
        if not ok:
            raise RuntimeError('The BrowserOS window could not be encoded as PNG.')
        if len(encoded) <= png_limit:
            return encoded, 'image/png'
    ok, encoded = image.save_to_bufferv('jpeg', ['quality'], [str(95 if lossless else quality)])
    if not ok:
        raise RuntimeError('The BrowserOS window could not be encoded as JPEG.')
    return encoded, 'image/jpeg'


def encoding_tier(pixel_id, lossless, since, changed_at, now, refined=False):
    # Once refined, newcomers share that tier too. New pixels always start as JPEG.
    if lossless and (refined or (since == pixel_id + '.j' and now - changed_at >= SETTLE_SECONDS)):
        return 'p'
    return 'j'


class DamageMonitor:
    def __init__(self, x, display, root):
        self.x, self.display = x, display
        self.lib = C.CDLL('libXdamage.so.1')
        Desktop.bind(self.lib, 'XDamageQueryExtension', C.c_int,
                     [C.c_void_p, C.POINTER(C.c_int), C.POINTER(C.c_int)])
        Desktop.bind(self.lib, 'XDamageCreate', C.c_ulong, [C.c_void_p, C.c_ulong, C.c_int])
        Desktop.bind(self.lib, 'XDamageSubtract', None, [C.c_void_p, C.c_ulong, C.c_ulong, C.c_ulong])
        Desktop.bind(self.lib, 'XDamageDestroy', None, [C.c_void_p, C.c_ulong])
        event, error = C.c_int(), C.c_int()
        if not self.lib.XDamageQueryExtension(display, C.byref(event), C.byref(error)):
            raise RuntimeError('XDamage is unavailable')
        self.event_type = event.value
        self.watches, self.targets, self.dirty = {}, set(), set()
        for name, result, arguments in [
            ('XPending', C.c_int, [C.c_void_p]),
            ('XNextEvent', C.c_int, [C.c_void_p, C.POINTER(XEvent)]),
            ('XSelectInput', C.c_int, [C.c_void_p, C.c_ulong, C.c_long]),
        ]:
            Desktop.bind(x, name, result, arguments)
        # This X connection is separate from GDK's; structure events include popup
        # map/unmap/configure even before a new popup has its own damage object.
        x.XSelectInput(display, root, 1 << 19)
        x.XFlush(display)

    def watch(self, window, target=False):
        if target:
            self.targets.add(window)
        if window not in self.watches:
            self.watches[window] = self.lib.XDamageCreate(self.display, window, 3)
            self.dirty.update(self.targets)
            self.x.XFlush(self.display)

    def retain_targets(self, windows, exists):
        # Client windows can be reparented, so their destruction need not be a
        # root SubstructureNotify. Reconcile watches with managed windows too.
        for window in self.targets - windows:
            damage = self.watches.pop(window, None)
            if damage and exists(window):
                self.lib.XDamageDestroy(self.display, damage)
            self.dirty.discard(window)
        self.targets.intersection_update(windows)

    def drain(self):
        for _ in range(2048):
            if not self.x.XPending(self.display):
                break
            event = XEvent()
            self.x.XNextEvent(self.display, C.byref(event))
            kind = event.client.type
            if kind == self.event_type:
                window = event.client.window  # XDamageNotifyEvent.drawable: XAnyEvent.window offset.
                self.dirty.update({window} if window in self.targets else self.targets)
            elif kind in (16, 17, 18, 19, 21, 22, 24, 26):
                self.dirty.update(self.targets)
                if kind == 17:  # The server already destroyed damage objects for this window.
                    window = event.pad[5]  # XDestroyWindowEvent.window, after .event.
                    self.watches.pop(window, None)
                    self.targets.discard(window)
                    self.dirty.discard(window)

    def changed(self, window):
        self.drain()
        return window not in self.targets or window in self.dirty

    def captured(self, window):
        self.drain()
        for xid, damage in self.watches.items():
            if xid == window or xid not in self.targets:
                self.lib.XDamageSubtract(self.display, damage, 0, 0)
        self.dirty.discard(window)
        self.x.XFlush(self.display)


class Attributes(C.Structure):
    _fields_ = [(name, kind) for name, kind in [
        ('x', C.c_int), ('y', C.c_int), ('width', C.c_int), ('height', C.c_int),
        ('border_width', C.c_int), ('depth', C.c_int), ('visual', C.c_void_p),
        ('root', C.c_ulong), ('window_class', C.c_int), ('bit_gravity', C.c_int),
        ('win_gravity', C.c_int), ('backing_store', C.c_int), ('backing_planes', C.c_ulong),
        ('backing_pixel', C.c_ulong), ('save_under', C.c_int), ('colormap', C.c_ulong),
        ('map_installed', C.c_int), ('map_state', C.c_int), ('all_event_masks', C.c_long),
        ('your_event_mask', C.c_long), ('do_not_propagate_mask', C.c_long),
        ('override_redirect', C.c_int), ('screen', C.c_void_p),
    ]]


class ClientData(C.Union):
    _fields_ = [('b', C.c_char * 20), ('s', C.c_short * 10), ('l', C.c_long * 5)]


class ClientMessage(C.Structure):
    _fields_ = [('type', C.c_int), ('serial', C.c_ulong), ('send_event', C.c_int),
                ('display', C.c_void_p), ('window', C.c_ulong), ('message_type', C.c_ulong),
                ('format', C.c_int), ('data', ClientData)]


class XEvent(C.Union):
    _fields_ = [('client', ClientMessage), ('pad', C.c_long * 24)]


class XError(C.Structure):
    _fields_ = [('type', C.c_int), ('display', C.c_void_p), ('resourceid', C.c_ulong),
                ('serial', C.c_ulong), ('error_code', C.c_ubyte),
                ('request_code', C.c_ubyte), ('minor_code', C.c_ubyte)]


class Desktop:
    def __init__(self):
        import gi
        gi.require_version('Gdk', '3.0')
        gi.require_version('GdkX11', '3.0')
        gi.require_version('GdkPixbuf', '2.0')
        from gi.repository import Gdk, GdkX11, GdkPixbuf, GLib
        self.Gdk, self.GdkX11, self.Pixbuf = Gdk, GdkX11, GdkPixbuf
        self.context = GLib.MainContext.default()
        self.gdk = Gdk.Display.get_default()
        if self.gdk is None or not isinstance(self.gdk, GdkX11.X11Display):
            raise RuntimeError('An X11 desktop is required. No X11 display could be opened.')
        self.x = C.CDLL('libX11.so.6')
        self.xt = C.CDLL('libXtst.so.6')
        self.bind(self.x, 'XOpenDisplay', C.c_void_p, [C.c_char_p])
        self.bind(self.x, 'XDefaultRootWindow', C.c_ulong, [C.c_void_p])
        self.bind(self.x, 'XInternAtom', C.c_ulong, [C.c_void_p, C.c_char_p, C.c_int])
        self.bind(self.x, 'XGetWindowProperty', C.c_int, [C.c_void_p, C.c_ulong, C.c_ulong,
            C.c_long, C.c_long, C.c_int, C.c_ulong, C.POINTER(C.c_ulong), C.POINTER(C.c_int),
            C.POINTER(C.c_ulong), C.POINTER(C.c_ulong), C.POINTER(C.POINTER(C.c_ubyte))])
        self.bind(self.x, 'XFree', C.c_int, [C.c_void_p])
        self.bind(self.x, 'XGetWindowAttributes', C.c_int, [C.c_void_p, C.c_ulong, C.POINTER(Attributes)])
        self.bind(self.x, 'XTranslateCoordinates', C.c_int, [C.c_void_p, C.c_ulong, C.c_ulong,
            C.c_int, C.c_int, C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_ulong)])
        self.bind(self.x, 'XQueryTree', C.c_int, [C.c_void_p, C.c_ulong, C.POINTER(C.c_ulong),
            C.POINTER(C.c_ulong), C.POINTER(C.POINTER(C.c_ulong)), C.POINTER(C.c_uint)])
        self.bind(self.x, 'XSendEvent', C.c_int, [C.c_void_p, C.c_ulong, C.c_int, C.c_long, C.POINTER(XEvent)])
        self.bind(self.x, 'XMapWindow', C.c_int, [C.c_void_p, C.c_ulong])
        self.bind(self.x, 'XSync', C.c_int, [C.c_void_p, C.c_int])
        self.bind(self.x, 'XFlush', C.c_int, [C.c_void_p])
        self.bind(self.x, 'XStringToKeysym', C.c_ulong, [C.c_char_p])
        self.bind(self.x, 'XDisplayKeycodes', C.c_int, [C.c_void_p, C.POINTER(C.c_int), C.POINTER(C.c_int)])
        self.bind(self.x, 'XGetKeyboardMapping', C.POINTER(C.c_ulong), [C.c_void_p, C.c_ubyte,
            C.c_int, C.POINTER(C.c_int)])
        self.bind(self.x, 'XChangeKeyboardMapping', C.c_int, [C.c_void_p, C.c_int, C.c_int,
            C.POINTER(C.c_ulong), C.c_int])
        self.bind(self.xt, 'XTestQueryExtension', C.c_int, [C.c_void_p] + [C.POINTER(C.c_int)] * 4)
        self.bind(self.xt, 'XTestFakeMotionEvent', C.c_int, [C.c_void_p, C.c_int, C.c_int, C.c_int, C.c_ulong])
        self.bind(self.xt, 'XTestFakeButtonEvent', C.c_int, [C.c_void_p, C.c_uint, C.c_int, C.c_ulong])
        self.bind(self.xt, 'XTestFakeKeyEvent', C.c_int, [C.c_void_p, C.c_uint, C.c_int, C.c_ulong])
        self.display = self.x.XOpenDisplay(None)
        if not self.display:
            raise RuntimeError('An X11 desktop is required. Check DISPLAY and XAUTHORITY.')
        self.last_error = None
        error_callback = C.CFUNCTYPE(C.c_int, C.c_void_p, C.POINTER(XError))
        def on_error(display, event):
            self.last_error = 'X11 error ' + str(event.contents.error_code)
            return 0
        self.on_error = error_callback(on_error)
        self.bind(self.x, 'XSetErrorHandler', C.c_void_p, [error_callback])
        self.x.XSetErrorHandler(self.on_error)
        fields = [C.c_int() for _ in range(4)]
        if not self.xt.XTestQueryExtension(self.display, *[C.byref(f) for f in fields]):
            raise RuntimeError('The X11 desktop does not support the XTest input extension.')
        self.root = self.x.XDefaultRootWindow(self.display)
        self.atoms = {}
        self.last_frames = {}
        self.last_images = {}
        self.foreign_windows = {}
        self.held_keys = set()
        self.held_buttons = set()
        self.init_damage()

    def init_damage(self):
        try:
            self.damage = DamageMonitor(self.x, self.display, self.root)
        except Exception:
            # Capture/input still work on X servers without this optional extension.
            self.damage = None

    def changed(self, request):
        damage = getattr(self, 'damage', None)
        window = int(request.get('windowId') or '0', 16)
        physical = damage.changed(window) if damage else True
        key = (request.get('windowId'), request['maxWidth'], request['maxHeight'],
               request['quality'], request.get('lossless', False))
        saved = self.last_frames.get(key)
        refine = bool(saved and request.get('lossless') and
            request.get('since') == saved['pixels'] + '.j' and
            time.monotonic() - saved['changedAt'] >= SETTLE_SECONDS)
        return dict(supported=damage is not None, changed=physical or refine)

    @staticmethod
    def bind(lib, name, result, arguments):
        fn = getattr(lib, name)
        fn.restype, fn.argtypes = result, arguments

    def atom(self, name):
        if name not in self.atoms:
            self.atoms[name] = self.x.XInternAtom(self.display, name.encode(), 0)
        return self.atoms[name]

    def prop(self, window, name):
        actual, fmt, length, remaining = C.c_ulong(), C.c_int(), C.c_ulong(), C.c_ulong()
        value = C.POINTER(C.c_ubyte)()
        result = self.x.XGetWindowProperty(self.display, window, self.atom(name), 0, 65536,
            0, 0, C.byref(actual), C.byref(fmt), C.byref(length), C.byref(remaining), C.byref(value))
        if result or not value:
            return []
        try:
            if fmt.value == 8:
                return C.string_at(value, length.value)
            if fmt.value == 32:
                return list(C.cast(value, C.POINTER(C.c_ulong))[:length.value])
            return []
        finally:
            self.x.XFree(value)

    def attributes(self, window):
        attrs = Attributes()
        return attrs if self.x.XGetWindowAttributes(self.display, window, C.byref(attrs)) else None

    def origin(self, window):
        x, y, child = C.c_int(), C.c_int(), C.c_ulong()
        if not self.x.XTranslateCoordinates(self.display, window, self.root, 0, 0,
                                            C.byref(x), C.byref(y), C.byref(child)):
            raise RuntimeError('The BrowserOS window no longer exists.')
        return x.value, y.value

    def tree(self, window):
        root, parent, count = C.c_ulong(), C.c_ulong(), C.c_uint()
        children = C.POINTER(C.c_ulong)()
        if not self.x.XQueryTree(self.display, window, C.byref(root), C.byref(parent),
                                C.byref(children), C.byref(count)):
            return 0, []
        try:
            return parent.value, list(children[:count.value])
        finally:
            if children:
                self.x.XFree(children)

    def title(self, window):
        raw = self.prop(window, '_NET_WM_NAME') or self.prop(window, 'WM_NAME')
        return raw.decode('utf-8', 'replace') if isinstance(raw, bytes) else ''

    def wm_class(self, window):
        value = self.prop(window, 'WM_CLASS')
        return value.lower().split(b'\0') if isinstance(value, bytes) else []

    def pid(self, window):
        value = self.prop(window, '_NET_WM_PID')
        return value[0] if value else None

    def is_browser(self, window):
        pid = self.pid(window)
        if pid:
            exe = os.path.realpath('/proc/' + str(pid) + '/exe').lower()
            if 'browserclaw' in exe or 'browseros' in exe:
                return True
        return b'chromium-browser' in self.wm_class(window) and 'browseros' in self.title(window).lower()

    def windows(self):
        active = self.prop(self.root, '_NET_ACTIVE_WINDOW')
        result = []
        for window in self.prop(self.root, '_NET_CLIENT_LIST_STACKING'):
            if not self.is_browser(window):
                continue
            attrs = self.attributes(window)
            if not attrs:
                continue
            state = self.prop(window, 'WM_STATE')
            minimized = self.atom('_NET_WM_STATE_HIDDEN') in self.prop(window, '_NET_WM_STATE') or bool(state and state[0] == 3)
            result.append(dict(id=hex(window), title=re.sub(r'\s[-–]\sBrowserOS.*$', '',
                self.title(window), flags=re.I), width=attrs.width, height=attrs.height,
                focused=bool(active and active[0] == window), minimized=minimized))
        result.sort(key=lambda w: (w['minimized'], -w['width'] * w['height'], int(w['id'], 16)))
        return result

    def display_info(self):
        root = self.attributes(self.root)
        desktop = self.prop(self.root, '_NET_CURRENT_DESKTOP')
        areas = self.prop(self.root, '_NET_WORKAREA')
        offset = (desktop[0] if desktop else 0) * 4
        if root is None or len(areas) < offset + 4:
            raise RuntimeError('The X11 desktop did not report its screen size and work area.')
        x, y, width, height = areas[offset:offset + 4]
        return dict(screenWidth=root.width, screenHeight=root.height,
                    workarea=dict(x=x, y=y, width=width, height=height))

    def pump_events(self):
        for _ in range(64):
            if not self.context.iteration(False):
                break

    def capture_window(self, window, width, height):
        self.pump_events()
        self.gdk.error_trap_push()
        try:
            native = self.foreign_windows.get(window)
            if native is None or native.is_destroyed():
                native = self.GdkX11.X11Window.foreign_new_for_display(self.gdk, window)
                if native is None:
                    return None
                # GDK caches foreign geometry; ConfigureNotify must update it after a resize.
                # Drop destroyed wrappers naturally. Calling destroy() would close BrowserOS.
                native.set_events(native.get_events() | self.Gdk.EventMask.STRUCTURE_MASK)
                self.foreign_windows[window] = native
                self.gdk.flush()
            attrs = self.attributes(window)
            if attrs is None or native.is_destroyed():
                return None
            # ConfigureNotify may still be in flight. Capture only pixels GDK and X11 agree exist.
            width = min(width, attrs.width, native.get_width())
            height = min(height, attrs.height, native.get_height())
            if width <= 0 or height <= 0:
                return None
            return self.Gdk.pixbuf_get_from_window(native, 0, 0, width, height)
        except Exception:
            # A window may unmap or disappear between discovery and capture.
            return None
        finally:
            self.gdk.error_trap_pop_ignored()

    def composite_popups(self, image, window):
        tx, ty = self.origin(window)
        width, height = image.get_width(), image.get_height()
        pid, classes = self.pid(window), set(self.wm_class(window)) - {b''}
        ancestor = window
        for _ in range(16):
            parent, _ = self.tree(ancestor)
            if parent == self.root or not parent:
                break
            ancestor = parent
        _, children = self.tree(self.root)
        above = False
        for popup in children:
            if popup == ancestor:
                above = True
                continue
            if not above:
                continue
            attrs = self.attributes(popup)
            if not attrs or not attrs.override_redirect or attrs.map_state != 2:
                continue
            if not ((pid and self.pid(popup) == pid) or classes.intersection(self.wm_class(popup))):
                continue
            try:
                px, py = self.origin(popup)
            except RuntimeError:
                continue
            dx, dy = px - tx, py - ty
            left, top = max(0, dx), max(0, dy)
            right, bottom = min(width, dx + attrs.width), min(height, dy + attrs.height)
            if right <= left or bottom <= top:
                continue
            if getattr(self, 'damage', None):
                self.damage.watch(popup)
            overlay = self.capture_window(popup, attrs.width, attrs.height)
            if overlay:
                right = min(right, dx + overlay.get_width())
                bottom = min(bottom, dy + overlay.get_height())
                if right <= left or bottom <= top:
                    continue
                overlay.composite(image, left, top, right - left, bottom - top,
                                  dx, dy, 1.0, 1.0, self.Pixbuf.InterpType.NEAREST, 255)

    def frame(self, request):
        self.pump_events()
        self.foreign_windows = {xid: native for xid, native in self.foreign_windows.items() if not native.is_destroyed()}
        windows = self.windows()
        if getattr(self, 'damage', None):
            self.damage.retain_targets({int(w['id'], 16) for w in windows},
                                       lambda xid: self.attributes(xid) is not None)
        result = dict(status='ready' if windows else 'not-running',
            reason=None if windows else 'No BrowserOS window is open.', windows=windows,
            windowId=None, windowWidth=0, windowHeight=0, hash=None, changed=False,
            image=None, mimeType='image/jpeg', imageWidth=0, imageHeight=0)
        if not windows:
            self.last_frames.clear()
            self.last_images.clear()
            return result
        ids = {w['id'] for w in windows}
        self.last_frames = {k: v for k, v in self.last_frames.items() if k[0] in ids}
        self.last_images = {k: v for k, v in self.last_images.items() if k in ids}
        target = next((w for w in windows if w['id'] == request.get('windowId')), windows[0])
        window = int(target['id'], 16)
        result.update(windowId=target['id'], windowWidth=target['width'], windowHeight=target['height'])
        lossless = request.get('lossless', False)
        key = (target['id'], request['maxWidth'], request['maxHeight'], request['quality'], lossless)
        if getattr(self, 'damage', None):
            self.damage.watch(window, target=True)
        attrs = self.attributes(window)
        image = None
        if attrs and attrs.map_state == 2 and not target['minimized']:
            image = self.capture_window(window, target['width'], target['height'])
        if image is None:
            if getattr(self, 'damage', None):
                # Minimized windows retain their last image; consume the unmap
                # notification so an idle long poll does not capture repeatedly.
                self.damage.captured(window)
            cached = self.last_frames.get(key)
            if cached and encoding_tier(cached['pixels'], lossless, request.get('since'),
                    cached['changedAt'], time.monotonic(), cached['hash'].endswith('.p')) == cached['hash'][-1]:
                return frame_response(result, cached, request.get('since'), request.get('includeImage', False))
            image = self.last_images.get(target['id'])
            if image is None:
                return result
        else:
            try:
                self.composite_popups(image, window)
            except RuntimeError:
                pass
            if len(self.last_images) >= 24 and target['id'] not in self.last_images:
                self.last_images.pop(next(iter(self.last_images)))
            self.last_images[target['id']] = image
            if getattr(self, 'damage', None):
                self.damage.captured(window)
        width, height = fit_size(image.get_width(), image.get_height(), request['maxWidth'], request['maxHeight'])
        if width != image.get_width() or height != image.get_height():
            image = image.scale_simple(width, height, self.Pixbuf.InterpType.BILINEAR)
        pixels = pixel_hash(image, request['quality'], lossless)
        cached = self.last_frames.get(key)
        now = time.monotonic()
        same_pixels = cached and cached['pixels'] == pixels
        changed_at = cached['changedAt'] if same_pixels else now
        tier = encoding_tier(pixels, lossless, request.get('since'), changed_at, now,
                             refined=bool(same_pixels and cached['hash'].endswith('.p')))
        frame_hash = pixels + '.' + tier
        if cached and cached['hash'] == frame_hash:
            return frame_response(result, cached, request.get('since'), request.get('includeImage', False))
        encoded, mime_type = encode_image(image, request['quality'], tier == 'p')
        saved = dict(hash=frame_hash, changed=True,
                     image=base64.b64encode(encoded).decode('ascii'), mimeType=mime_type,
                     imageWidth=width, imageHeight=height, pixels=pixels, changedAt=changed_at)
        if len(self.last_frames) >= 24 and key not in self.last_frames:
            self.last_frames.pop(next(iter(self.last_frames)))
        self.last_frames[key] = saved
        return frame_response(result, saved, request.get('since'), request.get('includeImage', False))

    def activate(self, window):
        attrs = self.attributes(window)
        if attrs is None:
            raise RuntimeError('The BrowserOS window no longer exists.')
        active = self.prop(self.root, '_NET_ACTIVE_WINDOW')
        if attrs.map_state == 2 and active and active[0] == window:
            return
        if attrs.map_state != 2:
            self.x.XMapWindow(self.display, window)
        event = XEvent()
        event.client.type, event.client.display, event.client.window = 33, self.display, window
        event.client.message_type, event.client.format = self.atom('_NET_ACTIVE_WINDOW'), 32
        event.client.data.l[0], event.client.data.l[1] = 2, 0
        self.x.XSendEvent(self.display, self.root, 0, (1 << 20) | (1 << 19), C.byref(event))
        self.x.XFlush(self.display)
        deadline = time.monotonic() + 0.4
        while time.monotonic() < deadline:
            active = self.prop(self.root, '_NET_ACTIVE_WINDOW')
            attrs = self.attributes(window)
            if attrs and attrs.map_state == 2 and active and active[0] == window:
                return
            time.sleep(0.01)
        raise RuntimeError('The desktop did not activate the BrowserOS window; no input was sent.')

    def mapping(self):
        low, high, per_key = C.c_int(), C.c_int(), C.c_int()
        self.x.XDisplayKeycodes(self.display, C.byref(low), C.byref(high))
        raw = self.x.XGetKeyboardMapping(self.display, low.value, high.value - low.value + 1, C.byref(per_key))
        if not raw:
            raise RuntimeError('The X11 keyboard mapping is unavailable.')
        try:
            return low.value, per_key.value, list(raw[:(high.value - low.value + 1) * per_key.value])
        finally:
            self.x.XFree(raw)

    def keysym(self, key):
        name = key_name(key)
        return name if isinstance(name, int) else self.x.XStringToKeysym(name.encode())

    def keycode(self, symbol, mapping):
        low, width, values = mapping
        # Core group 1 levels: looking at only the first two avoids silently typing
        # another character from a level that requires AltGr or a different group.
        for level in range(min(2, width)):
            for offset in range(0, len(values), width):
                if values[offset + level] == symbol:
                    return low + offset // width, level == 1
        return 0, False

    def fake_key(self, code, down):
        if not self.xt.XTestFakeKeyEvent(self.display, code, int(down), 0):
            raise RuntimeError('X11 could not send the key.')
        if down:
            self.held_keys.add(code)
        else:
            self.held_keys.discard(code)

    def press_key(self, key, modifiers=()):
        symbol = self.keysym(key)
        mapping = self.mapping()
        code, shifted = self.keycode(symbol, mapping)
        restore = None
        held = []
        try:
            if not code:
                low, width, values = mapping
                for offset in range(0, len(values), width):
                    if not any(values[offset:offset + width]):
                        code = low + offset // width
                        restore = (C.c_ulong * width)(*values[offset:offset + width])
                        replacement = (C.c_ulong * width)(*([symbol] * width))
                        self.x.XChangeKeyboardMapping(self.display, code, width, replacement, 1)
                        self.x.XSync(self.display, 0)
                        time.sleep(0.01)
                        break
                if not code:
                    raise RuntimeError('No unused X11 keycode is available for ' + repr(key) + '.')
            names = {'ctrl': 'Control_L', 'shift': 'Shift_L', 'alt': 'Alt_L', 'meta': 'Super_L'}
            modifiers = list(dict.fromkeys(modifiers))
            if shifted and 'shift' not in modifiers:
                modifiers.append('shift')
            for modifier in modifiers:
                modifier_code, _ = self.keycode(self.x.XStringToKeysym(names[modifier].encode()), mapping)
                if not modifier_code:
                    raise RuntimeError('The keyboard has no ' + modifier + ' key.')
                self.fake_key(modifier_code, True)
                held.append(modifier_code)
            self.fake_key(code, True)
            self.fake_key(code, False)
            self.x.XSync(self.display, 0)
            time.sleep(0.008)
        finally:
            for modifier_code in reversed(held):
                self.fake_key(modifier_code, False)
            self.x.XSync(self.display, 0)
            if restore is not None:
                time.sleep(0.02)
                self.x.XChangeKeyboardMapping(self.display, code, len(restore), restore, 1)
                self.x.XSync(self.display, 0)

    def pointer(self, window, event):
        attrs = self.attributes(window)
        if not attrs:
            raise RuntimeError('The BrowserOS window no longer exists.')
        x, y = self.origin(window)
        x += max(0, min(attrs.width - 1, round(event['x'])))
        y += max(0, min(attrs.height - 1, round(event['y'])))
        if not self.xt.XTestFakeMotionEvent(self.display, -1, x, y, 0):
            raise RuntimeError('X11 could not move the pointer.')

    def button(self, button, down):
        if not self.xt.XTestFakeButtonEvent(self.display, button, int(down), 0):
            raise RuntimeError('X11 could not send the mouse button.')
        if down:
            self.held_buttons.add(button)
        else:
            self.held_buttons.discard(button)

    def release_input(self):
        for code in tuple(self.held_keys):
            self.fake_key(code, False)
        for button in tuple(self.held_buttons):
            self.button(button, False)
        self.x.XSync(self.display, 0)

    def input(self, request):
        window = int(request['windowId'], 16)
        if request['windowId'] not in {w['id'] for w in self.windows()}:
            raise RuntimeError('The BrowserOS window no longer exists.')
        self.activate(window)
        self.last_error = None
        try:
            for event in request['events']:
                kind = event['type']
                # Stop if focus was stolen mid-batch; continuing would type into another app.
                active = self.prop(self.root, '_NET_ACTIVE_WINDOW')
                if not active or active[0] != window:
                    raise RuntimeError('The BrowserOS window lost focus; remaining input was stopped.')
                if kind in ('move', 'down', 'up', 'click', 'scroll'):
                    self.pointer(window, event)
                if kind in ('down', 'up', 'click'):
                    button = {'left': 1, 'middle': 2, 'right': 3}[event['button']]
                    if kind == 'click':
                        for count in range(event['count']):
                            if count:
                                time.sleep(0.04)
                            self.button(button, True)
                            self.button(button, False)
                            # Deliver each click before waiting; otherwise Xlib buffers
                            # both clicks and Chromium receives identical timestamps.
                            self.x.XSync(self.display, 0)
                    else:
                        self.button(button, kind == 'down')
                elif kind == 'scroll':
                    for delta, negative, positive in ((event['dy'], 4, 5), (event['dx'], 6, 7)):
                        for _ in range(abs(delta)):
                            self.button(positive if delta > 0 else negative, True)
                            self.button(positive if delta > 0 else negative, False)
                elif kind == 'key':
                    self.press_key(event['key'], event['modifiers'])
                elif kind == 'text':
                    for char in event['text']:
                        active = self.prop(self.root, '_NET_ACTIVE_WINDOW')
                        if not active or active[0] != window:
                            raise RuntimeError('The BrowserOS window lost focus; remaining text was stopped.')
                        self.press_key('Enter' if char == '\n' else 'Tab' if char == '\t' else char)
                self.x.XSync(self.display, 0)
                if self.last_error:
                    raise RuntimeError(self.last_error)
                time.sleep(0.005)
        except Exception:
            self.release_input()
            raise
        return dict(ok=True, error=None)


def main():
    if '--selftest' in sys.argv:
        # No GI or X11 initialization, so these checks also run on headless machines.
        cases = json.loads(sys.stdin.read())
        print(json.dumps(dict(keys=[key_name(k) for k in cases.get('keys', [])],
                              sizes=[fit_size(*s) for s in cases.get('sizes', [])])))
        return
    try:
        desktop = Desktop()
        atexit.register(desktop.release_input)
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        unsupported = None
    except Exception as error:
        desktop = None
        unsupported = 'BrowserOS remote display needs Python 3, PyGObject/Gdk 3, libX11, libXtst and an X11 desktop: ' + str(error)
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            if unsupported:
                if request['method'] == 'frame':
                    result = dict(status='unsupported', reason=unsupported, windows=[], windowId=None,
                        windowWidth=0, windowHeight=0, hash=None, changed=False, image=None, mimeType='image/jpeg', imageWidth=0, imageHeight=0)
                elif request['method'] == 'display':
                    raise RuntimeError(unsupported)
                else:
                    result = dict(ok=False, error=unsupported)
            elif request['method'] == 'frame':
                result = desktop.frame(request['params'])
            elif request['method'] == 'changed':
                result = desktop.changed(request['params'])
            elif request['method'] == 'input':
                result = desktop.input(request['params'])
            elif request['method'] == 'display':
                result = desktop.display_info()
            elif request['method'] == 'activate':
                desktop.activate(int(request['params']['windowId'], 16))
                result = dict(ok=True, error=None)
            else:
                raise ValueError('Unknown helper method.')
            print(json.dumps(dict(id=request['id'], result=result), separators=(',', ':')), flush=True)
        except Exception as error:
            if desktop and request and request.get('method') == 'input':
                desktop.release_input()
            print(json.dumps(dict(id=request.get('id') if request else None, error=str(error))), flush=True)


if __name__ == '__main__':
    main()
`;
