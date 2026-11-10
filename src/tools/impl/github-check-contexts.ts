interface CheckContextIdentity {
  __typename?: string | null;
  name?: string | null;
  isRequired?: boolean | null;
  checkSuite?: {
    app?: { id?: string | null } | null;
    workflowRun?: {
      id?: string | null;
      createdAt?: string | null;
      workflow?: { id?: string | null } | null;
    } | null;
  } | null;
}

// Names identify a check across workflow runs only when each run reports one
// matching context. Multiple jobs (or attempts) in one run are ambiguous.
export function latestGitHubCheckContexts<T extends CheckContextIdentity>(
  contexts: Array<T | null>,
): Array<T | null> {
  function identity(check: T | null): string | undefined {
    const app = check?.checkSuite?.app?.id;
    const workflow = check?.checkSuite?.workflowRun?.workflow?.id;
    if (
      check?.__typename !== "CheckRun" ||
      !check.name ||
      !app ||
      !workflow ||
      typeof check.isRequired !== "boolean"
    ) {
      return undefined;
    }
    return JSON.stringify([app, workflow, check.name, check.isRequired]);
  }
  const groups = new Map<string, Array<T>>();
  for (const check of contexts) {
    const key = identity(check);
    if (key && check) {
      const group = groups.get(key) ?? [];
      group.push(check);
      groups.set(key, group);
    }
  }
  const superseded = new Set<T>();
  for (const group of groups.values()) {
    const runs = new Set<string>();
    const times = group.map((check) => {
      const run = check.checkSuite?.workflowRun;
      if (!run?.id || runs.has(run.id)) return NaN;
      runs.add(run.id);
      return run.createdAt ? Date.parse(run.createdAt) : NaN;
    });
    // Never use numeric database IDs, response order, or completion time to
    // decide which workflow run is newer. Equal timestamps are ambiguous too.
    if (times.some((time) => !Number.isFinite(time))) continue;
    const newest = Math.max(...times);
    if (times.filter((time) => time === newest).length !== 1) continue;
    group.forEach((check, index) => {
      if (times[index] !== newest) superseded.add(check);
    });
  }
  return contexts.filter((check) => !check || !superseded.has(check));
}
