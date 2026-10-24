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

// Idle's group in the sidebar, whose icon is Done's: a check in a circle, in the theme's muted text color.
const IDLE_ICON = '[data-testid="sidebar-status-group-idle"] svg:has(circle)';
// The filter turns that gray into the Idle label's yellow, Paseo's amber label color: its light one on
// a dark theme's light gray, its dark one on a light theme's dark gray. The page carries no theme name to
// pick a color by.
const IDLE_CSS = `
${IDLE_ICON} { filter: sepia(1) saturate(1.6) brightness(0.75); }
${IDLE_ICON} path { d: path("M8 12h8") !important; }
`;

/**
 * Draws Idle's group icon as a minus in a circle, in the Idle label's yellow. The app gives plugins
 * no way to change a group's icon, so this styles the desktop and web apps' page; on iOS and Android
 * Idle keeps Done's icon. Returns a function that takes it off.
 */
export function styleIdleGroup(): () => void {
  if (Platform.OS !== "web") return () => {};
  const style = document.createElement("style");
  style.textContent = IDLE_CSS;
  document.head.appendChild(style);
  return () => style.remove();
}
