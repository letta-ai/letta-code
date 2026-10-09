import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAgentWebhookBasicAuthorization,
  cleanupCredentialFile,
  preserveCredentialFile,
  reserveCredentialFile,
  runAgentWebhookCli,
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

describe("managing-agent-webhooks credential lifecycle", () => {
  test("validates secure creation before reserving its credential file", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webhook-credential-"));
    const credentialOutput = join(root, "credential.json");
    try {
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
              "--preprompt",
              "   ",
              "--secure",
              "--credential-output",
              credentialOutput,
            ]),
          ).rejects.toThrow(
            "--preprompt must contain a non-whitespace character",
          );
        },
      );
      expect(await Bun.file(credentialOutput).exists()).toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
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

  test("refuses to overwrite a generated credential file", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webhook-credential-"));
    const credentialOutput = join(root, "credential.json");
    await writeFile(credentialOutput, "keep me", "utf8");
    try {
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
              "--credential-output",
              credentialOutput,
            ]),
          ).rejects.toThrow();
        },
      );
      expect(await readFile(credentialOutput, "utf8")).toBe("keep me");
      if (process.platform !== "win32") {
        const symlinkTarget = join(root, "target.json");
        const symlinkOutput = join(root, "credential-link.json");
        await writeFile(symlinkTarget, "target stays unchanged", "utf8");
        await symlink(symlinkTarget, symlinkOutput);
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
                "Symlink events",
                "--secure",
                "--credential-output",
                symlinkOutput,
              ]),
            ).rejects.toThrow();
          },
        );
        expect(await readFile(symlinkTarget, "utf8")).toBe(
          "target stays unchanged",
        );
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("preserves credentials after an ambiguous server failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webhook-credential-"));
    const credentialOutput = join(root, "credential.json");
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.writeHead(500);
      response.end('{"message":"failed"}');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a TCP test server address");
      }
      await withWebhookEnvironment(
        {
          AGENT_ID: "agent-current",
          LETTA_API_KEY: "dummy-secret",
          LETTA_BASE_URL: `http://127.0.0.1:${address.port}`,
        },
        async () => {
          let receivedError: unknown;
          try {
            await runAgentWebhookCli([
              "create",
              "--name",
              "Secured events",
              "--secure",
              "--credential-output",
              credentialOutput,
            ]);
          } catch (error) {
            receivedError = error;
          }
          expect(receivedError).toBeInstanceOf(Error);
          expect((receivedError as Error).message).toContain(
            "Webhook creation status is unknown or may have succeeded",
          );
          expect((receivedError as Error).message).toContain(credentialOutput);
          expect((receivedError as Error).message).toContain(
            "Run list and reconcile the webhook name before retrying",
          );
        },
      );
      expect(await Bun.file(credentialOutput).exists()).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await rm(root, { force: true, recursive: true });
    }
  });

  test("preserves credentials across reset and truncated-2xx ambiguity", async () => {
    for (const failureMode of ["reset", "truncated-2xx"] as const) {
      const root = await mkdtemp(join(tmpdir(), "agent-webhook-credential-"));
      const credentialOutput = join(root, "credential.json");
      let receivedSecurityKey = "";
      const server = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        receivedSecurityKey = (JSON.parse(body) as { security_key: string })
          .security_key;
        if (failureMode === "reset") {
          request.socket.destroy();
          return;
        }
        response.writeHead(201, { "Content-Type": "application/json" });
        response.flushHeaders();
        response.write('{"webhook":');
        await new Promise((resolve) => setTimeout(resolve, 10));
        response.socket?.destroy();
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Expected a TCP test server address");
        }
        await withWebhookEnvironment(
          {
            AGENT_ID: "agent-current",
            LETTA_API_KEY: "dummy-secret",
            LETTA_BASE_URL: `http://127.0.0.1:${address.port}`,
          },
          async () => {
            let receivedError: unknown;
            try {
              await runAgentWebhookCli([
                "create",
                "--name",
                `Secured events ${failureMode}`,
                "--secure",
                "--credential-output",
                credentialOutput,
              ]);
            } catch (error) {
              receivedError = error;
            }
            expect(receivedError).toBeInstanceOf(Error);
            expect((receivedError as Error).message).toContain(
              "Webhook creation status is unknown or may have succeeded",
            );
            expect((receivedError as Error).message).toContain(
              credentialOutput,
            );
            expect((receivedError as Error).message).not.toContain(
              receivedSecurityKey,
            );
          },
        );
        expect(receivedSecurityKey).toHaveLength(32);
        expect(await Bun.file(credentialOutput).exists()).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { force: true, recursive: true });
      }
    }
  });

  test("removes credentials after a definitive rejection", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webhook-credential-"));
    const credentialOutput = join(root, "credential.json");
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.writeHead(400);
      response.end('{"message":"invalid request"}');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a TCP test server address");
      }
      await withWebhookEnvironment(
        {
          AGENT_ID: "agent-current",
          LETTA_API_KEY: "dummy-secret",
          LETTA_BASE_URL: `http://127.0.0.1:${address.port}`,
        },
        async () => {
          await expect(
            runAgentWebhookCli([
              "create",
              "--name",
              "Secured events",
              "--secure",
              "--credential-output",
              credentialOutput,
            ]),
          ).rejects.toThrow(
            'HTTP 400 Bad Request: {"message":"invalid request"}',
          );
        },
      );
      expect(await Bun.file(credentialOutput).exists()).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await rm(root, { force: true, recursive: true });
    }
  });

  test("redacts reflected credentials from management errors", async () => {
    for (const responseMode of ["nested-json", "string"] as const) {
      const root = await mkdtemp(join(tmpdir(), "agent-webhook-credential-"));
      const credentialOutput = join(root, "credential.json");
      let receivedSecurityKey = "";
      let receivedAuthorizationHeader = "";
      const server = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        receivedSecurityKey = (JSON.parse(body) as { security_key: string })
          .security_key;
        receivedAuthorizationHeader =
          buildAgentWebhookBasicAuthorization(receivedSecurityKey);
        response.writeHead(400, {
          "Content-Type":
            responseMode === "nested-json" ? "application/json" : "text/plain",
        });
        response.end(
          responseMode === "nested-json"
            ? JSON.stringify({
                errors: [
                  {
                    authorization_header: receivedAuthorizationHeader,
                    nested: { security_key: receivedSecurityKey },
                  },
                ],
                message: `Rejected ${receivedSecurityKey}`,
                token: receivedAuthorizationHeader.slice("Basic ".length),
              })
            : `Rejected key=${receivedSecurityKey} header=${receivedAuthorizationHeader}`,
        );
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Expected a TCP test server address");
        }
        await withWebhookEnvironment(
          {
            AGENT_ID: "agent-current",
            LETTA_API_KEY: "dummy-secret",
            LETTA_BASE_URL: `http://127.0.0.1:${address.port}`,
          },
          async () => {
            let receivedError: unknown;
            try {
              await runAgentWebhookCli([
                "create",
                "--name",
                `Reflected ${responseMode}`,
                "--secure",
                "--credential-output",
                credentialOutput,
              ]);
            } catch (error) {
              receivedError = error;
            }
            expect(receivedError).toBeInstanceOf(Error);
            const message = (receivedError as Error).message;
            expect(message).not.toContain(receivedSecurityKey);
            expect(message).not.toContain(receivedAuthorizationHeader);
            expect(message).not.toContain(
              receivedAuthorizationHeader.slice("Basic ".length),
            );
            expect(message).toContain("[REDACTED]");
          },
        );
        expect(receivedSecurityKey).toHaveLength(32);
        expect(await Bun.file(credentialOutput).exists()).toBe(false);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        await rm(root, { force: true, recursive: true });
      }
    }
  });

  test("redacts management authorization from generic API errors", async () => {
    const apiKey = "management-api-key-secret";
    const authorization = `Bearer ${apiKey}`;
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.writeHead(400);
      response.end(
        JSON.stringify({
          errors: [{ authorization, token: apiKey }],
          message: `Reflected ${authorization}`,
        }),
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a TCP test server address");
      }
      await withWebhookEnvironment(
        {
          AGENT_ID: "agent-current",
          LETTA_API_KEY: apiKey,
          LETTA_BASE_URL: `http://127.0.0.1:${address.port}`,
        },
        async () => {
          let receivedError: unknown;
          try {
            await runAgentWebhookCli(["list"]);
          } catch (error) {
            receivedError = error;
          }
          expect(receivedError).toBeInstanceOf(Error);
          const message = (receivedError as Error).message;
          expect(message).toContain("[REDACTED]");
          expect(message).not.toContain(apiKey);
          expect(message).not.toContain(authorization);
        },
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  test("preserves credentials after a successful but malformed response", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webhook-credential-"));
    const credentialOutput = join(root, "credential.json");
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.writeHead(200);
      response.end("{}");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a TCP test server address");
      }
      await withWebhookEnvironment(
        {
          AGENT_ID: "agent-current",
          LETTA_API_KEY: "dummy-secret",
          LETTA_BASE_URL: `http://127.0.0.1:${address.port}`,
        },
        async () => {
          await expect(
            runAgentWebhookCli([
              "create",
              "--name",
              "Secured events",
              "--secure",
              "--credential-output",
              credentialOutput,
            ]),
          ).rejects.toThrow("Webhook response must be an object");
        },
      );
      const credential = JSON.parse(
        await readFile(credentialOutput, "utf8"),
      ) as Record<string, unknown>;
      expect(credential).toHaveProperty("authorization_header");
      expect(credential).toHaveProperty("security_key");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await rm(root, { force: true, recursive: true });
    }
  });

  test("redacts credential-backed ingress responses from stdout and stderr", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webhook-credential-"));
    const credentialPath = join(root, "credential.json");
    const securityKey = "credential-backed-test-secret";
    const authorizationHeader =
      buildAgentWebhookBasicAuthorization(securityKey);
    const secretFields = {
      APIKey: "upper-api-key-value",
      APIToken: "upper-api-token-value",
      apiToken: "api-token-value",
      apikey: "compact-api-key-value",
      apitoken: "compact-api-token-value",
      accesstoken: "compact-access-token-value",
      auth: "standalone-auth-secret",
      authHeader: "auth-header-value",
      authentication: "standalone-authentication-secret",
      authenticationHeader: "authentication-header-value",
      authorizationheader: "compact-authorization-header-value",
      authtoken: "compact-auth-token-value",
      bearertoken: "compact-bearer-token-value",
      clientSecret: "client-secret-value",
      credential_file: "untrusted-credential-file-value",
      databasePassword: "database-password-value",
      idToken: "id-token-value",
      passwordHash: "password-hash-value",
      private_key: "private-key-value",
      privateKey: "private-camel-key-value",
      requires_authorization_header: "untrusted-auth-mode-value",
      refreshtoken: "compact-refresh-token-value",
      sessionToken: "session-token-value",
      securitykey: "compact-security-key-value",
      signing_key: "signing-key-value",
    };
    await writeFile(
      credentialPath,
      JSON.stringify({
        authorization_header: authorizationHeader,
        security_key: securityKey,
      }),
      { mode: 0o600 },
    );
    let ingressShouldFail = true;
    const server = createServer(async (request, response) => {
      const address = server.address();
      if (!address || typeof address === "string") {
        response.writeHead(500);
        response.end();
        return;
      }
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url?.endsWith("/webhooks")) {
        response.writeHead(200);
        response.end(
          JSON.stringify({
            webhooks: [
              {
                authorization_header: null,
                id: "webhook-agent-secure",
                name: "Secure events",
                requires_authorization_header: true,
                webhook_slug: "private",
                webhook_url: `http://127.0.0.1:${address.port}/v1/agent-webhooks/private`,
              },
            ],
          }),
        );
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/agent-webhooks/private"
      ) {
        for await (const _chunk of request) {
          // Consume the request before responding.
        }
        response.writeHead(ingressShouldFail ? 401 : 202);
        response.end(
          JSON.stringify({
            ...secretFields,
            authorization_header: authorizationHeader,
            error: {
              ...secretFields,
              [`leak-${securityKey}`]: "bad",
            },
            errors: [{ security_key: securityKey }],
            [`leak-${securityKey}`]: "ok",
            message: `Reflected ${securityKey}`,
            nested: { ...secretFields },
            nestedArray: [{ ...secretFields }],
            secretary: "Ada",
            token_count: 42,
          }),
        );
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
      const runNode = async () => {
        const child = Bun.spawn(
          [
            "node",
            SCRIPT_PATH,
            "test",
            "--webhook-id",
            "webhook-agent-secure",
            "--credential-file",
            credentialPath,
            "--confirm",
          ],
          {
            env: {
              ...process.env,
              AGENT_ID: "agent-current",
              LETTA_API_KEY: "dummy-secret",
              LETTA_BASE_URL: `http://127.0.0.1:${address.port}`,
            },
            stderr: "pipe",
            stdout: "pipe",
          },
        );
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { exitCode, stderr, stdout };
      };

      const failed = await runNode();
      expect(failed.exitCode).toBe(1);
      expect(failed.stdout).toBe("");
      expect(failed.stderr).toContain("[REDACTED]");
      for (const secret of [
        securityKey,
        authorizationHeader,
        authorizationHeader.slice("Basic ".length),
        ...Object.values(secretFields),
      ]) {
        expect(failed.stdout).not.toContain(secret);
        expect(failed.stderr).not.toContain(secret);
      }

      ingressShouldFail = false;
      const accepted = await runNode();
      expect(accepted.exitCode).toBe(0);
      expect(accepted.stderr).toBe("");
      for (const secret of [
        securityKey,
        authorizationHeader,
        authorizationHeader.slice("Basic ".length),
        ...Object.values(secretFields),
      ]) {
        expect(accepted.stdout).not.toContain(secret);
      }
      const acceptedBody = JSON.parse(accepted.stdout).body as Record<
        string,
        unknown
      >;
      expect(acceptedBody).toMatchObject({
        authorization_header: "[REDACTED]",
        error: { "leak-[REDACTED]": "[REDACTED]" },
        errors: [{ security_key: "[REDACTED]" }],
        "leak-[REDACTED]": "[REDACTED]",
        message: "Reflected [REDACTED]",
        secretary: "Ada",
        token_count: 42,
      });
      for (const field of Object.keys(secretFields)) {
        expect(acceptedBody[field]).toBe("[REDACTED]");
        expect((acceptedBody.nested as Record<string, unknown>)[field]).toBe(
          "[REDACTED]",
        );
        expect((acceptedBody.error as Record<string, unknown>)[field]).toBe(
          "[REDACTED]",
        );
        expect(
          (
            (
              acceptedBody.nestedArray as Array<Record<string, unknown>>
            )[0] as Record<string, unknown>
          )[field],
        ).toBe("[REDACTED]");
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await rm(root, { force: true, recursive: true });
    }
  });

  test("uses fixed diagnostics for malformed credential and payload files", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webhook-malformed-"));
    const credentialPath = join(root, "credential.json");
    const payloadPath = join(root, "payload.json");
    const fragment = "must-not-appear-in-json-diagnostic";
    await writeFile(credentialPath, `{"security_key":"${fragment}`, "utf8");
    await writeFile(payloadPath, `{"message":"${fragment}`, "utf8");
    let secured = true;
    const server = createServer((_request, response) => {
      const address = server.address();
      if (!address || typeof address === "string") {
        response.writeHead(500);
        response.end();
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.writeHead(200);
      response.end(
        JSON.stringify({
          webhooks: [
            {
              authorization_header: null,
              id: "webhook-agent-malformed",
              name: "Malformed file test",
              requires_authorization_header: secured,
              webhook_slug: "private",
              webhook_url: `http://127.0.0.1:${address.port}/v1/agent-webhooks/private`,
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a TCP test server address");
      }
      const runNode = async (fileArgs: string[]) => {
        const child = Bun.spawn(
          [
            "node",
            SCRIPT_PATH,
            "test",
            "--webhook-id",
            "webhook-agent-malformed",
            ...fileArgs,
            "--confirm",
          ],
          {
            env: {
              ...process.env,
              AGENT_ID: "agent-current",
              LETTA_API_KEY: "dummy-secret",
              LETTA_BASE_URL: `http://127.0.0.1:${address.port}`,
            },
            stderr: "pipe",
            stdout: "pipe",
          },
        );
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { exitCode, stderr, stdout };
      };

      const malformedCredential = await runNode([
        "--credential-file",
        credentialPath,
      ]);
      expect(malformedCredential).toMatchObject({ exitCode: 1, stdout: "" });
      expect(malformedCredential.stderr).toContain(
        "Credential file contains invalid JSON",
      );
      expect(malformedCredential.stderr).not.toContain(fragment);

      secured = false;
      const malformedPayload = await runNode(["--payload-file", payloadPath]);
      expect(malformedPayload).toMatchObject({ exitCode: 1, stdout: "" });
      expect(malformedPayload.stderr).toContain(
        "Payload file contains invalid JSON",
      );
      expect(malformedPayload.stderr).not.toContain(fragment);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await rm(root, { force: true, recursive: true });
    }
  });

  test("owns cleanup immediately after credential-file reservation", async () => {
    const calls: string[] = [];
    const handle = {
      close: async () => {
        calls.push("close");
      },
      sync: async () => {
        calls.push("sync");
      },
      writeFile: async () => {
        calls.push("write");
      },
    };
    await expect(
      reserveCredentialFile("/tmp/fault-injected-credential.json", {
        openFile: async () => {
          calls.push("open");
          return handle;
        },
        randomBytes: () => {
          calls.push("random");
          throw new Error("rng failed");
        },
        unlinkFile: async () => {
          calls.push("unlink");
        },
      }),
    ).rejects.toThrow("rng failed");
    expect(calls).toEqual(["open", "random", "close", "unlink"]);
  });

  test("reports cleanup failures without reflecting generated secrets", async () => {
    const deterministicBytes = Buffer.alloc(24, 7);
    const securityKey = deterministicBytes.toString("base64url");
    const authorizationHeader =
      buildAgentWebhookBasicAuthorization(securityKey);
    let receivedError: unknown;
    try {
      await reserveCredentialFile("/tmp/fault-injected-credential.json", {
        openFile: async () => ({
          close: async () => {
            throw new Error("close failed");
          },
          sync: async () => {},
          writeFile: async () => {
            throw new Error(
              `write reflected ${securityKey} ${authorizationHeader}`,
            );
          },
        }),
        randomBytes: () => deterministicBytes,
        unlinkFile: async () => {
          throw new Error("unlink failed");
        },
      });
    } catch (error) {
      receivedError = error;
    }
    expect(receivedError).toBeInstanceOf(Error);
    const message = (receivedError as Error).message;
    expect(message).toContain(
      "Credential cleanup did not complete; a sensitive file may remain",
    );
    expect(message).toContain("close: close failed");
    expect(message).toContain("unlink: unlink failed");
    expect(message).not.toContain(securityKey);
    expect(message).not.toContain(authorizationHeader);
    const cause = (receivedError as Error & { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).not.toContain(securityKey);
    expect((cause as Error).message).not.toContain(authorizationHeader);
  });

  test("reports close and unlink failures for definitive cleanup", async () => {
    const originalError = new Error("definitive rejection");
    const result = await cleanupCredentialFile(
      {
        handle: {
          close: async () => {
            throw new Error("close failed");
          },
        },
        path: "/tmp/sensitive-credential.json",
      },
      originalError,
      {
        unlinkFile: async () => {
          throw new Error("unlink failed");
        },
      },
    );
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toContain("a sensitive file may remain");
    expect(result.message).toContain("/tmp/sensitive-credential.json");
    expect(result.message).toContain("close: close failed");
    expect(result.message).toContain("unlink: unlink failed");
    const cause = (result as Error & { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toBe(originalError.message);
    expect(cause).not.toBe(originalError);
  });

  test("reports close failure while preserving an ambiguous credential", async () => {
    const originalError = new Error("response body terminated");
    const result = await preserveCredentialFile(
      {
        handle: {
          close: async () => {
            throw new Error("close failed");
          },
        },
        path: "/tmp/preserved-credential.json",
      },
      originalError,
      [],
    );
    expect(result.message).toContain(
      "Webhook creation status is unknown or may have succeeded",
    );
    expect(result.message).toContain("/tmp/preserved-credential.json");
    expect(result.message).toContain("did not close cleanly (close failed)");
    expect(result.message).toContain(
      "Run list and reconcile the webhook name before retrying",
    );
    const cause = (result as Error & { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toBe(originalError.message);
    expect(cause).not.toBe(originalError);
  });

  test("drops secret-bearing nested error causes", async () => {
    const nestedSecret = "nested-cause-secret";
    const originalError = new Error("safe outer", {
      cause: new Error(nestedSecret),
    });
    const result = await preserveCredentialFile(
      {
        handle: { close: async () => {} },
        path: "/tmp/preserved-credential.json",
      },
      originalError,
      [nestedSecret],
    );
    const cause = (result as Error & { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toBe("safe outer");
    expect((cause as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(JSON.stringify(cause)).not.toContain(nestedSecret);
  });
});
