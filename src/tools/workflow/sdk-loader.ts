import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SdkClient } from "./types.ts";

const SDK_PACKAGE = ["@letta-ai", "letta-agent-sdk"].join("/");
const MIN_RESUME_SDK_VERSION: string | null = "0.8.20";

export function supportsPublishedResume(version: string | undefined): boolean {
  if (!version || !MIN_RESUME_SDK_VERSION) return false;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const minimum = MIN_RESUME_SDK_VERSION.split(".").map(Number);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const required = minimum[index];
    if (part !== required) return (part ?? 0) > (required ?? 0);
  }
  return true;
}

export interface LoadedSdk {
  createLocalClient(harnessBackend: "api" | "local"): SdkClient;
  createRemoteClient(url: string): SdkClient;
  supportsAgentFreeResume: boolean;
}

function preferRunningCliForSubagents(): void {
  if (process.env.LETTA_CLI_PATH) return;
  const entry = process.argv[1];
  if (entry && /(^|[\\/])letta\.js$/.test(entry) && existsSync(entry)) {
    process.env.LETTA_CLI_PATH = entry;
  }
}

function packageVersion(entry: string): string | undefined {
  for (let dir = dirname(entry); ; dir = dirname(dir)) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf8"),
      ) as {
        name?: string;
        version?: string;
      };
      if (manifest.name === SDK_PACKAGE) return manifest.version;
    } catch {}
    if (dir === dirname(dir)) return undefined;
  }
}

function packageEntry(packageDir: string): string | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(packageDir, "package.json"), "utf8"),
    ) as {
      main?: string;
      exports?: Record<string, string | Record<string, string>>;
    };
    const root = manifest.exports?.["."];
    const entry =
      typeof root === "string"
        ? root
        : (root?.import ?? root?.default ?? manifest.main);
    return entry ? join(packageDir, entry) : null;
  } catch {
    return null;
  }
}

export function probeInstalledSdkDirs(startDirs: string[]): string[] {
  const found: string[] = [];
  for (const start of startDirs) {
    let dir = start;
    while (true) {
      const candidate = join(dir, "node_modules", ...SDK_PACKAGE.split("/"));
      if (
        existsSync(join(candidate, "package.json")) &&
        !found.includes(candidate)
      ) {
        found.push(candidate);
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return found;
}

export async function loadAgentSdk(): Promise<LoadedSdk> {
  preferRunningCliForSubagents();
  const attempts: string[] = [];
  const envPath = process.env.LETTA_AGENT_SDK_PATH;
  const specifiers: string[] = [];
  if (envPath) {
    try {
      const require = createRequire(join(envPath, "noop.js"));
      specifiers.push(pathToFileURL(require.resolve(envPath)).href);
    } catch {
      specifiers.push(pathToFileURL(envPath).href);
    }
  }
  try {
    const require = createRequire(import.meta.url);
    specifiers.push(pathToFileURL(require.resolve(SDK_PACKAGE)).href);
  } catch {}
  try {
    const require = createRequire(join(process.cwd(), "package.json"));
    specifiers.push(pathToFileURL(require.resolve(SDK_PACKAGE)).href);
  } catch {
    specifiers.push(SDK_PACKAGE);
  }
  const installedDirs = probeInstalledSdkDirs([
    dirname(fileURLToPath(import.meta.url)),
    process.cwd(),
  ]);
  for (const dir of installedDirs) {
    const entry = packageEntry(dir);
    if (entry) specifiers.push(pathToFileURL(entry).href);
  }

  for (const specifier of new Set(specifiers)) {
    try {
      const sdk = (await import(specifier)) as {
        LettaAgentClient: new (options: {
          backend: string;
          appServer?: { harnessBackend: "api" | "local" };
          url?: string;
        }) => SdkClient;
      };
      if (typeof sdk.LettaAgentClient !== "function") {
        attempts.push(`${specifier}: module has no LettaAgentClient export`);
        continue;
      }
      const wrapClient = (client: SdkClient): SdkClient => ({
        query(params) {
          const query = client.query(params);
          if (!("conversationId" in query) || !("agentId" in query)) {
            query.close();
            throw new Error(
              "Workflow requires an Agent SDK with ephemeral worker lineage and query identity support. Upgrade the Agent SDK.",
            );
          }
          return query;
        },
        async [Symbol.asyncDispose]() {
          await client[Symbol.asyncDispose]?.();
        },
      });
      return {
        supportsAgentFreeResume:
          (process.env.LETTA_WORKFLOW_AGENT_FREE_RESUME === "1" &&
            Boolean(envPath) &&
            specifier === specifiers[0]) ||
          (specifier.startsWith("file:") &&
            supportsPublishedResume(packageVersion(fileURLToPath(specifier)))),
        createLocalClient: (harnessBackend) =>
          wrapClient(
            new sdk.LettaAgentClient({
              backend: "local",
              appServer: { harnessBackend },
            }),
          ),
        createRemoteClient: (url) =>
          wrapClient(new sdk.LettaAgentClient({ backend: "remote", url })),
      };
    } catch (error) {
      attempts.push(`${specifier}: ${String(error)}`);
    }
  }

  const advice =
    installedDirs.length > 0
      ? `${SDK_PACKAGE} is installed at ${installedDirs[0]} but this process ` +
        "cannot load it (it was likely started before the install). Restart the CLI and retry."
      : `Could not load ${SDK_PACKAGE}. Install it (bun add ${SDK_PACKAGE}) or ` +
        "set LETTA_AGENT_SDK_PATH to an installed copy.";
  throw new Error(
    `${advice}\n${attempts.map((a) => `  tried ${a}`).join("\n")}`,
  );
}
