import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { SignalRestClient } from "./client";

const SIGNAL_DOCKER_CONTAINER = "letta-signal-cli";
export const SIGNAL_DOCKER_VOLUME = "letta-signal-cli-data";
const SIGNAL_DOCKER_IMAGE = "bbernhard/signal-cli-rest-api:latest";

export function getSignalDockerRunCommand(): string {
  return [
    "docker run -d",
    `--name ${SIGNAL_DOCKER_CONTAINER}`,
    "-p 8080:8080",
    "-e MODE=json-rpc",
    `-v ${SIGNAL_DOCKER_VOLUME}:/home/.local/share/signal-cli`,
    SIGNAL_DOCKER_IMAGE,
  ].join(" ");
}

export function commandExists(command: string): boolean {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export function getDefaultSignalCliConfigDir(): string {
  return `${process.env.HOME ?? ""}/.local/share/signal-cli`;
}

export function parseNativeSignalCliDaemonConfigDir(
  processText: string,
): string | null {
  const match = processText.match(
    /(?:^|\s)(?:-c|--config|--data-dir|-d)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

export function detectNativeSignalCliConfigDir(): string | null {
  try {
    const output = execFileSync("ps", ["axo", "command"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    for (const line of output.split(/\r?\n/)) {
      if (!line.includes("signal-cli") || !line.includes(" daemon")) {
        continue;
      }
      const configDir = parseNativeSignalCliDaemonConfigDir(line);
      if (configDir) return configDir;
    }
  } catch {
    // Fall through to default path.
  }
  const defaultDir = getDefaultSignalCliConfigDir();
  return defaultDir && existsSync(defaultDir) ? defaultDir : null;
}

export function runNativeSignalCli(
  args: string[],
): { ok: true } | { ok: false; error: string } {
  try {
    execFileSync("signal-cli", args, {
      stdio: "pipe",
      encoding: "utf8",
      timeout: 120_000,
    });
    return { ok: true };
  } catch (error) {
    const err = error as {
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
    };
    const detail = [err.stderr, err.stdout, err.message]
      .filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      )
      .join("\n")
      .trim();
    return { ok: false, error: detail || String(error) };
  }
}

export function runNativeSignalCliInteractive(
  args: string[],
  onOutput?: (output: string) => void | Promise<void>,
): Promise<
  { ok: true; output: string } | { ok: false; output: string; error: string }
> {
  return new Promise((resolve) => {
    const child = spawn("signal-cli", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      process.stdout.write(text);
      void onOutput?.(output);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      process.stderr.write(text);
      void onOutput?.(output);
    });
    child.on("error", (error) => {
      resolve({ ok: false, output, error: error.message });
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, output });
      } else {
        resolve({
          ok: false,
          output,
          error: `signal-cli exited with code ${code ?? "unknown"}`,
        });
      }
    });
  });
}

export function parseSignalLinkAssociatedAccount(
  output: string,
): string | null {
  const match = output.match(/Associated with:\s*(\+\d{5,15})/i);
  return match?.[1] ?? null;
}

export function parseSignalLinkExistingAccount(output: string): string | null {
  const match = output.match(/The user\s+(\+\d{5,15})\s+already exists/i);
  return match?.[1] ?? null;
}

export function parseSignalCliDeletePath(output: string): string | null {
  const match = output.match(/Delete\s+"([^"]+)"\s+before trying again/i);
  return match?.[1] ?? null;
}

export function parseSignalLinkUri(output: string): string | null {
  const match = output.match(/sgnl:\/\/linkdevice\?\S+/i);
  return match?.[0] ?? null;
}

export async function probeSignalDaemon(baseUrl: string): Promise<boolean> {
  try {
    await new SignalRestClient({ baseUrl }).check();
    return true;
  } catch {
    return false;
  }
}

export async function fetchSignalSetupJson(
  baseUrl: string,
  path: string,
  options: RequestInit = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    });
    const text = await response.text();
    const parsed = text.trim() ? (JSON.parse(text) as unknown) : null;
    if (!response.ok) {
      const message =
        parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error?: unknown }).error)
          : text || response.statusText;
      throw new Error(message);
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

export async function hasSignalSetupRestEndpoints(
  baseUrl: string,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${baseUrl}/v1/about`, {
      method: "GET",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractSignalAccountsFromResponse(response: unknown): string[] {
  const values = Array.isArray(response)
    ? response
    : isRecord(response) && Array.isArray(response.accounts)
      ? response.accounts
      : [];
  return values
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (isRecord(entry)) {
        const number = entry.number ?? entry.account ?? entry.username;
        return typeof number === "string" ? number : "";
      }
      return "";
    })
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function listSignalDaemonAccounts(
  baseUrl: string,
): Promise<string[]> {
  try {
    const response = await fetchSignalSetupJson(baseUrl, "/v1/accounts");
    return extractSignalAccountsFromResponse(response);
  } catch {
    return [];
  }
}

export function getSignalQrLinkUrl(baseUrl: string): string {
  const url = new URL(`${baseUrl}/v1/qrcodelink`);
  url.searchParams.set("device_name", "Letta Code");
  return url.toString();
}

export async function openUrl(url: string): Promise<boolean> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    execFileSync(command, args, { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export async function waitForSignalDaemon(baseUrl: string): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await probeSignalDaemon(baseUrl)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

export async function startSignalDockerDaemon(): Promise<void> {
  execFileSync("docker", ["volume", "create", SIGNAL_DOCKER_VOLUME], {
    stdio: "ignore",
    timeout: 30_000,
  });
  execFileSync("docker", ["rm", "-f", SIGNAL_DOCKER_CONTAINER], {
    stdio: "ignore",
    timeout: 30_000,
  });
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      SIGNAL_DOCKER_CONTAINER,
      "-p",
      "8080:8080",
      "-e",
      "MODE=json-rpc",
      "-v",
      `${SIGNAL_DOCKER_VOLUME}:/home/.local/share/signal-cli`,
      SIGNAL_DOCKER_IMAGE,
    ],
    { stdio: "inherit", timeout: 60_000 },
  );
}
