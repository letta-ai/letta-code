// Runs only in a child process. Keep the SDK and its native helpers out of the
// listener/TUI process and preserve the installed package's lazy module loads.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  Agent,
  type AgentOptions,
  Cursor,
  JsonlLocalAgentStore,
  type ModelListItem,
  type Run,
  type RunResult,
} from "@cursor/sdk";

import { isCursorModelRejection, retryCursorStart } from "./cursor-start-retry";

export interface CursorWorkerStart {
  type: "start";
  sessionId: string;
  stateDir: string;
  resume: boolean;
  cwd: string;
  model?: string;
  reminder?: string;
  prompt: string;
}

export type CursorWorkerEvent =
  | { type: "started"; sessionId: string }
  | { type: "tool"; id: string; name: string; args: unknown }
  | { type: "steer"; id: number; delivered: boolean; error?: string }
  | { type: "result"; result: RunResult }
  | { type: "models"; models: ModelListItem[] }
  | { type: "error"; error: string };

function emit(event: CursorWorkerEvent): void {
  process.stdout.write(`letta-cursor:${JSON.stringify(event)}\n`);
}

let run: Run | undefined;
let cancelled = false;
let started = false;
const steering = new Set<Promise<void>>();
const input = createInterface({ input: process.stdin });

async function cancel(): Promise<void> {
  cancelled = true;
  await run?.cancel();
}

async function start(command: CursorWorkerStart): Promise<void> {
  await mkdir(command.stateDir, { recursive: true, mode: 0o700 });
  const configPath = join(command.stateDir, "config.json");
  const config: { cwd: string; model: string; reminder?: string } =
    command.resume
      ? JSON.parse(await readFile(configPath, "utf8"))
      : { cwd: command.cwd, model: command.model, reminder: command.reminder };
  if (!config.model)
    throw new Error(
      "Cursor requires an explicit model on the first Agent call; pick an ID from `letta model list --worker cursor`.",
    );
  if (!command.resume) {
    await writeFile(configPath, JSON.stringify(config), {
      mode: 0o600,
      flag: "wx",
    });
  }
  const options: AgentOptions = {
    apiKey: process.env.CURSOR_API_KEY,
    model: { id: command.model ?? config.model },
    // Noninteractive coding worker: shell and edits run without Letta approval.
    // Do not allow untracked native subagents or interactive questions.
    tools: [
      "shell",
      "read",
      "edit",
      "grep",
      "glob",
      "ls",
      "web_search_tool_call",
      "web_fetch_tool_call",
    ],
    local: {
      cwd: config.cwd,
      store: new JsonlLocalAgentStore(join(command.stateDir, "store")),
      settingSources: ["project"],
    },
  };
  await using agent = command.resume
    ? await Agent.resume(`agent-${command.sessionId}`, options)
    : await Agent.create({ ...options, agentId: `agent-${command.sessionId}` });
  if (cancelled) throw new Error("Cursor startup cancelled");
  const seen = new Set<string>();
  let notified = false;
  const result = await retryCursorStart(
    async () => {
      run = await agent.send(
        [config.reminder, command.prompt].filter(Boolean).join("\n\n"),
      );
      if (cancelled) await run.cancel();
      if (!notified) {
        emit({ type: "started", sessionId: command.sessionId });
        notified = true;
      }
      for await (const event of run.stream()) {
        if (event.type === "tool_call" && !seen.has(event.call_id)) {
          seen.add(event.call_id);
          emit({
            type: "tool",
            id: event.call_id,
            name: event.name,
            args: event.args,
          });
        }
      }
      const result = await run.wait();
      if (result.status !== "finished" && result.error) {
        const error = new Error(result.error.message);
        if (isCursorModelRejection(error)) throw error;
      }
      return result;
    },
    () => !cancelled && seen.size === 0 && steering.size === 0,
  );
  // Settle all steering acknowledgments before the result closes this process.
  await Promise.all(steering);
  emit({ type: "result", result });
}

input.on("line", (line) => {
  const command = JSON.parse(line) as
    | CursorWorkerStart
    | { type: "models" }
    | { type: "steer"; id: number; prompt: string };
  if ((command.type === "start" || command.type === "models") && !started) {
    started = true;
    void (
      command.type === "models"
        ? Cursor.models
            .list({ apiKey: process.env.CURSOR_API_KEY })
            .then((models) => emit({ type: "models", models }))
        : start(command)
    )
      .catch(async (error: unknown) => {
        await cancel().catch(() => undefined);
        emit({
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        input.close();
        process.stdout.write("", () => process.exit(0));
      });
  } else if (command.type === "steer") {
    const pending = (async () => {
      try {
        const outcome = await run?.steer?.(command.prompt);
        emit({
          type: "steer",
          id: command.id,
          delivered: outcome === "complete_delivered",
        });
      } catch (error) {
        // An unknown delivery outcome must not be retried automatically.
        emit({
          type: "steer",
          id: command.id,
          delivered: false,
          error: String(error),
        });
      }
    })();
    steering.add(pending);
    void pending.finally(() => steering.delete(pending));
  }
});
process.on("SIGINT", () => void cancel());
process.on("SIGTERM", () => void cancel());
input.on("close", () => {
  if (!started || run?.status === "running") void cancel();
});
