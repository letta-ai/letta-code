interface CheckContextIdentity {
  __typename?: string | null;
  databaseId?: number | null;
  name?: string | null;
  isRequired?: boolean | null;
  checkSuite?: {
    app?: { id?: string | null } | null;
    workflowRun?: { workflow?: { id?: string | null } | null } | null;
  } | null;
}

// Only coalesce checks whose producer and workflow are known. Third-party
// checks without a workflow can share names without being interchangeable.
export function latestGitHubCheckContexts<T extends CheckContextIdentity>(
  contexts: Array<T | null>,
): Array<T | null> {
  function identity(check: T | null): string | undefined {
    const app = check?.checkSuite?.app?.id;
    const workflow = check?.checkSuite?.workflowRun?.workflow?.id;
    if (
      check?.__typename !== "CheckRun" ||
      !check.databaseId ||
      !check.name ||
      !app ||
      !workflow ||
      typeof check.isRequired !== "boolean"
    ) {
      return undefined;
    }
    return JSON.stringify([app, workflow, check.name, check.isRequired]);
  }
  const latest = new Map<string, number>();
  for (const check of contexts) {
    const key = identity(check);
    if (key && check?.databaseId) {
      latest.set(key, Math.max(latest.get(key) ?? 0, check.databaseId));
    }
  }
  return contexts.filter((check) => {
    const key = identity(check);
    return !key || check?.databaseId === latest.get(key);
  });
}
