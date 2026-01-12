/**
 * Sandbox Management Module
 *
 * Provides functions to enable/disable remote sandbox providers (E2B, Daytona)
 * for Letta Code agents.
 */

import { getClient } from "../agent/client";
import {
  DAYTONA_PIP_PACKAGE,
  DAYTONA_TOOL_NAMES,
  DAYTONA_TOOLS,
} from "./daytona";
import { E2B_PIP_PACKAGE, E2B_TOOL_NAMES, E2B_TOOLS } from "./e2b";

export type SandboxProvider = "e2b" | "daytona";

export const ALL_SANDBOX_TOOL_NAMES = new Set([
  ...E2B_TOOL_NAMES,
  ...DAYTONA_TOOL_NAMES,
]);

export interface SandboxStatus {
  enabled: boolean;
  provider: SandboxProvider | null;
}

/**
 * Check the current sandbox status for an agent.
 * Detects if sandbox tools are attached based on tool names and metadata.
 */
export async function getSandboxStatus(
  agentId: string,
): Promise<SandboxStatus> {
  const client = await getClient();
  const agent = await client.agents.retrieve(agentId, {
    include: ["agent.tools"],
  });

  const toolNames = new Set((agent.tools || []).map((t) => t.name));

  // Check if any sandbox tools are attached
  const hasSandboxTools =
    E2B_TOOL_NAMES.some((name) => toolNames.has(name)) ||
    DAYTONA_TOOL_NAMES.some((name) => toolNames.has(name));

  if (!hasSandboxTools) {
    return { enabled: false, provider: null };
  }

  // Determine provider from metadata
  const metadata = agent.metadata as Record<string, unknown> | null;
  if (metadata?.sandbox_id) {
    return { enabled: true, provider: "e2b" };
  }
  if (metadata?.daytona_sandbox_id) {
    return { enabled: true, provider: "daytona" };
  }

  // Has tools but no metadata - assume based on which tools are present
  if (E2B_TOOL_NAMES.some((name) => toolNames.has(name))) {
    return { enabled: true, provider: "e2b" };
  }
  if (DAYTONA_TOOL_NAMES.some((name) => toolNames.has(name))) {
    return { enabled: true, provider: "daytona" };
  }

  return { enabled: false, provider: null };
}

/**
 * Enable a sandbox provider for an agent.
 * Upserts the sandbox tools to the server and attaches them to the agent.
 *
 * @param agentId - The agent ID
 * @param provider - The sandbox provider to enable
 * @param apiKey - The API key for the provider
 * @returns Number of tools attached
 */
export async function enableSandbox(
  agentId: string,
  provider: SandboxProvider,
  apiKey: string,
): Promise<number> {
  const client = await getClient();

  // Get tool definitions for provider
  const { tools, pipPackage } =
    provider === "e2b"
      ? { tools: E2B_TOOLS, pipPackage: E2B_PIP_PACKAGE }
      : { tools: DAYTONA_TOOLS, pipPackage: DAYTONA_PIP_PACKAGE };

  // Upsert each tool to server (idempotent - safe to call multiple times)
  for (const tool of tools) {
    await client.tools.upsert({
      source_code: tool.source_code,
      description: tool.description,
      pip_requirements: [{ name: pipPackage }],
      default_requires_approval: false,
      tags: ["sandbox", provider],
    });
  }

  // Get tool IDs after upsert
  const toolIds = (
    await Promise.all(
      tools.map(async (t) => {
        const resp = await client.tools.list({ name: t.name });
        return resp.items[0]?.id;
      }),
    )
  ).filter((id): id is string => !!id);

  // Get current agent state with tools and secrets
  const agent = await client.agents.retrieve(agentId, {
    include: ["agent.tools", "agent.secrets"],
  });
  const currentIds = (agent.tools || [])
    .map((t) => t.id)
    .filter((id): id is string => !!id);

  // Prepare secrets based on provider
  // agent.secrets from retrieve is AgentEnvironmentVariable[] - convert to Record
  const existingSecrets: Record<string, string> = {};
  if (Array.isArray(agent.secrets)) {
    for (const secret of agent.secrets) {
      if (secret.key && secret.value) {
        existingSecrets[secret.key] = secret.value;
      }
    }
  }
  const secretKey = provider === "e2b" ? "E2B_API_KEY" : "DAYTONA_API_KEY";
  const secrets: Record<string, string> = {
    ...existingSecrets,
    [secretKey]: apiKey,
  };

  // For Daytona, also set API URL
  if (provider === "daytona") {
    secrets.DAYTONA_API_URL = "https://app.daytona.io/api";
  }

  // Update agent with tools and secrets
  await client.agents.update(agentId, {
    tool_ids: [...new Set([...currentIds, ...toolIds])], // Dedupe
    secrets,
  });

  return toolIds.length;
}

/**
 * Disable sandbox for an agent.
 * Removes all sandbox tools and clears related secrets.
 */
export async function disableSandbox(agentId: string): Promise<number> {
  const client = await getClient();
  const agent = await client.agents.retrieve(agentId, {
    include: ["agent.tools", "agent.secrets"],
  });

  // Remove sandbox tools (both providers to be safe)
  const remainingTools = (agent.tools || [])
    .filter((t) => t.name && !ALL_SANDBOX_TOOL_NAMES.has(t.name))
    .map((t) => t.id)
    .filter((id): id is string => !!id);

  const removedCount = (agent.tools?.length || 0) - remainingTools.length;

  // Clear sandbox secrets from the existing secrets array
  // agent.secrets from retrieve is AgentEnvironmentVariable[] - convert to Record
  const secrets: Record<string, string> = {};
  if (Array.isArray(agent.secrets)) {
    for (const secret of agent.secrets) {
      // Skip sandbox-related secrets
      if (
        secret.key &&
        secret.value &&
        !["E2B_API_KEY", "DAYTONA_API_KEY", "DAYTONA_API_URL"].includes(
          secret.key,
        )
      ) {
        secrets[secret.key] = secret.value;
      }
    }
  }

  await client.agents.update(agentId, {
    tool_ids: remainingTools,
    secrets,
  });

  return removedCount;
}

/**
 * Check if API key is available in environment for a provider.
 */
export function hasApiKeyInEnv(provider: SandboxProvider): boolean {
  const envKey = provider === "e2b" ? "E2B_API_KEY" : "DAYTONA_API_KEY";
  return !!process.env[envKey];
}

/**
 * Get API key from environment for a provider.
 */
export function getApiKeyFromEnv(
  provider: SandboxProvider,
): string | undefined {
  const envKey = provider === "e2b" ? "E2B_API_KEY" : "DAYTONA_API_KEY";
  return process.env[envKey];
}

export { E2B_TOOL_NAMES, DAYTONA_TOOL_NAMES };
