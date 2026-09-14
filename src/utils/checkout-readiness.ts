import { realpathSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

function resolveCheckoutPath(path: string): string {
  let parent = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      return resolve(realpathSync(parent), ...suffix);
    } catch {
      if (dirname(parent) === parent) return resolve(path);
      suffix.unshift(basename(parent));
      parent = dirname(parent);
    }
  }
}

interface Checkout {
  path: string;
  start: () => Promise<void>;
  pending?: Promise<void>;
  ready: boolean;
}

const checkouts = new Map<string, Map<string, Checkout>>();
const discoveries = new Map<
  string,
  { start: () => Promise<void>; pending?: Promise<void> }
>();
let generation = 0;

export function getCheckoutGeneration(): number {
  return generation;
}

export function retainCheckouts(agentId: string, paths: string[]): void {
  const retained = new Set(paths.map(resolveCheckoutPath));
  const entries = checkouts.get(agentId);
  for (const path of entries?.keys() ?? []) {
    if (!retained.has(path)) entries?.delete(path);
  }
}

export function trackCheckoutDiscovery(
  agentId: string,
  start: () => Promise<void>,
): Promise<void> {
  const entry = { start, pending: undefined as Promise<void> | undefined };
  discoveries.set(agentId, entry);
  const pending = Promise.resolve().then(start);
  entry.pending = pending;
  void pending.catch(() => {
    entry.pending = undefined;
  });
  return pending;
}

/** Start once, share concurrent callers, and retain failures for access-time retry. */
export function startCheckout(
  agentId: string,
  path: string,
  start: () => Promise<void>,
  refresh = false,
): Promise<void> {
  let agent = checkouts.get(agentId);
  if (!agent) {
    agent = new Map();
    checkouts.set(agentId, agent);
  }
  const key = resolveCheckoutPath(path);
  let checkout = agent.get(key);
  if (!checkout) {
    checkout = { path: key, start, ready: false };
    agent.set(key, checkout);
  }
  if (checkout.pending) return checkout.pending;
  if (checkout.ready && !refresh) return Promise.resolve();
  checkout.ready = false;
  checkout.start = start;
  const entry = checkout;
  entry.pending = Promise.resolve()
    .then(entry.start)
    .then(
      () => {
        entry.ready = true;
        entry.pending = undefined;
        generation++;
      },
      (error) => {
        entry.pending = undefined;
        throw error;
      },
    );
  // A background failure must not become an unhandled rejection. Access still
  // receives the rejection (and a subsequent access retries the operation).
  void entry.pending.catch(() => {});
  return entry.pending;
}

export function isCheckoutPending(path: string): boolean {
  return [...checkouts.values()].some((agent) => {
    const entry = agent.get(resolveCheckoutPath(path));
    return entry !== undefined && !entry.ready;
  });
}

/** Shells and mod tools can compute paths: conservatively gate those callers. */
export async function waitForCheckouts(
  agentId: string | undefined,
  paths?: string[],
): Promise<void> {
  if (!agentId) return;
  const discovery = discoveries.get(agentId);
  if (discovery)
    await (discovery.pending ??
      trackCheckoutDiscovery(agentId, discovery.start));
  const entries = [...(checkouts.get(agentId)?.values() ?? [])];
  await Promise.all(
    entries
      .filter(
        (entry) =>
          !paths ||
          paths.some((path) => {
            const absolute = resolveCheckoutPath(path);
            return (
              absolute === entry.path ||
              absolute.startsWith(entry.path + sep) ||
              entry.path.startsWith(absolute + sep)
            );
          }),
      )
      .map((entry) => startCheckout(agentId, entry.path, entry.start)),
  );
}

export async function waitForToolCheckouts(
  agentId: string | undefined,
  name: string,
  args: unknown,
  cwd: string,
  arbitraryCode = false,
): Promise<void> {
  if (
    arbitraryCode ||
    /^(bash|exec_command|write_stdin|shell_?command|shell|run_shell_command|monitor|skill)$/i.test(
      name,
    )
  ) {
    await waitForCheckouts(agentId);
    return;
  }
  if (
    !/read|write|edit|patch|grep|glob|search|list|viewimage|memory/i.test(name)
  )
    return;
  const paths: string[] = [];
  let explicitRoot = false;
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (/apply_?patch/i.test(name)) {
        for (const header of value.matchAll(
          /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm,
        )) {
          paths.push(resolve(cwd, header[1] ?? ""));
        }
      } else paths.push(resolve(cwd, value));
    } else if (value && typeof value === "object")
      Object.entries(value).forEach(([key, entry]) => {
        if (/path|directory|^dir$|^root$/.test(key) && entry)
          explicitRoot = true;
        visit(entry);
      });
  };
  visit(args);
  // Search tools with no explicit root search the cwd.
  if (!explicitRoot && /grep|glob|search|list/i.test(name)) paths.push(cwd);
  await waitForCheckouts(agentId, paths);
}
