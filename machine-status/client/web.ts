import { Platform } from "react-native";

// The DOM this module uses, on the desktop and web apps only.
interface ElementLike {
  getClientRects(): { length: number };
}
declare class ResizeObserver {
  constructor(callback: () => void);
  observe(target: ElementLike): void;
  disconnect(): void;
}

/**
 * Calls onChange with whether the element is drawn, now and whenever that
 * changes: the desktop and web apps hide a screen kept under another with
 * `display: none`, which takes its size to nothing. The iOS and Android apps have
 * no page to look at, so there it never calls and the screen counts as shown.
 * Returns a function that stops watching.
 */
export function watchShown(node: unknown, onChange: (shown: boolean) => void): () => void {
  if (Platform.OS !== "web" || typeof ResizeObserver === "undefined") return () => {};
  const element = node as Partial<ElementLike> | null;
  if (typeof element?.getClientRects !== "function") return () => {};
  const check = () => onChange(element.getClientRects!().length > 0);
  const observer = new ResizeObserver(check);
  observer.observe(element as ElementLike);
  check();
  return () => observer.disconnect();
}
