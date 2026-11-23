import { isStatelessSubagentTags } from "@/agent/agent-tags";

interface HeadlessMemfsPolicyOptions {
  statelessRequested: boolean;
  isSubagentRole: boolean;
  newAgentRequested: boolean;
  agentTags?: readonly string[] | null;
}

interface HeadlessMemfsPolicy {
  isFreshStatelessSubagent: boolean;
  isStatelessSession: boolean;
}

export function resolveHeadlessMemfsPolicy(
  options: HeadlessMemfsPolicyOptions,
): HeadlessMemfsPolicy {
  const isFreshStatelessSubagent =
    options.isSubagentRole && options.newAgentRequested;
  return {
    isFreshStatelessSubagent,
    isStatelessSession:
      options.statelessRequested ||
      isFreshStatelessSubagent ||
      isStatelessSubagentTags(options.agentTags),
  };
}
