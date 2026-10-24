Picks Claude and Codex agents back up after the daemon goes away mid-turn. When the daemon starts, every agent whose last turn a daemon stop, restart or crash cut off, or whose last turn ended with an error, gets a message asking it to continue where it left off. Turns you stopped and turns that finished are left alone, and so are archived agents and agents whose last activity is more than a day old. Subagents are resumed like any other agent.

The message is "Your previous turn was cut off when the Paseo daemon stopped. Continue where you left off." After an error it names the error instead. A failed turn is retried once per daemon start, so one that hit a usage limit fails again until the limit resets.

Paseo keeps no record of why a turn ended, and Codex writes the same "interrupted" for your Stop as for a daemon stop. So the plugin records how each agent's last turn ended in `plugin-data/continue-after-error/turns.json` in the daemon's home, and decides from that at the next start: a daemon stop closes the agent mid-turn or right after canceling it, a crash leaves the turn running, and your Stop cancels the turn and leaves the agent open.

Limits:

- It only knows the turns that ran while it was installed and on.
- A Stop pressed within three seconds of the daemon shutting down counts as cut off.
- Only a daemon start or restart resumes anything; reloading the plugin does not.
- It reaches the daemon through the `paseo` command-line tool on the daemon's machine, since a plugin has no other way in at startup.
