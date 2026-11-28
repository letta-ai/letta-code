import { expect, spyOn, test } from "bun:test";
import { hostname } from "node:os";
import { settingsManager } from "@/settings-manager";
import { openEmbeddedTerminal } from "./embedded-terminal";

test("separate TUI launches register the same cloud listener", async () => {
  const originalPid = process.pid;
  const wasReady = settingsManager.isReady;
  if (!wasReady) {
    await settingsManager.reset();
    await settingsManager.initialize();
  }
  const baseSettings = settingsManager.getSettings();
  const device = spyOn(settingsManager, "getOrCreateDeviceId").mockReturnValue(
    "device-123",
  );
  const settings = spyOn(
    settingsManager,
    "getSettingsWithSecureTokens",
  ).mockResolvedValue({
    ...baseSettings,
    env: { LETTA_API_KEY: "test-key", LETTA_BASE_URL: "https://example.test" },
  });
  const fetch = spyOn(globalThis, "fetch");

  async function captureRegistration(pid: number) {
    Object.defineProperty(process, "pid", { value: pid });
    const controller = new AbortController();
    let payload: { listenerInstanceId: string } | undefined;
    fetch.mockImplementationOnce(
      Object.assign(
        async (
          _input: Parameters<typeof globalThis.fetch>[0],
          init?: Parameters<typeof globalThis.fetch>[1],
        ) => {
          payload = JSON.parse(String(init?.body));
          controller.abort();
          return Response.json({
            connectionId: "connection-123",
            wsUrl: "wss://example.test",
          });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );

    await expect(
      openEmbeddedTerminal(
        "agent-123",
        "default",
        true,
        controller.signal,
        () => {},
      ),
    ).rejects.toHaveProperty("name", "AbortError");

    expect(payload).toMatchObject({
      deviceId: "device-123",
      connectionName: `${hostname()} (Letta TUI)`,
      metadata: { registrationSource: "embedded-terminal" },
    });
    expect(payload?.listenerInstanceId).toMatch(/^listen-[a-f0-9]{16}$/);
    return payload?.listenerInstanceId;
  }

  try {
    const first = await captureRegistration(12345);
    const second = await captureRegistration(23456);
    expect(second).toBe(first);
  } finally {
    Object.defineProperty(process, "pid", { value: originalPid });
    fetch.mockRestore();
    settings.mockRestore();
    device.mockRestore();
    if (!wasReady) await settingsManager.reset();
  }
});
