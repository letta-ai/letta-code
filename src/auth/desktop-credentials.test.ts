import { describe, expect, test } from "bun:test";
import { type ChildProcess, fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopCredentialSession } from "./desktop-credentials";

describe("DesktopCredentialSession", () => {
  test("requires a parent credential and replaces it without replacing the session", () => {
    const credentials = new DesktopCredentialSession();
    expect(() => credentials.getAccessToken()).toThrow("unavailable");
    expect(
      credentials.receive({
        type: "desktop_credentials",
        accessToken: "first",
      }),
    ).toBe(true);
    const retainedReader = () => credentials.getAccessToken();
    expect(retainedReader()).toBe("first");
    expect(
      credentials.receive({
        type: "desktop_credentials",
        accessToken: "second",
      }),
    ).toBe(true);
    expect(retainedReader()).toBe("second");
  });

  test("ignores unrelated or malformed IPC messages", () => {
    const credentials = new DesktopCredentialSession();
    for (const message of [
      null,
      "token",
      {},
      { type: "input", accessToken: "bad" },
      { type: "desktop_credentials", accessToken: " " },
    ]) {
      expect(credentials.receive(message)).toBe(false);
    }
    expect(() => credentials.getAccessToken()).toThrow("unavailable");
  });

  test("closing clears credentials and rejects late renewal", () => {
    const credentials = new DesktopCredentialSession();
    credentials.receive({ type: "desktop_credentials", accessToken: "first" });
    credentials.close();
    expect(
      credentials.receive({ type: "desktop_credentials", accessToken: "late" }),
    ).toBe(false);
    expect(() => credentials.getAccessToken()).toThrow("unavailable");
  });
});

function nextMessage(child: ChildProcess): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Child IPC timed out")),
      10_000,
    );
    child.once("message", (message) => {
      clearTimeout(timer);
      resolve(message as Record<string, unknown>);
    });
  });
}

for (const runtime of [process.execPath, "node"]) {
  test(`retained SDK renews over real IPC under ${runtime}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "desktop-credentials-"));
    const entry = join(directory, "child.mjs");
    const build = await Bun.build({
      entrypoints: [
        join(process.cwd(), "src/test-utils/desktop-credentials-child.ts"),
      ],
      target: "node",
      format: "esm",
      loader: { ".md": "text", ".mdx": "text", ".txt": "text" },
    });
    expect(build.success).toBe(true);
    const artifact = build.outputs[0];
    if (!artifact) throw new Error("Missing child build output");
    await Bun.write(entry, artifact);
    const child = fork(entry, [], {
      execPath: runtime,
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      env: {
        ...process.env,
        HOME: directory,
        LETTA_SKIP_KEYCHAIN_CHECK: "1",
        LETTA_BASE_URL: "http://credential-test.invalid",
        LETTA_DESKTOP_CREDENTIALS_IPC: "1",
        LETTA_API_KEY: "unrelated-cli-key",
      },
    });
    try {
      expect((await nextMessage(child)).type).toBe("desktop_credentials_ready");
      let response = nextMessage(child);
      child.send({ type: "desktop_credentials", accessToken: "first" });
      expect(await response).toMatchObject({
        type: "initialized",
        hasInheritedCredential: false,
        hasIpcMarker: false,
      });
      response = nextMessage(child);
      child.send({ type: "request" });
      expect(await response).toMatchObject({
        type: "observed",
        authorization: "Bearer first",
        rawApiToken: "first",
        savedCliToken: "unrelated-cli-key",
        pid: child.pid,
      });
      response = nextMessage(child);
      child.send({ type: "register" });
      expect((await response).type).toBe("retry_waiting");
      response = nextMessage(child);
      child.send({ type: "desktop_credentials", accessToken: "renewed" });
      child.send({ type: "resume_registration" });
      expect(await response).toMatchObject({
        type: "registered",
        headers: ["Bearer first", "Bearer renewed"],
        pid: child.pid,
      });
      response = nextMessage(child);
      child.send({ type: "request" });
      expect(await response).toMatchObject({
        type: "observed",
        authorization: "Bearer renewed",
        rawApiToken: "renewed",
        savedCliToken: "unrelated-cli-key",
        pid: child.pid,
      });
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.disconnect();
      await exited;
    } finally {
      child.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
