import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Letta from "@letta-ai/letta-client";
import { createAuthenticatedCliTestEnv } from "@/test-utils/test-process-env";

type Sandbox = { sandboxId: string; conversationId?: string | null };

// Runs in the API integration job; no messages or model inference are needed.
test.skipIf(!process.env.LETTA_API_KEY)(
  "sandbox transfers honor explicit Cloud targets instead of ambient sessions",
  async () => {
    const baseURL = process.env.LETTA_BASE_URL || "https://api.letta.com";
    const sdk = new Letta({
      apiKey: process.env.LETTA_API_KEY,
      baseURL,
      timeout: 30000,
      maxRetries: 0,
    });
    const home = await mkdtemp(join(tmpdir(), "letta-sandbox-transfer-"));
    let agentId: string | undefined;
    let conversationId: string | undefined;
    async function sandboxRequest(path: string, method = "GET") {
      const response = await fetch(new URL(`/v1/sandboxes${path}`, baseURL), {
        method,
        headers: { Authorization: `Bearer ${process.env.LETTA_API_KEY}` },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok)
        throw new Error(`Sandbox ${method} failed: ${response.status}`);
      return response;
    }
    async function listSandboxes(): Promise<Sandbox[]> {
      const response = await sandboxRequest(
        `?agentId=${agentId}&includeConversationScoped=true`,
      );
      return ((await response.json()) as { sandboxes: Sandbox[] }).sandboxes;
    }
    async function cli(args: string[], ambient: NodeJS.ProcessEnv = {}) {
      const artifact = process.env.LETTA_TEST_CLI_PATH;
      const child = Bun.spawn(
        [
          artifact ? "node" : process.execPath,
          ...(artifact
            ? []
            : [
                "--loader=.md:text",
                "--loader=.mdx:text",
                "--loader=.txt:text",
              ]),
          artifact
            ? resolve(artifact)
            : resolve(import.meta.dir, "../index.ts"),
          "--backend",
          "cloud",
          "sandbox",
          ...args,
        ],
        {
          cwd: home,
          env: createAuthenticatedCliTestEnv({
            HOME: home,
            LETTA_BASE_URL: baseURL,
            LETTA_DISABLE_MODS: "1",
            LETTA_AGENT_ID: `agent-local-${randomUUID()}`,
            LETTA_CONVERSATION_ID: `conv-${randomUUID()}`,
            AGENT_ID: `agent-${randomUUID()}`,
            CONVERSATION_ID: `conv-${randomUUID()}`,
            ...ambient,
          }),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { stdout, stderr, code };
      } finally {
        clearTimeout(timer);
      }
    }
    try {
      const agent = await sdk.agents.create({
        name: "Sandbox transfer integration",
        agent_type: "letta_v1_agent",
        model: "openai/gpt-5.6-luna",
        include_base_tools: false,
        include_base_tool_rules: false,
        initial_message_sequence: [],
      });
      agentId = agent.id;
      conversationId = (await sdk.conversations.create({ agent_id: agentId }))
        .id;
      const localPath = join(home, "payload.bin");
      const scenarios = [conversationId, "default"].map((target, i) => ({
        target,
        payload: Buffer.from([0, 255, 128, 13, 10, i, 0, 254]),
        remotePath: "",
      }));
      for (const scenario of scenarios) {
        const { target, payload } = scenario;
        await writeFile(localPath, payload);
        const upload = await cli([
          "upload",
          localPath,
          "--conversation",
          target,
          ...(target === "default" ? ["--agent", agentId] : []),
        ]);
        expect(upload.code, upload.stderr).toBe(0);
        const output = JSON.parse(upload.stdout);
        expect(output).toMatchObject({ agentId, conversationId: target });
        expect(output.files).toHaveLength(1);
        expect(output.files[0].size).toBe(payload.length);
        expect(output.files[0].path).toStartWith("/root/downloads/");
        scenario.remotePath = output.files[0].path;
      }
      const sandboxes = await listSandboxes();
      expect(sandboxes).toHaveLength(2);
      const concrete = sandboxes.find(
        (s) => s.conversationId === conversationId,
      );
      const defaultSandbox = sandboxes.find((s) => s.conversationId === null);
      expect(concrete?.sandboxId).toBeTruthy();
      expect(defaultSandbox?.sandboxId).toBeTruthy();
      expect(concrete?.sandboxId).not.toBe(defaultSandbox?.sandboxId);
      // Download from each scope after both uploads and verify the binary contents.
      for (const { target, payload, remotePath } of scenarios) {
        const destination = join(home, `download-${target}.bin`);
        const download = await cli([
          "download",
          remotePath,
          "--to",
          destination,
          "--conversation",
          target,
          ...(target === "default" ? ["--agent", agentId] : []),
        ]);
        expect(download.code, download.stderr).toBe(0);
        expect(JSON.parse(download.stdout)).toMatchObject({
          agentId,
          conversationId: target,
        });
        expect(await readFile(destination)).toEqual(payload);
      }
      const ambient = {
        LETTA_AGENT_ID: agentId,
        LETTA_CONVERSATION_ID: conversationId,
        AGENT_ID: agentId,
        CONVERSATION_ID: conversationId,
      };
      const legacy = await cli(["upload", localPath], ambient);
      expect(legacy.code, legacy.stderr).toBe(0);
      const ambientPath = JSON.parse(legacy.stdout).files[0].path;
      for (const action of ["upload", "download"]) {
        for (const flags of [
          [
            "--conversation",
            conversationId,
            "--agent",
            `agent-${randomUUID()}`,
          ],
          ["--conversation", `conv-${randomUUID()}`],
        ]) {
          const failed = await cli(
            [action, action === "upload" ? localPath : ambientPath, ...flags],
            ambient,
          );
          expect(failed.code, failed.stdout).toBe(1);
          expect(failed.stderr).toContain("Error:");
          expect(failed.stdout.trim()).toBe("");
        }
      }
      expect((await listSandboxes()).map((s) => s.sandboxId).sort()).toEqual(
        sandboxes.map((s) => s.sandboxId).sort(),
      );
    } finally {
      // Agent deletion only cleans its default sandbox; terminate every scope first.
      try {
        if (agentId) {
          const results = await Promise.allSettled(
            (await listSandboxes()).map((s) =>
              sandboxRequest(
                `/${encodeURIComponent(s.sandboxId)}/terminate`,
                "POST",
              ),
            ),
          );
          expect(
            results.filter((result) => result.status === "rejected"),
          ).toEqual([]);
        }
      } finally {
        try {
          if (conversationId) await sdk.conversations.delete(conversationId);
        } finally {
          try {
            if (agentId) await sdk.agents.delete(agentId);
          } finally {
            await rm(home, { recursive: true, force: true });
          }
        }
      }
    }
  },
  360000,
);
