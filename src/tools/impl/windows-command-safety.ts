import { homedir } from "node:os";
import { win32 } from "node:path";

const CMD_REMOVALS = new Set(["rd", "rmdir", "del", "erase"]);
const POWERSHELLS = new Set([
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);

interface WindowsCommandSafetyOptions {
  platform?: NodeJS.Platform;
  cwd?: string;
  homeDirectory?: string;
  env?: NodeJS.ProcessEnv;
}

/** Tokenize command lists while preserving a quoted command as one token. */
function parseCommands(input: string): string[][] {
  const commands: string[][] = [];
  let tokens: string[] = [];
  let token = "";
  let quote: "single" | "double" | null = null;
  let escaped = false;

  const flushToken = () => {
    if (token) tokens.push(token);
    token = "";
  };
  const flushCommand = () => {
    flushToken();
    if (tokens.length) commands.push(tokens);
    tokens = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === undefined) continue;
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (quote === "single") {
      if (character === "'") quote = null;
      else token += character;
      continue;
    }
    if (quote === "double") {
      if (character === "`") escaped = true;
      else if (character === '"') quote = null;
      else token += character;
      continue;
    }
    if (character === "'") {
      quote = "single";
      continue;
    }
    if (character === '"') {
      quote = "double";
      continue;
    }
    if (character === "`" || character === "^") {
      escaped = true;
      continue;
    }
    if (/\s/.test(character)) {
      flushToken();
      if (character === "\n" || character === "\r") flushCommand();
      continue;
    }
    if (character === ";" || character === "&" || character === "|") {
      flushCommand();
      if (input[index + 1] === character) index += 1;
      continue;
    }
    if (character === "(" && !token && tokens.length === 0) continue;
    if (character === ")" && quote === null) {
      flushCommand();
      continue;
    }
    token += character;
  }

  flushCommand();
  return commands;
}

function executableName(token: string | undefined): string {
  return win32.basename((token ?? "").replaceAll("/", "\\")).toLowerCase();
}

function expandEnvironment(value: string, env: NodeJS.ProcessEnv): string {
  const entries = new Map(
    Object.entries(env).map(([name, entry]) => [
      name.toLowerCase(),
      entry ?? "",
    ]),
  );
  return value.replace(/%([^%]+)%/g, (_match, name: string) => {
    return entries.get(name.toLowerCase()) ?? "";
  });
}

function resolveRemovalTarget(
  rawTarget: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string | null {
  let target = expandEnvironment(rawTarget, env)
    .replace(/[),]+$/g, "")
    // PowerShell expands this before cmd sees it. An unset variable after a
    // literal path component can collapse the target to a protected parent.
    .replace(/(?<=[\\/:])\$(?:env:)?[A-Za-z_][A-Za-z0-9_]*/gi, "")
    .replaceAll("/", "\\");
  if (target.endsWith("\\*")) target = target.slice(0, -2) || "\\";
  if (!target || target === "*") return null;
  return win32.normalize(win32.resolve(cwd, target));
}

function comparablePath(value: string): string {
  const normalized = win32.normalize(value);
  const root = win32.parse(normalized).root;
  return normalized.toLowerCase() === root.toLowerCase()
    ? root.toLowerCase()
    : normalized.replace(/[\\/]+$/, "").toLowerCase();
}

function isProtectedPath(target: string, homeDirectory: string): boolean {
  if (comparablePath(target) === comparablePath(homeDirectory)) return true;
  const root = win32.parse(target).root;
  if (!root) return false;
  const relative = win32.relative(root, target);
  return !relative || relative.split(/[\\/]+/).filter(Boolean).length === 1;
}

function findProtectedPayloadTarget(
  payload: string,
  cwd: string,
  homeDirectory: string,
  env: NodeJS.ProcessEnv,
): string | null {
  for (const tokens of parseCommands(payload)) {
    if (!CMD_REMOVALS.has(executableName(tokens[0]))) continue;
    for (const token of tokens.slice(1)) {
      if (/^\/[A-Za-z?]+(?::.*)?$/.test(token)) continue;
      const target = resolveRemovalTarget(token, cwd, env);
      if (target && isProtectedPath(target, homeDirectory)) return target;
    }
  }
  return null;
}

function findProtectedCmdTarget(
  command: string,
  cwd: string,
  homeDirectory: string,
  env: NodeJS.ProcessEnv,
  depth = 0,
): string | null {
  if (depth > 3) return null;
  for (const tokens of parseCommands(command)) {
    const executable = executableName(tokens[0]);
    if (executable === "cmd" || executable === "cmd.exe") {
      const flag = tokens.findIndex(
        (token, index) => index > 0 && token.toLowerCase() === "/c",
      );
      if (flag === -1) continue;
      const target = findProtectedPayloadTarget(
        tokens.slice(flag + 1).join(" "),
        cwd,
        homeDirectory,
        env,
      );
      if (target) return target;
    } else if (POWERSHELLS.has(executable)) {
      const flag = tokens.findIndex(
        (token, index) =>
          index > 0 && ["-c", "-command"].includes(token.toLowerCase()),
      );
      if (flag === -1) continue;
      const target = findProtectedCmdTarget(
        tokens.slice(flag + 1).join(" "),
        cwd,
        homeDirectory,
        env,
        depth + 1,
      );
      if (target) return target;
    }
  }
  return null;
}

export function assertSafeWindowsCommand(
  command: string,
  options: WindowsCommandSafetyOptions = {},
): void {
  if ((options.platform ?? process.platform) !== "win32") return;
  const target = findProtectedCmdTarget(
    command,
    options.cwd ?? process.cwd(),
    options.homeDirectory ?? homedir(),
    options.env ?? process.env,
  );
  if (target) {
    throw new Error(
      `Refusing to run a cmd removal against protected Windows path: ${target}`,
    );
  }
}
