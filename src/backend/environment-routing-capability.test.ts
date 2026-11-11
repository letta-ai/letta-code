import { afterEach, describe, expect, test } from "bun:test";
import { isCloudServerUrl } from "@/backend/api/server-url";
import { APIBackend } from "@/backend/backend";
import {
  MANAGED_CLOUD_RUNTIME_ENV,
  markManagedCloudRuntimeFromListenerIdentity,
} from "@/managed-cloud-runtime";
import { resolveLaunchComputer } from "@/tools/impl/subagent-computer";

const originalBaseUrl = process.env.LETTA_BASE_URL;
const originalManagedRuntime = process.env[MANAGED_CLOUD_RUNTIME_ENV];

function restore(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  restore("LETTA_BASE_URL", originalBaseUrl);
  restore(MANAGED_CLOUD_RUNTIME_ENV, originalManagedRuntime);
});

function launchCloudSubagent() {
  return resolveLaunchComputer({
    requested: "cloud",
    subagentType: "general-purpose",
    config: { fork: false, launchProfile: "default" },
    hasEnvironmentRouting: () =>
      new APIBackend().capabilities.environmentRouting,
  });
}

describe("isCloudServerUrl", () => {
  test("true for the Letta Cloud API URL", () => {
    expect(isCloudServerUrl("https://api.letta.com")).toBe(true);
    expect(isCloudServerUrl("https://api.letta.com/")).toBe(true);
  });

  test("false for self-hosted and app-server URLs", () => {
    expect(isCloudServerUrl("http://localhost:8283")).toBe(false);
    expect(isCloudServerUrl("https://letta.internal.example.com")).toBe(false);
  });

  test("false for unparseable URLs", () => {
    expect(isCloudServerUrl("not a url")).toBe(false);
  });
});

describe("environmentRouting capability", () => {
  test("APIBackend reports environmentRouting for Cloud", () => {
    process.env.LETTA_BASE_URL = "https://api.letta.com";
    expect(new APIBackend().capabilities.environmentRouting).toBe(true);
  });

  test("APIBackend reports no environmentRouting for a self-hosted server", () => {
    delete process.env[MANAGED_CLOUD_RUNTIME_ENV];
    process.env.LETTA_BASE_URL = "http://localhost:8283";
    expect(new APIBackend().capabilities.environmentRouting).toBe(false);
  });

  test("a Cloud sandbox reaching Cloud through another hostname can route", () => {
    // Cloud names its sandbox listeners sandbox:<id>; a test deployment
    // serves the Cloud API from its own hostname.
    process.env.LETTA_BASE_URL = "https://cloud-api.example.test";
    markManagedCloudRuntimeFromListenerIdentity("sandbox:sbx-1");
    expect(new APIBackend().capabilities.environmentRouting).toBe(true);
    expect(launchCloudSubagent()).toEqual({ computer: "cloud" });
  });

  test("a listener that is not a Cloud sandbox stays unrouted off Cloud", () => {
    delete process.env[MANAGED_CLOUD_RUNTIME_ENV];
    process.env.LETTA_BASE_URL = "http://localhost:8283";
    markManagedCloudRuntimeFromListenerIdentity("desktop-primary:install-1");
    expect(new APIBackend().capabilities.environmentRouting).toBe(false);
    expect(launchCloudSubagent().error).toContain(
      "requires a Letta Cloud backend",
    );
  });
});
