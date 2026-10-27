# ZeroSub

Use several Claude subscriptions side by side in [Paseo](https://paseo.sh), beside your ChatGPT (Codex) login, without logging in and out of the CLI.

This is a copy of [kapybara-org/zerosub](https://github.com/kapybara-org/zerosub) 1.3.0 by Kapybara, under the same plugin id and MIT license. It adds upstream's open fix for Paseo 0.13 ([#17](https://github.com/kapybara-org/zerosub/pull/17)), lists every account in Paseo's usage display, lets hosts share usage readings, and fixes how Make default, automatic moves and full usage readings route agents. It leaves out upstream's support for several ChatGPT accounts, forking a chat to the other provider, and the account button in the message box.

- **Add accounts in the app.** Click **Add account** under Claude and sign in on any device, including your phone. You don't need a terminal, environment variables or config files.
- **Your existing CLI logins show up automatically.** Nothing changes until you add a second account.
- **Pick an account per agent.** Type `/account <name>` in an agent's message box to move it.
- **Automatic failover.** When an account hits its 5-hour or weekly limit, the agent moves to the account with the most room left and carries on, and idle agents on it move too. Agents moved one after another spread across the roomiest accounts instead of all landing on one. New agents skip exhausted accounts.
- **Live usage.** Each account shows its own 5-hour and weekly usage and when they reset. Accounts in use refresh about every minute and after each turn, and a limit shows up the moment it hits.
- **Every account in Paseo's usage display.** On Paseo 0.11 and later, each account appears under **Claude · ZeroSub** or **ChatGPT · ZeroSub**, whether or not an agent uses it, so you can pin the ones you want. These cards show ZeroSub's last reading and never ask the provider themselves. Paseo's own Claude and Codex cards stay as well; they list only the CLI login and accounts with an agent open.
- **Banked resets.** If a provider has banked limit resets on an account, you can use one from the account card.
- **Set an account aside.** Disable an account for a while and its agents move to your other accounts, then come back when you enable it again.
- **Several hosts.** Each Paseo host keeps its own accounts, and the Accounts screen says which host you're looking at.
- **ChatGPT (Codex) uses your CLI login only.** Codex encrypts each thread's reasoning per ChatGPT account, so a thread can't move to another one. Its card shows usage, and a limit note says when it frees up.
- **Everything else stays the same.** Every account shares your settings, skills, plugins, MCP servers, `CLAUDE.md`/`AGENTS.md` and conversation history.

## Install

Requirements:

- Paseo 0.9.1 or later, with plugins enabled (**Settings → Plugins → Enable plugins**).
- The `claude` and/or `codex` CLI installed where the daemon runs, the same ones Paseo already uses.

On the daemon host:

```bash
paseo plugin install git:ragokan/paseo-plugins:zerosub
```

To replace an installed upstream copy, remove it first with `paseo plugin remove zerosub`. Accounts live in `~/.paseo/zerosub`, which removing the plugin leaves in place.

Then open **Accounts (ZeroSub)** in the sidebar.

## Use it

1. Open **Accounts (ZeroSub)** in the sidebar. Your current Claude Code and Codex logins are already listed.
2. Click **Add account** under Claude, then **Open sign-in page**, and sign in with the other account.
   - In a browser on the host's own computer, the page finishes by itself.
   - Anywhere else, choose **Use a code instead** and paste the code shown after sign-in. Phones, and hosts without a desktop (servers, containers, daemons started over SSH), start with the code.
   - A signed-out Codex CLI login is signed back in the same way, from its card; there, you type the code shown in Paseo on the ChatGPT page.
3. Choose which account agents use:
   - **Make default**: new agents, and agents that follow the default, use it. Open agents switch right away, busy ones after their turn. Agents that **Spread new agents across accounts** placed, and agents moved off an account at its limit, follow the default from then on; an agent you picked an account for stays on it.
     - To leave open agents where they are, turn off **Move open agents when the default changes** (in Accounts, or **Settings → Plugins → zerosub → ZeroSub preferences**). Each open agent that follows the default then stays pinned to the account it's using, even after it reopens, unless that account is signed out, disabled or at its limit. New agents, and agents that aren't open at the time, use the new default.
     - A kept agent still switches when its account hits a limit. To move it to the new default, type `/account default`.
   - **`/account work`** in the message box, or `/account default` to follow the default again.
   - **⌘K → "Make … the default"**.
   - **Disable for now** (the pause button on a card): the account stays signed in but ZeroSub stops using it. Its agents move to your other accounts right away (busy ones after their turn) and come back when you press **Enable**. You can't disable the last usable account of a provider.
4. Leave **Automatic switching** on (in Accounts, or **Settings → Plugins → zerosub → ZeroSub preferences**) and limits take care of themselves:
   - Only the CLIs' own limit notices trigger a switch. That covers Claude Code's "You've hit your session limit · resets 3pm" and Codex's "You’ve hit your usage limit…".
   - Paseo 0.13 and later no longer send the finished turn to plugins, so ZeroSub reads that turn from the agent's timeline instead.
   - A short note in the agent's timeline says what happened.
   - Idle agents on that account move as well, and so do they when a usage reading shows the account full before any agent hits the limit.
   - As a safety stop, one agent changes accounts at most 4 times in 10 minutes. If it hits that, its timeline says so; pick an account with `/account` to carry on.
   - An exhausted account is skipped until it resets. If you know it has room again sooner, for example after upgrading or buying credits, press **Mark as available again** (the check mark) on its card.

### ChatGPT (Codex)

Codex encrypts its reasoning per ChatGPT account, so another account can't read an existing thread. ZeroSub therefore keeps Codex on your CLI login: it shows that login's usage, marks it limited when Codex says so, and notes in the agent's timeline when it frees up. With **Use banked resets when every account is out** on, it spends one of the login's reset credits instead. Agents that an earlier release moved to another ChatGPT account keep that binding.

### Banked resets

Some plans come with banked limit resets: ChatGPT's reset credits, and Claude Code's limit resets. When an account has any, its card shows how many are banked and when they expire, with a **Use reset** button. Agents its limit stopped carry on afterwards.

- A reset can't be undone, so ZeroSub always asks first and says what it refills.
- **ChatGPT** uses Codex's own reset-credit API, the same one as `/usage` → reset in the Codex CLI. It never spends a credit while nothing is used up.
- **Claude** uses Claude Code's limit-reset endpoint. Anthropic decides which accounts get resets; so far it reports the tested accounts as not eligible, so the button may not appear for Claude. It shows up by itself once an account has a reset.
- **Use banked resets when every account is out** (off by default) spends one automatically, but only when every account of that provider is at its limit and the provider confirms the limit at that moment.

### When every account of a provider is out

ZeroSub tries these in order, and a timeline note says which one happened:

1. **Use a banked reset**, if you turned on **Use banked resets when every account is out**.
2. **Stop and say so**, with the time the account frees up.

## Several hosts

Paseo installs plugins per host (daemon), so install ZeroSub on each host whose agents should use it. When more than one host has it, Paseo shows a single **Accounts (ZeroSub)** item with a host picker at the top.

- **Each host has its own accounts, default and preferences**, because the sign-ins live on the machine where the agents run. The Accounts screen and the sign-in dialog name the host they belong to.
- **Sign the same account in on each host.** ZeroSub never copies sign-ins between hosts. Both providers rotate sign-in tokens, so two machines sharing one token sign each other out. Separate sign-ins of the same account work fine. Limits are per account, so every host sees the combined usage and switches when it runs out.
- **Remote hosts:** phones, and hosts without a desktop, get the code sign-in automatically. For a remote computer that does have a desktop, choose **Use a code instead** unless you're sitting at it.
- **Banked resets refill the account everywhere.** Automatic use re-checks the limit with the provider first, so two hosts can't spend two resets on the same limit.
- **Share usage readings.** Under Settings → Plugins → ZeroSub → **Usage across hosts**, list the hosts in order, this one included, e.g. `ragdevbox, ragmini, ragair`, and use the same list on each. Before a scheduled read, a host asks the hosts before it for a recent reading of the same account, matched by organization and email, and asks the provider only when none has one. So the first host reads, and the others mostly reuse its readings instead of each hitting the provider's rate limit. Offline or unreachable hosts are skipped silently. Refreshing by hand, and reads after a turn, still go to the provider. Hosts reach each other through Paseo's connected hosts (`paseo host ls`), so a host must be registered there to be asked.

## How it works

Each added Claude account gets its own credential home under `$PASEO_HOME/zerosub/homes/`:

- Claude uses it as `CLAUDE_CONFIG_DIR`, and keeps its login separate: in its own keychain entry, or `.credentials.json` on Linux.
- Everything that isn't account-specific is a symlink back to `~/.claude`, including `settings.json`, `skills/`, `plugins/` and `projects/`.
- Claude's `.claude.json` holds the account identity, so each account keeps its own copy. It's seeded from yours, and your MCP servers stay in sync.

A `before("agent.session_open")` hook sets those variables for every session Paseo opens: create, resume, refresh and import. To move a live agent, ZeroSub reopens its session with `paseo agent reload`. It never interrupts a running turn; a busy agent moves when its turn ends.

Sign-in runs the official CLIs:

- Claude: `claude auth login`.
- Codex, to sign your CLI login back in: `codex app-server`'s account API.

ZeroSub never implements OAuth itself and never copies credentials between accounts.

## Privacy and security

- Credentials stay in the CLIs' own stores. ZeroSub's registry (`$PASEO_HOME/zerosub/state.json`) holds account names, emails, plans, and which agent uses which account.
- To show Claude usage, ZeroSub reads each account's current access token and calls Anthropic's usage endpoint, the same way Paseo's built-in usage display and `/usage` do. It never logs or stores tokens and never refreshes them itself. When you refresh usage (the ↻ button beside the title) or use a reset and a token has expired, it runs `claude -p /usage` so Claude Code renews its own sign-in. Codex usage comes from `codex app-server`.
- Using a banked reset calls the provider's own reset endpoint with that account's sign-in, and only after you confirm (or turn on automatic use).
- Removing an account moves its agents to the default account, then signs it out (`claude auth logout`) and deletes its home. This happens once no agent is mid-turn on it. Abandoned sign-ins are cleaned up the same way.
- Your CLI login can't be removed from ZeroSub.

## Limitations

- **MCP servers that use OAuth** (Linear, Notion, …) store their tokens per Claude account, so sign in to them once on each account.
- **Shared settings apply to every account.** If `~/.claude/settings.json` sets an `apiKeyHelper` or API-key `env`, every account uses that key instead of its subscription.
- **Usage for an idle Claude account** shows the last reading until the account is used again or you refresh usage. Anthropic rate-limits its usage endpoint (Claude Code and Paseo read it too), so a reading can be a few minutes old; the card then says when it was taken. Readings are saved in `$PASEO_HOME/zerosub/usage.json`, so they survive restarts. Several hosts can share one read (see [Several hosts](#several-hosts)).
- **Password-protected daemons:** `paseo agent reload` can't authenticate. Agents then switch the next time their session starts, not immediately, and their timeline note says so.
- **ChatGPT device-code sign-in** has to be enabled in ChatGPT → Settings → Security. The browser option works from a browser on the host's own computer.
- Runs on macOS and Linux. Upstream tested it on macOS with Claude Code 2.1.280, Codex 0.156.1 and Paseo 0.9.1.

## Development

```bash
git clone https://github.com/ragokan/paseo-plugins.git
cd paseo-plugins/zerosub
npm install
paseo plugin install "$(pwd)"   # run the working copy

npm run typecheck      # client and server bundles, separately
npm test               # routing, failover, limit detection, usage, resets, shared readings
npm run audit:mobile   # no DOM/HTML in client code
paseo plugin reload zerosub
paseo plugin logs zerosub
```

Code layout:

- `client/`: React Native UI (Accounts surface, sign-in modal, commands, timeline note).
- `server/`: routing, account homes, Claude and Codex adapters, failover.
- `shared/`: RPC contracts and the view model.

Report problems at [github.com/ragokan/paseo-plugins/issues](https://github.com/ragokan/paseo-plugins/issues).

## Uninstall

Remove added accounts from **Accounts** first, so they're signed out. Then run:

```bash
paseo plugin remove zerosub
rm -rf ~/.paseo/zerosub
```
