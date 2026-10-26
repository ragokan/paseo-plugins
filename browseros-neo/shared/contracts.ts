import { defineRpc, type RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * The app and the daemon agree on these and nothing else. Both sides validate
 * every call against them, so this module stays free of Node and React Native.
 *
 * Coordinates are the BrowserOS window's own units, (0, 0) at its top-left
 * corner, whatever size the app draws the frame at: X11 pixels on Linux, points
 * on macOS. The app scales a touch or a click back to window units before it
 * sends it. On a Retina Mac a frame can have more pixels than the window has
 * points.
 */

export const WindowSchema = z.object({
  /** The window id, as hex: the X11 window on Linux, the CGWindowID on macOS. */
  id: z.string().regex(/^0x[0-9a-f]+$/),
  /** The window's title without BrowserOS's " - BrowserOS neo" suffix. */
  title: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  /** The window the desktop has focused. */
  focused: z.boolean(),
  minimized: z.boolean(),
});

/**
 * - `ready`: BrowserOS has at least one window.
 * - `not-running`: no BrowserOS window; `launch` can start it.
 * - `unsupported`: no X11 display, or the daemon machine lacks what capture needs.
 */
export const StatusSchema = z.enum(["ready", "not-running", "unsupported"]);

export const readFrame = defineRpc({
  name: "frame.read",
  input: z.object({
    /**
     * Null for the default window: the largest one that is not minimized, the
     * oldest of equal ones (the lowest window id). Focus does not decide it, since
     * agents and popups move focus.
     */
    windowId: z.string().regex(/^0x[0-9a-f]+$/).nullable(),
    /** The largest image the app can use, in image pixels. Never scaled up. */
    maxWidth: z.number().int().min(64).max(8192),
    maxHeight: z.number().int().min(64).max(8192),
    /** JPEG quality for frames sent while the picture is changing. */
    quality: z.number().int().min(20).max(95),
    /**
     * Refine when still: once the picture has stopped changing for a moment, the
     * daemon sends the same pixels again as lossless PNG (a new frame id), so
     * moving content stays fast and still text is exact. A PNG over 1.5 MB is
     * sent as JPEG at quality 95 instead. Older apps omit it and get JPEG only.
     */
    lossless: z.boolean().default(false),
    /** The id of the last frame the app received; that frame is not sent again. */
    since: z.string().nullable(),
    /** Long poll: hold the call up to this long while the frame equals `since`. */
    waitMs: z.number().int().min(0).max(5000),
  }),
  output: z.object({
    status: StatusSchema,
    /** Why, for `unsupported` and `not-running`, in plain words. */
    reason: z.string().nullable(),
    /** Every BrowserOS window, the default one first. */
    windows: z.array(WindowSchema),
    /** The window this frame shows; null without one. */
    windowId: z.string().nullable(),
    /** The window's size in window units (see above), which input coordinates use. */
    windowWidth: z.number().int(),
    windowHeight: z.number().int(),
    /**
     * Identifies the frame: its pixels and how they are encoded, so a lossless
     * refinement of the same pixels has a new id. Equal to `since` when nothing changed.
     */
    hash: z.string().nullable(),
    /** False when the frame still equals `since`; then `image` is null. */
    changed: z.boolean(),
    /** Base64 image, without a data: prefix, in the `mimeType` format. */
    image: z.string().nullable(),
    mimeType: z.enum(["image/jpeg", "image/png"]),
    imageWidth: z.number().int(),
    imageHeight: z.number().int(),
  }),
});

const Button = z.enum(["left", "middle", "right"]);
const Point = { x: z.number(), y: z.number() };
const Modifier = z.enum(["ctrl", "shift", "alt", "meta"]);

export const InputEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("move"), ...Point }),
  z.object({ type: z.literal("down"), ...Point, button: Button }),
  z.object({ type: z.literal("up"), ...Point, button: Button }),
  z.object({
    type: z.literal("click"),
    ...Point,
    button: Button,
    count: z.number().int().min(1).max(3),
  }),
  /** Wheel notches at a point: positive dy scrolls down, positive dx right. */
  z.object({
    type: z.literal("scroll"),
    ...Point,
    dx: z.number().int().min(-50).max(50),
    dy: z.number().int().min(-50).max(50),
  }),
  /**
   * One key press, named as DOM `KeyboardEvent.key` names it: "Enter",
   * "Backspace", "ArrowLeft", "F5", "a", "A", "/". Modifiers are held around it.
   * "meta" is the Linux Super key; the app maps a Mac's Command to "ctrl".
   */
  z.object({ type: z.literal("key"), key: z.string().min(1).max(32), modifiers: z.array(Modifier) }),
  /** Text typed as is, any Unicode, into whatever has focus. */
  z.object({ type: z.literal("text"), text: z.string().min(1).max(10000) }),
]);

export const sendInput = defineRpc({
  name: "input.send",
  input: z.object({
    windowId: z.string().regex(/^0x[0-9a-f]+$/),
    /** Applied in order. The daemon brings the window to the front first. */
    events: z.array(InputEventSchema).min(1).max(200),
  }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

/**
 * Sizes the desktop so a maximized BrowserOS window matches the viewer: the
 * app sends the area it draws the window in, in its own logical pixels (CSS
 * pixels on the web and desktop apps, points on iOS, dp on Android). The daemon
 * scales that up to at least 800x600, keeping its shape. On Linux it grows or
 * shrinks the X11 virtual screen around a maximized BrowserOS; only virtual
 * displays (such as Xorg's dummy driver) are resized, and a real monitor is
 * left alone with `ok` false. On macOS it resizes the BrowserOS window itself,
 * within the screen's visible area. The last call wins; everything returns to
 * how it was once no app has read a frame for a minute, and when the plugin
 * stops.
 */
export const fitDisplay = defineRpc({
  name: "display.fit",
  input: z.object({
    width: z.number().int().min(100).max(8192),
    height: z.number().int().min(100).max(8192),
  }),
  output: z.object({
    ok: z.boolean(),
    /** The size BrowserOS's window gets, in window units; 0 when not resized. */
    width: z.number().int(),
    height: z.number().int(),
    error: z.string().nullable(),
  }),
});

export const launchBrowser = defineRpc({
  name: "browser.launch",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

export type BrowserWindow = z.output<typeof WindowSchema>;
export type FrameStatus = z.output<typeof StatusSchema>;
export type Frame = RpcOutput<typeof readFrame>;
export type InputEvent = z.output<typeof InputEventSchema>;
export type MouseButton = z.output<typeof Button>;
export type KeyModifier = z.output<typeof Modifier>;
