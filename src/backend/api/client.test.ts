import { afterEach, describe, expect, test } from "bun:test";
import { getClientDefaultHeaders } from "./client";

const RUNTIME_ENVIRONMENT_DEVICE_ID_ENV = "LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID";
const originalRuntimeEnvironmentDeviceId =
  process.env[RUNTIME_ENVIRONMENT_DEVICE_ID_ENV];

afterEach(() => {
  if (originalRuntimeEnvironmentDeviceId === undefined) {
    delete process.env[RUNTIME_ENVIRONMENT_DEVICE_ID_ENV];
  } else {
    process.env[RUNTIME_ENVIRONMENT_DEVICE_ID_ENV] =
      originalRuntimeEnvironmentDeviceId;
  }
});

describe("getClientDefaultHeaders", () => {
  test("uses the managed runtime device identity for environment attribution", () => {
    process.env[RUNTIME_ENVIRONMENT_DEVICE_ID_ENV] = "  sandbox-agent-test  ";

    expect(getClientDefaultHeaders()["X-Letta-Environment-Device-Id"]).toBe(
      "sandbox-agent-test",
    );
  });
});
