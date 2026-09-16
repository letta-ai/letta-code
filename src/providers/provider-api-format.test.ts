import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type ProviderRecord = {
  id: string;
  name: string;
  provider_type: string;
  api_format?: string;
  base_url?: string;
};

// Run production connection code in a child: no shared settings, backend state,
// module mocks, real credentials, or remote network calls in the test worker.
async function runConnectionScenario(script: string) {
  const home = await mkdtemp(join(tmpdir(), "provider-format-"));
  const records = new Map<string, ProviderRecord>();
  const writes: Array<{ method: string; body: Record<string, unknown> }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/v1/providers") {
        return Response.json([...records.values()]);
      }
      if (req.method === "POST" && path === "/v1/providers/check") {
        return Response.json({ message: "OK" });
      }
      if (req.method === "POST" && path === "/v1/providers") {
        const body = (await req.json()) as Record<string, unknown>;
        const record = {
          ...body,
          id: `provider-${records.size + 1}`,
          name: String(body.name),
          provider_type: String(body.provider_type),
        };
        records.set(record.id, record);
        writes.push({ method: req.method, body });
        return Response.json(record);
      }
      if (req.method === "PATCH" && path.startsWith("/v1/providers/")) {
        const id = path.split("/").pop() ?? "";
        const current = records.get(id);
        if (!current) return new Response("Not found", { status: 404 });
        const body = (await req.json()) as Record<string, unknown>;
        const updated = { ...current, ...body };
        records.set(id, updated);
        writes.push({ method: req.method, body });
        return Response.json(updated);
      }
      return new Response("Unexpected request", { status: 404 });
    },
  });
  const root = resolve(import.meta.dir, "../..");
  const moduleUrl = (path: string) =>
    JSON.stringify(pathToFileURL(join(root, path)).href);
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
          import { configureBackendMode } from ${moduleUrl("src/backend/backend.ts")};
          import { runConnectSubcommand } from ${moduleUrl("src/cli/subcommands/connect.ts")};
          import { connectProvider } from ${moduleUrl("src/providers/connect-provider-service.ts")};
          import { updateProvider } from ${moduleUrl("src/backend/api/providers.ts")};
          import { settingsManager } from ${moduleUrl("src/settings-manager.ts")};
          configureBackendMode("api");
          await settingsManager.initialize();
          ${script}
        `,
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          USERPROFILE: home,
          LETTA_BASE_URL: server.url.origin,
          LETTA_API_KEY: "test-letta-key",
          LETTA_DISABLE_TELEMETRY: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, error: exitCode ? `${stdout}\n${stderr}` : "" }).toEqual(
      {
        exitCode: 0,
        error: "",
      },
    );
    return { records: [...records.values()], writes };
  } finally {
    await server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
}

describe("explicit provider API format on Cloud connections", () => {
  test.each([
    ["openai", "lc-openai", "responses"],
    ["openai-compatible", "lc-openai-compatible", "chat_completions"],
  ])(
    "%s persists its selection on create and reconnect",
    async (choice, name, format) => {
      const args = JSON.stringify([
        choice,
        "--api-key",
        "test-provider-key",
        "--base-url",
        "https://gateway.example/v1",
      ]);
      const { records, writes } = await runConnectionScenario(`
      if (await runConnectSubcommand(${args}) !== 0) throw new Error("Create failed");
      if (await runConnectSubcommand(${args}) !== 0) throw new Error("Reconnect failed");
      await updateProvider("provider-1", "rotated-test-key");
    `);
      expect(writes.map((write) => write.method)).toEqual([
        "POST",
        "PATCH",
        "PATCH",
      ]);
      expect(writes[0]?.body).toMatchObject({
        name,
        provider_type: "openai",
        api_format: format,
        base_url: "https://gateway.example/v1",
      });
      expect(writes[1]?.body.api_format).toBe(format);
      expect(writes[2]?.body).not.toHaveProperty("api_format");
      expect(records).toEqual([
        expect.objectContaining({ name, api_format: format }),
      ]);
    },
  );

  test("Desktop connection service persists the compatible selection", async () => {
    const { records } = await runConnectionScenario(`
      await connectProvider({ target: "api", providerId: "openai-compatible", fields: { apiKey: "test-provider-key", baseUrl: "https://gateway.example/v1" } });
    `);
    expect(records).toEqual([
      expect.objectContaining({
        name: "lc-openai-compatible",
        api_format: "chat_completions",
      }),
    ]);
  });

  test("other providers do not acquire an OpenAI API format", async () => {
    const { writes } = await runConnectionScenario(`
      if (await runConnectSubcommand(["anthropic", "--api-key", "test-provider-key"]) !== 0) throw new Error("Create failed");
    `);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).not.toHaveProperty("api_format");
  });
});
