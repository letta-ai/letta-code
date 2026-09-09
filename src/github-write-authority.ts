import { getRuntimeContext } from "./runtime-context";

export const GITHUB_WRITE_CAPABILITY_ENV = "LETTA_GITHUB_WRITE_CAPABILITY";
export const GITHUB_WRITE_BOOTSTRAP_ENV =
  "LETTA_SUBAGENT_GITHUB_WRITE_CAPABILITY";

// Only a delegated headless process receives this bootstrap. Remove it from
// the ambient environment before any tools, mods, or children are launched.
const delegatedCapability = process.env[GITHUB_WRITE_BOOTSTRAP_ENV] ?? null;
delete process.env[GITHUB_WRITE_BOOTSTRAP_ENV];

export function getDelegatedGithubWriteCapability(): string | null {
  return process.env.LETTA_CODE_AGENT_ROLE === "subagent"
    ? delegatedCapability
    : null;
}

export function getGithubWriteCapability(): string | null {
  return getRuntimeContext()?.githubWriteCapability ?? null;
}

/** Remove private inbound fields before the frame is acknowledged or observed. */
export function takeGithubWriteCapability(frame: unknown): string | null {
  if (!frame || typeof frame !== "object" || !("runtime" in frame)) return null;
  const runtime = frame.runtime;
  if (
    !runtime ||
    typeof runtime !== "object" ||
    !("github_write_capability" in runtime)
  )
    return null;
  const value = runtime.github_write_capability;
  delete runtime.github_write_capability;
  return typeof value === "string" ? value : null;
}

export function redactGithubWriteAuthority(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(
      /("github_write_capability"\s*:\s*)"[^"\\]*(?:\\.[^"\\]*)*"/g,
      '$1"[REDACTED]"',
    );
  }
  if (Array.isArray(value)) return value.map(redactGithubWriteAuthority);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "github_write_capability" || key === "githubWriteCapability"
        ? "[REDACTED]"
        : redactGithubWriteAuthority(item),
    ]),
  );
}
