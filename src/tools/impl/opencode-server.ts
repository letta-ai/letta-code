import {
  type ChildProcessWithoutNullStreams,
  spawnSync,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createOpencodeClient,
  type Event,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2/client";
import { Agent } from "undici";
import { spawnManagedWorkloadProcess } from "@/agent/subagents/subagent-process";

const children = new Set<ChildProcessWithoutNullStreams>();
let exitCleanupInstalled = false;

function trackProcess(child: ChildProcessWithoutNullStreams): void {
  children.add(child);
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  process.once("exit", () => {
    // Exit handlers cannot await the normal graceful process-group shutdown.
    for (const running of children) {
      if (!running.pid) continue;
      try {
        if (process.platform === "win32") {
          spawnSync("taskkill.exe", ["/pid", String(running.pid), "/t", "/f"], {
            stdio: "ignore",
            windowsHide: true,
            timeout: 3000,
          });
        } else {
          process.kill(-running.pid, "SIGKILL");
        }
      } catch {
        running.kill("SIGKILL");
      }
    }
  });
}

/** Private, authenticated loopback server; never attaches to a user's server. */
export class OpenCodeServer {
  private readonly connections = process.versions.bun
    ? undefined
    : new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  private readonly lifetime = new AbortController();
  private readonly password = randomUUID();
  private url = "";
  private readonly ready: Promise<void>;
  private readonly stopped: Promise<void>;

  constructor(cwd: string, env: NodeJS.ProcessEnv) {
    const running = spawnManagedWorkloadProcess(
      "opencode",
      ["serve", "--hostname=127.0.0.1", "--port=0"],
      {
        cwd,
        env: {
          ...env,
          OPENCODE_SERVER_USERNAME: "opencode",
          OPENCODE_SERVER_PASSWORD: this.password,
        },
        signal: this.lifetime.signal,
      },
    );
    trackProcess(running.process);
    running.process.stdin.end();
    this.stopped = running.completion.then(() => {
      children.delete(running.process);
    });
    let stdout = "";
    let stderr = "";
    running.process.stdout.setEncoding("utf8");
    running.process.stderr.setEncoding("utf8");
    running.process.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    this.ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.close(new Error("OpenCode server startup timed out"));
      }, 30_000);
      const abort = () => {
        clearTimeout(timeout);
        reject(this.lifetime.signal.reason);
      };
      this.lifetime.signal.addEventListener("abort", abort, { once: true });
      running.process.stdout.on("data", (chunk: string) => {
        stdout = (stdout + chunk).slice(-4096);
        const match = stdout.match(
          /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/,
        );
        if (!match?.[1]) return;
        this.url = match[1];
        clearTimeout(timeout);
        this.lifetime.signal.removeEventListener("abort", abort);
        resolve();
      });
      running.process.once("error", (error: NodeJS.ErrnoException) => {
        this.close(
          error.code === "ENOENT"
            ? new Error("Required executable 'opencode' was not found on PATH")
            : error,
        );
      });
    });
    void running.completion.then(({ exitCode }) => {
      this.close(
        new Error(
          `OpenCode server exited (${exitCode ?? "unknown"}): ${stderr}`,
        ),
      );
    });
  }

  async connect(signal?: AbortSignal): Promise<void> {
    const abort = () => this.close(new Error("OpenCode startup cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      await this.ready;
      this.lifetime.signal.throwIfAborted();
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  client(directory: string): OpencodeClient {
    return createOpencodeClient({
      baseUrl: this.url,
      directory,
      signal: this.lifetime.signal,
      // Scope Node's pool to this process, not a port a later server can reuse.
      fetch: this.connections
        ? (((request: Request) => {
            const options = {
              dispatcher: this.connections,
              signal: request.signal,
            };
            return fetch(request, options as RequestInit);
          }) as typeof fetch)
        : undefined,
      headers: {
        Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`,
      },
    });
  }

  close(reason = new Error("OpenCode server closed")): Promise<void> {
    this.lifetime.abort(reason);
    return Promise.all([this.stopped, this.connections?.destroy()]).then(
      () => undefined,
    );
  }

  controlOptions() {
    return {
      throwOnError: true as const,
      signal: AbortSignal.any([
        this.lifetime.signal,
        AbortSignal.timeout(30_000),
      ]),
    };
  }

  /** Subscribe before submitting a prompt so even fast tool calls are visible. */
  async events(
    client: OpencodeClient,
    onEvent: (event: Event) => void,
  ): Promise<{ completion: Promise<void> }> {
    let streamError: unknown;
    const { stream } = await client.event.subscribe(undefined, {
      sseMaxRetryAttempts: 1,
      onSseError: (error) => {
        streamError = error;
      },
    });
    // SDK streams are lazy. Wait for server.connected before starting work.
    const first = await stream.next();
    if (first.done)
      throw streamError ?? new Error("OpenCode event stream closed");
    onEvent(first.value);
    const consume = async () => {
      for await (const event of stream) onEvent(event);
      throw streamError ?? new Error("OpenCode event stream closed");
    };
    // The first event confirms the subscription; consumption stays in background.
    const completion = consume();
    void completion.catch(() => undefined);
    return { completion };
  }
}
