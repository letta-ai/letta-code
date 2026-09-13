import { describe, expect, test } from "bun:test";
import {
  buildCloudScheduleInput,
  CLOUD_CRON_UTC_NOTE,
  CLOUD_DEVICE_FALLBACK_NOTE,
  resolveCronRunner,
  resolveInferredTargetDevice,
  validateTargetDevice,
} from "./cron-runner";

describe("resolveCronRunner", () => {
  test("cloud agent defaults to cloud runner when server supports schedules", () => {
    const result = resolveCronRunner({
      agentId: "agent-123",
      backendMode: "api",
      cloudSchedulesSupported: true,
    });
    expect(result).toMatchObject({ runner: "cloud" });
  });

  test("cloud agent resolves to cloud candidate pre-probe", () => {
    // Default policy is agent-identity based, not environment based: a cloud
    // agent scheduled from a VPS/laptop/sandbox still gets the cloud runner.
    const result = resolveCronRunner({
      agentId: "agent-abc",
      backendMode: "api",
    });
    expect(result).toMatchObject({ runner: "cloud" });
  });

  test("--runner local overrides the cloud default", () => {
    const result = resolveCronRunner({
      explicit: "local",
      agentId: "agent-123",
      backendMode: "api",
      cloudSchedulesSupported: true,
    });
    expect(result).toMatchObject({ runner: "local" });
  });

  test("local-backend agent defaults to local runner", () => {
    const result = resolveCronRunner({
      agentId: "agent-local-123",
      backendMode: "api",
    });
    expect(result).toMatchObject({ runner: "local" });
  });

  test("local backend mode defaults to local runner", () => {
    const result = resolveCronRunner({
      agentId: "agent-123",
      backendMode: "local",
    });
    expect(result).toMatchObject({ runner: "local" });
  });

  test("server without schedule routes defaults to local runner", () => {
    const result = resolveCronRunner({
      agentId: "agent-123",
      backendMode: "api",
      cloudSchedulesSupported: false,
    });
    expect(result).toMatchObject({ runner: "local" });
  });

  test("--runner cloud errors for local-backend agents", () => {
    const result = resolveCronRunner({
      explicit: "cloud",
      agentId: "agent-local-123",
      backendMode: "api",
    });
    expect("error" in result).toBe(true);
  });

  test("--runner cloud errors in local backend mode", () => {
    const result = resolveCronRunner({
      explicit: "cloud",
      agentId: "agent-123",
      backendMode: "local",
    });
    expect("error" in result).toBe(true);
  });

  test("--runner cloud errors when server lacks schedule routes", () => {
    const result = resolveCronRunner({
      explicit: "cloud",
      agentId: "agent-123",
      backendMode: "api",
      cloudSchedulesSupported: false,
    });
    expect("error" in result).toBe(true);
  });

  test("--runner cloud is honored for cloud agents", () => {
    const result = resolveCronRunner({
      explicit: "cloud",
      agentId: "agent-123",
      backendMode: "api",
      cloudSchedulesSupported: true,
    });
    expect(result).toMatchObject({ runner: "cloud" });
  });

  test("invalid --runner value errors", () => {
    const result = resolveCronRunner({
      explicit: "remote",
      agentId: "agent-123",
      backendMode: "api",
    });
    expect("error" in result).toBe(true);
  });
});

