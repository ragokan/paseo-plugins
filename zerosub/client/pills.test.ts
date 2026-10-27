import type { PluginButton, PluginButtonMenuEntry, PluginClientContext } from "@getpaseo/plugin/client";
import { describe, expect, it, vi } from "vitest";
import type { AccountView, AgentRoute, StateView } from "../shared/model";
import { setAgentAccount } from "../shared/rpc";
import { contributePills } from "./pills";
import type { ZeroSubStore } from "./store";

// The popovers render React Native, which the pill's menu doesn't need here.
vi.mock("./fork-confirm", () => ({ forkPopover: () => () => null }));
vi.mock("./reset-confirm", () => ({ resetPopover: () => () => null }));

const AGENT = { id: "agent-1", workspaceId: "workspace-1", provider: "claude" };

function account(id: string, label: string, overrides: Partial<AccountView> = {}): AccountView {
  return {
    id,
    family: "claude",
    label,
    kind: "managed",
    email: null,
    plan: null,
    organization: null,
    status: "ready",
    isDefault: false,
    limitedUntil: null,
    usage: null,
    agentCount: 0,
    home: null,
    ...overrides,
  } as AccountView;
}

/** The pill ZeroSub shows for AGENT, and the store calls its menu makes. */
async function pillFor(route: Omit<AgentRoute, "agentId" | "family">) {
  const state = {
    accounts: [account("claude-development", "development", { status: "limited" }), account("claude-main", "okan", { kind: "main" })],
    agents: [{ agentId: AGENT.id, family: "claude", ...route }],
    logins: [],
    providers: { claude: "claude" },
    canReopen: true,
    browserSignIn: true,
    showComposerPill: true,
    warnings: [],
  } as unknown as StateView;
  const rpc = vi.fn(async () => ({}));
  const store = {
    current: { state },
    subscribe: () => () => undefined,
    rpc,
    refresh: async () => undefined,
  } as unknown as ZeroSubStore;
  const buttons: PluginButton[] = [];
  const client = {
    addComposerPill: ({ button }: { button: PluginButton }) => {
      buttons.push(button);
      return { update: (patch: PluginButton) => buttons.push(patch), remove: () => undefined };
    },
    openSurface: () => undefined,
    paseo: {
      agents: {
        list: async () => ({
          subscription: {
            subscribe: ({ snapshot }: { snapshot: (page: unknown) => void }) =>
              snapshot({ entries: [{ agent: AGENT }], pageInfo: { hasMore: false, nextCursor: null } }),
          },
        }),
      },
    },
  } as unknown as PluginClientContext;
  const stop = contributePills(client, store);
  await vi.waitFor(() => expect(buttons).toHaveLength(1));
  stop();
  const button = buttons[0]!;
  if (button.behavior.kind !== "menu") throw new Error("the pill should open a menu");
  const item = (title: string) =>
    button.behavior.kind === "menu"
      ? (button.behavior.items.find(
          (entry): entry is Extract<PluginButtonMenuEntry, { kind: "item" }> => entry.kind === "item" && entry.title.startsWith(title),
        ) ?? null)
      : null;
  return { button, item, rpc };
}

describe("the account pill", () => {
  it("moves an agent still on a spent account when its routed account is picked", async () => {
    // development hit its limit, so the agent's next session goes to okan, but the session it has
    // open is still on development. An idle agent has no turn to end, so nothing moves it by itself.
    const { button, item, rpc } = await pillFor({ accountId: "claude-main", pinned: true, pendingAccountId: "claude-development", movable: true });
    expect(button.label).toBe("okan (after this turn)");

    const okan = item("okan");
    expect(okan?.disabled).toBe(false);
    if (okan?.behavior.kind !== "action") throw new Error("okan should be an action");
    await okan.behavior.onPress();
    expect(rpc).toHaveBeenCalledWith(setAgentAccount, { agentId: AGENT.id, accountId: "claude-main" });
  });

  it("leaves the account an agent already runs on unpickable", async () => {
    const { item } = await pillFor({ accountId: "claude-main", pinned: true, pendingAccountId: null, movable: true });
    expect(item("okan")?.disabled).toBe(true);
  });
});
