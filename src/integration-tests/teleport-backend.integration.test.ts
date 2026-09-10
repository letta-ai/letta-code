import { expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Letta from "@letta-ai/letta-client";
import WebSocket from "ws";
import { AppServerClient } from "@/app-server-client";
import type {
  ListEnvironmentsResponse,
  TeleportResponse,
} from "@/backend/api/environments";
import { createAuthenticatedCliTestEnv } from "@/test-utils/test-process-env";

// Real Cloud relay, model turn, and two real CLIs; no mocks or shared settings.
// Optional: LETTA_TEST_CLI_PATH=/absolute/path/to/built/letta.js runs Node.
const apiKey = process.env.LETTA_API_KEY;
const baseURL = process.env.LETTA_BASE_URL || "https://api.letta.com";
const sourceEntry = resolve(import.meta.dir, "../../src/index.ts");
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function bounded<T>(label: string, work: Promise<T>, ms = 30_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function poll<T>(label: string, probe: () => Promise<T | undefined>) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== undefined) return result;
    await delay(500);
  }
  throw new Error(`${label} timed out`);
}

async function request<T>(
  path: string,
  body?: object,
  method = body ? "POST" : "GET",
): Promise<T> {
  const response = await fetch(new URL(path, baseURL), {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      errorCode?: string;
      message?: string;
    };
    throw new Error(
      `Cloud request failed: HTTP ${response.status}: ${error.errorCode ?? ""} ${error.message ?? ""}`,
    );
  }
  return response.json() as Promise<T>;
}

async function stop(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGTERM");
  try {
    await bounded("listener shutdown", exited, 5_000);
  } catch {
    child.kill("SIGKILL");
    await bounded("listener force shutdown", exited, 5_000);
  }
}

