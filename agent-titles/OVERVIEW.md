Gives each Claude and Codex agent you start a short title from its first message, like "Fix flaky login test in auth.spec.ts", instead of the message's first 60 characters. Paseo writes such titles for workspaces but not for the agents inside them, and Claude and Codex don't title the sessions Paseo runs either.

The title comes a few seconds after the agent's first turn starts. It is written by the model in **Settings → Host → Metadata**, the one Paseo uses for workspace titles, branch names and commit messages, in the same style as a workspace title. In Automatic mode that is a Haiku model, then GPT-5.4 mini, then the agent's own model, whichever your providers have. In Manual mode it is only the models you picked there.

An agent keeps its title when:

- another agent started it, since the starter named it;
- it was started with a title, or you renamed it, before the title was written;
- it is not a Claude or Codex agent;
- the plugin has already titled it.

Agents started before the plugin was installed get a title on their next turn, if their conversation is still short.

How it runs the model: it calls the `claude` or `codex` command Paseo runs, with your login on the daemon's machine. Claude gets one request with no tools, MCP servers, settings, hooks or saved session. Codex runs read-only in an empty folder, without MCP servers and without saving the session. It sends the agent's first message, up to 20,000 characters, to that model and nothing else. Only Claude and Codex models from the Metadata settings are used. If you use a plugin that picks Claude or Codex accounts per agent, such as ZeroSub, the title is written with the account the command uses by default.

Limits:

- It renames agents through the `paseo` command-line tool on the daemon's machine, as plugins have no way to rename an agent yet.
- Per-project title instructions in `paseo.json` are not applied.
- When every model fails, the agent keeps its title, and the error is in **Settings → Plugins → Logs**.
