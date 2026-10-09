import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAgentWebhookBasicAuthorization,
  validatedWebhookIngressUrl,
} from "@/skills/builtin/managing-agent-webhooks/scripts/manage-agent-webhooks.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL(
    "./builtin/managing-agent-webhooks/scripts/manage-agent-webhooks.mjs",
    import.meta.url,
  ),
);

async function runHelper(
  baseUrl: string,
  args: string[],
  stdin?: string,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const child = Bun.spawn(["node", SCRIPT_PATH, ...args], {
    env: {
      ...process.env,
      AGENT_ID: "agent-endpoint-safety",
      LETTA_API_KEY: "dummy-secret",
      LETTA_BASE_URL: baseUrl,
    },
    stderr: "pipe",
    stdin: stdin === undefined ? undefined : "pipe",
    stdout: "pipe",
  });
  if (stdin !== undefined) {
    child.stdin.write(stdin);
    child.stdin.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

describe("managing-agent-webhooks endpoint safety", () => {
  test("validates canonical runtime-origin ingress URLs", () => {
    const baseUrl = "https://api.example.test";
    const webhook = {
      webhook_slug: "abc_DEF-123",
      webhook_url: "https://api.example.test/v1/agent-webhooks/abc_DEF-123",
    };
    expect(validatedWebhookIngressUrl(webhook, baseUrl)).toBe(
      webhook.webhook_url,
    );
    for (const invalid of [
      "https://evil.example/v1/agent-webhooks/abc_DEF-123",
      "https://user:pass@api.example.test/v1/agent-webhooks/abc_DEF-123",
      "https://api.example.test/v1/agent-webhooks/other",
      "https://api.example.test/v1/agent-webhooks/abc_DEF-123?next=evil",
      "https://api.example.test/v1/agent-webhooks/abc_DEF-123#fragment",
      "https://api.example.test/v1/agent-webhooks/abc%5FDEF-123",
    ]) {
      expect(() =>
        validatedWebhookIngressUrl(
          { ...webhook, webhook_url: invalid },
          baseUrl,
        ),
      ).toThrow();
    }
    expect(() =>
      validatedWebhookIngressUrl(
        { ...webhook, webhook_slug: "bad/slug" },
        baseUrl,
      ),
    ).toThrow("invalid webhook_slug");
  });

  test("sends neither credentials nor payload across origins or redirects", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webhook-endpoint-"));
    const credentialPath = join(root, "credential.json");
    const securityKey = "endpoint-boundary-secret";
    const authorizationHeader =
      buildAgentWebhookBasicAuthorization(securityKey);
    await writeFile(
      credentialPath,
      JSON.stringify({
        authorization_header: authorizationHeader,
        security_key: securityKey,
      }),
      { mode: 0o600 },
    );
    let targetRequests = 0;
    const target = createServer((_request, response) => {
      targetRequests += 1;
      response.writeHead(202);
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve) =>
      target.listen(0, "127.0.0.1", resolve),
    );
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === "string") {
      throw new Error("Expected target server address");
    }
    let mode: "cross-origin" | "redirect" = "cross-origin";
    const management = createServer((request, response) => {
      const address = management.address();
      if (!address || typeof address === "string") {
        response.writeHead(500);
        response.end();
        return;
      }
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url?.endsWith("/webhooks")) {
        const origin =
          mode === "cross-origin"
            ? `http://127.0.0.1:${targetAddress.port}`
            : `http://127.0.0.1:${address.port}`;
        response.writeHead(200);
        response.end(
          JSON.stringify({
            webhooks: [
              {
                authorization_header: null,
                id: "webhook-agent-endpoint",
                name: "Endpoint safety",
                requires_authorization_header: true,
                webhook_slug: "canonical-slug",
                webhook_url: `${origin}/v1/agent-webhooks/canonical-slug`,
              },
            ],
          }),
        );
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/agent-webhooks/canonical-slug"
      ) {
        response.writeHead(307, {
          Location: `http://127.0.0.1:${targetAddress.port}/capture`,
        });
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) =>
      management.listen(0, "127.0.0.1", resolve),
    );
    try {
      const managementAddress = management.address();
      if (!managementAddress || typeof managementAddress === "string") {
        throw new Error("Expected management server address");
      }
      const baseUrl = `http://127.0.0.1:${managementAddress.port}`;
      const args = [
        "test",
        "--webhook-id",
        "webhook-agent-endpoint",
        "--credential-file",
        credentialPath,
        "--confirm",
      ];
      const crossOrigin = await runHelper(baseUrl, args);
      expect(crossOrigin).toMatchObject({ exitCode: 1, stdout: "" });
      expect(crossOrigin.stderr).toContain("active runtime origin");
      expect(targetRequests).toBe(0);

      mode = "redirect";
      const redirected = await runHelper(baseUrl, args);
      expect(redirected).toMatchObject({ exitCode: 1, stdout: "" });
      expect(targetRequests).toBe(0);
      for (const secret of [securityKey, authorizationHeader]) {
        expect(crossOrigin.stderr).not.toContain(secret);
        expect(redirected.stderr).not.toContain(secret);
      }
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => management.close(() => resolve())),
        new Promise<void>((resolve) => target.close(() => resolve())),
      ]);
      await rm(root, { force: true, recursive: true });
    }
  });

  test("blocks management redirects and poisoned returned URLs", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webhook-management-"));
    const credentialPath = join(root, "generated.json");
    let redirectedRequests = 0;
    const target = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Consume any incorrectly redirected body.
      }
      redirectedRequests += 1;
      response.writeHead(400);
      response.end('{"error":"must not arrive"}');
    });
    await new Promise<void>((resolve) =>
      target.listen(0, "127.0.0.1", resolve),
    );
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === "string") {
      throw new Error("Expected redirect target address");
    }
    let mode: "redirect" | "poisoned-create" | "poisoned-list" = "redirect";
    const management = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const address = management.address();
      if (!address || typeof address === "string") {
        response.writeHead(500);
        response.end();
        return;
      }
      if (mode === "redirect" && request.method === "POST") {
        response.writeHead(307, {
          Location: `http://127.0.0.1:${targetAddress.port}/capture`,
        });
        response.end();
        return;
      }
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET") {
        response.writeHead(200);
        response.end(
          JSON.stringify({
            webhooks: [
              {
                authorization_header: null,
                id: "webhook-poisoned-list",
                name: "Poisoned list",
                requires_authorization_header: false,
                webhook_slug: "poisoned-list",
                webhook_url: "http://127.0.0.1:9/capture",
              },
            ],
          }),
        );
        return;
      }
      const create = JSON.parse(body) as { security_key: string };
      response.writeHead(200);
      response.end(
        JSON.stringify({
          webhook: {
            authorization_header: buildAgentWebhookBasicAuthorization(
              create.security_key,
            ),
            id: "webhook-poisoned-create",
            name: "Poisoned create",
            requires_authorization_header: true,
            webhook_slug: "poisoned-create",
            webhook_url: "http://127.0.0.1:9/capture",
          },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      management.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = management.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected management server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const createArgs = [
        "create",
        "--name",
        "Management boundary",
        "--secure",
        "--credential-output",
        credentialPath,
      ];
      const redirected = await runHelper(baseUrl, createArgs);
      expect(redirected).toMatchObject({ exitCode: 1, stdout: "" });
      expect(redirected.stderr).toContain(
        "status is unknown or may have succeeded",
      );
      expect(redirected.stderr).toContain("Run list and reconcile");
      expect(redirectedRequests).toBe(0);
      expect(await readFile(credentialPath, "utf8")).toContain("security_key");

      await rm(credentialPath, { force: true });
      mode = "poisoned-create";
      const poisonedCreate = await runHelper(baseUrl, createArgs);
      expect(poisonedCreate).toMatchObject({ exitCode: 1, stdout: "" });
      expect(poisonedCreate.stderr).toContain("active runtime origin");
      expect(poisonedCreate.stderr).toContain("Run list and reconcile");
      expect(await readFile(credentialPath, "utf8")).toContain("security_key");

      mode = "poisoned-list";
      const poisonedList = await runHelper(baseUrl, ["list"]);
      expect(poisonedList).toMatchObject({ exitCode: 1, stdout: "" });
      expect(poisonedList.stderr).toContain("active runtime origin");
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => management.close(() => resolve())),
        new Promise<void>((resolve) => target.close(() => resolve())),
      ]);
      await rm(root, { force: true, recursive: true });
    }
  });

  test("rejects contradictory authentication state after accepted creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webhook-auth-state-"));
    const credentialPath = join(root, "generated.json");
    const suppliedKey = "user-supplied-key";
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const create = JSON.parse(body) as {
        name: string;
        security_key?: string;
      };
      const address = server.address();
      if (!address || typeof address === "string") {
        response.writeHead(500);
        response.end();
        return;
      }
      const isGenerated = create.name === "Generated mismatch";
      const isPublic = create.name === "Public mismatch";
      const responseKey = isPublic
        ? "unexpected-public-key"
        : isGenerated
          ? create.security_key
          : "different-key";
      response.setHeader("Content-Type", "application/json");
      response.writeHead(200);
      response.end(
        JSON.stringify({
          webhook: {
            authorization_header: responseKey
              ? buildAgentWebhookBasicAuthorization(responseKey)
              : null,
            id: `webhook-${create.name}`,
            name: create.name,
            requires_authorization_header: isPublic || !isGenerated,
            webhook_slug: "auth-state",
            webhook_url: `http://127.0.0.1:${address.port}/v1/agent-webhooks/auth-state`,
          },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const generated = await runHelper(baseUrl, [
        "create",
        "--name",
        "Generated mismatch",
        "--secure",
        "--credential-output",
        credentialPath,
      ]);
      expect(generated).toMatchObject({ exitCode: 1, stdout: "" });
      expect(generated.stderr).toContain("authentication mode does not match");
      expect(generated.stderr).toContain("Run list and reconcile");
      expect(await readFile(credentialPath, "utf8")).toContain("security_key");

      const publicResult = await runHelper(baseUrl, [
        "create",
        "--name",
        "Public mismatch",
        "--public",
      ]);
      expect(publicResult).toMatchObject({ exitCode: 1, stdout: "" });
      expect(publicResult.stderr).toContain(
        "authentication mode does not match",
      );
      expect(publicResult.stderr).toContain("Run list and reconcile");

      const supplied = await runHelper(
        baseUrl,
        ["create", "--name", "Supplied mismatch", "--security-key-stdin"],
        suppliedKey,
      );
      expect(supplied).toMatchObject({ exitCode: 1, stdout: "" });
      expect(supplied.stderr).toContain(
        "authorization_header does not match the requested credential",
      );
      expect(supplied.stderr).toContain("Run list and reconcile");
      expect(supplied.stderr).not.toContain(suppliedKey);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { force: true, recursive: true });
    }
  });

  test("reports oversized accepted side effects as bounded success", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webhook-oversized-"));
    const credentialPath = join(root, "credential.json");
    const key = "oversized-response-key";
    await writeFile(
      credentialPath,
      JSON.stringify({
        authorization_header: buildAgentWebhookBasicAuthorization(key),
        security_key: key,
      }),
      { mode: 0o600 },
    );
    let ingressRequests = 0;
    let deleteRequests = 0;
    const secretFields = {
      apiToken: "delete-api-token",
      clientSecret: "delete-client-secret",
      databasePassword: "delete-database-password",
      idToken: "delete-id-token",
      passwordHash: "delete-password-hash",
      private_key: "delete-private-key",
      privateKey: "delete-private-camel-key",
      sessionToken: "delete-session-token",
      signing_key: "delete-signing-key",
    };
    const server = createServer(async (request, response) => {
      const address = server.address();
      if (!address || typeof address === "string") {
        response.writeHead(500);
        response.end();
        return;
      }
      for await (const _chunk of request) {
        // Consume request bodies before responding.
      }
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url?.endsWith("/webhooks")) {
        response.writeHead(200);
        response.end(
          JSON.stringify({
            webhooks: [
              {
                authorization_header: null,
                id: "webhook-agent-oversized",
                name: "Oversized",
                requires_authorization_header: true,
                webhook_slug: "oversized",
                webhook_url: `http://127.0.0.1:${address.port}/v1/agent-webhooks/oversized`,
              },
            ],
          }),
        );
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/agent-webhooks/oversized"
      ) {
        ingressRequests += 1;
        response.writeHead(202);
        response.end(JSON.stringify({ data: "x".repeat(1_100_000) }));
        return;
      }
      if (
        request.method === "DELETE" &&
        request.url?.includes("webhook-agent-oversized")
      ) {
        deleteRequests += 1;
        response.writeHead(200);
        response.end(
          JSON.stringify(
            deleteRequests === 1
              ? { data: "x".repeat(1_100_000) }
              : {
                  ...secretFields,
                  nested: { ...secretFields },
                  secretary: "Ada",
                  token_count: 42,
                },
          ),
        );
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const tested = await runHelper(baseUrl, [
        "test",
        "--webhook-id",
        "webhook-agent-oversized",
        "--credential-file",
        credentialPath,
        "--confirm",
      ]);
      expect(tested).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(tested.stdout)).toMatchObject({
        accepted_for_processing: true,
        body_omitted: true,
        dispatch_verified: false,
        status_code: 202,
      });
      expect(ingressRequests).toBe(1);

      const deleted = await runHelper(baseUrl, [
        "delete",
        "--webhook-id",
        "webhook-agent-oversized",
        "--confirm",
      ]);
      expect(deleted).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(deleted.stdout)).toMatchObject({
        body_omitted: true,
        deleted: true,
        status_code: 200,
        webhook_id: "webhook-agent-oversized",
      });
      expect(deleteRequests).toBe(1);

      const sanitizedDelete = await runHelper(baseUrl, [
        "delete",
        "--webhook-id",
        "webhook-agent-oversized",
        "--confirm",
      ]);
      expect(sanitizedDelete).toMatchObject({ exitCode: 0, stderr: "" });
      const sanitizedBody = JSON.parse(sanitizedDelete.stdout) as Record<
        string,
        unknown
      >;
      expect(sanitizedBody).toMatchObject({
        body_omitted: true,
        deleted: true,
        status_code: 200,
      });
      for (const secret of Object.values(secretFields)) {
        expect(sanitizedDelete.stdout).not.toContain(secret);
      }
      expect(deleteRequests).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { force: true, recursive: true });
    }
  });

  test("reports truncated and malformed successful mutations as accepted", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webhook-truncated-"));
    const credentialPath = join(root, "credential.json");
    const key = "truncated-response-key";
    await writeFile(
      credentialPath,
      JSON.stringify({
        authorization_header: buildAgentWebhookBasicAuthorization(key),
        security_key: key,
      }),
      { mode: 0o600 },
    );
    let ingressRequests = 0;
    let rotateRequests = 0;
    let updateRequests = 0;
    const server = createServer(async (request, response) => {
      const address = server.address();
      if (!address || typeof address === "string") {
        response.writeHead(500);
        response.end();
        return;
      }
      for await (const _chunk of request) {
        // Consume request bodies before responding.
      }
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url?.endsWith("/webhooks")) {
        response.writeHead(200);
        response.end(
          JSON.stringify({
            webhooks: [
              {
                authorization_header: null,
                id: "webhook-agent-truncated",
                name: "Truncated",
                requires_authorization_header: true,
                webhook_slug: "truncated",
                webhook_url: `http://127.0.0.1:${address.port}/v1/agent-webhooks/truncated`,
              },
            ],
          }),
        );
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/agent-webhooks/truncated"
      ) {
        ingressRequests += 1;
        response.writeHead(202, { "Content-Length": "100" });
        response.flushHeaders();
        response.write('{"partial":');
        setImmediate(() => response.destroy());
        return;
      }
      if (request.method === "POST" && request.url?.endsWith("/refresh")) {
        rotateRequests += 1;
        if (rotateRequests <= 2) {
          response.writeHead(rotateRequests === 1 ? 200 : 500, {
            "Content-Length": "100",
          });
          response.flushHeaders();
          response.write('{"partial":');
          setImmediate(() => response.destroy());
        } else {
          response.writeHead(200);
          response.end(
            JSON.stringify({
              webhook: {
                authorization_header: null,
                id: "different-webhook",
                name: "Wrong rotate record",
                requires_authorization_header: true,
                webhook_slug: "different-rotate",
                webhook_url: `http://127.0.0.1:${address.port}/v1/agent-webhooks/different-rotate`,
              },
            }),
          );
        }
        return;
      }
      if (request.method === "PATCH") {
        updateRequests += 1;
        response.writeHead(200);
        response.end(
          updateRequests === 1
            ? "not-json"
            : JSON.stringify({
                webhook: {
                  authorization_header: null,
                  enabled: true,
                  id:
                    updateRequests === 2
                      ? "different-webhook"
                      : "webhook-agent-truncated",
                  name: "Wrong update record",
                  requires_authorization_header: true,
                  webhook_slug: "different-update",
                  webhook_url: `http://127.0.0.1:${address.port}/v1/agent-webhooks/different-update`,
                },
              }),
        );
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected server address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const tested = await runHelper(baseUrl, [
        "test",
        "--webhook-id",
        "webhook-agent-truncated",
        "--credential-file",
        credentialPath,
        "--confirm",
      ]);
      expect(tested).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(tested.stdout)).toMatchObject({
        accepted: true,
        accepted_for_processing: true,
        body_omitted: true,
        status_code: 202,
      });
      expect(ingressRequests).toBe(1);

      const rotated = await runHelper(baseUrl, [
        "rotate",
        "--webhook-id",
        "webhook-agent-truncated",
        "--confirm",
      ]);
      expect(rotated).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(rotated.stdout)).toMatchObject({
        accepted: true,
        body_omitted: true,
        operation: "rotate",
        status_code: 200,
      });
      expect(rotateRequests).toBe(1);

      const ambiguousRotate = await runHelper(baseUrl, [
        "rotate",
        "--webhook-id",
        "webhook-agent-truncated",
        "--confirm",
      ]);
      expect(ambiguousRotate).toMatchObject({ exitCode: 1, stdout: "" });
      expect(ambiguousRotate.stderr).toContain("HTTP 500");
      expect(ambiguousRotate.stderr).toContain(
        "status is unknown and may have succeeded",
      );
      expect(ambiguousRotate.stderr).toContain("do not blindly retry");
      expect(rotateRequests).toBe(2);

      const mismatchedRotate = await runHelper(baseUrl, [
        "rotate",
        "--webhook-id",
        "webhook-agent-truncated",
        "--confirm",
      ]);
      expect(mismatchedRotate).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(mismatchedRotate.stdout)).toMatchObject({
        accepted: true,
        body_omitted: true,
        operation: "rotate",
        status_code: 200,
        webhook_id: "webhook-agent-truncated",
      });
      expect(mismatchedRotate.stdout).not.toContain("different-webhook");
      expect(rotateRequests).toBe(3);

      const updated = await runHelper(baseUrl, [
        "enable",
        "--webhook-id",
        "webhook-agent-truncated",
      ]);
      expect(updated).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(updated.stdout)).toMatchObject({
        accepted: true,
        body_omitted: true,
        operation: "enable",
        status_code: 200,
      });
      expect(updateRequests).toBe(1);

      const mismatchedUpdate = await runHelper(baseUrl, [
        "disable",
        "--webhook-id",
        "webhook-agent-truncated",
        "--confirm",
      ]);
      expect(mismatchedUpdate).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(mismatchedUpdate.stdout)).toMatchObject({
        accepted: true,
        body_omitted: true,
        operation: "disable",
        status_code: 200,
        webhook_id: "webhook-agent-truncated",
      });
      expect(mismatchedUpdate.stdout).not.toContain("different-webhook");
      expect(updateRequests).toBe(2);

      const mismatchedState = await runHelper(baseUrl, [
        "disable",
        "--webhook-id",
        "webhook-agent-truncated",
        "--confirm",
      ]);
      expect(mismatchedState).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(mismatchedState.stdout)).toMatchObject({
        accepted: true,
        body_omitted: true,
        operation: "disable",
        status_code: 200,
      });
      expect(updateRequests).toBe(3);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { force: true, recursive: true });
    }
  });
});