describe("buildCloudScheduleInput", () => {
  const base = {
    name: "test-task",
    description: "a test task",
    prompt: "do the thing",
    conversationId: "default",
  };

  test("recurring schedule maps to cron_expression with UTC note", () => {
    const built = buildCloudScheduleInput({
      ...base,
      cron: "0 9 * * *",
      recurring: true,
    });
    expect(built.input.schedule).toEqual({
      type: "recurring",
      cron_expression: "0 9 * * *",
    });
    expect(built.notes).toContain(CLOUD_CRON_UTC_NOTE);
  });

  test("one-shot schedule maps to scheduled_at timestamp", () => {
    const when = new Date(Date.now() + 60_000);
    const built = buildCloudScheduleInput({
      ...base,
      cron: "30 15 17 7 *",
      recurring: false,
      scheduledFor: when,
    });
    expect(built.input.schedule).toEqual({
      type: "one-time",
      scheduled_at: when.getTime(),
    });
    expect(built.notes).toHaveLength(0);
  });

  test("one-shot without a resolved time throws", () => {
    expect(() =>
      buildCloudScheduleInput({
        ...base,
        cron: "30 15 17 7 *",
        recurring: false,
      }),
    ).toThrow();
  });

  test("prompt rides as a single user message", () => {
    const built = buildCloudScheduleInput({
      ...base,
      cron: "*/5 * * * *",
      recurring: true,
    });
    expect(built.input.messages).toEqual([
      { role: "user", content: "do the thing" },
    ]);
    expect(built.input.conversation_id).toBe("default");
    expect(built.input.name).toBe("test-task");
    expect(built.input.description).toBe("a test task");
  });

  test("target device rides as target_device_id with a fallback note", () => {
    const built = buildCloudScheduleInput({
      ...base,
      cron: "*/5 * * * *",
      recurring: true,
      targetDeviceId: "device-railway-1",
    });
    expect(built.input.target_device_id).toBe("device-railway-1");
    expect(built.notes).toContain(CLOUD_DEVICE_FALLBACK_NOTE);
  });

  test("untargeted schedules omit target_device_id entirely", () => {
    const built = buildCloudScheduleInput({
      ...base,
      cron: "*/5 * * * *",
      recurring: true,
    });
    expect("target_device_id" in built.input).toBe(false);
    expect(built.notes).not.toContain(CLOUD_DEVICE_FALLBACK_NOTE);
  });

  test("whitespace-only computer target is treated as absent", () => {
    const built = buildCloudScheduleInput({
      ...base,
      cron: "*/5 * * * *",
      recurring: true,
      targetDeviceId: "   ",
    });
    expect("target_device_id" in built.input).toBe(false);
    expect(built.notes).not.toContain(CLOUD_DEVICE_FALLBACK_NOTE);
  });
});

describe("validateTargetDevice", () => {
  test("registered remote device passes", () => {
    const result = validateTargetDevice("device-railway-1", {
      organizationId: "org-abc",
    });
    expect(result).toEqual({ ok: true });
  });

  test("unknown device (no local entry) passes through to server validation", () => {
    const result = validateTargetDevice("device-unknown", null);
    expect(result).toEqual({ ok: true });
  });

  test("synthetic Cloud row is rejected with omit guidance", () => {
    const result = validateTargetDevice("__letta_cloud__", {
      organizationId: "local",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("--runner cloud");
    }
  });

  test("synthetic local placeholder is rejected", () => {
    const result = validateTargetDevice("local", null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("letta server");
    }
  });

  test("desktop-local connection is rejected with connect guidance", () => {
    const result = validateTargetDevice("07fca6a1-device", {
      organizationId: "local",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("letta server");
      expect(result.error).toContain("local desktop connection");
    }
  });
});

describe("resolveInferredTargetDevice", () => {
  const onlineEnvironment = {
    id: "environment-1",
    connectionId: "connection-1",
    deviceId: "device-external-1",
    connectionName: "external listener",
    organizationId: "org-1",
    podId: null,
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
    lastSeenAt: Date.now(),
    firstSeenAt: Date.now(),
  };

  test("accepts a registered online external listener", async () => {
    expect(
      await resolveInferredTargetDevice(
        onlineEnvironment.deviceId,
        async () => onlineEnvironment,
      ),
    ).toEqual({ kind: "device" });
  });

  test("resolves a managed sandbox runtime to the untargeted Cloud sandbox without a registry lookup", async () => {
    // Sandbox rows can be registered/online in the environments registry, but
    // individual sandboxes get retired and recreated, so one must never be
    // pinned as a device target. The lookup must not even run.
    expect(
      await resolveInferredTargetDevice("sandbox-agent-example", async () => {
        throw new Error("registry lookup should not run for sandbox ids");
      }),
    ).toEqual({ kind: "cloud-sandbox" });
  });

  test.each([
    ["unregistered", "device-missing", null],
    [
      "offline",
      "device-external-1",
      {
        ...onlineEnvironment,
        connectionId: null,
        lastHeartbeat: Date.now() - 300_000,
      },
    ],
    [
      "Desktop-local",
      "device-local-1",
      {
        ...onlineEnvironment,
        deviceId: "device-local-1",
        organizationId: "local",
      },
    ],
    ["synthetic local", "local", null],
    ["synthetic Cloud", "__letta_cloud__", null],
  ])(
    "resolves %s identities to the local-runner fallback",
    async (_label, deviceId, environment) => {
      const result = await resolveInferredTargetDevice(
        deviceId,
        async () => environment,
      );
      expect(result.kind).toBe("local-fallback");
      if (result.kind === "local-fallback") {
        expect(result.reason.length).toBeGreaterThan(0);
      }
    },
  );
});
