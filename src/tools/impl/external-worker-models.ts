import { createInterface } from "node:readline";
import { spawnManagedWorkloadProcess } from "@/agent/subagents/subagent-process";
import { scrubSecretsFromString } from "@/tools/secret-substitution";
import { isRecord } from "@/utils/type-guards";
import { listCodexModels } from "./codex-app-server";
import { resolveExternalCodingAgentSecretEnv } from "./external-coding-agent";
import { OpenCodeServer } from "./opencode-server";

interface WorkerModel {
  id: string;
  display_name: string;
  description?: string;
}

async function listClaudeModels(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<unknown[]> {
  const controller = new AbortController();
  const running = spawnManagedWorkloadProcess(
    "claude",
    [
      "--print",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--settings",
      '{"disableAllHooks":true}',
    ],
    { cwd, env, signal: controller.signal },
  );
  const timer = setTimeout(() => controller.abort(), 30_000);
  const lines = createInterface({ input: running.process.stdout });
  let stderr = "";
  running.process.once("error", (error) => {
    stderr = error.message;
  });
  running.process.stderr.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-2000);
  });
  running.process.stdin.on("error", () => {});
  running.process.stdin.end(
    `${JSON.stringify({
      type: "control_request",
      request_id: "models",
      request: { subtype: "initialize" },
    })}\n`,
  );
  async function readModels(): Promise<unknown[]> {
    for await (const line of lines) {
      const message: unknown = JSON.parse(line);
      if (!isRecord(message) || message.type !== "control_response") continue;
      const response = message.response;
      if (!isRecord(response) || response.request_id !== "models") continue;
      if (response.subtype === "error") throw new Error(String(response.error));
      const result = response.response;
      if (!isRecord(result) || !Array.isArray(result.models))
        throw new Error("Claude Code did not return a model catalog");
      return result.models;
    }
    throw new Error(
      controller.signal.aborted
        ? "Claude Code model discovery timed out"
        : `Claude Code exited without a model catalog: ${stderr}`,
    );
  }
  try {
    return await Promise.race([
      readModels(),
      running.completion.then(() => {
        throw new Error(
          controller.signal.aborted
            ? "Claude Code model discovery timed out"
            : `Claude Code exited without a model catalog: ${stderr}`,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    lines.close();
    controller.abort();
    await running.completion;
  }
}

/** Native IDs, not Letta backend handles. No inference or persistent sessions. */
export async function listExternalWorkerModels(worker: string): Promise<{
  worker: string;
  computer: "local";
  cwd: string;
  models: WorkerModel[];
}> {
  if (!["claude-code", "codex", "opencode"].includes(worker))
    throw new Error("--worker must be claude-code, codex, or opencode");
  const agentId = process.env.AGENT_ID ?? process.env.LETTA_AGENT_ID;
  const secrets = agentId
    ? await resolveExternalCodingAgentSecretEnv(agentId)
    : {};
  const env = { ...process.env, ...secrets };
  const cwd = process.cwd();
  const models: WorkerModel[] = [];
  try {
    if (worker === "opencode") {
      const server = new OpenCodeServer(cwd, env);
      try {
        await server.connect();
        const catalog = await server.request<{
          providers: { id: string; models: Record<string, { name: string }> }[];
        }>("/config/providers");
        for (const provider of catalog.providers) {
          for (const [id, model] of Object.entries(provider.models))
            models.push({
              id: `${provider.id}/${id}`,
              display_name: model.name,
            });
        }
      } finally {
        await server.close();
      }
    } else {
      const catalog =
        worker === "codex"
          ? await listCodexModels(cwd, env)
          : await listClaudeModels(cwd, env);
      for (const model of catalog) {
        if (!isRecord(model))
          throw new Error("Invalid native model catalog entry");
        const id = worker === "codex" ? model.model : model.value;
        if (typeof id !== "string" || typeof model.displayName !== "string")
          throw new Error(
            "Native model catalog entry is missing its ID or name",
          );
        models.push({
          id,
          display_name: model.displayName,
          ...(typeof model.description === "string" && {
            description: model.description,
          }),
        });
      }
    }
    return { worker, computer: "local", cwd, models };
  } catch (error) {
    throw new Error(
      scrubSecretsFromString(
        error instanceof Error ? error.message : String(error),
        secrets,
      ),
    );
  }
}
