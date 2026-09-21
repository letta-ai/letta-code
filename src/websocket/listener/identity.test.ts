import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __listenerIdentityTestUtils,
  getSpawnerDeviceId,
  getSpawnerListenerInstanceId,
  isValidListenerInstanceId,
  LISTENER_INSTANCE_ID_ENV,
} from "./identity";

const originalEnv = process.env[LISTENER_INSTANCE_ID_ENV];
const originalDeviceId = process.env.LETTA_LISTENER_DEVICE_ID;

beforeEach(() => {
  __listenerIdentityTestUtils.resetCachedSpawnerIdentity();
  delete process.env[LISTENER_INSTANCE_ID_ENV];
  delete process.env.LETTA_LISTENER_DEVICE_ID;
});

afterEach(() => {
  if (originalDeviceId === undefined)
    delete process.env.LETTA_LISTENER_DEVICE_ID;
  else process.env.LETTA_LISTENER_DEVICE_ID = originalDeviceId;
  __listenerIdentityTestUtils.resetCachedSpawnerIdentity();
  if (originalEnv === undefined) {
    delete process.env[LISTENER_INSTANCE_ID_ENV];
  } else {
    process.env[LISTENER_INSTANCE_ID_ENV] = originalEnv;
  }
});

describe("getSpawnerListenerInstanceId", () => {
  test("consumes the registered device separately from listener instance identity", () => {
    process.env.LETTA_LISTENER_DEVICE_ID = "desktop:install-42:user-17";
    process.env[LISTENER_INSTANCE_ID_ENV] = "desktop-primary:install-42";
    expect(getSpawnerDeviceId()).toBe("desktop:install-42:user-17");
    expect(process.env.LETTA_LISTENER_DEVICE_ID).toBeUndefined();
    expect(getSpawnerDeviceId()).toBe("desktop:install-42:user-17");
    expect(getSpawnerListenerInstanceId()).toBe("desktop-primary:install-42");
  });

  test("manual registration does not inherit the parent device override", () => {
    expect(getSpawnerDeviceId()).toBeNull();
    process.env.LETTA_LISTENER_DEVICE_ID = "late-inherited-device";
    expect(getSpawnerDeviceId()).toBeNull();
  });

  test("rejects a corrupt assigned device rather than registering the CLI device", () => {
    process.env.LETTA_LISTENER_DEVICE_ID = "bad identity";
    expect(() => getSpawnerDeviceId()).toThrow("Invalid spawner device ID");
    expect(process.env.LETTA_LISTENER_DEVICE_ID).toBeUndefined();
  });
  test("consumes and caches a valid spawner identity without leaving it inheritable", () => {
    process.env[LISTENER_INSTANCE_ID_ENV] = "desktop-primary:install-42";

    expect(getSpawnerListenerInstanceId()).toBe("desktop-primary:install-42");
    expect(process.env[LISTENER_INSTANCE_ID_ENV]).toBeUndefined();
    // Re-registration gets the process-owned cache after the transport env
    // variable is gone.
    expect(getSpawnerListenerInstanceId()).toBe("desktop-primary:install-42");
  });

  test("returns and caches null when unset (manual listeners keep legacy identity)", () => {
    expect(getSpawnerListenerInstanceId()).toBeNull();
    expect(getSpawnerListenerInstanceId()).toBeNull();
  });

  test("consumes invalid values instead of exposing them to descendants", () => {
    process.env[LISTENER_INSTANCE_ID_ENV] = "bad value with spaces!";

    expect(getSpawnerListenerInstanceId()).toBeNull();
    expect(process.env[LISTENER_INSTANCE_ID_ENV]).toBeUndefined();
    expect(getSpawnerListenerInstanceId()).toBeNull();
  });
});

describe("isValidListenerInstanceId", () => {
  test("accepts desktop-slot and legacy-derived shapes", () => {
    expect(isValidListenerInstanceId("desktop-primary:install-42")).toBe(true);
    expect(isValidListenerInstanceId("desktop-local-backend:1c2d3e4f")).toBe(
      true,
    );
    expect(isValidListenerInstanceId("server-0123456789abcdef")).toBe(true);
  });

  test("rejects empty, oversized, and unsafe values", () => {
    expect(isValidListenerInstanceId("")).toBe(false);
    expect(isValidListenerInstanceId("has spaces")).toBe(false);
    expect(isValidListenerInstanceId(`x${"a".repeat(200)}`)).toBe(false);
    expect(isValidListenerInstanceId("-leading-dash")).toBe(false);
  });
});
