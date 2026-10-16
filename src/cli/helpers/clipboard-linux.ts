// Linux clipboard image reader: wl-paste on Wayland, xclip on X11
import { spawn } from "node:child_process";

const LIST_TIMEOUT_MS = 1000;
const READ_TIMEOUT_MS = 3000;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_LIST_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;

const PREFERRED_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

const EMPTY_CLIPBOARD_MESSAGES = [
  "nothing is copied",
  "no selection",
  "no suitable type of content copied",
  "not available",
  "cannot convert",
  "there is no owner",
];

export type CommandResult =
  | { status: "ok"; stdout: Buffer }
  | { status: "missing" }
  | { status: "timeout" }
  | { status: "too-large" }
  | { status: "failed"; stderr: string };

export type RunCommand = (
  command: string,
  args: string[],
  options: { timeoutMs: number; maxBytes: number },
) => Promise<CommandResult>;

export interface LinuxClipboardDeps {
  env: Record<string, string | undefined>;
  runCommand: RunCommand;
}

export type LinuxClipboardImage =
  | { kind: "image"; data: Buffer; mediaType: string }
  | { kind: "empty" }
  | { kind: "tools-missing" }
  | { kind: "error"; message: string };

type ToolOutcome =
  | { kind: "image"; data: Buffer; mediaType: string }
  | { kind: "empty" }
  | { kind: "missing" }
  | { kind: "too-large" }
  | { kind: "failed"; message: string };

interface ClipboardTool {
  name: string;
  listTypes: { command: string; args: string[] };
  readType: (mediaType: string) => { command: string; args: string[] };
}

const WL_PASTE: ClipboardTool = {
  name: "wl-paste",
  listTypes: { command: "wl-paste", args: ["--list-types"] },
  readType: (mediaType) => ({
    command: "wl-paste",
    args: ["--no-newline", "--type", mediaType],
  }),
};

const XCLIP: ClipboardTool = {
  name: "xclip",
  listTypes: {
    command: "xclip",
    args: ["-selection", "clipboard", "-t", "TARGETS", "-o"],
  },
  readType: (mediaType) => ({
    command: "xclip",
    args: ["-selection", "clipboard", "-t", mediaType, "-o"],
  }),
};

export function spawnCommand(
  command: string,
  args: string[],
  { timeoutMs, maxBytes }: { timeoutMs: number; maxBytes: number },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const settle = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ status: "timeout" });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        child.kill("SIGKILL");
        settle({ status: "too-large" });
        return;
      }
      stdout.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      stderrBytes += chunk.length;
      stderr.push(chunk);
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        settle({ status: "missing" });
        return;
      }
      settle({ status: "failed", stderr: err.message });
    });

    child.on("close", (code) => {
      if (code === 0) {
        settle({ status: "ok", stdout: Buffer.concat(stdout) });
        return;
      }
      settle({
        status: "failed",
        stderr:
          Buffer.concat(stderr).toString("utf8").trim() ||
          `exited with code ${code}`,
      });
    });
  });
}

function isEmptyClipboardMessage(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return EMPTY_CLIPBOARD_MESSAGES.some((message) => lower.includes(message));
}

function pickImageMediaType(listing: string): string | null {
  const types = listing
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => /^image\/[a-z0-9.+-]+$/.test(line));

  for (const preferred of PREFERRED_MEDIA_TYPES) {
    if (types.includes(preferred)) return preferred;
  }
  return types[0] ?? null;
}

async function readWithTool(
  tool: ClipboardTool,
  runCommand: RunCommand,
): Promise<ToolOutcome> {
  const listed = await runCommand(tool.listTypes.command, tool.listTypes.args, {
    timeoutMs: LIST_TIMEOUT_MS,
    maxBytes: MAX_LIST_BYTES,
  });
  const listFailure = classifyFailure(tool, "listing types", listed);
  if (listFailure) return listFailure;
  if (listed.status !== "ok") return { kind: "empty" };

  const mediaType = pickImageMediaType(listed.stdout.toString("utf8"));
  if (!mediaType) return { kind: "empty" };

  const read = tool.readType(mediaType);
  const result = await runCommand(read.command, read.args, {
    timeoutMs: READ_TIMEOUT_MS,
    maxBytes: MAX_IMAGE_BYTES,
  });
  const readFailure = classifyFailure(tool, "reading the image", result);
  if (readFailure) return readFailure;
  if (result.status !== "ok" || result.stdout.length === 0) {
    return { kind: "empty" };
  }
  return { kind: "image", data: result.stdout, mediaType };
}

function classifyFailure(
  tool: ClipboardTool,
  step: string,
  result: CommandResult,
): ToolOutcome | null {
  switch (result.status) {
    case "ok":
      return null;
    case "missing":
      return { kind: "missing" };
    case "too-large":
      return { kind: "too-large" };
    case "timeout":
      return { kind: "failed", message: `${tool.name} timed out ${step}` };
    case "failed":
      if (isEmptyClipboardMessage(result.stderr)) return { kind: "empty" };
      return {
        kind: "failed",
        message: `${tool.name} failed ${step}: ${result.stderr}`,
      };
  }
}

export async function readLinuxClipboardImage(
  deps: Partial<LinuxClipboardDeps> = {},
): Promise<LinuxClipboardImage> {
  const env = deps.env ?? process.env;
  const runCommand = deps.runCommand ?? spawnCommand;

  const hasWaylandDisplay = Boolean(env.WAYLAND_DISPLAY);
  const hasX11Display = Boolean(env.DISPLAY);
  if (!hasWaylandDisplay && !hasX11Display) return { kind: "empty" };

  const isWaylandSession =
    hasWaylandDisplay || env.XDG_SESSION_TYPE === "wayland";
  const tools: ClipboardTool[] = [];
  if (isWaylandSession) tools.push(WL_PASTE);
  if (hasX11Display) tools.push(XCLIP);

  let failure: string | null = null;
  for (const tool of tools) {
    const outcome = await readWithTool(tool, runCommand);
    switch (outcome.kind) {
      case "image":
        return outcome;
      case "empty":
        return { kind: "empty" };
      case "too-large":
        return { kind: "error", message: "Clipboard image is too large" };
      case "failed":
        failure = outcome.message;
        break;
      case "missing":
        break;
    }
  }

  if (failure) return { kind: "error", message: failure };
  return { kind: "tools-missing" };
}
