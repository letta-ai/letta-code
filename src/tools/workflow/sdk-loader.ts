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
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SdkClient } from "./types.ts";

// Computed so bundlers treat the import as fully dynamic.
const SDK_PACKAGE = ["@letta-ai", "letta-agent-sdk"].join("/");

export interface LoadedSdk {
  createClient(backend: string): SdkClient;
}

export async function loadAgentSdk(): Promise<LoadedSdk> {
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

  for (const specifier of specifiers) {
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
        createClient: (backend) =>
          new sdk.LettaAgentClient({
            backend,
            ...(backend === "local"
              ? { appServer: { harnessBackend: "api" as const } }
              : {}),
          }),
      };
    } catch (error) {
      attempts.push(`${specifier}: ${String(error)}`);
    }
  }

  throw new Error(
    `Could not load ${SDK_PACKAGE}. Install it (bun add ${SDK_PACKAGE}) or ` +
      `set LETTA_AGENT_SDK_PATH to an installed copy.\n` +
      attempts.map((a) => `  tried ${a}`).join("\n"),
  );
}
