import { Platform } from "react-native";

// The DOM this module uses, on the desktop and web apps only.
interface StyleElement {
  textContent: string | null;
  remove(): void;
}
declare const document: {
  createElement(tag: "style"): StyleElement;
  head: { appendChild(node: StyleElement): void };
};
// A key press, as the page's keydown event has it.
export interface KeyPress {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}
type KeyListener = (event: KeyPress) => void;
declare const window: {
  location: { pathname: string };
  addEventListener(type: "keydown", listener: KeyListener, capture: boolean): void;
  removeEventListener(type: "keydown", listener: KeyListener, capture: boolean): void;
};
declare const navigator: { platform: string };

// Idle's group in the sidebar, whose icon is Done's: a check in a circle, in the theme's muted text color.
const IDLE_ICON = '[data-testid="sidebar-status-group-idle"] svg:has(circle)';
// The filter turns that gray into the Idle label's yellow, Paseo's amber label color: its light one on
// a dark theme's light gray, its dark one on a light theme's dark gray. The page carries no theme name to
// pick a color by.
const IDLE_CSS = `
${IDLE_ICON} { filter: sepia(1) saturate(1.6) brightness(0.75); }
${IDLE_ICON} path { d: path("M8 12h8") !important; }
`;
// The Done label in gray, like Paseo's Done group: Paseo's label colors have no gray, so status-labels
// makes it indigo, and grayscale keeps its light and dark shades.
const DONE_CSS = `[data-testid="workspace-label-chip-Done"] { filter: grayscale(1); }`;

/**
 * Draws Idle's group icon as a minus in a circle, in the Idle label's yellow, and grays the Done
 * label. The app gives plugins no way to change these, so this styles the desktop and web apps' page;
 * iOS and Android keep Paseo's own. Returns a function that takes it off.
 */
export function stylePage(): () => void {
  if (Platform.OS !== "web") return () => {};
  const style = document.createElement("style");
  style.textContent = [IDLE_CSS, DONE_CSS].join("\n");
  document.head.appendChild(style);
  return () => style.remove();
}

/**
 * Calls listener with every key pressed in the desktop and web apps' window, before the page's own
 * handlers see it. Returns a function that stops.
 */
export function listenForKeys(listener: KeyListener): () => void {
  if (Platform.OS !== "web") return () => {};
  window.addEventListener("keydown", listener, true);
  return () => window.removeEventListener("keydown", listener, true);
}

/** The page's path, which is the app's route on the desktop and web apps. */
export function pagePath(): string | null {
  return Platform.OS === "web" ? window.location.pathname : null;
}

/** Whether the desktop or web app runs on a Mac. */
export function onMac(): boolean {
  return Platform.OS === "web" && /^Mac/.test(navigator.platform);
}
