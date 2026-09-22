/**
 * Lazy loader for @letta-ai/letta-agent-sdk.
 *
 * The SDK is a runtime dependency of letta-code, but it is imported lazily by
 * a computed specifier rather than statically: the SDK itself depends on a
 * published @letta-ai/letta-code (the Workflow tool accepts that its
 * subagents may run a version behind), and bundling that nested copy into
 * letta.js would be circular and heavy. Resolution order:
 *
 *   1. LETTA_AGENT_SDK_PATH env var (installed copy or checkout; overrides)
 *   2. letta-code's own dependency (resolved from this module)
 *   3. Normal module resolution from the working directory
 *   4. A direct probe of node_modules/@letta-ai/letta-agent-sdk walking up
 *      from this module and from the working directory
 *
 * Step 4 exists because the runtime caches a failed resolution for the life
 * of the process: a CLI started before `bun install` added the SDK keeps
 * failing steps 2-3 after the install, while a file URL it has never tried
 * still loads. When the package is on disk and nothing loads, the error says
 * to restart rather than to install.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SdkClient } from "./types.ts";

// Computed so bundlers treat the import as fully dynamic.
const SDK_PACKAGE = ["@letta-ai", "letta-agent-sdk"].join("/");

export interface LoadedSdk {
  /** A local client whose subagents run on this computer against the API backend. */
  createLocalClient(): SdkClient;
}

/**
 * The SDK spawns a letta-code app-server for subagents and, by default,
 * resolves the published @letta-ai/letta-code copy it depends on — which can
 * lag behind the CLI that is running (agent-free conversations, for one, need
 * this branch's app-server). When this process *is* a built letta.js bundle,
 * point the SDK at it so subagents run the same version. `bun run dev` runs
 * from source, so there the caller sets LETTA_CLI_PATH explicitly.
 */
function preferRunningCliForSubagents(): void {
  if (process.env.LETTA_CLI_PATH) return;
  const entry = process.argv[1];
  if (entry && /(^|[\\/])letta\.js$/.test(entry) && existsSync(entry)) {
    process.env.LETTA_CLI_PATH = entry;
  }
}

/** The package's ESM entry from its package.json, or null if unreadable. */
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

/**
 * Installed copies found by walking up from each start directory, nearest
 * first. Bypasses the module resolver entirely.
 */
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
      // Resolve through require so a package DIRECTORY works, not just an
      // entry file (directory imports need package.json "main"/"exports").
      const require = createRequire(join(envPath, "noop.js"));
      specifiers.push(pathToFileURL(require.resolve(envPath)).href);
    } catch {
      specifiers.push(pathToFileURL(envPath).href);
    }
  }
  try {
    const require = createRequire(import.meta.url);
    specifiers.push(pathToFileURL(require.resolve(SDK_PACKAGE)).href);
  } catch {
    // Not resolvable from the letta-code install; fall through.
  }
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
        }) => SdkClient;
      };
      if (typeof sdk.LettaAgentClient !== "function") {
        attempts.push(`${specifier}: module has no LettaAgentClient export`);
        continue;
      }
      return {
        createLocalClient: () => {
          const client = new sdk.LettaAgentClient({
            backend: "local",
            appServer: { harnessBackend: "api" },
          });
          return {
            query(params) {
              const query = client.query(params);
              // Queries are lazy. Reject older SDKs before they can create a
              // parentless worker whose identity cannot be verified.
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
          };
        },
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
