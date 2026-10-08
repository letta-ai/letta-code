import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAgentWebhookBasicAuthorization,
  parseAgentWebhookArgs,
  resolveAgentWebhookTarget,
  runAgentWebhookCli,
  safeAgentWebhook,
} from "@/skills/builtin/managing-agent-webhooks/scripts/manage-agent-webhooks.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL(
    "./builtin/managing-agent-webhooks/scripts/manage-agent-webhooks.mjs",
    import.meta.url,
  ),
);

async function withWebhookEnvironment<T>(
  values: Record<string, string | undefined>,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await operation();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("managing-agent-webhooks helper", () => {
  test("parses a public create request", () => {
    expect(
      parseAgentWebhookArgs([
        "create",
        "--name",
        "Build events",
        "--preprompt",
        "Summarize the build.",
        "--public",
      ]),
    ).toEqual({
      command: "create",
      args: {
        name: "Build events",
        preprompt: "Summarize the build.",
        public: true,
      },
    });
  });

  test("rejects management of another active agent", () => {
    expect(() =>
      parseAgentWebhookArgs(["list", "--agent-id", "agent-other"]),
    ).toThrow("Unsupported option --agent-id for list");
  });

  test("requires the current agent from the runtime", () => {
    expect(resolveAgentWebhookTarget("agent-current")).toBe("agent-current");
    expect(() => resolveAgentWebhookTarget(undefined)).toThrow(
      "AGENT_ID is required",
    );
  });

  test("rejects unknown, duplicate, and payload-in-argv options", () => {
    expect(() =>
      parseAgentWebhookArgs([
        "create",
        "--name",
        "Build events",
        "--prepromt",
        "typo",
        "--public",
      ]),
    ).toThrow("Unsupported option --prepromt for create");
    expect(() =>
      parseAgentWebhookArgs([
        "create",
        "--name",
        "one",
        "--name",
        "two",
        "--public",
      ]),
    ).toThrow("Duplicate option --name");
    expect(() =>
      parseAgentWebhookArgs([
        "test",
        "--webhook-id",
        "webhook-agent-1",
        "--payload-json",
        "{}",
        "--confirm",
      ]),
    ).toThrow("Unsupported option --payload-json for test");
  });

  test("redacts one-time credentials and the internal slug", () => {
    expect(
      safeAgentWebhook({
        authorization_header: "Basic do-not-print",
        id: "webhook-agent-1",
        name: "Build events",
        webhook_slug: "private-slug",
        webhook_url: "https://api.example.test/v1/agent-webhooks/private-slug",
      }),
    ).toEqual({
      id: "webhook-agent-1",
      name: "Build events",
      webhook_url: "https://api.example.test/v1/agent-webhooks/private-slug",
    });
  });

  test("builds the documented Basic authorization value", () => {
    expect(buildAgentWebhookBasicAuthorization("secret-key")).toBe(
      `Basic ${Buffer.from("webhook:secret-key").toString("base64")}`,
    );
  });

  test("requires confirmation before a test can make a request", async () => {
    await withWebhookEnvironment(
      {
        AGENT_ID: "agent-current",
        LETTA_API_KEY: "dummy-secret",
        LETTA_BASE_URL: "http://127.0.0.1:1",
      },
      async () => {
        await expect(
          runAgentWebhookCli(["test", "--webhook-id", "webhook-agent-1"]),
        ).rejects.toThrow("Testing a webhook requires --confirm");
      },
    );
  });

  test("rejects a whitespace-only preprompt before making a request", async () => {
    await withWebhookEnvironment(
      {
        AGENT_ID: "agent-current",
        LETTA_API_KEY: "dummy-secret",
        LETTA_BASE_URL: "http://127.0.0.1:1",
      },
      async () => {
        await expect(
          runAgentWebhookCli([
            "create",
            "--name",
            "Build events",
            "--preprompt",
            "   ",
            "--public",
          ]),
        ).rejects.toThrow(
          "--preprompt must contain a non-whitespace character",
        );
      },
    );
  });

  test("rejects plaintext non-loopback runtime origins", async () => {
    await withWebhookEnvironment(
      {
        AGENT_ID: "agent-current",
        LETTA_API_KEY: "dummy-secret",
        LETTA_BASE_URL: "http://example.test",
      },
      async () => {
        await expect(runAgentWebhookCli(["list"])).rejects.toThrow(
          "Plaintext LETTA_BASE_URL is allowed only on loopback",
        );
      },
    );
  });

  test("runs from a packaged node_modules layout with plain Node", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webhook-skill-"));
    const packagedScript = join(
      root,
      "node_modules",
      "pkg",
      "skills",
      "managing-agent-webhooks",
      "scripts",
      "manage-agent-webhooks.mjs",
    );
    await mkdir(dirname(packagedScript), { recursive: true });
    await copyFile(SCRIPT_PATH, packagedScript);
    const aliasRoot = join(dirname(root), `${basename(root)}-alias`);
    await symlink(
      root,
      aliasRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    const aliasedPackagedScript = packagedScript.replace(root, aliasRoot);

    const received: Array<{
      authorization?: string;
      body: string;
      method?: string;
      path?: string;
    }> = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      received.push({
        authorization: request.headers.authorization,
        body,
        method: request.method,
        path: request.url,
      });

      const address = server.address();
      if (!address || typeof address === "string") {
        response.writeHead(500);
        response.end();
        return;
      }
      const webhook = {
        authorization_header: "Basic do-not-print",
        id: "webhook-agent-1",
        name: "Build events",
        requires_authorization_header: false,
        webhook_slug: "private-slug",
        webhook_url: `http://127.0.0.1:${address.port}/ingress`,
      };
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url?.endsWith("/webhooks")) {
        response.writeHead(200);
        response.end(JSON.stringify({ webhooks: [webhook] }));
        return;
      }
      if (request.method === "POST" && request.url?.endsWith("/webhooks")) {
        response.writeHead(201);
        response.end(JSON.stringify({ webhook }));
        return;
      }
      if (request.method === "GET" && request.url?.includes("/requests?")) {
        response.writeHead(200);
        response.end(
          JSON.stringify({
            requests: [
              {
                enqueued: true,
                id: "request-1",
                request_body: { secret: "hidden-by-default" },
                status_code: 202,
              },
            ],
          }),
        );
        return;
      }
      if (request.method === "POST" && request.url === "/ingress") {
        response.writeHead(202);
        response.end('{"ok":true}');
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a TCP test server address");
      }
      const runNode = async (args: string[]): Promise<unknown> => {
        const child = Bun.spawn(["node", aliasedPackagedScript, ...args], {
          env: {
            ...process.env,
            AGENT_ID: "agent-current/encoded",
            LETTA_API_KEY: "dummy-secret",
            LETTA_BASE_URL: `http://127.0.0.1:${address.port}`,
          },
          stderr: "pipe",
          stdout: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(stderr).toBe("");
        expect(exitCode).toBe(0);
        expect(stdout.length).toBeGreaterThan(0);
        return JSON.parse(stdout);
      };

      const listed = (await runNode(["list"])) as {
        webhooks: Array<Record<string, unknown>>;
      };
      expect(listed.webhooks).toHaveLength(1);
      expect(listed.webhooks[0]).not.toHaveProperty("authorization_header");
      expect(listed.webhooks[0]).not.toHaveProperty("webhook_slug");

      const created = await runNode([
        "create",
        "--name",
        "Build events",
        "--preprompt",
        "  Summarize this build.  ",
        "--public",
        "--disabled",
      ]);
      expect(created).not.toHaveProperty("webhook.authorization_header");
      expect(created).not.toHaveProperty("webhook.webhook_slug");

      const history = (await runNode([
        "requests",
        "--webhook-id",
        "webhook-agent-1",
      ])) as { requests: Array<Record<string, unknown>> };
      expect(history.requests[0]).toMatchObject({
        accepted: true,
        id: "request-1",
        status_code: 202,
      });
      expect(history.requests[0]).not.toHaveProperty("enqueued");
      expect(history.requests[0]).not.toHaveProperty("request_body");

      const historyWithBody = (await runNode([
        "requests",
        "--webhook-id",
        "webhook-agent-1",
        "--include-body",
      ])) as { requests: Array<Record<string, unknown>> };
      expect(historyWithBody.requests[0]?.request_body).toEqual({
        secret: "hidden-by-default",
      });

      expect(
        await runNode(["test", "--webhook-id", "webhook-agent-1", "--confirm"]),
      ).toEqual({
        accepted_for_processing: true,
        body: { ok: true },
        dispatch_verified: false,
        note: "HTTP 202 confirms only that the ingress handler accepted the request; conversation creation and queue submission happen asynchronously.",
        status_code: 202,
      });

      expect(received[0]).toMatchObject({
        authorization: "Bearer dummy-secret",
        body: "",
        method: "GET",
        path: "/v1/agents/agent-current%2Fencoded/webhooks",
      });
      const createRequest = received.find(
        (request) =>
          request.method === "POST" && request.path?.endsWith("/webhooks"),
      );
      expect(JSON.parse(createRequest?.body ?? "")).toEqual({
        enabled: false,
        name: "Build events",
        preprompt: "Summarize this build.",
        requires_authorization_header: false,
      });
      const ingressRequest = received.find(
        (request) => request.method === "POST" && request.path === "/ingress",
      );
      expect(JSON.parse(ingressRequest?.body ?? "")).toMatchObject({
        event: "agent-webhook-test",
        message: "Test delivery from Letta Code",
      });

      const whitespaceKeyChild = Bun.spawn(
        [
          "node",
          aliasedPackagedScript,
          "create",
          "--name",
          "Whitespace key",
          "--security-key-stdin",
        ],
        {
          env: {
            ...process.env,
            AGENT_ID: "agent-current/encoded",
            LETTA_API_KEY: "dummy-secret",
            LETTA_BASE_URL: `http://127.0.0.1:${address.port}`,
          },
          stderr: "pipe",
          stdin: "pipe",
          stdout: "pipe",
        },
      );
      whitespaceKeyChild.stdin.write(" \t\n");
      whitespaceKeyChild.stdin.end();
      const [whitespaceExitCode, whitespaceStdout, whitespaceStderr] =
        await Promise.all([
          whitespaceKeyChild.exited,
          new Response(whitespaceKeyChild.stdout).text(),
          new Response(whitespaceKeyChild.stderr).text(),
        ]);
      expect(whitespaceExitCode).toBe(1);
      expect(whitespaceStdout).toBe("");
      expect(whitespaceStderr).toContain(
        "Security key from stdin must contain a non-whitespace character",
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await rm(aliasRoot, { force: true, recursive: true });
      await rm(root, { force: true, recursive: true });
    }
  });
});
