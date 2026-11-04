/**
 * Direct App Server computers: machines reached over their own
 * `letta server --listen` WebSocket instead of the Letta Cloud environments
 * relay. Records name a URL and the path of a capability-token file; the
 * token itself is never stored here.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { resolveGlobalConfigDir } from "@/utils/settings-path";

/** `computer` selectors with this prefix name a direct App Server computer. */
export const DIRECT_COMPUTER_PREFIX = "direct:";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface DirectComputer {
  name: string;
  /** `ws:` or `wss:` URL of the remote `letta server --listen` endpoint. */
  url: string;
  /** Absolute path of the file holding the capability token. */
  tokenFile: string;
}

interface DirectComputerFile {
  version: 1;
  computers: DirectComputer[];
}

export function getDirectComputersPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(resolveGlobalConfigDir(env), "direct-computers.json");
}

export function isDirectComputerSelector(selector: string): boolean {
  return selector.trim().startsWith(DIRECT_COMPUTER_PREFIX);
}

/** The name in a `direct:<name>` selector, or null for any other selector. */
export function parseDirectComputerSelector(selector: string): string | null {
  const trimmed = selector.trim();
  if (!trimmed.startsWith(DIRECT_COMPUTER_PREFIX)) return null;
  const name = trimmed.slice(DIRECT_COMPUTER_PREFIX.length);
  return NAME_PATTERN.test(name) ? name : null;
}

export function formatDirectComputerSelector(name: string): string {
  return `${DIRECT_COMPUTER_PREFIX}${name}`;
}

/** Throws with a user-facing message when a record is not usable. */
export function validateDirectComputer(computer: DirectComputer): void {
  if (!NAME_PATTERN.test(computer.name))
    throw new Error(
      "Direct computer names use letters, digits, '.', '_' or '-' (max 64 characters)",
    );
  let url: URL;
  try {
    url = new URL(computer.url);
  } catch {
    throw new Error(`Invalid direct computer URL: ${computer.url}`);
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:")
    throw new Error("Direct computer URL must use ws:// or wss://");
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      "Direct computer URL cannot include credentials, a query, or a hash",
    );
  if (!computer.tokenFile || !isAbsolute(computer.tokenFile))
    throw new Error("Direct computer token file must be an absolute path");
}

/** Whether a plain `ws://` URL leaves the machine unencrypted. */
export function isInsecureRemoteUrl(rawUrl: string): boolean {
  const url = new URL(rawUrl);
  if (url.protocol !== "ws:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return !(host === "localhost" || host === "::1" || host.startsWith("127."));
}

function parseFile(raw: string, path: string): DirectComputerFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  const computers = (parsed as { computers?: unknown } | null)?.computers;
  if (!Array.isArray(computers))
    throw new Error(`${path} must contain a "computers" array`);
  const valid: DirectComputer[] = [];
  for (const entry of computers) {
    const record = entry as Partial<DirectComputer> | null;
    if (
      typeof record?.name !== "string" ||
      typeof record.url !== "string" ||
      typeof record.tokenFile !== "string"
    )
      throw new Error(`${path} has an invalid computer entry`);
    const computer = {
      name: record.name,
      url: record.url,
      tokenFile: record.tokenFile,
    };
    validateDirectComputer(computer);
    valid.push(computer);
  }
  return { version: 1, computers: valid };
}

export function listDirectComputers(
  env: NodeJS.ProcessEnv = process.env,
): DirectComputer[] {
  const path = getDirectComputersPath(env);
  if (!existsSync(path)) return [];
  return parseFile(readFileSync(path, "utf8"), path).computers;
}

export function getDirectComputer(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): DirectComputer {
  const computer = listDirectComputers(env).find(
    (entry) => entry.name === name,
  );
  if (!computer)
    throw new Error(
      `Direct computer "${name}" is not configured. Add it with \`letta computers add-direct ${name} <ws-url> --token-file <path>\`.`,
    );
  return computer;
}

function writeAll(computers: DirectComputer[], env: NodeJS.ProcessEnv): void {
  const path = getDirectComputersPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  const body: DirectComputerFile = { version: 1, computers };
  writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

/** Add or replace the record with the same name. */
export function saveDirectComputer(
  computer: DirectComputer,
  env: NodeJS.ProcessEnv = process.env,
): void {
  validateDirectComputer(computer);
  const rest = listDirectComputers(env).filter(
    (entry) => entry.name !== computer.name,
  );
  writeAll([...rest, computer], env);
}

export function removeDirectComputer(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const all = listDirectComputers(env);
  const rest = all.filter((entry) => entry.name !== name);
  if (rest.length === all.length) return false;
  writeAll(rest, env);
  return true;
}

/** Read the capability token; never include its value in errors. */
export function readDirectComputerToken(computer: DirectComputer): string {
  let token: string;
  try {
    token = readFileSync(computer.tokenFile, "utf8").trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "read failed";
    throw new Error(
      `Can't read the token file for direct computer "${computer.name}" (${code}): ${computer.tokenFile}`,
    );
  }
  if (!token)
    throw new Error(
      `The token file for direct computer "${computer.name}" is empty: ${computer.tokenFile}`,
    );
  return token;
}
