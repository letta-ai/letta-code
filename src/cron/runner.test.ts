import { describe, expect, test } from "bun:test";
import {
  buildCloudScheduleInput,
  CLOUD_CRON_UTC_NOTE,
  CLOUD_DEVICE_FALLBACK_NOTE,
  isManagedCloudSandbox,
  resolveCronRunner,
  validateTargetDevice,
} from "./runner";

describe("resolveCronRunner", () => {
  test("managed Cloud sandbox uses Cloud schedules", () => {
    expect(
      resolveCronRunner({
        managedCloudSandbox: true,
        backendMode: "api",
        cloudSchedulesSupported: true,
      }),
    ).toMatchObject({ runner: "cloud" });
  });

  test("Cloud API-backed local execution uses local schedules", () => {
    expect(
      resolveCronRunner({
        managedCloudSandbox: false,
        backendMode: "api",
        cloudSchedulesSupported: true,
      }),
    ).toMatchObject({ runner: "local" });
  });

  test("managed Cloud sandbox never falls back when schedule routes fail", () => {
    const result = resolveCronRunner({
      managedCloudSandbox: true,
      backendMode: "api",
      cloudSchedulesSupported: false,
    });
    expect(result).toEqual({
      error:
        "Cloud schedules are unavailable in this managed Cloud sandbox. No local schedule was created.",
    });
  });

  test("Daytona sandbox identity is independent of listener device identity", () => {
    expect(
      isManagedCloudSandbox({
        DAYTONA_SANDBOX_ID: "sandbox-runtime",
        LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID: "unregistered-device",
      }),
    ).toBe(true);
    expect(
      isManagedCloudSandbox({
        LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID: "sandbox-looking-device",
      }),
    ).toBe(false);
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
      expect(result.error).toContain("Omit --computer");
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