const testWithAPI = apiKey ? test : test.skip;
testWithAPI.each(["destination lookup", "active handoff"])(
  "Cloud teleport with saved local backend: %s",
  async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), "letta-teleport-backend-"));
    const sdk = new Letta({ apiKey, baseURL, timeout: 30_000, maxRetries: 0 });
    const children: ChildProcess[] = [];
    const clients: AppServerClient[] = [];
    const environmentIds = new Set<string>();
    let agentId: string | undefined;
    let conversationId: string | undefined;
    let destinationSettingsPath: string | undefined;
    let stage = "setup";
    let destinationAgentNotFound = false;
    const failures: string[] = [];
    const stderrByRole = new Map<string, string>();
    try {
      async function listener(role: "source" | "destination") {
        const home = join(root, role, "home");
        const cwd = join(root, role, "cwd");
        await mkdir(join(home, ".letta"), { recursive: true });
        await mkdir(cwd, { recursive: true });
        const settingsPath = join(home, ".letta", "settings.json");
        if (role === "destination") destinationSettingsPath = settingsPath;
        await writeFile(
          settingsPath,
          JSON.stringify({
            preferredBackendMode: role === "source" ? "api" : "local",
          }),
        );
        const env = createAuthenticatedCliTestEnv({
          HOME: home,
          LETTA_BASE_URL: baseURL,
        });
        for (const key of Object.keys(env)) {
          if (
            /^LETTA_(DESKTOP_|LISTENER_|RUNTIME_|RESTORE_|CHANNEL|SPAWN)/.test(
              key,
            )
          ) {
            delete env[key];
          }
        }
        const name = `teleport-test-${role}-${randomUUID()}`;
        const artifact = process.env.LETTA_TEST_CLI_PATH;
        const child = spawn(
          artifact ? "node" : process.execPath,
          [
            ...(artifact
              ? []
              : [
                  "--loader=.md:text",
                  "--loader=.mdx:text",
                  "--loader=.txt:text",
                ]),
            artifact ? resolve(artifact) : sourceEntry,
            "remote",
            "--computer-name",
            name,
          ],
          { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
        );
        children.push(child);
        child.stderr?.on("data", (chunk: Buffer) => {
          stderrByRole.set(
            role,
            `${stderrByRole.get(role) ?? ""}${chunk.toString()}`.slice(-4000),
          );
        });
        let spawnFailed = false;
        child.on("error", () => {
          spawnFailed = true;
        });
        for (const stream of [child.stdout, child.stderr]) {
          stream?.on("data", (chunk: Buffer) => {
            if (
              role === "destination" &&
              /Agent\b.*not found/i.test(chunk.toString())
            ) {
              destinationAgentNotFound = true;
            }
          });
        }
        const connectionId = await poll(`${role} registration`, async () => {
          if (
            spawnFailed ||
            child.exitCode !== null ||
            child.signalCode !== null
          ) {
            throw new Error(`${role} listener exited before registration`);
          }
          const result = await request<ListEnvironmentsResponse>(
            "/v1/environments?limit=100&onlineOnly=true",
          );
          const environment = result.connections.find(
            (item) => item.connectionName === name,
          );
          if (environment) environmentIds.add(environment.id);
          return environment?.connectionId ?? undefined;
        });
        const client = new AppServerClient({
          url: new URL(
            `/v1/environments/${encodeURIComponent(connectionId)}/status/ws`,
            baseURL,
          ).toString(),
          authToken: apiKey,
          WebSocket,
          requestTimeoutMs: 30_000,
        });
        clients.push(client);
        await bounded(`${role} status WebSocket`, client.connect());
        return { client, connectionId };
      }

      stage = "fixture creation";
      const agent = await sdk.agents.create({
        name: "Teleport backend integration",
        agent_type: "letta_v1_agent",
        model: "openai/gpt-5.6-luna",
        system: "Reply with exactly TELEPORT_BACKEND_OK. Do not call tools.",
        include_base_tools: false,
        include_base_tool_rules: false,
        initial_message_sequence: [],
      });
      agentId = agent.id;
      const conversation = await sdk.conversations.create({
        agent_id: agent.id,
      });
      conversationId = conversation.id;
      stage = "listener startup";
      const source = await listener("source");
      const destination = await listener("destination");
      const scope = { agent_id: agent.id, conversation_id: conversation.id };
      const runtimeStart = {
        ...scope,
        recover_approvals: false,
        wait_for_replay: true,
      };
      if (scenario === "destination lookup") {
        stage = "destination runtime_start";
        const resumed = await destination.client.runtimeStart(runtimeStart);
        destinationAgentNotFound = /Agent\b.*not found/i.test(
          resumed.error ?? "",
        );
        if (!resumed.success)
          throw new Error(resumed.error ?? "runtime_start failed");
        expect(resumed.success).toBe(true);
        expect(resumed.runtime).toMatchObject(scope);
        expect(resumed.agent?.id).toBe(agent.id);
        expect(resumed.conversation?.id).toBe(conversation.id);
        expect(resumed.created).toEqual({ agent: false, conversation: false });
      } else {
        stage = "source runtime_start";
        const started = await source.client.runtimeStart(runtimeStart);
        expect(started.success).toBe(true);
        expect(started.runtime).toMatchObject(scope);

        async function ownerIs(connectionId: string) {
          const result = await request<{
            statuses: Array<{
              conversation_id: string;
              active_harness: { connection_id: string } | null;
            }>;
          }>(
            `/v1/agents/${agent.id}/runtime-status?conversation_ids=${conversation.id}`,
          );
          return result.statuses.some(
            (status) =>
              status.conversation_id === conversation.id &&
              status.active_harness?.connection_id === connectionId,
          )
            ? true
            : undefined;
        }
        // Cloud only attributes an active harness while the conversation runs.
        source.client.input({
          runtime: scope,
          payload: {
            kind: "create_message",
            messages: [{ role: "user", content: "Reply now." }],
          },
        });
        stage = "active source ownership";
        await poll(stage, () => ownerIs(source.connectionId));
        stage = "teleport";
        const runtimePath = `/v1/environments/runtimes/${agent.id}/${conversation.id}`;
        const teleport = await request<TeleportResponse>(
          `${runtimePath}/teleport`,
          {
            targetConnectionId: destination.connectionId,
            idempotencyKey: randomUUID(),
          },
        );
        expect(teleport.sourceConnectionId).toBe(source.connectionId);
        expect(teleport.targetConnectionId).toBe(destination.connectionId);
        expect(typeof teleport.id).toBe("string");
        const completed = await poll("teleport completion", async () => {
          // Cloud's GET route is plural, unlike the initiation POST route.
          const result = await request<TeleportResponse>(
            `${runtimePath}/teleports/${encodeURIComponent(teleport.id)}`,
          );
          if (result.status === "failed") {
            // On pre-fix code this produces the concrete local lookup failure,
            // rather than merely asserting that a backend flag has the wrong value.
            const failed = await destination.client.runtimeStart(runtimeStart);
            destinationAgentNotFound ||= /Agent\b.*not found/i.test(
              failed.error ?? "",
            );
            throw new Error("Cloud teleport failed");
          }
          return result.status === "completed" ? result : undefined;
        });
        expect(completed.agentId).toBe(agent.id);
        expect(completed.conversationId).toBe(conversation.id);
        expect(completed.targetConnectionId).toBe(destination.connectionId);
        stage = "destination runtime_start";
        const resumed = await destination.client.runtimeStart(runtimeStart);
        expect(resumed.success).toBe(true);
        expect(resumed.runtime).toMatchObject(scope);
        expect(resumed.agent?.id).toBe(agent.id);
        expect(resumed.conversation?.id).toBe(conversation.id);
        expect(resumed.created).toEqual({ agent: false, conversation: false });
      }
    } catch (error) {
      const httpStatus =
        error instanceof Letta.APIError
          ? error.status
          : error instanceof Error
            ? error.message.match(/^Cloud request failed: HTTP (\d{3})/)?.[1]
            : undefined;
      failures.push(
        `stage=${stage}; HTTP=${httpStatus ?? "n/a"}; destination Agent not found=${destinationAgentNotFound}; listener exits=${children.map((child) => child.exitCode ?? child.signalCode ?? "running").join(",")}`,
      );
      const detail = [
        error instanceof Error ? error.message : "Unknown failure",
        ...[...stderrByRole].map(([role, stderr]) => `${role}: ${stderr}`),
      ].join("\n");
      failures.push(
        detail
          .replaceAll(apiKey ?? "unconfigured-test-key", "[REDACTED]")
          .replace(/(?:at-let-|rt-let-|sk-)[\w-]+/g, "[REDACTED]")
          .replace(/([?&](?:token|api_key)=)[^\s&]+/g, "$1[REDACTED]"),
      );
    } finally {
      for (const client of clients) client.close();
      await Promise.all(
        children.map((child) =>
          stop(child).catch(() => {
            failures.push("listener shutdown");
          }),
        ),
      );
      // Check after shutdown too: an asynchronous settings flush must not persist API.
      if (destinationSettingsPath) {
        try {
          const saved = JSON.parse(
            await readFile(destinationSettingsPath, "utf8"),
          );
          expect(saved.preferredBackendMode).toBe("local");
        } catch {
          failures.push("destination saved local preference was not preserved");
        }
      }
      if (conversationId)
        await sdk.conversations.delete(conversationId).catch(() => {
          failures.push("conversation deletion");
        });
      if (agentId)
        await sdk.agents.delete(agentId).catch(() => {
          failures.push("agent deletion");
        });
      for (const id of environmentIds) {
        await request(
          `/v1/environments/${encodeURIComponent(id)}`,
          undefined,
          "DELETE",
        ).catch(() => {
          failures.push(`environment deletion: ${id}`);
        });
      }
      await rm(root, { recursive: true, force: true }).catch(() => {
        failures.push("temporary directory removal");
      });
    }
    if (failures.length) {
      throw new Error(`Teleport integration failed: ${failures.join("; ")}`);
    }
  },
  600_000,
);
