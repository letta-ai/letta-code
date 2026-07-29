import { isLocalAgentId } from "./app-urls";

export interface ParsedCloudCommand {
  instruction: string | null;
}

export function parseCloudCommand(input: string): ParsedCloudCommand | null {
  const trimmed = input.trim();
  if (!/^\/cloud(?:\s|$)/i.test(trimmed)) return null;
  const instruction = trimmed.slice("/cloud".length).trim();
  return { instruction: instruction || null };
}

export function getCloudCommandEligibilityError(params: {
  agentId: string;
  serverUrl: string;
}): string | null {
  if (isLocalAgentId(params.agentId)) {
    return "/cloud is only available for agents hosted on Letta Cloud.";
  }
  try {
    if (new URL(params.serverUrl).hostname !== "api.letta.com") {
      return "/cloud is only available when connected to Letta Cloud.";
    }
  } catch {
    return "/cloud is only available when connected to Letta Cloud.";
  }
  return null;
}

export function formatRepositoryHandoffResult(params: {
  handoffRequested: boolean;
  changedFileCount: number;
  repositoryHandoffSupported: boolean;
}): string {
  if (!params.handoffRequested) return "";
  if (!params.repositoryHandoffSupported) {
    return " Exact local repository state was not transferred because this Cloud deployment does not support repository handoffs.";
  }
  return params.changedFileCount > 0
    ? ` Included ${params.changedFileCount} local file change(s).`
    : "";
}
