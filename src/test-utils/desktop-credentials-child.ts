import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSubagent } from "@/agent/subagents/manager";
import { initializeDesktopCredentials } from "@/auth/desktop-credentials";
import { getClient } from "@/backend/api/client";
import { getApiRequestConfig } from "@/backend/api/request";
import { settingsManager } from "@/settings-manager";
import { registerWithCloudRetry } from "@/websocket/listen-register";

await initializeDesktopCredentials();
await settingsManager.initialize();
settingsManager.updateSettings({
  env: { LETTA_API_KEY: "unrelated-cli-key" },
  refreshToken: "unrelated-cli-refresh",
  tokenExpiresAt: 1,
});
globalThis.fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("http://credential-test.invalid/")) {
      throw new Error("Desktop must not refresh the unrelated CLI OAuth grant");
    }
    if (url.endsWith("/v1/metadata/balance")) {
      return Response.json({ billing_tier: "free" });
    }
    process.send?.({
      type: "observed",
      authorization: new Headers(init?.headers).get("authorization"),
      rawApiToken: (await getApiRequestConfig()).apiKey,
      savedCliToken: settingsManager.getSettings().env?.LETTA_API_KEY,
      pid: process.pid,
    });
    return Response.json({ id: "agent-test" });
  },
  { preconnect: () => {} },
);
const client = await getClient();
const probe = join(process.env.HOME ?? "", "subagent-probe.cjs");
writeFileSync(
  probe,
  `console.log(JSON.stringify({type: "result", result: JSON.stringify({
    apiKey: process.env.LETTA_API_KEY,
    hasIpcMarker: Boolean(process.env.LETTA_DESKTOP_CREDENTIALS_IPC),
    computer: process.argv.includes("--computer")
  })}));`,
);
process.on("message", async (message) => {
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "spawn_subagent"
  ) {
    // Exercise the real manager and OS spawn, without running an LLM turn.
    process.env.LETTA_CODE_BIN = process.execPath;
    process.env.LETTA_CODE_BIN_ARGS_JSON = JSON.stringify([probe]);
    if ("missing" in message) {
      delete process.env.LETTA_API_KEY;
      settingsManager.updateSettings({ env: { LETTA_API_KEY: "" } });
    } else {
      process.env.LETTA_API_KEY = "unrelated-env-key";
    }
    const result = await spawnSubagent(
      "general-purpose",
      "probe",
      undefined,
      "credential-probe",
      undefined,
      "agent-probe",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "computer" in message ? "cloud" : undefined,
    );
    delete process.env.LETTA_API_KEY;
    settingsManager.updateSettings({
      env: { LETTA_API_KEY: "unrelated-cli-key" },
    });
    process.send?.({ type: "subagent_result", ...result });
  }
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "register"
  ) {
    const headers: (string | null)[] = [];
    await registerWithCloudRetry(
      {
        serverUrl: "http://credential-test.invalid",
        apiKey: client.apiKey ?? "",
        deviceId: "desktop:install:user",
        connectionName: "Desktop",
      },
      {
        fetchImpl: Object.assign(
          async (_url: unknown, init?: RequestInit) => {
            headers.push(new Headers(init?.headers).get("authorization"));
            return headers.length === 1
              ? new Response("unavailable", { status: 503 })
              : Response.json({
                  connectionId: "conn-test",
                  wsUrl: "ws://credential-test.invalid",
                });
          },
          { preconnect: () => {} },
        ),
        sleep: () =>
          new Promise<void>((resolve) => {
            const resume = (input: unknown) => {
              if (
                input &&
                typeof input === "object" &&
                "type" in input &&
                input.type === "resume_registration"
              ) {
                process.off("message", resume);
                resolve();
              }
            };
            process.on("message", resume);
            process.send?.({ type: "retry_waiting" });
          }),
      },
    );
    process.send?.({ type: "registered", headers, pid: process.pid });
  }
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "request"
  ) {
    await client.agents.retrieve("agent-test");
  }
});
process.send?.({
  type: "initialized",
  hasInheritedCredential: Boolean(process.env.LETTA_API_KEY),
  hasIpcMarker: Boolean(process.env.LETTA_DESKTOP_CREDENTIALS_IPC),
});
