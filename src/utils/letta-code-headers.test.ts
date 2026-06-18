import { afterEach, describe, expect, test } from "bun:test";
import {
  getLettaCodeClientMetadataHeaders,
  getLettaCodeEnvironment,
  getLettaCodeRequestHeaders,
} from "@/utils/letta-code-headers";
import { getVersion } from "@/version";

const originalDesktopManaged = process.env.LETTA_CODE_DESKTOP_MANAGED;

afterEach(() => {
  if (originalDesktopManaged === undefined) {
    delete process.env.LETTA_CODE_DESKTOP_MANAGED;
  } else {
    process.env.LETTA_CODE_DESKTOP_MANAGED = originalDesktopManaged;
  }
});

describe("Letta Code request headers", () => {
  test("includes allowlisted client runtime metadata", () => {
    const headers = getLettaCodeClientMetadataHeaders();

    expect(headers).toMatchObject({
      "X-Letta-Client-Name": "letta-code",
      "X-Letta-Client-Version": getVersion(),
      "X-Letta-Client-Platform": process.platform,
      "X-Letta-Client-Runtime-Version":
        process.versions.bun ?? process.versions.node,
    });
    const runtime = headers["X-Letta-Client-Runtime"] ?? "";
    expect(["bun", "node"]).toContain(runtime);
    expect(headers["X-Letta-Client-OS-Type"]).toBeTruthy();
    expect(headers["X-Letta-Client-OS-Release"]).toBeTruthy();
    expect(headers["X-Letta-Client-Arch"]).toBeTruthy();
  });

  test("keeps request headers limited to source, user agent, and allowlisted metadata", () => {
    const headers = getLettaCodeRequestHeaders();

    expect(headers["X-Letta-Source"]).toBe("letta-code");
    expect(headers["User-Agent"]).toBe(`letta-code/${getVersion()}`);
    expect(Object.keys(headers).sort()).toEqual([
      "User-Agent",
      "X-Letta-Client-Arch",
      "X-Letta-Client-Environment",
      "X-Letta-Client-Name",
      "X-Letta-Client-OS-Release",
      "X-Letta-Client-OS-Type",
      "X-Letta-Client-Platform",
      "X-Letta-Client-Runtime",
      "X-Letta-Client-Runtime-Version",
      "X-Letta-Client-Version",
      "X-Letta-Source",
    ]);
  });

  test("marks desktop-managed runtimes without reading arbitrary env values", () => {
    delete process.env.LETTA_CODE_DESKTOP_MANAGED;
    expect(getLettaCodeEnvironment()).toBe("cli");

    process.env.LETTA_CODE_DESKTOP_MANAGED = "1";
    expect(getLettaCodeEnvironment()).toBe("desktop");
  });
});
