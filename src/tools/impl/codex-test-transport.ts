import { PassThrough } from "node:stream";
import type { CodexAppServerTransport } from "./codex-app-server";

export const CAPACITY_MESSAGE =
  'unexpected status 409 Conflict: {"error":{"message":"No account capacity is available."}}';

export class FakeCodexTransport {
  readonly requests: Array<Record<string, unknown>> = [];
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  private threadId = "thread-1";
  private turnId = "turn-1";
  steerRace = false;
  completeBeforeTurnStartSettles = false;
  initializeError = false;
  onInitialize?: (id: number) => void;
  failNextTurns = 0;
  failure: Record<string, unknown> = {
    message: CAPACITY_MESSAGE,
    codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 409 } },
  };
  completeAfterFailures?: string;
  onTurnStarted?: () => void;
  resumedModel?: string;
  private failedTurns = 0;
  account: Record<string, unknown> | null = {
    account: { type: "chatgpt" },
    requiresOpenaiAuth: true,
  };
  killed = false;

  constructor() {
    let buffered = "";
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      buffered += chunk;
      while (buffered.includes("\n")) {
        const index = buffered.indexOf("\n");
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        if (line) this.handle(JSON.parse(line) as Record<string, unknown>);
      }
    });
  }

  transport(): CodexAppServerTransport {
    return {
      stdin: this.stdin,
      stdout: this.stdout,
      stderr: this.stderr,
      kill: () => {
        this.killed = true;
      },
    };
  }

  complete(text = "done", items = true): void {
    if (!items) {
      this.send({
        method: "item/completed",
        params: {
          threadId: this.threadId,
          turnId: this.turnId,
          item: { type: "agentMessage", text },
        },
      });
    }
    this.send({
      method: "turn/completed",
      params: {
        threadId: this.threadId,
        turn: {
          id: this.turnId,
          status: "completed",
          items: items ? [{ type: "agentMessage", text }] : [],
        },
      },
    });
  }

  private handle(request: Record<string, unknown>): void {
    this.requests.push(request);
    if (typeof request.id !== "number") return;
    const method = request.method;
    if (method === "initialize") {
      this.onInitialize?.(request.id);
      if (this.initializeError) {
        this.send({ id: request.id, error: { message: "initialize failed" } });
      } else {
        this.reply(request.id, {});
      }
    }
    if (method === "account/read") {
      if (this.account) this.reply(request.id, this.account);
      else this.send({ id: request.id, error: { message: "unknown method" } });
    }
    if (method === "skills/extraRoots/set") this.reply(request.id, {});
    if (method === "thread/start" || method === "thread/resume") {
      const params = request.params as Record<string, unknown>;
      if (typeof params.threadId === "string") this.threadId = params.threadId;
      this.reply(request.id, {
        thread: { id: this.threadId },
        model: method === "thread/resume" ? this.resumedModel : params.model,
      });
    }
    if (method === "turn/start" && this.failNextTurns > 0) {
      this.failNextTurns--;
      const turnId = `failed-turn-${++this.failedTurns}`;
      this.reply(request.id, {
        turn: { id: turnId, status: "inProgress", items: [] },
      });
      this.fail(turnId);
      return;
    }
    if (method === "turn/start") {
      this.reply(request.id, {
        turn: { id: this.turnId, status: "inProgress", items: [] },
      });
      if (this.completeBeforeTurnStartSettles) {
        this.complete("fast completion", false);
      }
      this.onTurnStarted?.();
      if (this.completeAfterFailures !== undefined) {
        this.complete(this.completeAfterFailures);
      }
    }
    if (method === "turn/steer") {
      if (this.steerRace) {
        this.complete("first turn done");
        this.turnId = "turn-2";
        this.send({
          id: request.id,
          error: { message: "active turn changed" },
        });
      } else {
        this.reply(request.id, { turnId: this.turnId });
      }
    }
    if (method === "turn/interrupt") this.reply(request.id, {});
  }

  private reply(id: number, result: Record<string, unknown>): void {
    this.send({ id, result });
  }

  item(
    method: "item/started" | "item/completed",
    item: Record<string, unknown>,
  ): void {
    this.send({
      method,
      params: { threadId: this.threadId, turnId: this.turnId, item },
    });
  }

  errorNotification(
    error: Record<string, unknown>,
    turnId = this.turnId,
    willRetry = false,
  ): void {
    this.send({
      method: "error",
      params: { threadId: this.threadId, turnId, error, willRetry },
    });
  }

  fail(
    turnId = this.turnId,
    error: Record<string, unknown> | null = this.failure,
  ) {
    this.send({
      method: "turn/completed",
      params: {
        threadId: this.threadId,
        turn: { id: turnId, status: "failed", items: [], error },
      },
    });
  }

  close(detail = "transport died"): void {
    this.stderr.write(detail);
    this.stdout.end();
  }

  send(message: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}
