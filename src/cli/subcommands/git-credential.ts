/**
 * `letta git-credential` — dynamic git credential helper for Letta-hosted
 * repos (agent MemFS and shared memory mounts).
 *
 * Repo-local git config points at this subcommand (see
 * configureLocalCredentialHelper in @/agent/memory-git), following the
 * `gh auth git-credential` pattern: the token is resolved fresh from harness
 * auth (env key, keychain OAuth, refresh) on every git network operation, so
 * nothing secret is persisted on disk and rotation cannot strand a stale
 * credential.
 *
 * Protocol: git invokes `<helper> get|store|erase` with `key=value` lines on
 * stdin. Only `get` answers, and only for the configured Letta host; `store`
 * and `erase` are deliberate no-ops (the repo-local reset entry ensures no
 * other helper stores our token either, which is what used to poison the
 * macOS keychain).
 *
 * LATENCY: this runs on every `git push`/`pull`/`fetch` in a memory repo.
 * src/standalone-entry.ts dispatches here before importing the main CLI
 * graph, and this module has NO static imports — everything heavy (settings,
 * API client) is imported lazily inside the token resolver. Keep it that way.
 */

const RESOLVE_DEADLINE_MS = 10_000;

type GitCredentialDeps = {
  /** Resolve the current harness API token ("" when unauthenticated). */
  resolveToken?: () => Promise<string>;
  /** Resolve the canonical Letta MemFS base URL. */
  resolveBaseUrl?: () => Promise<string>;
  /** Raw stdin content (tests inject; defaults to reading process.stdin). */
  input?: string;
  deadlineMs?: number;
};

/** Parse git's `key=value` credential-protocol lines (stops at blank line). */
export function parseGitCredentialInput(input: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const line of input.split("\n")) {
    if (line.trim() === "") break;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    attributes[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return attributes;
}

/**
 * Match git's requested host (`host[:port]`) against the configured Letta
 * base URL. Anything else gets no answer — this helper only ever speaks for
 * the Letta remote it was configured for.
 */
export function requestMatchesLettaHost(
  request: Record<string, string>,
  baseUrl: string,
): boolean {
  const requestHost = request.host?.trim();
  if (!requestHost) return false;
  try {
    const parsed = new URL(baseUrl.trim());
    return requestHost === parsed.host || requestHost === parsed.hostname;
  } catch {
    return false;
  }
}

async function readStdinToEnd(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function defaultResolveBaseUrl(): Promise<string> {
  const { settingsManager } = await import("@/settings-manager");
  await settingsManager.initialize();
  const { getMemfsServerUrl } = await import("@/backend/api/memfs-git-proxy");
  return getMemfsServerUrl();
}

/**
 * Token resolution delegates to getClient(), which owns the full story:
 * env LETTA_API_KEY → keychain secure tokens → single-flight OAuth refresh
 * (persisted back to settings). Duplicating any of that here would fork
 * auth behavior; the import cost is paid only after the host check passes.
 */
async function defaultResolveToken(): Promise<string> {
  const { getClient } = await import("@/backend/api/client");
  const client = await getClient();
  // biome-ignore lint/suspicious/noExplicitAny: accessing internal client options, same as memory-git's getAuthToken
  return (client as any)._options?.apiKey ?? "";
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function runGitCredentialSubcommand(
  argv: string[],
  deps: GitCredentialDeps = {},
): Promise<number> {
  const action = argv[0];
  if (action !== "get" && action !== "store" && action !== "erase") {
    console.error("Usage: letta git-credential <get|store|erase>");
    return 1;
  }

  // Always drain stdin so git never blocks on a closed-pipe write.
  const input = deps.input ?? (await readStdinToEnd());

  // store/erase: nothing is persisted, nothing to erase.
  if (action !== "get") return 0;

  const request = parseGitCredentialInput(input);
  const deadlineMs = deps.deadlineMs ?? RESOLVE_DEADLINE_MS;

  try {
    const baseUrl = await withDeadline(
      (deps.resolveBaseUrl ?? defaultResolveBaseUrl)(),
      deadlineMs,
    );
    // Not our host: stay silent and let git move on. Exit 0 mirrors how
    // gh/gcloud helpers decline requests outside their domain.
    if (!requestMatchesLettaHost(request, baseUrl)) return 0;

    const token = await withDeadline(
      (deps.resolveToken ?? defaultResolveToken)(),
      deadlineMs,
    );
    if (!token) return 0;

    process.stdout.write(`username=letta\npassword=${token}\n`);
    return 0;
  } catch (error) {
    // Fail fast (git surfaces "credential helper exited") rather than hang a
    // push on a wedged keychain read or refresh call. Never echo the request.
    console.error(
      `letta git-credential: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
