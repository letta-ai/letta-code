import {
  type ChildProcessWithoutNullStreams,
  spawnSync,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { type IncomingMessage, request } from "node:http";
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

export interface OpenCodeEvent {
  type: string;
  properties: {
    sessionID?: string;
    part?: {
      sessionID: string;
      type: string;
      callID?: string;
      tool?: string;
      state?: { status: string; input?: unknown };
    };
  };
}

/** Private, authenticated loopback server; never attaches to a user's server. */
export class OpenCodeServer {
  private readonly lifetime = new AbortController();
  private readonly password = randomUUID();
  private url = "";
  private directory: string;
  private readonly ready: Promise<void>;
  private readonly stopped: Promise<void>;

  constructor(cwd: string, env: NodeJS.ProcessEnv) {
    this.directory = cwd;
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

  setDirectory(directory: string): void {
    this.directory = directory;
  }

  close(reason = new Error("OpenCode server closed")): Promise<void> {
    this.lifetime.abort(reason);
    return this.stopped;
  }

  private async response(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<IncomingMessage> {
    this.lifetime.signal.throwIfAborted();
    const url = new URL(path, this.url);
    url.searchParams.set("directory", this.directory);
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(
        url,
        {
          method: body === undefined ? "GET" : "POST",
          // Each server owns its connections. A restarted OpenCode can reuse its
          // default port; global fetch pooling can reuse the old SSE connection.
          agent: false,
          signal: signal
            ? AbortSignal.any([this.lifetime.signal, signal])
            : this.lifetime.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`,
          },
        },
        resolve,
      );
      req.once("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    if (!response.statusCode || response.statusCode >= 400) {
      throw new Error(
        `OpenCode ${path} failed (${response.statusCode}): ${(await responseText(response)).slice(0, 4096)}`,
      );
    }
    return response;
  }

  async request<T>(
    path: string,
    body?: unknown,
    longRunning = false,
  ): Promise<T> {
    const response = await this.response(
      path,
      body,
      longRunning ? undefined : AbortSignal.timeout(30_000),
    );
    return JSON.parse(await responseText(response)) as T;
  }

  /** Subscribe before submitting a prompt so even fast tool calls are visible. */
  async events(
    onEvent: (event: OpenCodeEvent) => void,
  ): Promise<{ completion: Promise<void> }> {
    const response = await this.response("/event");
    const consume = async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const value of response) {
        buffer += decoder
          .decode(value, { stream: true })
          .replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data) onEvent(JSON.parse(data) as OpenCodeEvent);
          boundary = buffer.indexOf("\n\n");
        }
      }
      throw new Error("OpenCode event stream closed");
    };
    // Do not await the stream here: only wait for subscription headers.
    const completion = consume();
    void completion.catch(() => undefined);
    return { completion };
  }
}

async function responseText(response: IncomingMessage): Promise<string> {
  response.setEncoding("utf8");
  let text = "";
  for await (const chunk of response) text += chunk;
  return text;
}
