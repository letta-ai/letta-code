import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { settingsManager } from "@/settings-manager";
import { resolveAgentSandboxConnectionId } from "./environments";

beforeEach(async () => {
  await settingsManager.reset();
  await settingsManager.initialize();
});
afterEach(() => mock.restore());

test("cloud sandbox creation retains the status of a mapped API error", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(
      { error: "Cloud sandboxes are only available for pro or enterprise" },
      { status: 403 },
    ),
  );

  await expect(
    resolveAgentSandboxConnectionId("agent-test"),
  ).rejects.toMatchObject({
    code: "cloud_sandbox_create_failed",
    httpStatus: 403,
    cause: expect.objectContaining({ message: "PLAN_UPGRADE_REQUIRED" }),
  });
});

test("cloud sandbox online timeout retains the last poll HTTP error after an offline response", async () => {
  const startedAt = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(startedAt);
  spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      Response.json({ deviceId: "device-test", connectionName: "worker" }),
    )
    .mockResolvedValueOnce(
      Response.json({
        deviceId: "device-test",
        connectionName: "worker",
        connectionId: null,
      }),
    )
    .mockImplementation(
      Object.assign(
        async () => {
          clock.mockReturnValue(startedAt + 100);
          return Response.json({ detail: "Not found" }, { status: 404 });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );

  await expect(
    resolveAgentSandboxConnectionId("agent-test", {
      timeoutMs: 100,
      pollIntervalMs: 1,
    }),
  ).rejects.toMatchObject({
    code: "cloud_sandbox_online_timeout",
    httpStatus: 404,
    cause: expect.objectContaining({ status: 404 }),
  });
});
