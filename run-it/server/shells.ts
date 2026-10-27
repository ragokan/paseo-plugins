import { accessSync, constants } from "node:fs";
import { basename, join, resolve } from "node:path";

// The shell that runs a command, with the arguments that hand it the command: the user's login
// shell, non-interactive, so startup files like .zshrc don't load.
export function shellCommand(env: NodeJS.ProcessEnv, command: string): { file: string; args: string[] } {
  return { file: pickShell(env.SHELL), args: ["-c", command] };
}

const SHELLS = new Set(["zsh", "bash", "sh", "dash", "ksh", "fish"]);

export function pickShell(preferred: string | undefined): string {
  const candidates = [preferred && SHELLS.has(basename(preferred)) ? preferred : null, "/bin/bash", "/bin/sh"];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return "/bin/sh";
}


// Words a shell runs without a program on the PATH.
const BUILTINS = new Set(["cd", "export", "source", ".", "echo", "printf", "set", "unset", "alias", "eval", "exec", "pushd", "popd", "ulimit", "umask", "for", "if", "while"]);

// Whether a word starts a command here: a shell builtin, a program on the PATH, or a path to
// a program, read from the folder the command runs in. Remembers each word, so a long reply
// costs one lookup per word.
export function commandFinder(env: NodeJS.ProcessEnv, cwd: string): (word: string) => boolean {
  const dirs = (env.PATH ?? "").split(":").filter(Boolean);
  const runnable = (file: string) => {
    try {
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const seen = new Map<string, boolean>();
  return (word) => {
    let found = seen.get(word);
    if (found !== undefined) return found;
    found = BUILTINS.has(word);
    if (!found && word.includes("/")) found = runnable(resolve(cwd, word));
    else if (!found) found = dirs.some((dir) => runnable(join(dir, word)));
    seen.set(word, found);
    return found;
  };
}
