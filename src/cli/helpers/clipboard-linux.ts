// Linux clipboard image reader: wl-paste on Wayland, xclip on X11
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface ClipboardImage {
  data: Buffer;
  mediaType: string;
}

export type RunCommand = (
  argv: string[],
  limits: { timeout: number; maxBuffer: number },
) => Promise<Buffer>;

const execFileAsync = promisify(execFile);

export async function runCommand(
  [command = "", ...args]: string[],
  limits: { timeout: number; maxBuffer: number },
): Promise<Buffer> {
  const { stdout } = await execFileAsync(command, args, {
    ...limits,
    encoding: "buffer",
    killSignal: "SIGKILL",
  });
  return stdout;
}

const toolsMissingNotice = { shown: false };
const LIST = { timeout: 1000, maxBuffer: 64 * 1024 };
const READ = { timeout: 3000, maxBuffer: 50 * 1024 * 1024 };
const PREFERRED_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];
const EMPTY_CLIPBOARD =
  /nothing is copied|no selection|no suitable type|not available|cannot convert|there is no owner/i;

const WL_PASTE = {
  list: ["wl-paste", "--list-types"],
  read: (type: string) => ["wl-paste", "--no-newline", "--type", type],
};
const XCLIP = {
  list: ["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"],
  read: (type: string) => [
    "xclip",
    "-selection",
    "clipboard",
    "-t",
    type,
    "-o",
  ],
};

function pickImageMediaType(listing: string): string | null {
  const types = listing
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => /^image\/[a-z0-9.+-]+$/.test(line));
  return (
    PREFERRED_MEDIA_TYPES.find((p) => types.includes(p)) ?? types[0] ?? null
  );
}

export async function readLinuxClipboardImage({
  env = process.env,
  run = runCommand,
  notice = toolsMissingNotice,
}: {
  env?: Record<string, string | undefined>;
  run?: RunCommand;
  notice?: { shown: boolean };
} = {}): Promise<ClipboardImage | null> {
  const tools = [];
  if (
    env.WAYLAND_DISPLAY ||
    (env.DISPLAY && env.XDG_SESSION_TYPE === "wayland")
  ) {
    tools.push(WL_PASTE);
  }
  if (env.DISPLAY) tools.push(XCLIP);

  let failure: Error | null = null;
  for (const tool of tools) {
    try {
      const type = pickImageMediaType(
        (await run(tool.list, LIST)).toString("utf8"),
      );
      if (!type) return null;
      const data = await run(tool.read(type), READ);
      return data.length > 0 ? { data, mediaType: type } : null;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        killed?: boolean;
        stderr?: Buffer;
      };
      const stderr = e.stderr?.toString("utf8").trim() ?? "";
      if (e.code === "ENOENT") continue;
      if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        throw new Error("clipboard image is too large");
      }
      if (EMPTY_CLIPBOARD.test(stderr)) return null;
      failure = new Error(
        `${tool.list[0]} ${e.killed ? "timed out" : `failed: ${stderr || `exit ${e.code}`}`}`,
      );
    }
  }
  if (failure) throw failure;
  if (tools.length === 0 || notice.shown) return null;
  notice.shown = true;
  throw new Error("install wl-clipboard (Wayland) or xclip (X11)");
}
