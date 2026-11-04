/**
 * Where the pi coding agent keeps its JSONL session files. pi names them
 * `<timestamp>_<session-id>.jsonl`, grouped by working directory under the
 * session root (`~/.pi/agent/sessions/--<cwd>--/` by default).
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function piAgentDir(env: NodeJS.ProcessEnv): string {
  return env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), ".pi", "agent");
}

/** The `sessionDir` setting from pi's global settings, when configured. */
async function settingsSessionDir(
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const raw = await readFile(join(piAgentDir(env), "settings.json"), "utf8");
    const value = (JSON.parse(raw) as { sessionDir?: unknown }).sessionDir;
    if (typeof value !== "string" || !value.trim()) return undefined;
    if (value.startsWith("~/"))
      return join(env.HOME || homedir(), value.slice(2));
    return isAbsolute(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Session roots in pi's precedence order (env override, setting, default). */
export async function piSessionRoots(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const roots = [
    env.PI_CODING_AGENT_SESSION_DIR,
    await settingsSessionDir(env),
    join(piAgentDir(env), "sessions"),
  ].filter((root): root is string => Boolean(root));
  return [...new Set(roots)];
}

async function entries(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Find the session file for a pi session ID, if pi has written one. */
export async function findPiSessionPath(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (!UUID.test(sessionId)) return undefined;
  const suffix = `_${sessionId}.jsonl`;
  for (const root of await piSessionRoots(env)) {
    const directories = [
      root,
      ...(await entries(root)).map((name) => join(root, name)),
    ];
    for (const directory of directories) {
      for (const name of await entries(directory)) {
        if (!name.endsWith(suffix)) continue;
        const path = join(directory, name);
        if (await isFile(path)) return path;
      }
    }
  }
  return undefined;
}
