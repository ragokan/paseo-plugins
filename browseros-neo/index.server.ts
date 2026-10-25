import type { PluginServerContext } from "@getpaseo/plugin/server";
import { BrowserDaemon } from "./server/daemon.ts";
import { fitDisplay, launchBrowser, readFrame, sendInput } from "./shared/contracts.ts";

export default function contribute(server: PluginServerContext) {
  const daemon = new BrowserDaemon();
  server.handle(readFrame, daemon.readFrame);
  server.handle(sendInput, daemon.sendInput);
  server.handle(fitDisplay, daemon.fitDisplay);
  server.handle(launchBrowser, daemon.launchBrowser);
  return async () => { await daemon.stop(); };
}
