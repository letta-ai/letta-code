interface HeadlessMemfsPolicyOptions {
  statelessRequested: boolean;
  isSubagentRole: boolean;
  newAgentRequested: boolean;
}

interface HeadlessMemfsPolicy {
  /** A newly created subagent whose prompt and blocks must be stateless. */
  isFreshStatelessSubagent: boolean;
  /** This process must not enable, clone, or sync MemFS for its selected agent. */
  isStatelessSession: boolean;
}

export function resolveHeadlessMemfsPolicy(
  options: HeadlessMemfsPolicyOptions,
): HeadlessMemfsPolicy {
  const isFreshStatelessSubagent =
    options.isSubagentRole && options.newAgentRequested;
  return {
    isFreshStatelessSubagent,
    isStatelessSession: options.statelessRequested || isFreshStatelessSubagent,
  };
}
