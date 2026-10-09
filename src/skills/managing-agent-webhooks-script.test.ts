import { describe, expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
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
        safe_message: "must-not-pass-through",
        items: ["must-not-pass-through"],
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

  test("requires credential output only for generated secure creation", async () => {
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
            "Secured events",
            "--secure",
          ]),
        ).rejects.toThrow(
          "Generated credentials require --credential-output <path>",
        );
        await expect(
          runAgentWebhookCli([
            "create",
            "--name",
            "Public events",
            "--public",
            "--credential-output",
            "/tmp/should-not-exist.json",
          ]),
        ).rejects.toThrow("--credential-output is valid only with --secure");
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
    let listedAuthorizationHeader: string | null = null;
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
        agent_id: "agent-current/encoded",
        authorization_header: listedAuthorizationHeader,
        enabled: true,
        id: "webhook-agent-1",
        name: "Build events",
        requires_authorization_header: listedAuthorizationHeader !== null,
        webhook_slug: "private-slug",
        webhook_url: `http://127.0.0.1:${address.port}/v1/agent-webhooks/private-slug`,
      };
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url?.endsWith("/webhooks")) {
        response.writeHead(200);
        response.end(JSON.stringify({ webhooks: [webhook] }));
        return;
      }
      if (request.method === "POST" && request.url?.endsWith("/webhooks")) {
        const createBody = JSON.parse(body) as {
          enabled?: boolean;
          name?: string;
          preprompt?: string;
          requires_authorization_header?: boolean;
          security_key?: string;
        };
        listedAuthorizationHeader = createBody.requires_authorization_header
          ? createBody.security_key
            ? buildAgentWebhookBasicAuthorization(createBody.security_key)
            : "Basic generated-one-time"
          : null;
        response.writeHead(201);
        response.end(
          JSON.stringify({
            webhook: {
              ...webhook,
              authorization_header: listedAuthorizationHeader,
              enabled: createBody.enabled,
              items: [listedAuthorizationHeader],
              name: createBody.name,
              preprompt:
                createBody.preprompt ??
                "Use the webhook payload to decide what work to perform.",
              requires_authorization_header: listedAuthorizationHeader !== null,
              safe_message:
                createBody.security_key ?? "unpromised-public-field",
            },
          }),
        );
        return;
      }
      if (request.method === "GET" && request.url?.includes("/requests?")) {
        response.writeHead(200);
        response.end(
          JSON.stringify({
            requests: [
              {
                authorization_passed: true,
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
      if (
        request.method === "POST" &&
        request.url === "/v1/agent-webhooks/private-slug"
      ) {
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
        authorization_passed: true,
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
        secret: "[REDACTED]",
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
        (request) =>
          request.method === "POST" &&
          request.path === "/v1/agent-webhooks/private-slug",
      );
      expect(JSON.parse(ingressRequest?.body ?? "")).toMatchObject({
        event: "agent-webhook-test",
        message: "Test delivery from Letta Code",
      });

      const credentialOutput = join(root, "generated-webhook-credential.json");
      const secured = (await runNode([
        "create",
        "--name",
        "Secured build events",
        "--secure",
        "--credential-output",
        credentialOutput,
      ])) as {
        credential_file: string;
        credential_file_is_sensitive: boolean;
        credential_is_recoverable_from_server: boolean;
        webhook: Record<string, unknown>;
      };
      expect(secured).toMatchObject({
        credential_file: credentialOutput,
        credential_file_is_sensitive: true,
        credential_is_recoverable_from_server: false,
      });
      expect(secured.webhook).not.toHaveProperty("authorization_header");
      expect(secured.webhook.preprompt).toBe(
        "Use the webhook payload to decide what work to perform.",
      );
      expect(secured.webhook).not.toHaveProperty("safe_message");
      expect(secured.webhook).not.toHaveProperty("items");
      const credential = JSON.parse(
        await readFile(credentialOutput, "utf8"),
      ) as {
        authorization_header: string;
        security_key: string;
      };
      expect(credential.security_key).toHaveLength(32);
      expect(credential.authorization_header).toBe(
        buildAgentWebhookBasicAuthorization(credential.security_key),
      );
      expect(JSON.stringify(secured)).not.toContain(credential.security_key);
      expect(JSON.stringify(secured)).not.toContain(
        credential.authorization_header,
      );
      if (process.platform !== "win32") {
        expect((await stat(credentialOutput)).mode & 0o777).toBe(0o600);
      }
      const secureCreateRequest = received
        .filter(
          (request) =>
            request.method === "POST" && request.path?.endsWith("/webhooks"),
        )
        .at(-1);
      expect(JSON.parse(secureCreateRequest?.body ?? "")).toEqual({
        enabled: true,
        name: "Secured build events",
        requires_authorization_header: true,
        security_key: credential.security_key,
      });

      expect(
        await runNode([
          "test",
          "--webhook-id",
          "webhook-agent-1",
          "--credential-file",
          credentialOutput,
          "--confirm",
        ]),
      ).toMatchObject({ accepted_for_processing: true, status_code: 202 });
      const securedIngressRequest = received
        .filter(
          (request) =>
            request.method === "POST" &&
            request.path === "/v1/agent-webhooks/private-slug",
        )
        .at(-1);
      expect(securedIngressRequest?.authorization).toBe(
        credential.authorization_header,
      );

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
